/**
 * Structure from motion for one shot: the camera's position and orientation in every frame and a sparse cloud of 3D points,
 * from feature tracks alone (no markers, no sensor data, no AI).
 *
 * 1. Keyframes are taken at an even spacing (at most `maxKeyframes`), so the adjustment stays small for a long clip.
 * 2. The first keyframe and a later one with enough parallax give the essential matrix (RANSAC), hence the second camera and
 *    the first points (triangulated), refined by bundle adjustment.
 * 3. The other keyframes are placed one by one by resection against the points known so far (RANSAC, then Gauss-Newton);
 *    each new keyframe adds the tracks it makes triangulable. The whole is re-adjusted at 4, 8, 16, ... cameras, with
 *    observations further than a few pixels from their point thrown out.
 * 4. A final adjustment also refines the focal length (unless it was given), and every frame that is not a keyframe is placed
 *    by resection against the final points.
 *
 * Scale is arbitrary: the world is scaled so that the median depth of the points in the first frame is 1.
 * Limits: a camera that only rotates (or a flat scene) has no depth to recover and fails with a clear error; the solve assumes
 * a rigid scene (moving objects are outvoted if they are a minority of the tracks) and a pinhole camera without lens distortion.
 */
import { bundleAdjust, type Obs } from './ba.js';
import {
  centerOf, decomposeEssential, expSO3, logSO3, project, ransacEssential, rayAngle, refinePose, resect, toCam, triangulate,
  type Pose, type Vec3,
} from './cam.js';
import type { Pt } from './geom.js';
import { mul3, rng } from './linalg.js';
import type { FeatureTrack, TrackSet } from './tracks.js';

export class SolveError extends Error {
  constructor(
    public code: 'NO_PARALLAX' | 'TOO_FEW_FEATURES' | 'LOST',
    message: string,
  ) {
    super(message);
  }
}

export interface SolveOptions {
  /** initial focal length in pixels of the analysed image (default 0.9 x width, about 58 degrees across) */
  focal?: number;
  /** keep the focal length at the given value instead of refining it */
  fixFocal?: boolean;
  maxKeyframes?: number;
  /** the pair that starts the solve needs a median disparity of at least this fraction of the width */
  minParallax?: number;
  log?: (m: string) => void;
}

export interface SolvedPoint {
  X: Vec3;
  /** index of the feature track */
  track: number;
  /** observations in keyframes */
  views: number;
  /** rms reprojection error over them (px) */
  rms: number;
}
export type FrameHow = 'bundle' | 'resection' | 'interpolated' | 'held' | 'none';
export interface CameraSolve {
  w: number;
  h: number;
  /** focal length in pixels of the analysed image */
  f: number;
  fInit: number;
  fixedFocal: boolean;
  frames: number;
  /** per frame: world to camera, x_cam = R X + t; null when no pose could be given */
  poses: (Pose | null)[];
  how: FrameHow[];
  /** reprojection rms per frame over its tracked points (px), NaN when none */
  frameRms: number[];
  points: SolvedPoint[];
  keyframes: number[];
  stats: {
    registered: number;
    keyframes: number;
    points: number;
    observations: number;
    rmsPx: number;
    medianPx: number;
    p95Px: number;
    initPair: [number, number];
    initAngleDeg: number;
    hfovDeg: number;
    /** rms of the first bundle adjustment with the starting focal, to compare with rmsPx after refining it */
    rmsAtInitialFocal: number;
  };
}

interface TObs {
  k: number;
  x: number;
  y: number;
}

const median = (a: number[]) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1]! : NaN;
};

export function solveCamera(set: TrackSet, o: SolveOptions = {}): CameraSolve {
  const t0 = Date.now();
  const { w, h, frames: nFrames } = set;
  const log = o.log ?? (() => undefined);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  let f = o.focal ?? 0.9 * w;
  const fInit = f;
  const fixF = !!o.fixFocal;
  const fRange: [number, number] = [0.4 * w, 4 * w];
  if (set.tracks.length < 40) throw new SolveError('TOO_FEW_FEATURES', `only ${set.tracks.length} feature tracks were found; the picture needs more texture to solve a camera`);

  // keyframes
  const maxK = Math.max(8, o.maxKeyframes ?? 120);
  const step = Math.max(1, Math.ceil(nFrames / maxK));
  const keys: number[] = [];
  for (let i = 0; i < nFrames; i += step) keys.push(i);
  if (keys[keys.length - 1] !== nFrames - 1) keys.push(nFrames - 1);
  const K = keys.length;
  if (K < 3) throw new SolveError('TOO_FEW_FEATURES', 'a camera solve needs at least three frames');

  // observations per track (in keyframes), centred pixel coordinates
  const tObs: TObs[][] = set.tracks.map((tr) => {
    const out: TObs[] = [];
    keys.forEach((fr, k) => {
      const i = fr - tr.first;
      if (i >= 0 && i < tr.xs.length) out.push({ k, x: tr.xs[i]! - cx, y: tr.ys[i]! - cy });
    });
    return out;
  });
  const obsOf = (t: number, k: number): TObs | undefined => tObs[t]!.find((q) => q.k === k);

  const poseK: (Pose | null)[] = new Array(K).fill(null);
  const X3: (Vec3 | null)[] = new Array(set.tracks.length).fill(null);
  const excluded = new Set<number>(); // track * 4096 + k
  const ex = (t: number, k: number) => excluded.has(t * 4096 + k);
  const R = rng(5);

  // ----- the first pair ------------------------------------------------------------------------------------------------------
  const minPar = (o.minParallax ?? 0.04) * w;
  interface Init {
    j: number;
    pose: Pose;
    common: number[];
    angle: number;
  }
  let init = null as Init | null;
  let bestScore = 0;
  let bestInit = null as Init | null;
  for (let j = 1; j < K && !init; j++) {
    const common: number[] = [];
    const disp: number[] = [];
    for (let t = 0; t < set.tracks.length; t++) {
      const a = obsOf(t, 0);
      const b = a ? obsOf(t, j) : undefined;
      if (a && b) {
        common.push(t);
        disp.push(Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    if (common.length < 40 || median(disp) < minPar) continue;
    const a: Pt[] = common.map((t) => [obsOf(t, 0)!.x / f, obsOf(t, 0)!.y / f]);
    const b: Pt[] = common.map((t) => [obsOf(t, j)!.x / f, obsOf(t, j)!.y / f]);
    const fit = ransacEssential(a, b, { thresh: 1.5 / f, seed: 11 });
    if (!fit || fit.count < Math.max(30, common.length * 0.4)) continue;
    const idx = common.map((_, i) => i).filter((i) => fit.inliers[i]);
    const I: Pose = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    let pick: { pose: Pose; front: number } | null = null;
    for (const cand of decomposeEssential(fit.E)) {
      let front = 0;
      for (const i of idx) {
        const X = triangulate([I, cand], [a[i]!, b[i]!]);
        if (X && X[2] > 0 && toCam(cand, X)[2] > 0) front++;
      }
      if (!pick || front > pick.front) pick = { pose: cand, front };
    }
    if (!pick || pick.front < idx.length * 0.7) continue;
    const c2 = centerOf(pick.pose);
    const angles: number[] = [];
    for (const i of idx) {
      const X = triangulate([I, pick.pose], [a[i]!, b[i]!]);
      if (X && X[2] > 0) angles.push(rayAngle([0, 0, 0], c2, X));
    }
    const angle = median(angles);
    const score = idx.length * Math.min(angle, 8);
    const cand = { j, pose: pick.pose, common: idx.map((i) => common[i]!), angle };
    if (angle >= 1.5 && score > bestScore) {
      bestScore = score;
      bestInit = cand;
    }
    if (angle >= 4 && idx.length >= 60) init = cand;
  }
  init ??= bestInit;
  if (!init) throw new SolveError('NO_PARALLAX', 'the camera does not move enough to recover depth: it may only rotate or zoom, or the scene is flat. Without parallax there is nothing to solve in 3D; use a planar track (--model homography) or stabilize instead');
  log(`first pair: frames ${keys[0]} and ${keys[init.j]}, ${init.common.length} matches, triangulation angle ${init.angle.toFixed(1)} degrees`);
  poseK[0] = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  poseK[init.j] = init.pose;
  const trianglePt = (t: number, minAngle: number, maxErr: number): Vec3 | null => {
    const obs = tObs[t]!.filter((q) => poseK[q.k] && !ex(t, q.k));
    if (obs.length < 2) return null;
    const ps = obs.map((q) => poseK[q.k]!);
    const X = triangulate(ps, obs.map((q) => [q.x / f, q.y / f] as Pt));
    if (!X) return null;
    for (let i = 0; i < obs.length; i++) {
      const q = project(f, ps[i]!, X);
      if (!q || Math.hypot(q[0] - obs[i]!.x, q[1] - obs[i]!.y) > maxErr) return null;
    }
    const first = ps[0]!;
    const last = ps[ps.length - 1]!;
    let ang = 0;
    for (const p of [ps[ps.length >> 1]!, last]) ang = Math.max(ang, rayAngle(centerOf(first), centerOf(p), X));
    return ang >= minAngle ? X : null;
  };
  const triangulateNew = (minAngle = 1.5) => {
    let added = 0;
    for (let t = 0; t < set.tracks.length; t++) {
      if (X3[t]) continue;
      const X = trianglePt(t, minAngle, 3);
      if (X) {
        X3[t] = X;
        added++;
      }
    }
    return added;
  };

  /** Bundle adjustment over the registered keyframes. Returns the rms (px) before outliers are removed. */
  const adjust = (optimizeF: boolean, outlierPx: number): number => {
    const regs: number[] = [];
    poseK.forEach((p, k) => p && regs.push(k));
    const camIdx = new Map(regs.map((k, i) => [k, i]));
    const pidx = new Map<number, number>();
    const ptsList: Vec3[] = [];
    const obs: Obs[] = [];
    const origin: { t: number; k: number }[] = [];
    for (let t = 0; t < set.tracks.length; t++) {
      const X = X3[t];
      if (!X) continue;
      const list = tObs[t]!.filter((q) => camIdx.has(q.k) && !ex(t, q.k));
      if (list.length < 2) continue;
      pidx.set(t, ptsList.length);
      ptsList.push(X);
      for (const q of list) {
        obs.push({ c: camIdx.get(q.k)!, p: ptsList.length - 1, u: q.x, v: q.y });
        origin.push({ t, k: q.k });
      }
    }
    if (!obs.length) return NaN;
    const prob = { f, cams: regs.map((k) => poseK[k]!), pts: ptsList, obs, fixedCams: [0], optimizeF: optimizeF && !fixF, fRange };
    const res = bundleAdjust(prob, { iters: 25, huber: 1.5 });
    f = prob.f;
    regs.forEach((k, i) => (poseK[k] = prob.cams[i]!));
    for (const [t, i] of pidx) X3[t] = prob.pts[i]!;
    // throw out what disagrees with the adjusted model
    if (outlierPx > 0) {
      obs.forEach((ob, i) => {
        const q = project(f, prob.cams[ob.c]!, prob.pts[ob.p]!);
        if (!q || Math.hypot(q[0] - ob.u, q[1] - ob.v) > outlierPx) excluded.add(origin[i]!.t * 4096 + origin[i]!.k);
      });
      for (const [t] of pidx) {
        const left = tObs[t]!.filter((q) => poseK[q.k] && !ex(t, q.k)).length;
        if (left < 2) X3[t] = null;
      }
    }
    return res.rms;
  };

  // two-view start
  for (const t of init.common) X3[t] = null;
  triangulateNew(0.5);
  let rmsInitialFocal = adjust(false, 4);
  triangulateNew(1.0);
  log(`two views: ${X3.filter(Boolean).length} points, rms ${rmsInitialFocal.toFixed(2)} px`);

  // ----- the other keyframes -----------------------------------------------------------------------------------------------------
  let registered = 2;
  let nextAdjust = 4;
  const solveFrame = (k: number): boolean => {
    const ts: number[] = [];
    const Xs: Vec3[] = [];
    const px: Pt[] = [];
    for (let t = 0; t < set.tracks.length; t++) {
      const X = X3[t];
      const q = X ? obsOf(t, k) : undefined;
      if (X && q) (ts.push(t), Xs.push(X), px.push([q.x, q.y]));
    }
    return placeFrame(Xs, px, (pose) => (poseK[k] = pose), k);
  };
  /** RANSAC resection then refinement; `set` receives the pose */
  const placeFrame = (Xs: Vec3[], px: Pt[], set_: (p: Pose) => void, _k: number): boolean => {
    const n = Xs.length;
    if (n < 12) return false;
    const xn: Pt[] = px.map(([x, y]) => [x / f, y / f]);
    let best: { pose: Pose; count: number } | null = null;
    for (let it = 0; it < 300; it++) {
      const pick = new Set<number>();
      while (pick.size < 6) pick.add(Math.floor(R() * n));
      const pose = resect(Xs, xn, [...pick]);
      if (!pose) continue;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const q = project(f, pose, Xs[i]!);
        if (q && Math.hypot(q[0] - px[i]![0], q[1] - px[i]![1]) < 3) count++;
      }
      if (!best || count > best.count) best = { pose, count };
      if (count > n * 0.9) break;
    }
    if (!best || best.count < 10) return false;
    const r = refinePose(best.pose, f, Xs, px, { huber: 1.5, inlier: 3 });
    if (r.inliers < 10 || r.inliers < n * 0.3) return false;
    set_(r.pose);
    return true;
  };
  for (let k = 1; k < K; k++) {
    if (poseK[k]) continue;
    if (!solveFrame(k)) {
      log(`frame ${keys[k]}: could not be placed yet`);
      continue;
    }
    registered++;
    triangulateNew();
    if (registered >= nextAdjust) {
      adjust(registered >= 8, 4);
      triangulateNew();
      nextAdjust *= 2;
    }
  }
  // keyframes that failed on the way get another try with the points of the whole shot
  for (let k = 1; k < K; k++) if (!poseK[k] && solveFrame(k)) registered++;
  triangulateNew(1.0);
  if (registered < 3) throw new SolveError('LOST', `only ${registered} frames could be placed; the features were lost too quickly (fast motion, blur or too little texture)`);

  // ----- final adjustment ----------------------------------------------------------------------------------------------------------
  let rms = adjust(true, 3);
  triangulateNew(1.0);
  rms = adjust(true, 2.5);
  if (!Number.isFinite(rmsInitialFocal)) rmsInitialFocal = rms;
  log(`adjusted: focal ${f.toFixed(1)} px (started at ${fInit.toFixed(1)}), rms ${rms.toFixed(3)} px, ${X3.filter(Boolean).length} points`);

  // scale: median depth in the first frame is 1
  const depths: number[] = [];
  for (const X of X3) if (X) depths.push(toCam(poseK[0]!, X)[2]);
  const s = 1 / Math.max(1e-9, median(depths));
  for (let t = 0; t < X3.length; t++) if (X3[t]) X3[t] = [X3[t]![0] * s, X3[t]![1] * s, X3[t]![2] * s];
  for (const p of poseK) if (p) p.t = [p.t[0] * s, p.t[1] * s, p.t[2] * s];

  // ----- every frame ------------------------------------------------------------------------------------------------------------------
  const poses: (Pose | null)[] = new Array(nFrames).fill(null);
  const how: FrameHow[] = new Array(nFrames).fill('none');
  keys.forEach((fr, k) => {
    if (poseK[k]) {
      poses[fr] = poseK[k]!;
      how[fr] = 'bundle';
    }
  });
  const known = () => poses.map((p, i) => (p && (how[i] === 'bundle' || how[i] === 'resection') ? i : -1)).filter((i) => i >= 0);
  const lerpPose = (a: Pose, b: Pose, u: number): Pose => {
    const d = logSO3(mul3(b.R, a.R));
    const Rm = mul3(expSO3([d[0] * u, d[1] * u, d[2] * u]), a.R);
    const ca = centerOf(a);
    const cb = centerOf(b);
    const c: Vec3 = [ca[0] + u * (cb[0] - ca[0]), ca[1] + u * (cb[1] - ca[1]), ca[2] + u * (cb[2] - ca[2])];
    const r = [Rm[0] * c[0] + Rm[1] * c[1] + Rm[2] * c[2], Rm[3] * c[0] + Rm[4] * c[1] + Rm[5] * c[2], Rm[6] * c[0] + Rm[7] * c[1] + Rm[8] * c[2]];
    return { R: Rm, t: [-r[0]!, -r[1]!, -r[2]!] };
  };
  const finalPts = X3.map((X, t) => (X && tObs[t]!.filter((q) => poseK[q.k] && !ex(t, q.k)).length >= 2 ? X : null));
  for (let fr = 0; fr < nFrames; fr++) {
    if (how[fr] === 'bundle') continue;
    const kn = known();
    const prev = [...kn].reverse().find((i) => i < fr);
    const next = kn.find((i) => i > fr);
    const guess = prev !== undefined && next !== undefined ? lerpPose(poses[prev]!, poses[next]!, (fr - prev) / (next - prev)) : (poses[prev ?? next ?? 0] ?? null);
    const Xs: Vec3[] = [];
    const px: Pt[] = [];
    set.tracks.forEach((tr, t) => {
      const X = finalPts[t];
      const i = fr - tr.first;
      if (X && i >= 0 && i < tr.xs.length) (Xs.push(X), px.push([tr.xs[i]! - cx, tr.ys[i]! - cy]));
    });
    let done = false;
    if (guess && Xs.length >= 10) {
      const r = refinePose(guess, f, Xs, px, { huber: 1.5, inlier: 3 });
      if (r.inliers >= 10 && r.inliers >= Xs.length * 0.3) {
        poses[fr] = r.pose;
        how[fr] = 'resection';
        done = true;
      }
    }
    if (!done && guess) {
      poses[fr] = guess;
      how[fr] = prev !== undefined && next !== undefined ? 'interpolated' : 'held';
    }
  }

  // ----- results -------------------------------------------------------------------------------------------------------------------
  const errs: number[] = [];
  const frameSq = new Array(nFrames).fill(0);
  const frameN = new Array(nFrames).fill(0);
  const points: SolvedPoint[] = [];
  set.tracks.forEach((tr, t) => {
    const X = finalPts[t];
    if (!X) return;
    let sq = 0;
    let views = 0;
    for (let i = 0; i < tr.xs.length; i++) {
      const fr = tr.first + i;
      const p = poses[fr];
      if (!p || how[fr] === 'interpolated' || how[fr] === 'held') continue;
      const q = project(f, p, X);
      if (!q) continue;
      const e = Math.hypot(q[0] - (tr.xs[i]! - cx), q[1] - (tr.ys[i]! - cy));
      if (e > 6) continue;
      errs.push(e);
      frameSq[fr] += e * e;
      frameN[fr]++;
      sq += e * e;
      views++;
    }
    if (views >= 3) points.push({ X, track: t, views, rms: Math.sqrt(sq / views) });
  });
  errs.sort((a, b) => a - b);
  const rmsAll = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / Math.max(1, errs.length));
  void t0;
  return {
    w,
    h,
    f,
    fInit,
    fixedFocal: fixF,
    frames: nFrames,
    poses,
    how,
    frameRms: frameSq.map((v, i) => (frameN[i] ? Math.sqrt(v / frameN[i]) : NaN)),
    points,
    keyframes: keys,
    stats: {
      registered: how.filter((x) => x === 'bundle' || x === 'resection').length,
      keyframes: K,
      points: points.length,
      observations: errs.length,
      rmsPx: rmsAll,
      medianPx: errs.length ? errs[errs.length >> 1]! : NaN,
      p95Px: errs.length ? errs[Math.floor(errs.length * 0.95)]! : NaN,
      initPair: [keys[0]!, keys[init.j]!],
      initAngleDeg: init.angle,
      hfovDeg: (2 * Math.atan(w / (2 * f)) * 180) / Math.PI,
      rmsAtInitialFocal: rmsInitialFocal,
    },
  };
}

/** Where a 3D point is in a frame (pixels, index coordinates of the analysed image), or null when it is behind the camera. */
export function projectIndex(s: { w: number; h: number; f: number }, pose: Pose, X: Vec3): Pt | null {
  const q = project(s.f, pose, X);
  return q ? [q[0] + (s.w - 1) / 2, q[1] + (s.h - 1) / 2] : null;
}
export type { FeatureTrack };
