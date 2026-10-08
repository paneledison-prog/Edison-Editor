/**
 * Camera geometry for structure from motion: rotations, poses, the essential matrix, triangulation and resection.
 * Conventions: a pose maps a world point to the camera, x_cam = R X + t; the camera looks down +z, x is right, y is down.
 * Image points are in pixels relative to the principal point (centre of the image), `f` is the focal length in pixels.
 */
import { fitHomography, type Pt } from './geom.js';
import { cholSolve, mul3, nullVector, rng, svd, transpose3, type Mat3 } from './linalg.js';

export type Vec3 = [number, number, number];
export interface Pose {
  R: Mat3;
  t: Vec3;
}

export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const rot = (R: ArrayLike<number>, X: Vec3): Vec3 => [
  R[0]! * X[0] + R[1]! * X[1] + R[2]! * X[2],
  R[3]! * X[0] + R[4]! * X[1] + R[5]! * X[2],
  R[6]! * X[0] + R[7]! * X[1] + R[8]! * X[2],
];
/** The point in the camera's frame. */
export const toCam = (p: Pose, X: Vec3): Vec3 => add3(rot(p.R, X), p.t);
/** Where the camera is, in world coordinates. */
export const centerOf = (p: Pose): Vec3 => scale3(rot(transpose3(p.R), p.t), -1);
export const skew = (v: Vec3): Mat3 => [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];

/** Rodrigues: the rotation by the vector w (axis times angle). */
export function expSO3(w: Vec3): Mat3 {
  const th = len3(w);
  const K = skew(w);
  if (th < 1e-9) return [1 + 0, K[1]!, K[2]!, K[3]!, 1, K[5]!, K[6]!, K[7]!, 1];
  const a = Math.sin(th) / th;
  const b = (1 - Math.cos(th)) / (th * th);
  const K2 = mul3(K, K);
  return [1 + a * K[0]! + b * K2[0]!, a * K[1]! + b * K2[1]!, a * K[2]! + b * K2[2]!, a * K[3]! + b * K2[3]!, 1 + a * K[4]! + b * K2[4]!, a * K[5]! + b * K2[5]!, a * K[6]! + b * K2[6]!, a * K[7]! + b * K2[7]!, 1 + a * K[8]! + b * K2[8]!];
}
/** The rotation vector of a rotation matrix. */
export function logSO3(R: Mat3): Vec3 {
  const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-5) {
    // near a half turn: the axis from the diagonal
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] + R[3] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] + R[6] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const s = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * s, (R[2] - R[6]) * s, (R[3] - R[1]) * s];
}
/** The nearest rotation matrix (polar decomposition by SVD), with a positive determinant. */
export function nearestRotation(M: ArrayLike<number>): Mat3 {
  const { U, V } = svd(M, 3, 3);
  const Ut = U;
  const R = mul3(Ut, transpose3(V));
  const d = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (d < 0) {
    const U2 = Array.from(U) as number[];
    for (let i = 0; i < 3; i++) U2[i * 3 + 2] = -U2[i * 3 + 2]!;
    return mul3(U2, transpose3(V));
  }
  return R;
}
/** Angle (degrees) of the rotation taking one orientation to the other. */
export function angleBetween(a: Mat3, b: Mat3): number {
  const r = mul3(a, transpose3(b));
  return (Math.acos(Math.min(1, Math.max(-1, (r[0] + r[4] + r[8] - 1) / 2))) * 180) / Math.PI;
}

/** Pixel position (relative to the principal point) of a world point, or null when it is behind the camera. */
export function project(f: number, p: Pose, X: Vec3): Pt | null {
  const c = toCam(p, X);
  if (c[2] <= 1e-9) return null;
  return [(f * c[0]) / c[2], (f * c[1]) / c[2]];
}

// ----- two views --------------------------------------------------------------------------------------------------------------

/** Normalised 8-point estimate of the essential matrix from calibrated points (x2^T E x1 = 0); rank 2 with equal singular values. */
export function fitEssential(a: Pt[], b: Pt[], idx: number[] = a.map((_, i) => i)): Mat3 | null {
  if (idx.length < 8) return null;
  const A = new Float64Array(Math.max(9, idx.length) * 9);
  idx.forEach((i, k) => {
    const [x1, y1] = a[i]!;
    const [x2, y2] = b[i]!;
    A.set([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1], 9 * k);
  });
  const e = nullVector(A, Math.max(9, idx.length), 9);
  const { U, S, V } = svd(Array.from(e), 3, 3);
  const s = (S[0]! + S[1]!) / 2;
  const D: Mat3 = [s, 0, 0, 0, s, 0, 0, 0, 0];
  return mul3(mul3(U, D), transpose3(V));
}
/** Sampson distance (squared, in the units of the calibrated points) of a match from an essential matrix. */
export function sampson(E: Mat3, p: Pt, q: Pt): number {
  const Ex = [E[0] * p[0] + E[1] * p[1] + E[2], E[3] * p[0] + E[4] * p[1] + E[5], E[6] * p[0] + E[7] * p[1] + E[8]];
  const Etx = [E[0] * q[0] + E[3] * q[1] + E[6], E[1] * q[0] + E[4] * q[1] + E[7]];
  const num = q[0] * Ex[0]! + q[1] * Ex[1]! + Ex[2]!;
  const den = Ex[0]! ** 2 + Ex[1]! ** 2 + Etx[0]! ** 2 + Etx[1]! ** 2;
  return den > 1e-18 ? (num * num) / den : Infinity;
}
export interface EssentialFit {
  E: Mat3;
  inliers: Uint8Array;
  count: number;
}
/** RANSAC over calibrated matches; `thresh` is in the units of the points (pixels divided by the focal length). */
export function ransacEssential(a: Pt[], b: Pt[], o: { thresh: number; iters?: number; seed?: number }): EssentialFit | null {
  const n = a.length;
  if (n < 12) return null;
  const R = rng(o.seed ?? 3);
  const t2 = o.thresh * o.thresh;
  let best: { E: Mat3; count: number } | null = null;
  for (let it = 0; it < (o.iters ?? 400); it++) {
    const pick = new Set<number>();
    while (pick.size < 8) pick.add(Math.floor(R() * n));
    const E = fitEssential(a, b, [...pick]);
    if (!E) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (sampson(E, a[i]!, b[i]!) <= t2) count++;
    if (!best || count > best.count) best = { E, count };
  }
  if (!best || best.count < 12) return null;
  let E = best.E;
  for (let round = 0; round < 3; round++) {
    const inl: number[] = [];
    for (let i = 0; i < n; i++) if (sampson(E, a[i]!, b[i]!) <= t2) inl.push(i);
    if (inl.length < 12) break;
    const E2 = fitEssential(a, b, inl);
    if (!E2) break;
    E = E2;
  }
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++)
    if (sampson(E, a[i]!, b[i]!) <= t2) {
      mask[i] = 1;
      count++;
    }
  return { E, inliers: mask, count };
}
/** The four (R, t) that an essential matrix allows, with |t| = 1: x2 = R x1 + t up to scale. */
export function decomposeEssential(E: Mat3): Pose[] {
  const { U, V } = svd(E, 3, 3);
  const det = (M: ArrayLike<number>) => M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) - M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) + M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
  const U2 = Array.from(U) as number[];
  const V2 = Array.from(V) as number[];
  if (det(U2) < 0) for (let i = 0; i < 3; i++) U2[i * 3 + 2] = -U2[i * 3 + 2]!;
  if (det(V2) < 0) for (let i = 0; i < 3; i++) V2[i * 3 + 2] = -V2[i * 3 + 2]!;
  const W: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const R1 = mul3(mul3(U2, W), transpose3(V2));
  const R2 = mul3(mul3(U2, transpose3(W)), transpose3(V2));
  const t: Vec3 = [U2[2]!, U2[5]!, U2[8]!];
  return [
    { R: R1, t },
    { R: R1, t: scale3(t, -1) },
    { R: R2, t },
    { R: R2, t: scale3(t, -1) },
  ];
}

/** The point seen by several views (calibrated image points), by the linear method; null when it is not determined. */
export function triangulate(poses: Pose[], xs: Pt[]): Vec3 | null {
  const n = poses.length;
  if (n < 2) return null;
  const A = new Float64Array(Math.max(4, 2 * n) * 4);
  for (let k = 0; k < n; k++) {
    const { R, t } = poses[k]!;
    const [x, y] = xs[k]!;
    for (let c = 0; c < 3; c++) {
      A[8 * k + c] = x * R[6 + c]! - R[c]!;
      A[8 * k + 4 + c] = y * R[6 + c]! - R[3 + c]!;
    }
    A[8 * k + 3] = x * t[2] - t[0];
    A[8 * k + 7] = y * t[2] - t[1];
  }
  const v = nullVector(A, Math.max(4, 2 * n), 4);
  if (Math.abs(v[3]!) < 1e-12) return null;
  return [v[0]! / v[3]!, v[1]! / v[3]!, v[2]! / v[3]!];
}
/** The angle (degrees) between the rays from two camera centres to a point. */
export function rayAngle(c1: Vec3, c2: Vec3, X: Vec3): number {
  const a = sub3(X, c1);
  const b = sub3(X, c2);
  const d = dot3(a, b) / Math.max(1e-18, len3(a) * len3(b));
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
}

// ----- one view of known points -------------------------------------------------------------------------------------------------

/** Pose from at least six 3D-2D matches by the direct linear transform (calibrated points); null when degenerate or behind. */
export function resect(X: Vec3[], x: Pt[], idx: number[]): Pose | null {
  if (idx.length < 6) return null;
  const A = new Float64Array(Math.max(12, 2 * idx.length) * 12);
  idx.forEach((i, k) => {
    const [Xw, Yw, Zw] = X[i]!;
    const [u, v] = x[i]!;
    A.set([Xw, Yw, Zw, 1, 0, 0, 0, 0, -u * Xw, -u * Yw, -u * Zw, -u], 24 * k);
    A.set([0, 0, 0, 0, Xw, Yw, Zw, 1, -v * Xw, -v * Yw, -v * Zw, -v], 24 * k + 12);
  });
  const p = nullVector(A, Math.max(12, 2 * idx.length), 12);
  let M = [p[0]!, p[1]!, p[2]!, p[4]!, p[5]!, p[6]!, p[8]!, p[9]!, p[10]!];
  let t = [p[3]!, p[7]!, p[11]!];
  const d = M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) - M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) + M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
  if (d < 0) {
    M = M.map((v) => -v);
    t = t.map((v) => -v);
  }
  const { S } = svd(M, 3, 3);
  const s = (S[0]! + S[1]! + S[2]!) / 3;
  if (!(s > 1e-12) || S[2]! / S[0]! < 1e-3) return null;
  const R = nearestRotation(M);
  const pose: Pose = { R, t: [t[0]! / s, t[1]! / s, t[2]! / s] };
  let front = 0;
  for (const i of idx) if (toCam(pose, X[i]!)[2] > 0) front++;
  return front >= idx.length * 0.8 ? pose : null;
}

/** The homography of a plane between two views: fits the four projected corners (calibrated or pixel points alike). */
export const planeHomography = (a: [Pt, Pt, Pt, Pt], b: [Pt, Pt, Pt, Pt]): Mat3 | null => fitHomography(a, b);

/** The similarity (scale, rotation, translation) that best takes `src` onto `dst` in least squares (Umeyama): dst ~ s R src + t. */
export function similarityAlign(src: Vec3[], dst: Vec3[]): { s: number; R: Mat3; t: Vec3 } {
  const n = src.length;
  const mean = (a: Vec3[]): Vec3 => scale3(a.reduce((m, p) => add3(m, p), [0, 0, 0] as Vec3), 1 / n);
  const ms = mean(src);
  const md = mean(dst);
  const C = new Float64Array(9);
  let vs = 0;
  for (let i = 0; i < n; i++) {
    const a = sub3(src[i]!, ms);
    const b = sub3(dst[i]!, md);
    vs += dot3(a, a);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = C[r * 3 + c]! + b[r]! * a[c]!;
  }
  for (let i = 0; i < 9; i++) C[i] = C[i]! / n;
  vs /= n;
  const { U, S, V } = svd(C, 3, 3);
  const det3 = (M: ArrayLike<number>) => M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) - M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) + M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
  const d = Math.sign(det3(U) * det3(V)) || 1;
  const D: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, d];
  const R = mul3(mul3(U, D), transpose3(V));
  const s = (S[0]! + S[1]! + S[2]! * d) / Math.max(1e-18, vs);
  const t = sub3(md, scale3(rot(R, ms), s));
  return { s, R, t };
}

/**
 * Refines a pose against known points by Gauss-Newton with a Huber loss: `pts` are 3D points and `obs` their pixel positions
 * (relative to the principal point). Returns the pose and the rms reprojection error of the points within `inlier` px.
 */
export function refinePose(pose: Pose, f: number, pts: Vec3[], obs: Pt[], o: { iters?: number; huber?: number; inlier?: number } = {}): { pose: Pose; rms: number; inliers: number } {
  const huber = o.huber ?? 2;
  let cur = { R: pose.R.slice() as Mat3, t: pose.t.slice() as Vec3 };
  const evalCost = (p: Pose) => {
    let c = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = project(f, p, pts[i]!);
      const r = q ? Math.hypot(q[0] - obs[i]![0], q[1] - obs[i]![1]) : 1e3;
      c += r <= huber ? 0.5 * r * r : huber * (r - 0.5 * huber);
    }
    return c;
  };
  let cost = evalCost(cur);
  let lambda = 1e-3;
  for (let it = 0; it < (o.iters ?? 15); it++) {
    const H = new Float64Array(36);
    const g = new Float64Array(6);
    for (let i = 0; i < pts.length; i++) {
      const v = rot(cur.R, pts[i]!);
      const xc = v[0] + cur.t[0];
      const yc = v[1] + cur.t[1];
      const zc = v[2] + cur.t[2];
      if (zc <= 1e-6) continue;
      const iz = 1 / zc;
      const ru = f * xc * iz - obs[i]![0];
      const rv = f * yc * iz - obs[i]![1];
      const r = Math.hypot(ru, rv);
      const w = r <= huber ? 1 : huber / r;
      const a = f * iz;
      const j02 = -a * xc * iz;
      const j12 = -a * yc * iz;
      const J: number[][] = [[], []];
      // rows of the Jacobian with respect to (theta_x, theta_y, theta_z, t_x, t_y, t_z)
      J[0] = [j02 * v[1], a * v[2] - j02 * v[0], -a * v[1], a, 0, j02];
      J[1] = [-a * v[2] + j12 * v[1], -j12 * v[0], a * v[0], 0, a, j12];
      for (let p = 0; p < 6; p++) {
        g[p] = g[p]! - w * (J[0]![p]! * ru + J[1]![p]! * rv);
        for (let q = 0; q < 6; q++) H[p * 6 + q] = H[p * 6 + q]! + w * (J[0]![p]! * J[0]![q]! + J[1]![p]! * J[1]![q]!);
      }
    }
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      const A = Float64Array.from(H);
      for (let p = 0; p < 6; p++) A[p * 6 + p] = A[p * 6 + p]! * (1 + lambda) + 1e-9;
      const d = cholSolve(A, g, 6);
      if (!d) {
        lambda *= 10;
        continue;
      }
      const cand: Pose = { R: mul3(expSO3([d[0]!, d[1]!, d[2]!]), cur.R), t: [cur.t[0] + d[3]!, cur.t[1] + d[4]!, cur.t[2] + d[5]!] };
      const c2 = evalCost(cand);
      if (c2 < cost) {
        const rel = (cost - c2) / Math.max(1e-12, cost);
        cur = cand;
        cost = c2;
        lambda = Math.max(1e-9, lambda / 3);
        ok = true;
        if (rel < 1e-8) it = 1e9;
      } else lambda *= 4;
    }
    if (!ok) break;
  }
  let sq = 0;
  let n = 0;
  const lim = o.inlier ?? 3;
  for (let i = 0; i < pts.length; i++) {
    const q = project(f, cur, pts[i]!);
    if (!q) continue;
    const r = Math.hypot(q[0] - obs[i]![0], q[1] - obs[i]![1]);
    if (r <= lim) (sq += r * r, n++);
  }
  return { pose: cur, rms: n ? Math.sqrt(sq / n) : Infinity, inliers: n };
}
