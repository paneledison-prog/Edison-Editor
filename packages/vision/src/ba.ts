/**
 * Bundle adjustment: the cameras (and optionally the shared focal length) and the 3D points that best explain the image
 * observations, by Levenberg-Marquardt with a Huber loss. The points are eliminated with the Schur complement, so the
 * system solved is only (6 x free cameras + 1) wide however many points there are.
 *
 * Parametrisation: x_cam = R X + t; a step turns R by exp(dtheta) on the left and adds dt to t, which is the same
 * perturbation the derivatives below use. One camera is held fixed (the world's origin and orientation); the overall scale
 * is left free and kept in check by the damping.
 */
import { cholSolve, type Mat3 } from './linalg.js';
import { expSO3, type Pose, type Vec3 } from './cam.js';
import { mul3 } from './linalg.js';

export interface Obs {
  /** camera index */
  c: number;
  /** point index */
  p: number;
  /** pixels relative to the principal point */
  u: number;
  v: number;
}
export interface BAProblem {
  /** focal length in pixels */
  f: number;
  cams: Pose[];
  pts: Vec3[];
  obs: Obs[];
  fixedCams?: number[];
  optimizeF?: boolean;
  fRange?: [number, number];
}
export interface BAResult {
  iterations: number;
  cost0: number;
  cost1: number;
  /** root mean square reprojection error over the observations (px) */
  rms: number;
  f: number;
}

const BEHIND = 1e3;

function inv3s(a: number[]): number[] | null {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = a as [number, number, number, number, number, number, number, number, number];
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  const d = m00 * c00 + m01 * c01 + m02 * c02;
  if (Math.abs(d) < 1e-300) return null;
  const i = 1 / d;
  return [c00 * i, (m02 * m21 - m01 * m22) * i, (m01 * m12 - m02 * m11) * i, c01 * i, (m00 * m22 - m02 * m20) * i, (m02 * m10 - m00 * m12) * i, c02 * i, (m01 * m20 - m00 * m21) * i, (m00 * m11 - m01 * m10) * i];
}

export function bundleAdjust(P: BAProblem, o: { iters?: number; huber?: number } = {}): BAResult {
  const huber = o.huber ?? 2;
  const C = P.cams.length;
  const N = P.pts.length;
  const fixed = new Set(P.fixedCams ?? []);
  const cIdx = new Int32Array(C);
  let nFree = 0;
  for (let c = 0; c < C; c++) cIdx[c] = fixed.has(c) ? -1 : nFree++;
  const optF = !!P.optimizeF;
  const D = 6 * nFree + (optF ? 1 : 0);
  const fI = 6 * nFree;
  const [fLo, fHi] = P.fRange ?? [1, 1e9];
  const byPt: number[][] = Array.from({ length: N }, () => []);
  P.obs.forEach((ob, k) => byPt[ob.p]!.push(k));

  let f = P.f;
  let cams = P.cams.map((p) => ({ R: p.R.slice() as Mat3, t: p.t.slice() as Vec3 }));
  let pts = P.pts.map((x) => x.slice() as Vec3);

  const rho = (r: number) => (r <= huber ? 0.5 * r * r : huber * (r - 0.5 * huber));
  const cost = (cs: Pose[], ps: Vec3[], ff: number): { cost: number; sq: number; n: number } => {
    let c = 0;
    let sq = 0;
    let n = 0;
    for (const ob of P.obs) {
      const R = cs[ob.c]!.R;
      const t = cs[ob.c]!.t;
      const X = ps[ob.p]!;
      const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
      let r: number;
      if (z <= 1e-6) r = BEHIND;
      else {
        const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
        const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
        r = Math.hypot((ff * x) / z - ob.u, (ff * y) / z - ob.v);
      }
      c += rho(r);
      sq += r * r;
      n++;
    }
    return { cost: c, sq, n };
  };

  let cur = cost(cams, pts, f);
  const cost0 = cur.cost;
  let lambda = 1e-3;
  let iterations = 0;
  if (D === 0 || !P.obs.length) return { iterations: 0, cost0, cost1: cost0, rms: Math.sqrt(cur.sq / Math.max(1, cur.n)), f };

  const nObs = P.obs.length;
  const Wc = new Float64Array(18 * nObs); // per observation: w Jc^T Jp (6 x 3)
  for (let it = 0; it < (o.iters ?? 30); it++) {
    iterations++;
    const S = new Float64Array(D * D);
    const g = new Float64Array(D);
    const V = new Float64Array(9 * N);
    const gp = new Float64Array(3 * N);
    const Wf = new Float64Array(3 * N);
    Wc.fill(0);
    const Jc = new Float64Array(12); // 2 x 6
    const Jp = new Float64Array(6); // 2 x 3
    for (let k = 0; k < nObs; k++) {
      const ob = P.obs[k]!;
      const cam = cams[ob.c]!;
      const R = cam.R;
      const X = pts[ob.p]!;
      const rx = R[0] * X[0] + R[1] * X[1] + R[2] * X[2];
      const ry = R[3] * X[0] + R[4] * X[1] + R[5] * X[2];
      const rz = R[6] * X[0] + R[7] * X[1] + R[8] * X[2];
      const xc = rx + cam.t[0];
      const yc = ry + cam.t[1];
      const zc = rz + cam.t[2];
      if (zc <= 1e-6) continue;
      const iz = 1 / zc;
      const xn = xc * iz;
      const yn = yc * iz;
      const ru = f * xn - ob.u;
      const rv = f * yn - ob.v;
      const r = Math.hypot(ru, rv);
      const w = r <= huber ? 1 : huber / r;
      // d(u,v)/d(Xc): 2 x 3
      const a = f * iz;
      const j00 = a;
      const j02 = -a * xn;
      const j11 = a;
      const j12 = -a * yn;
      // Jp = Jproj R
      for (let c = 0; c < 3; c++) {
        Jp[c] = j00 * R[c]! + j02 * R[6 + c]!;
        Jp[3 + c] = j11 * R[3 + c]! + j12 * R[6 + c]!;
      }
      // Jtheta = Jproj * (-skew(R X)); skew(v) = [0 -vz vy; vz 0 -vx; -vy vx 0], so -skew(v) = [0 vz -vy; -vz 0 vx; vy -vx 0]
      Jc[0] = j02 * ry; // row u, theta_x
      Jc[1] = j00 * rz - j02 * rx; // theta_y
      Jc[2] = -j00 * ry; // theta_z
      Jc[3] = j00;
      Jc[4] = 0;
      Jc[5] = j02;
      Jc[6] = -j11 * rz + j12 * ry; // row v, theta_x
      Jc[7] = -j12 * rx; // theta_y
      Jc[8] = j11 * rx; // theta_z
      Jc[9] = 0;
      Jc[10] = j11;
      Jc[11] = j12;
      const ci = cIdx[ob.c]!;
      const gr = [xn, yn];
      const b = 6 * ci;
      if (ci >= 0) {
        for (let p = 0; p < 6; p++) {
          g[b + p] = g[b + p]! - w * (Jc[p]! * ru + Jc[6 + p]! * rv);
          for (let q = 0; q < 6; q++) S[(b + p) * D + b + q] = S[(b + p) * D + b + q]! + w * (Jc[p]! * Jc[q]! + Jc[6 + p]! * Jc[6 + q]!);
          for (let q = 0; q < 3; q++) Wc[18 * k + p * 3 + q] = w * (Jc[p]! * Jp[q]! + Jc[6 + p]! * Jp[3 + q]!);
        }
      }
      if (optF) {
        g[fI] = g[fI]! - w * (gr[0]! * ru + gr[1]! * rv);
        S[fI * D + fI] = S[fI * D + fI]! + w * (gr[0]! * gr[0]! + gr[1]! * gr[1]!);
        if (ci >= 0)
          for (let p = 0; p < 6; p++) {
            const v = w * (Jc[p]! * gr[0]! + Jc[6 + p]! * gr[1]!);
            S[(b + p) * D + fI] = S[(b + p) * D + fI]! + v;
            S[fI * D + b + p] = S[fI * D + b + p]! + v;
          }
        for (let q = 0; q < 3; q++) Wf[3 * ob.p + q] = Wf[3 * ob.p + q]! + w * (gr[0]! * Jp[q]! + gr[1]! * Jp[3 + q]!);
      }
      for (let p = 0; p < 3; p++) {
        gp[3 * ob.p + p] = gp[3 * ob.p + p]! - w * (Jp[p]! * ru + Jp[3 + p]! * rv);
        for (let q = 0; q < 3; q++) V[9 * ob.p + p * 3 + q] = V[9 * ob.p + p * 3 + q]! + w * (Jp[p]! * Jp[q]! + Jp[3 + p]! * Jp[3 + q]!);
      }
    }

    let accepted = false;
    for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
      const Sd = Float64Array.from(S);
      const gd = Float64Array.from(g);
      for (let i = 0; i < D; i++) Sd[i * D + i] = Sd[i * D + i]! * (1 + lambda) + 1e-9;
      const Vinv: (number[] | null)[] = new Array(N).fill(null);
      const dp = new Float64Array(3 * N);
      for (let p = 0; p < N; p++) {
        const ks = byPt[p]!;
        if (!ks.length) continue;
        const Vd = Array.from(V.subarray(9 * p, 9 * p + 9));
        for (let i = 0; i < 3; i++) Vd[i * 4] = Vd[i * 4]! * (1 + lambda) + 1e-9;
        const vi = inv3s(Vd);
        Vinv[p] = vi;
        if (!vi) continue;
        // T_k = Wc_k Vinv (6 x 3) for the free cameras of this point
        const free = ks.filter((k) => cIdx[P.obs[k]!.c]! >= 0);
        const T = free.map((k) => {
          const t = new Float64Array(18);
          for (let a = 0; a < 6; a++)
            for (let c = 0; c < 3; c++) t[a * 3 + c] = Wc[18 * k + a * 3]! * vi[c]! + Wc[18 * k + a * 3 + 1]! * vi[3 + c]! + Wc[18 * k + a * 3 + 2]! * vi[6 + c]!;
          return t;
        });
        const wf = [Wf[3 * p]!, Wf[3 * p + 1]!, Wf[3 * p + 2]!];
        free.forEach((k, ia) => {
          const a = 6 * cIdx[P.obs[k]!.c]!;
          const Ta = T[ia]!;
          for (let r = 0; r < 6; r++) gd[a + r] = gd[a + r]! - (Ta[r * 3]! * gp[3 * p]! + Ta[r * 3 + 1]! * gp[3 * p + 1]! + Ta[r * 3 + 2]! * gp[3 * p + 2]!);
          free.forEach((l, ib) => {
            if (ib < ia) return;
            const bI = 6 * cIdx[P.obs[l]!.c]!;
            for (let r = 0; r < 6; r++)
              for (let c = 0; c < 6; c++) {
                const v = Ta[r * 3]! * Wc[18 * l + c * 3]! + Ta[r * 3 + 1]! * Wc[18 * l + c * 3 + 1]! + Ta[r * 3 + 2]! * Wc[18 * l + c * 3 + 2]!;
                Sd[(a + r) * D + bI + c] = Sd[(a + r) * D + bI + c]! - v;
                if (ib !== ia) Sd[(bI + c) * D + a + r] = Sd[(bI + c) * D + a + r]! - v;
              }
          });
          if (optF)
            for (let r = 0; r < 6; r++) {
              const v = Ta[r * 3]! * wf[0]! + Ta[r * 3 + 1]! * wf[1]! + Ta[r * 3 + 2]! * wf[2]!;
              Sd[(a + r) * D + fI] = Sd[(a + r) * D + fI]! - v;
              Sd[fI * D + a + r] = Sd[fI * D + a + r]! - v;
            }
        });
        if (optF) {
          const tf = [wf[0]! * vi[0]! + wf[1]! * vi[3]! + wf[2]! * vi[6]!, wf[0]! * vi[1]! + wf[1]! * vi[4]! + wf[2]! * vi[7]!, wf[0]! * vi[2]! + wf[1]! * vi[5]! + wf[2]! * vi[8]!];
          gd[fI] = gd[fI]! - (tf[0]! * gp[3 * p]! + tf[1]! * gp[3 * p + 1]! + tf[2]! * gp[3 * p + 2]!);
          Sd[fI * D + fI] = Sd[fI * D + fI]! - (tf[0]! * wf[0]! + tf[1]! * wf[1]! + tf[2]! * wf[2]!);
        }
      }
      const dc = cholSolve(Sd, gd, D);
      if (!dc) {
        lambda *= 10;
        continue;
      }
      // the points follow
      for (let p = 0; p < N; p++) {
        const vi = Vinv[p];
        if (!vi) continue;
        const r = [gp[3 * p]!, gp[3 * p + 1]!, gp[3 * p + 2]!];
        for (const k of byPt[p]!) {
          const ci = cIdx[P.obs[k]!.c]!;
          if (ci < 0) continue;
          for (let c = 0; c < 3; c++) for (let a = 0; a < 6; a++) r[c] = r[c]! - Wc[18 * k + a * 3 + c]! * dc[6 * ci + a]!;
        }
        if (optF) for (let c = 0; c < 3; c++) r[c] = r[c]! - Wf[3 * p + c]! * dc[fI]!;
        dp[3 * p] = vi[0]! * r[0]! + vi[1]! * r[1]! + vi[2]! * r[2]!;
        dp[3 * p + 1] = vi[3]! * r[0]! + vi[4]! * r[1]! + vi[5]! * r[2]!;
        dp[3 * p + 2] = vi[6]! * r[0]! + vi[7]! * r[1]! + vi[8]! * r[2]!;
      }
      const cams2: Pose[] = cams.map((cm, c) => {
        const ci = cIdx[c]!;
        if (ci < 0) return cm;
        const dth: Vec3 = [dc[6 * ci]!, dc[6 * ci + 1]!, dc[6 * ci + 2]!];
        return { R: mul3(expSO3(dth), cm.R), t: [cm.t[0] + dc[6 * ci + 3]!, cm.t[1] + dc[6 * ci + 4]!, cm.t[2] + dc[6 * ci + 5]!] };
      });
      const pts2: Vec3[] = pts.map((x, p) => [x[0] + dp[3 * p]!, x[1] + dp[3 * p + 1]!, x[2] + dp[3 * p + 2]!]);
      const f2 = optF ? Math.min(fHi, Math.max(fLo, f + dc[fI]!)) : f;
      const next = cost(cams2, pts2, f2);
      if (next.cost < cur.cost) {
        const rel = (cur.cost - next.cost) / Math.max(1e-12, cur.cost);
        cams = cams2;
        pts = pts2;
        f = f2;
        cur = next;
        lambda = Math.max(1e-9, lambda / 3);
        accepted = true;
        if (rel < 1e-7) it = 1e9;
      } else lambda *= 4;
    }
    if (!accepted) break;
  }
  for (let c = 0; c < C; c++) P.cams[c] = cams[c]!;
  for (let p = 0; p < N; p++) P.pts[p] = pts[p]!;
  P.f = f;
  return { iterations, cost0, cost1: cur.cost, rms: Math.sqrt(cur.sq / Math.max(1, cur.n)), f };
}
