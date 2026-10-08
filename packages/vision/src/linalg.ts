/**
 * Small dense linear algebra, in plain typed arrays: enough for homographies, the essential matrix, resection and the
 * least-squares steps of the trackers. Row-major everywhere. Nothing here allocates per element in an inner loop.
 */

/** One-sided Jacobi SVD of an m x n matrix (m >= n): A = U diag(S) V^T. Singular values come back sorted, largest first. */
export function svd(A: ArrayLike<number>, m: number, n: number): { U: Float64Array; S: Float64Array; V: Float64Array } {
  if (m < n) throw new Error('svd needs at least as many rows as columns (pad with zero rows)');
  const U = Float64Array.from(A as ArrayLike<number>); // columns get orthogonalised in place
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let i = 0; i < m; i++) {
          const up = U[i * n + p]!;
          const uq = U[i * n + q]!;
          alpha += up * up;
          beta += uq * uq;
          gamma += up * uq;
        }
        if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta));
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < m; i++) {
          const up = U[i * n + p]!;
          const uq = U[i * n + q]!;
          U[i * n + p] = c * up - s * uq;
          U[i * n + q] = s * up + c * uq;
        }
        for (let i = 0; i < n; i++) {
          const vp = V[i * n + p]!;
          const vq = V[i * n + q]!;
          V[i * n + p] = c * vp - s * vq;
          V[i * n + q] = s * vp + c * vq;
        }
      }
    }
    if (off < 1e-14) break;
  }
  const S = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += U[i * n + j]! ** 2;
    S[j] = Math.sqrt(s);
    if (S[j]! > 1e-300) for (let i = 0; i < m; i++) U[i * n + j] = U[i * n + j]! / S[j]!;
  }
  // sort descending
  const order = [...Array(n).keys()].sort((a, b) => S[b]! - S[a]!);
  const U2 = new Float64Array(m * n);
  const V2 = new Float64Array(n * n);
  const S2 = new Float64Array(n);
  order.forEach((src, dst) => {
    S2[dst] = S[src]!;
    for (let i = 0; i < m; i++) U2[i * n + dst] = U[i * n + src]!;
    for (let i = 0; i < n; i++) V2[i * n + dst] = V[i * n + src]!;
  });
  return { U: U2, S: S2, V: V2 };
}

/** The right singular vector of the smallest singular value of an m x n matrix (the null-space direction of A x = 0). */
export function nullVector(A: ArrayLike<number>, m: number, n: number): Float64Array {
  let M = A as ArrayLike<number>;
  let rows = m;
  if (m < n) {
    const P = new Float64Array(n * n);
    P.set(Array.from(A as ArrayLike<number>));
    M = P;
    rows = n;
  }
  const { V } = svd(M, rows, n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = V[i * n + (n - 1)]!;
  return v;
}

/** Solves A x = b for a square system by Gaussian elimination with partial pivoting. Returns null when singular. */
export function solve(A: ArrayLike<number>, b: ArrayLike<number>, n: number): Float64Array | null {
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j]!;
    M[i * (n + 1) + n] = b[i]!;
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * (n + 1) + c]!) > Math.abs(M[p * (n + 1) + c]!)) p = r;
    if (Math.abs(M[p * (n + 1) + c]!) < 1e-14) return null;
    if (p !== c) for (let j = c; j <= n; j++) [M[c * (n + 1) + j], M[p * (n + 1) + j]] = [M[p * (n + 1) + j]!, M[c * (n + 1) + j]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * (n + 1) + c]! / M[c * (n + 1) + c]!;
      if (f === 0) continue;
      for (let j = c; j <= n; j++) M[r * (n + 1) + j] = M[r * (n + 1) + j]! - f * M[c * (n + 1) + j]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n]!;
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j]! * x[j]!;
    x[i] = s / M[i * (n + 1) + i]!;
  }
  return x;
}

/** Least squares for an m x n system (m >= n) by the normal equations with a tiny ridge, for well-conditioned fits. */
export function lstsq(A: ArrayLike<number>, b: ArrayLike<number>, m: number, n: number, ridge = 1e-12): Float64Array | null {
  const AtA = new Float64Array(n * n);
  const Atb = new Float64Array(n);
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) {
      const aij = A[i * n + j]!;
      if (aij === 0) continue;
      Atb[j] = Atb[j]! + aij * b[i]!;
      for (let k = j; k < n; k++) AtA[j * n + k] = AtA[j * n + k]! + aij * A[i * n + k]!;
    }
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) AtA[j * n + k] = AtA[k * n + j]!;
    AtA[j * n + j] = AtA[j * n + j]! * (1 + ridge) + ridge;
  }
  return solve(AtA, Atb, n);
}

// ---------------------------------------------------------------------------------------------------------------
// 3x3 matrices (row-major, 9 numbers)

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const o = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return o;
}
export const det3 = (m: ArrayLike<number>) =>
  m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);

export function inv3(m: ArrayLike<number>): Mat3 | null {
  const d = det3(m);
  if (Math.abs(d) < 1e-18) return null;
  const [a, b, c, e, f, g, h, i, j] = m as unknown as number[];
  return [
    (f! * j! - g! * i!) / d, (c! * i! - b! * j!) / d, (b! * g! - c! * f!) / d,
    (g! * h! - e! * j!) / d, (a! * j! - c! * h!) / d, (c! * e! - a! * g!) / d,
    (e! * i! - f! * h!) / d, (b! * h! - a! * i!) / d, (a! * f! - b! * e!) / d,
  ];
}
export const transpose3 = (m: ArrayLike<number>): Mat3 => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

/** Applies a homography to a point. */
export function apply(H: ArrayLike<number>, x: number, y: number): [number, number] {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}
/** Scales a homography so its last entry is 1. */
export const norm3 = (H: ArrayLike<number>): Mat3 => (Array.from(H) as number[]).map((v) => v / H[8]!) as Mat3;

// ---------------------------------------------------------------------------------------------------------------
// a small deterministic random generator, so RANSAC and everything built on it repeats exactly

export type Rng = () => number;
export function rng(seed = 1): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
