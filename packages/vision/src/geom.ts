/** Fitting motion models to point matches: translation, similarity, affine, homography, and the RANSAC around them. */
import { apply, inv3, lstsq, mul3, nullVector, rng, type Mat3 } from './linalg.js';

export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt]; // clockwise from the top left

export type MotionKind = 'translation' | 'similarity' | 'affine' | 'homography';

/** Hartley normalisation: moves the centroid to the origin and scales the mean distance to sqrt 2. */
function normaliser(p: Pt[], idx: number[]): Mat3 {
  let cx = 0;
  let cy = 0;
  for (const i of idx) {
    cx += p[i]![0];
    cy += p[i]![1];
  }
  cx /= idx.length;
  cy /= idx.length;
  let d = 0;
  for (const i of idx) d += Math.hypot(p[i]![0] - cx, p[i]![1] - cy);
  d /= idx.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Direct linear transform with normalisation over the matches `idx` (at least four). Returns H with H[8] = 1, or null. */
export function fitHomography(p: Pt[], q: Pt[], idx: number[] = p.map((_, i) => i)): Mat3 | null {
  if (idx.length < 4) return null;
  const Tp = normaliser(p, idx);
  const Tq = normaliser(q, idx);
  const A = new Float64Array(Math.max(2 * idx.length, 9) * 9);
  idx.forEach((i, k) => {
    const [x, y] = apply(Tp, p[i]![0], p[i]![1]);
    const [u, v] = apply(Tq, q[i]![0], q[i]![1]);
    A.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u], 18 * k);
    A.set([0, 0, 0, -x, -y, -1, v * x, v * y, v], 18 * k + 9);
  });
  const h = nullVector(A, Math.max(2 * idx.length, 9), 9);
  const Hn = Array.from(h) as Mat3;
  const Tqi = inv3(Tq);
  if (!Tqi) return null;
  const H = mul3(mul3(Tqi, Hn), Tp);
  if (!Number.isFinite(H[8]) || Math.abs(H[8]) < 1e-12) return null;
  return H.map((v) => v / H[8]) as Mat3;
}

export function fitAffine(p: Pt[], q: Pt[], idx: number[] = p.map((_, i) => i)): Mat3 | null {
  if (idx.length < 3) return null;
  const A = new Float64Array(2 * idx.length * 6);
  const b = new Float64Array(2 * idx.length);
  idx.forEach((i, k) => {
    A.set([p[i]![0], p[i]![1], 1, 0, 0, 0], 12 * k);
    A.set([0, 0, 0, p[i]![0], p[i]![1], 1], 12 * k + 6);
    b[2 * k] = q[i]![0];
    b[2 * k + 1] = q[i]![1];
  });
  const x = lstsq(A, b, 2 * idx.length, 6);
  return x ? [x[0]!, x[1]!, x[2]!, x[3]!, x[4]!, x[5]!, 0, 0, 1] : null;
}

/** Rotation, uniform scale and translation (4 degrees of freedom). */
export function fitSimilarity(p: Pt[], q: Pt[], idx: number[] = p.map((_, i) => i)): Mat3 | null {
  if (idx.length < 2) return null;
  const A = new Float64Array(2 * idx.length * 4);
  const b = new Float64Array(2 * idx.length);
  idx.forEach((i, k) => {
    A.set([p[i]![0], -p[i]![1], 1, 0], 8 * k);
    A.set([p[i]![1], p[i]![0], 0, 1], 8 * k + 4);
    b[2 * k] = q[i]![0];
    b[2 * k + 1] = q[i]![1];
  });
  const x = lstsq(A, b, 2 * idx.length, 4);
  return x ? [x[0]!, -x[1]!, x[2]!, x[1]!, x[0]!, x[3]!, 0, 0, 1] : null;
}

export function fitTranslation(p: Pt[], q: Pt[], idx: number[] = p.map((_, i) => i)): Mat3 | null {
  if (!idx.length) return null;
  let dx = 0;
  let dy = 0;
  for (const i of idx) {
    dx += q[i]![0] - p[i]![0];
    dy += q[i]![1] - p[i]![1];
  }
  return [1, 0, dx / idx.length, 0, 1, dy / idx.length, 0, 0, 1];
}

export const MIN_POINTS: Record<MotionKind, number> = { translation: 1, similarity: 2, affine: 3, homography: 4 };
export function fitModel(kind: MotionKind, p: Pt[], q: Pt[], idx?: number[]): Mat3 | null {
  return kind === 'homography' ? fitHomography(p, q, idx) : kind === 'affine' ? fitAffine(p, q, idx) : kind === 'similarity' ? fitSimilarity(p, q, idx) : fitTranslation(p, q, idx);
}

export interface Fit {
  H: Mat3;
  inliers: Uint8Array;
  count: number;
  /** root mean square of the inliers' error, in the units of the points */
  rms: number;
}

/**
 * RANSAC over matches p[i] -> q[i]: random minimal samples, the model with the most points within `thresh`, refitted on all
 * of them (twice). Deterministic for a given seed. Returns null when no model gets more than the minimal sample.
 */
export function ransac(kind: MotionKind, p: Pt[], q: Pt[], o: { thresh?: number; iters?: number; seed?: number; confidence?: number } = {}): Fit | null {
  const n = p.length;
  const s = MIN_POINTS[kind];
  if (n < s) return null;
  const thresh = o.thresh ?? 2;
  const maxIters = o.iters ?? 500;
  const R = rng(o.seed ?? 1);
  const err = (H: Mat3, i: number) => {
    const [x, y] = apply(H, p[i]![0], p[i]![1]);
    return Math.hypot(x - q[i]![0], y - q[i]![1]);
  };
  let best: { H: Mat3; count: number } | null = null;
  let need = maxIters;
  for (let it = 0; it < Math.min(need, maxIters); it++) {
    const pick = new Set<number>();
    while (pick.size < s) pick.add(Math.floor(R() * n));
    const H = fitModel(kind, p, q, [...pick]);
    if (!H) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (err(H, i) <= thresh) count++;
    if (!best || count > best.count) {
      best = { H, count };
      const w = count / n;
      const conf = o.confidence ?? 0.999;
      need = w >= 1 ? it + 1 : Math.ceil(Math.log(1 - conf) / Math.log(Math.max(1e-9, 1 - Math.pow(w, s))));
    }
  }
  if (!best || best.count < Math.max(s, 3)) return null;
  let H = best.H;
  let inl: number[] = [];
  for (let round = 0; round < 3; round++) {
    inl = [];
    for (let i = 0; i < n; i++) if (err(H, i) <= thresh) inl.push(i);
    if (inl.length < s) break;
    const refit = fitModel(kind, p, q, inl);
    if (!refit) break;
    H = refit;
  }
  inl = [];
  let sq = 0;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = err(H, i);
    if (e <= thresh) {
      inl.push(i);
      mask[i] = 1;
      sq += e * e;
    }
  }
  if (inl.length < s) return null;
  return { H, inliers: mask, count: inl.length, rms: Math.sqrt(sq / inl.length) };
}

/** The homography that maps quad a onto quad b. */
export function quadHomography(a: Quad, b: Quad): Mat3 | null {
  return fitHomography(a, b);
}

/** Image corners of a width x height frame as a quad. */
export const frameQuad = (w: number, h: number): Quad => [[0, 0], [w, 0], [w, h], [0, h]];

/** Splits a homography that is close to a similarity into rotation (rad), scale and translation, for smoothing paths. */
export function decomposeSimilarity(H: Mat3): { rot: number; scale: number; tx: number; ty: number } {
  const a = H[0];
  const b = H[3];
  return { rot: Math.atan2(b, a), scale: Math.hypot(a, b), tx: H[2], ty: H[5] };
}
export function composeSimilarity(rot: number, scale: number, tx: number, ty: number): Mat3 {
  const c = Math.cos(rot) * scale;
  const s = Math.sin(rot) * scale;
  return [c, -s, tx, s, c, ty, 0, 0, 1];
}
