/**
 * Planar tracking: where a flat region of a reference frame goes in every other frame, as a homography per frame.
 *
 * Two stages per frame. First the region's corner features are followed from the previous frame (Lucas-Kanade with a
 * forward-backward check), and a robust fit (RANSAC) of reference positions to current positions gives the motion even when
 * something moves in front of the region. Then that estimate is refined by aligning the reference image itself to the current
 * frame (Gauss-Newton on the 8 homography parameters, robust to occlusion by down-weighting large residuals), which removes the
 * drift that following points frame to frame would add up. When the refinement cannot match (the picture changed too much), the
 * feature estimate stands and the frame is marked as not refined.
 */
import { cornerPoints, detectCorners } from './features.js';
import { buildPyr, trackChecked, type Pyr } from './flow.js';
import { fitModel, ransac, type MotionKind, type Pt, type Quad } from './geom.js';
import { bilinear, gradients, type Gray } from './image.js';
import { apply, inv3, mul3, solve, type Mat3, I3 } from './linalg.js';

export interface PlanarFrame {
  /** maps reference-frame coordinates to this frame's (analysis pixels); null before the first estimate */
  H: Mat3 | null;
  ok: boolean;
  /** feature matches the fit agreed with */
  inliers: number;
  /** their rms error (px) */
  rms: number;
  /** the direct alignment was used for this frame */
  refined: boolean;
  /** mean absolute difference between the reference patch and this frame through H (0..1), when refined */
  resid?: number;
}

export interface PlanarOptions {
  model: MotionKind;
  /** run the direct alignment against the reference image */
  refine: boolean;
  maxPoints?: number;
  minPoints?: number;
  /** pixels to leave out of the region (something that moves in front of it): for the reference (`-1`) and for each later frame, by its index in `frames` */
  exclude?: (i: number) => Uint8Array | undefined;
}

/** Marks the pixels inside a convex quad (analysis pixels). */
export function quadMask(w: number, h: number, q: Quad): Uint8Array {
  const m = new Uint8Array(w * h);
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z !== 0) sign = Math.sign(z);
  }
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let inside = true;
      for (let i = 0; i < 4 && inside; i++) {
        const a = q[i]!;
        const b = q[(i + 1) % 4]!;
        const z = (b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0]);
        if (z * sign < 0) inside = false;
      }
      if (inside) m[y * w + x] = 1;
    }
  return m;
}

/** The quad's corners moved through a homography. */
export const warpQuad = (q: Quad, H: Mat3): Quad => q.map((p) => apply(H, p[0], p[1])) as Quad;

/** Template samples: pixel positions inside the quad (on a stride so there are at most `cap`), with the reference intensities. */
interface Template {
  x: Float32Array;
  y: Float32Array;
  t: Float32Array;
  n: number;
  /** normalisation of coordinates for a well-conditioned solve */
  cx: number;
  cy: number;
  s: number;
}
function makeTemplate(ref: Gray, mask: Uint8Array, cap = 9000): Template {
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i]!;
  const stride = Math.max(1, Math.round(Math.sqrt(area / cap)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < ref.h; y += stride) for (let x = 0; x < ref.w; x += stride) if (mask[y * ref.w + x]) (xs.push(x), ys.push(y));
  const n = xs.length;
  const t = new Float32Array(n);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    t[i] = bilinear(ref.d, ref.w, ref.h, xs[i]!, ys[i]!);
    cx += xs[i]!;
    cy += ys[i]!;
  }
  cx /= Math.max(1, n);
  cy /= Math.max(1, n);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  return { x: Float32Array.from(xs), y: Float32Array.from(ys), t, n, cx, cy, s: span / 2 };
}

/**
 * Aligns the template to the current image starting from H0 (reference -> current). Gauss-Newton with Levenberg damping on
 * the normalised homography, intensity offset removed, and a Tukey biweight so pixels that do not belong to the plane (an
 * object passing in front) get no say at all. The scale of "does not belong" comes from the residuals at the start, where
 * H0 is already close. Returns null when it does not reach a better match or too little of the region agrees.
 */
function refine(T: Template, img: Gray, gx: Float32Array, gy: Float32Array, H0: Mat3): { H: Mat3; resid: number } | null {
  const { cx, cy, s } = T;
  const N: Mat3 = [1 / s, 0, -cx / s, 0, 1 / s, -cy / s, 0, 0, 1];
  const Ni = inv3(N)!;
  const H3 = (h: Mat3): Mat3 => mul3(mul3(Ni, h), N); // normalised parameters -> template pixels to image pixels
  let Hn = mul3(mul3(N, H0), Ni);
  Hn = Hn.map((v) => v / Hn[8]) as Mat3;
  const n = T.n;
  /** brightness offset between the frame and the reference: the median, so an object covering part of the region does not shift it */
  const offsetOf = (d: Float32Array): number => Float32Array.from(d).sort()[n >> 1]!;
  const resid = (H: Mat3): Float32Array => {
    const Hi = H3(H);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = Hi[6]! * T.x[i]! + Hi[7]! * T.y[i]! + Hi[8]!;
      r[i] = bilinear(img.d, img.w, img.h, (Hi[0]! * T.x[i]! + Hi[1]! * T.y[i]! + Hi[2]!) / w, (Hi[3]! * T.x[i]! + Hi[4]! * T.y[i]! + Hi[5]!) / w) - T.t[i]!;
    }
    const m = offsetOf(r);
    for (let i = 0; i < n; i++) r[i] = r[i]! - m;
    return r;
  };
  const scaleOf = (r: Float32Array) => {
    const a = Float32Array.from(r, Math.abs).sort();
    return Math.max(0.012, a[n >> 1]! * 1.4826);
  };
  const r0 = resid(Hn);
  const sigma = scaleOf(r0);
  const cap = 4.685 * sigma;
  // truncated absolute error: what the alignment is judged by
  const robustCost = (r: Float32Array) => {
    let c = 0;
    let inl = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(r[i]!);
      if (a < cap) {
        c += a;
        inl++;
      } else c += cap;
    }
    return { cost: c / n, inl: inl / n };
  };
  const start = robustCost(r0);
  if (start.inl < 0.35) return null; // most of the region is not the plane any more
  let cur = start.cost;
  let lambda = 1e-3;
  const J = new Float64Array(8);
  for (let it = 0; it < 25; it++) {
    const Hi = H3(Hn);
    const r = new Float32Array(n);
    const gxs = new Float32Array(n);
    const gys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = Hi[6]! * T.x[i]! + Hi[7]! * T.y[i]! + Hi[8]!;
      const qx = (Hi[0]! * T.x[i]! + Hi[1]! * T.y[i]! + Hi[2]!) / w;
      const qy = (Hi[3]! * T.x[i]! + Hi[4]! * T.y[i]! + Hi[5]!) / w;
      r[i] = bilinear(img.d, img.w, img.h, qx, qy) - T.t[i]!;
      gxs[i] = bilinear(gx, img.w, img.h, qx, qy);
      gys[i] = bilinear(gy, img.w, img.h, qx, qy);
    }
    const mI = offsetOf(r);
    for (let i = 0; i < n; i++) r[i] = r[i]! - mI;
    const JtJ = new Float64Array(64);
    const Jtr = new Float64Array(8);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(r[i]!) / cap;
      if (a >= 1) continue; // an outlier: no weight
      const wgt = (1 - a * a) ** 2;
      const xn = (T.x[i]! - cx) / s;
      const yn = (T.y[i]! - cy) / s;
      const w = Hn[6]! * xn + Hn[7]! * yn + 1;
      const qxn = (Hn[0]! * xn + Hn[1]! * yn + Hn[2]!) / w;
      const qyn = (Hn[3]! * xn + Hn[4]! * yn + Hn[5]!) / w;
      const ix = gxs[i]! * s;
      const iy = gys[i]! * s;
      const k = 1 / w;
      J[0] = ix * k * xn;
      J[1] = ix * k * yn;
      J[2] = ix * k;
      J[3] = iy * k * xn;
      J[4] = iy * k * yn;
      J[5] = iy * k;
      J[6] = -k * (ix * qxn + iy * qyn) * xn;
      J[7] = -k * (ix * qxn + iy * qyn) * yn;
      for (let p = 0; p < 8; p++) {
        Jtr[p] = Jtr[p]! + wgt * J[p]! * r[i]!;
        for (let q = p; q < 8; q++) JtJ[p * 8 + q] = JtJ[p * 8 + q]! + wgt * J[p]! * J[q]!;
      }
    }
    for (let p = 0; p < 8; p++) for (let q = 0; q < p; q++) JtJ[p * 8 + q] = JtJ[q * 8 + p]!;
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = Float64Array.from(JtJ);
      for (let p = 0; p < 8; p++) A[p * 8 + p] = A[p * 8 + p]! * (1 + lambda) + 1e-9;
      const d = solve(A, Float64Array.from(Jtr, (v) => -v), 8);
      if (!d) {
        lambda *= 10;
        continue;
      }
      const cand = Hn.slice() as Mat3;
      for (let p = 0; p < 8; p++) cand[p] = cand[p]! + d[p]!;
      const c = robustCost(resid(cand)).cost;
      if (c < cur) {
        Hn = cand;
        cur = c;
        lambda = Math.max(1e-7, lambda / 5);
        improved = true;
        if (Math.hypot(...d) < 1e-6) it = 99;
      } else lambda *= 8;
    }
    if (!improved) break;
  }
  if (!(cur < start.cost)) return null;
  const H = H3(Hn);
  return { H: H.map((v) => v / H[8]) as Mat3, resid: cur };
}

/**
 * Follows a planar region through `frames` (the frames after the reference, in the direction of tracking, one at a time).
 * `ref` is the reference frame the quad is drawn on. Yields one result per frame.
 */
export async function* trackPlane(ref: Gray, quad: Quad, frames: AsyncIterable<Gray> | Iterable<Gray>, o: PlanarOptions): AsyncGenerator<PlanarFrame> {
  const { w, h } = ref;
  const maxPts = o.maxPoints ?? 140;
  const minPts = o.minPoints ?? 10;
  const mask = quadMask(w, h, quad);
  const ex0 = o.exclude?.(-1);
  if (ex0) for (let i = 0; i < mask.length; i++) if (ex0[i]) mask[i] = 0;
  let frameNo = -1;
  const seeds = detectCorners(ref, { max: maxPts, minDist: Math.max(4, Math.round(Math.min(w, h) / 40)), border: 10, mask });
  let pref: Pt[] = cornerPoints(seeds);
  let pcur: Pt[] = pref.map((p) => [p[0], p[1]]);
  const T = makeTemplate(ref, mask);
  let prev: Pyr = buildPyr(ref, 4, true);
  let H: Mat3 = I3;
  let Hprev: Mat3 = I3;
  let lastRefined = 0;
  let sinceRedetect = 0;
  for await (const img of frames as AsyncIterable<Gray>) {
    frameNo++;
    const cur = buildPyr(img, 4, false);
    // predicted positions: assume the camera keeps moving as it just did
    const step = mul3(H, inv3(Hprev) ?? I3);
    const guess = pcur.map((p) => apply(step, p[0], p[1]) as Pt);
    const tr = pcur.length ? trackChecked(prev, cur, pcur, { guess }) : [];
    const keep: number[] = [];
    tr.forEach((t, i) => t.ok && keep.push(i));
    const P = keep.map((i) => pref[i]!);
    const Q = keep.map((i) => [tr[i]!.x, tr[i]!.y] as Pt);
    let fit = P.length >= Math.max(minPts, 4) ? ransac(o.model, P, Q, { thresh: 1.5, seed: 7 }) : null;
    let ok = !!fit && fit.count >= minPts;
    let Hn: Mat3 = ok ? fit!.H : H;
    let refined = false;
    let resid: number | undefined;
    if (ok && o.refine) {
      const g = gradients(img);
      const r = refine(T, img, g.gx, g.gy, Hn);
      if (r && r.resid < 0.12) {
        // accept only when the alignment stays near the feature estimate: a wild jump is a wrong match, not a better one
        const q0 = warpQuad(quad, Hn);
        const q1 = warpQuad(quad, r.H);
        const jump = Math.max(...q0.map((p, i) => Math.hypot(p[0] - q1[i]![0], p[1] - q1[i]![1])));
        if (jump < 1.5) {
          Hn = r.H;
          refined = true;
          resid = r.resid;
          lastRefined = 0;
        }
      }
    }
    if (!refined) lastRefined++;
    if (!ok) {
      // lost: carry the last motion forward and look for the region again around where it should be
      Hn = H;
    }
    // points that agreed with the fit stay; the rest are dropped
    const nextRef: Pt[] = [];
    const nextCur: Pt[] = [];
    if (ok && fit) {
      keep.forEach((i, k) => {
        if (fit!.inliers[k]) {
          nextRef.push(pref[i]!);
          nextCur.push([tr[i]!.x, tr[i]!.y]);
        }
      });
    }
    sinceRedetect++;
    // top up with fresh features inside the (moved) region, anchored to the reference through the current estimate
    if (nextCur.length < maxPts * 0.7 || sinceRedetect >= 20 || !ok) {
      const q = warpQuad(quad, Hn);
      const m2 = quadMask(w, h, q);
      const exn = o.exclude?.(frameNo);
      if (exn) for (let i = 0; i < m2.length; i++) if (exn[i]) m2[i] = 0;
      const fresh = detectCorners(img, { max: maxPts, minDist: Math.max(4, Math.round(Math.min(w, h) / 40)), border: 10, mask: m2 });
      const Hi = inv3(Hn);
      const minD = Math.max(4, Math.round(Math.min(w, h) / 40));
      if (Hi)
        for (const c of fresh) {
          if (nextCur.length >= maxPts) break;
          if (nextCur.some((p) => Math.hypot(p[0] - c.x, p[1] - c.y) < minD)) continue;
          nextCur.push([c.x, c.y]);
          nextRef.push(apply(Hi, c.x, c.y));
        }
      sinceRedetect = 0;
    }
    // when the direct alignment worked, tie the points to it: their reference positions follow from the refined motion
    if (refined) {
      const Hi = inv3(Hn);
      if (Hi) for (let i = 0; i < nextCur.length; i++) nextRef[i] = apply(Hi, nextCur[i]![0], nextCur[i]![1]);
    }
    pref = nextRef;
    pcur = nextCur;
    Hprev = H;
    H = Hn;
    prev = buildPyr(img, 4, true);
    yield { H: ok ? Hn : null, ok, inliers: fit?.count ?? 0, rms: fit?.rms ?? 0, refined, ...(resid !== undefined ? { resid } : {}) };
    void lastRefined;
    fit = null;
  }
}
