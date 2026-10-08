/**
 * 3D camera tracking for a shot: the camera's pose in every analysed frame and a sparse point cloud, solved from feature
 * tracks (see packages/vision/src/sfm.ts) and cached under `.studio/cache/solve/`. Several trackers on the same shot share one
 * solve, because its key leaves out the region.
 *
 * What it is used for here: a `plane3d` tracker takes a flat region of the shot, fits a plane to the solved points inside it
 * and follows that plane through the camera's motion. Unlike a planar tracker it keeps the plane when the region is occluded,
 * leaves the frame, or the camera moves so much that the picture of it changes completely.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apply, centerOf, dot3, fitHomography, fromBytes, inv3, len3, probeVideo, project, readFrames, rng, rot, scale3, solveCamera, sub3, svd,
  trackFeatures, transpose3, add3, SolveError, type CameraSolve, type Mat3, type Pose, type Pt, type Quad, type Vec3,
} from '@studio/vision';
import { grabFrame } from './grab.js';
import { EngineError } from './run.js';

export const SOLVE_VERSION = 1;

export interface SolveData {
  v: number;
  key: string;
  fps: number;
  w: number;
  h: number;
  fromMs: number;
  frames: number;
  f: number;
  fInit: number;
  fixedFocal: boolean;
  /** per frame: world to camera, [r0..r8, t0..t2], or null */
  poses: (number[] | null)[];
  how: string;
  frameRms: (number | null)[];
  /** [x, y, z, track, views, rms] per point; the world is scaled so the median depth in the first frame is 1 */
  points: number[][];
  keyframes: number[];
  stats: CameraSolve['stats'] & { ms: number; tracks: number };
}

const HOW: Record<string, string> = { bundle: 'b', resection: 'r', interpolated: 'i', held: 'h', none: 'x' };
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

export interface SolveRequest {
  projectDir: string;
  /** the file to read frames from, relative to projectDir */
  file: string;
  assetHash: string;
  fromMs: number;
  toMs: number;
  fps: number;
  width: number;
  /** horizontal field of view in degrees, as the starting value (or the fixed one) */
  focalDeg?: number;
  fixFocal?: boolean;
  log?: (m: string) => void;
  force?: boolean;
}

export function solveKey(r: Pick<SolveRequest, 'assetHash' | 'file' | 'fromMs' | 'toMs' | 'fps' | 'width' | 'focalDeg' | 'fixFocal'>): string {
  return createHash('sha256')
    .update(JSON.stringify([SOLVE_VERSION, r.assetHash, r.file, r.fromMs, r.toMs, r.fps, r.width, r.focalDeg ?? null, !!r.fixFocal]))
    .digest('hex')
    .slice(0, 20);
}
export const solveFile = (projectDir: string, key: string): string => join(projectDir, '.studio', 'cache', 'solve', `${key}.json`);

export function loadSolve(projectDir: string, key: string): SolveData | null {
  const f = solveFile(projectDir, key);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as SolveData;
  } catch {
    return null;
  }
}

/** Solves (or reads from the cache) the camera of a shot. */
export async function ensureSolve(r: SolveRequest): Promise<{ solve: SolveData; cached: boolean }> {
  const key = solveKey(r);
  if (!r.force) {
    const have = loadSolve(r.projectDir, key);
    if (have) return { solve: have, cached: true };
  }
  const log = r.log ?? (() => undefined);
  const t0 = Date.now();
  const src = join(r.projectDir, r.file);
  const info = probeVideo(src);
  const w = Math.min(r.width % 2 ? r.width + 1 : r.width, info.w);
  const h = Math.max(2, Math.round((w * info.h) / info.w / 2) * 2);
  const step = 1000 / r.fps;
  const total = Math.max(3, Math.round((r.toMs - r.fromMs) / step) + 1);
  if (total > 1500) throw new EngineError('INVALID_INPUT', `${total} frames is more than a camera solve takes (1500)`, 'solve a shorter range (--from/--to) or a lower --fps');
  async function* grays() {
    for await (const b of readFrames({ file: src, startMs: r.fromMs, durMs: Math.ceil(total * step) + 1, fps: r.fps, size: { w, h }, channels: 1 })) yield fromBytes(b, w, h, 1);
  }
  let n = 0;
  const set = await trackFeatures(grays(), { max: 400, log: (fr) => (n = fr) });
  if (set.frames > total) set.frames = total;
  log(`camera solve: ${set.tracks.length} feature tracks over ${set.frames} frames (${Date.now() - t0} ms)`);
  void n;
  let sol: CameraSolve;
  try {
    sol = solveCamera(set, {
      ...(r.focalDeg ? { focal: w / (2 * Math.tan((r.focalDeg * Math.PI) / 360)) } : {}),
      fixFocal: !!r.fixFocal,
      log,
    });
  } catch (e) {
    if (e instanceof SolveError) throw new EngineError('INVALID_INPUT', `camera solve failed: ${e.message}`, e.code === 'NO_PARALLAX' ? 'plane3d needs a camera that moves through space; for a camera that only pans use --model homography' : 'choose a range with more texture and slower motion');
    throw e;
  }
  const data: SolveData = {
    v: SOLVE_VERSION,
    key,
    fps: r.fps,
    w: set.w,
    h: set.h,
    fromMs: r.fromMs,
    frames: sol.frames,
    f: r7(sol.f),
    fInit: r7(sol.fInit),
    fixedFocal: sol.fixedFocal,
    poses: sol.poses.map((p) => (p ? [...p.R, ...p.t].map(r7) : null)),
    how: sol.how.map((x) => HOW[x]!).join(''),
    frameRms: sol.frameRms.map((v) => (Number.isFinite(v) ? r7(v) : null)),
    points: sol.points.map((p) => [...p.X.map(r7), p.track, p.views, r7(p.rms)]),
    keyframes: sol.keyframes,
    stats: { ...sol.stats, ms: Date.now() - t0, tracks: set.tracks.length },
  };
  mkdirSync(join(r.projectDir, '.studio', 'cache', 'solve'), { recursive: true });
  const file = solveFile(r.projectDir, key);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
  return { solve: data, cached: false };
}

export const poseOf = (s: SolveData, frame: number): Pose | null => {
  const p = s.poses[frame];
  return p ? { R: p.slice(0, 9) as Mat3, t: p.slice(9, 12) as Vec3 } : null;
};

// ----- a plane in the solved scene ---------------------------------------------------------------------------------------------------------

export interface ScenePlane {
  /** unit normal and offset: n . X + d = 0 in the solve's world */
  n: Vec3;
  d: number;
  /** points that were inside the region at the reference frame, and how many of them lie on the plane */
  candidates: number;
  inliers: number;
  /** rms distance of the inliers from the plane, in units where the median depth in the first frame is 1 */
  rms: number;
}

const inside = (q: Quad, x: number, y: number) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const z = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (z !== 0) {
      if (sign && Math.sign(z) !== sign) return false;
      sign = Math.sign(z);
    }
  }
  return true;
};

/** Where a solved point is in a frame (index coordinates of the analysed image). */
export function projectInto(s: SolveData, pose: Pose, X: Vec3): Pt | null {
  const q = project(s.f, pose, X);
  return q ? [q[0] + (s.w - 1) / 2, q[1] + (s.h - 1) / 2] : null;
}

/** Fits a plane to the solved points that lie inside `quad` (index coordinates) at the reference frame. */
export function fitScenePlane(s: SolveData, quad: Quad, refIndex: number): ScenePlane {
  const pose = poseOf(s, refIndex);
  if (!pose) throw new EngineError('INVALID_INPUT', 'the camera was not solved at the reference frame', 'choose another reference frame (--at) where the camera is solved');
  const pts: Vec3[] = [];
  for (const p of s.points) {
    if (p[5]! > 1.5 || p[4]! < 3) continue;
    const X: Vec3 = [p[0]!, p[1]!, p[2]!];
    const q = projectInto(s, pose, X);
    if (q && inside(quad, q[0], q[1])) pts.push(X);
  }
  if (pts.length < 6)
    throw new EngineError('INVALID_INPUT', `only ${pts.length} solved points lie inside the region at the reference frame (6 are needed to find the plane)`, 'draw a larger region on a more textured surface, or choose another reference frame (--at)');
  // the scale of "on the plane": a small fraction of how far away the region is
  const depth = pts.map((X) => rot(pose.R, X)[2] + pose.t[2]).sort((a, b) => a - b)[pts.length >> 1]!;
  const tol = 0.015 * depth;
  const R = rng(17);
  let best: { n: Vec3; d: number; count: number } | null = null;
  const planeOf = (a: Vec3, b: Vec3, c: Vec3) => {
    const u = sub3(b, a);
    const v = sub3(c, a);
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = len3(n);
    if (l < 1e-12) return null;
    const nn = scale3(n, 1 / l);
    return { n: nn, d: -dot3(nn, a) };
  };
  for (let it = 0; it < 400; it++) {
    const i = Math.floor(R() * pts.length);
    const j = Math.floor(R() * pts.length);
    const k = Math.floor(R() * pts.length);
    if (i === j || j === k || i === k) continue;
    const pl = planeOf(pts[i]!, pts[j]!, pts[k]!);
    if (!pl) continue;
    let count = 0;
    for (const X of pts) if (Math.abs(dot3(pl.n, X) + pl.d) < tol) count++;
    if (!best || count > best.count) best = { ...pl, count };
  }
  if (!best || best.count < 5) throw new EngineError('INVALID_INPUT', 'the solved points in the region do not lie on one plane', 'the region should be a flat surface (a wall, a screen, a table top); draw it tighter');
  // least squares over the inliers
  let inl = pts.filter((X) => Math.abs(dot3(best!.n, X) + best!.d) < tol);
  for (let round = 0; round < 2; round++) {
    const c = scale3(inl.reduce((m, X) => add3(m, X), [0, 0, 0] as Vec3), 1 / inl.length);
    const A = new Float64Array(Math.max(3, inl.length) * 3);
    inl.forEach((X, i) => A.set([X[0] - c[0], X[1] - c[1], X[2] - c[2]], 3 * i));
    const { V } = svd(A, Math.max(3, inl.length), 3);
    const n: Vec3 = [V[2]!, V[5]!, V[8]!]; // the direction of least spread
    const d = -dot3(n, c);
    best = { n, d, count: inl.length };
    inl = pts.filter((X) => Math.abs(dot3(n, X) + d) < tol);
  }
  const rms = Math.sqrt(inl.reduce((a, X) => a + (dot3(best!.n, X) + best!.d) ** 2, 0) / Math.max(1, inl.length));
  if (inl.length < Math.max(5, pts.length * 0.4))
    throw new EngineError('INVALID_INPUT', `only ${inl.length} of the ${pts.length} solved points in the region lie on one plane: the region is not flat enough`, 'draw it tighter around one surface');
  return { n: best.n, d: best.d, candidates: pts.length, inliers: inl.length, rms };
}

/**
 * The homography of the plane from the reference frame to every frame, in index coordinates of the analysed image (null where
 * the camera was not solved or the plane is behind it).
 */
export function planeHomographies(s: SolveData, plane: ScenePlane, quad: Quad, refIndex: number): (Mat3 | null)[] {
  const ref = poseOf(s, refIndex)!;
  const cx = (s.w - 1) / 2;
  const cy = (s.h - 1) / 2;
  const O = centerOf(ref);
  const Rt = transpose3(ref.R);
  // the quad's corners on the plane
  const world: Vec3[] = [];
  for (const [x, y] of quad) {
    const dir = rot(Rt, [(x - cx) / s.f, (y - cy) / s.f, 1]);
    const den = dot3(plane.n, dir);
    if (Math.abs(den) < 1e-9) throw new EngineError('INVALID_INPUT', 'the plane is seen edge-on at the reference frame', 'choose a reference frame that looks at the surface more squarely (--at)');
    const lam = -(dot3(plane.n, O) + plane.d) / den;
    if (lam <= 0) throw new EngineError('INVALID_INPUT', 'the plane lies behind the camera at the reference frame', 'choose another reference frame (--at)');
    world.push(add3(O, scale3(dir, lam)));
  }
  const out: (Mat3 | null)[] = [];
  for (let i = 0; i < s.frames; i++) {
    const p = poseOf(s, i);
    if (!p || s.how[i] === 'x') {
      out.push(null);
      continue;
    }
    const q = world.map((X) => projectInto(s, p, X));
    if (q.some((v) => !v)) {
      out.push(null);
      continue;
    }
    out.push(fitHomography(quad, q as Quad));
  }
  return out;
}

export { apply, inv3 };

// ----- looking at, and handing on, a solve --------------------------------------------------------------------------------------------------

/** Unit quaternion (w, x, y, z) of a rotation matrix. */
function quat(R: Mat3): [number, number, number, number] {
  const t = R[0] + R[4] + R[8];
  let q: [number, number, number, number];
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [s / 4, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s];
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    q = [(R[7] - R[5]) / s, s / 4, (R[1] + R[3]) / s, (R[2] + R[6]) / s];
  } else if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    q = [(R[2] - R[6]) / s, (R[1] + R[3]) / s, s / 4, (R[5] + R[7]) / s];
  } else {
    const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    q = [(R[3] - R[1]) / s, (R[2] + R[6]) / s, (R[5] + R[7]) / s, s / 4];
  }
  return q.map((v) => Math.round(v * 1e7) / 1e7) as [number, number, number, number];
}

/**
 * The solve as a plain document for other tools. Coordinates: x right, y down, z forward (the camera looks along +z); the world
 * is unitless and scaled so the median depth of the points in the first frame is 1. `rotation` is the camera-to-world
 * quaternion (w, x, y, z); `position` the camera centre in the world.
 */
export function cameraExport(s: SolveData) {
  return {
    format: 'studio-camera-solve/1',
    convention: 'x right, y down, z forward; world unitless, median point depth in the first frame = 1; rotation = camera-to-world quaternion (w, x, y, z)',
    image: { width: s.w, height: s.h, focalPx: s.f, horizontalFovDeg: s.stats.hfovDeg, principalPoint: [(s.w - 1) / 2, (s.h - 1) / 2] },
    fps: s.fps,
    frames: s.poses.map((p, i) => {
      const pose = poseOf(s, i);
      if (!pose || !p) return { frame: i, ms: Math.round(s.fromMs + (i * 1000) / s.fps), solved: false };
      return {
        frame: i,
        ms: Math.round(s.fromMs + (i * 1000) / s.fps),
        solved: s.how[i] === 'b' || s.how[i] === 'r',
        position: centerOf(pose).map((v) => Math.round(v * 1e6) / 1e6),
        rotation: quat(transpose3(pose.R)),
        reprojectionRmsPx: s.frameRms[i],
      };
    }),
    points: s.points.map((p) => ({ position: [p[0], p[1], p[2]], views: p[4], reprojectionRmsPx: p[5] })),
    stats: s.stats,
  };
}

/** A contact sheet of frames with the solved points drawn where the camera says they are (green = tight, yellow = loose, red = off). */
export async function solveSheet(o: { projectDir: string; file: string; solve: SolveData; out: string; count?: number }): Promise<{ file: string; frames: { frame: number; ms: number; how: string; rmsPx: number | null }[] }> {
  const s = o.solve;
  const { drawCross, tileRgb } = await import('@studio/vision');
  const { spawn } = await import('node:child_process');
  const count = Math.max(2, Math.min(12, o.count ?? 6));
  const idx = [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * (s.frames - 1)) / (count - 1))))];
  const tiles: Uint8Array[] = [];
  const rows: { frame: number; ms: number; how: string; rmsPx: number | null }[] = [];
  const step = 1000 / s.fps;
  for (const i of idx) {
    const ms = s.fromMs + i * step;
    const frame = await grabFrame(join(o.projectDir, o.file), ms, s.fps, { w: s.w, h: s.h });
    const buf = new Uint8Array(frame ?? Buffer.alloc(s.w * s.h * 3));
    const pose = poseOf(s, i);
    if (pose)
      for (const p of s.points) {
        const q = projectInto(s, pose, [p[0]!, p[1]!, p[2]!]);
        if (!q) continue;
        drawCross(buf, s.w, s.h, q, p[5]! < 0.6 ? [60, 255, 90] : p[5]! < 1.2 ? [255, 220, 0] : [255, 60, 60], 3);
      }
    tiles.push(buf);
    const h = s.how[i]!;
    rows.push({ frame: i, ms: Math.round(ms), how: h === 'b' ? 'solved' : h === 'r' ? 'placed' : h === 'i' ? 'interpolated' : h === 'h' ? 'held' : 'none', rmsPx: s.frameRms[i] ?? null });
  }
  const sheet = tileRgb(tiles, s.w, s.h, Math.min(3, tiles.length));
  mkdirSync(join(o.out, '..'), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheet.w}x${sheet.h}`, '-i', '-', '-frames:v', '1', o.out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => undefined);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new EngineError('ENGINE_FAILED', `ffmpeg could not write the sheet: ${err.trim().split('\n').pop()}`))));
    p.stdin.end(Buffer.from(sheet.data));
  });
  return { file: o.out, frames: rows };
}
