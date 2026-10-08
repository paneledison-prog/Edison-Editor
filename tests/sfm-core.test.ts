/**
 * The geometry under 3D camera tracking, on points and cameras alone (no pictures): the essential matrix and its
 * decomposition, triangulation, resection, and bundle adjustment, each against a known truth.
 */
import { describe, expect, it } from 'vitest';
import {
  angleBetween, bundleAdjust, centerOf, decomposeEssential, expSO3, fitEssential, logSO3, nearestRotation, project, ransacEssential,
  mul3, resect, rng, similarityAlign, transpose3, toCam, triangulate, len3, sub3, scale3, add3, rot,
  type Mat3, type Obs, type Pose, type Pt, type Vec3,
} from '../packages/vision/src/index.js';

const R = rng(11);
const gauss = () => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());
const F = 520;

/** A camera looking at the middle of the scene from a point on an arc. */
function camAt(i: number, n: number): Pose {
  const a = ((i / Math.max(1, n - 1)) - 0.5) * 0.9; // about 50 degrees of arc
  const C: Vec3 = [8 * Math.sin(a), 0.4 * Math.sin(3 * a), -8 * Math.cos(a) + 8];
  const target: Vec3 = [0, 0, 8];
  const z = scale3(sub3(target, C), 1 / len3(sub3(target, C)));
  const x0: Vec3 = [0, 1, 0];
  // x = y0 x z, y = z x x
  const cx = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let x = cx(x0, z);
  x = scale3(x, 1 / len3(x));
  const y = cx(z, x);
  const Rm: Mat3 = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
  return { R: Rm, t: scale3(rot(Rm, C), -1) };
}
const cloud = (n: number): Vec3[] => Array.from({ length: n }, () => [(R() - 0.5) * 10, (R() - 0.5) * 6, 5 + R() * 9] as Vec3);

describe('two views', () => {
  it('essential matrix: recovers the relative pose and the points from noisy matches with outliers', () => {
    const P = cloud(150);
    const A = camAt(0, 2);
    const B = camAt(1, 2);
    const noise = 0.4;
    const a: Pt[] = [];
    const b: Pt[] = [];
    const truth: Vec3[] = [];
    for (const X of P) {
      const pa = project(F, A, X)!;
      const pb = project(F, B, X)!;
      a.push([(pa[0] + noise * gauss()) / F, (pa[1] + noise * gauss()) / F]);
      b.push([(pb[0] + noise * gauss()) / F, (pb[1] + noise * gauss()) / F]);
      truth.push(X);
    }
    for (let i = 0; i < 25; i++) b[i] = [(R() - 0.5), (R() - 0.5) * 0.6]; // wrong matches
    const fit = ransacEssential(a, b, { thresh: 1.5 / F })!;
    expect(fit.count).toBeGreaterThan(110);
    let best: { pose: Pose; front: number } | null = null;
    for (const c of decomposeEssential(fit.E)) {
      let front = 0;
      for (let i = 25; i < 100; i++) {
        const X = triangulate([{ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, c], [a[i]!, b[i]!]);
        if (X && X[2] > 0 && toCam(c, X)[2] > 0) front++;
      }
      if (!best || front > best.front) best = { pose: c, front };
    }
    // the truth relative pose: x_B = R_B R_A^T x_A + (t_B - R_B R_A^T t_A)
    const Rrel = mul3(B.R, transpose3(A.R));
    const trel = sub3(B.t, rot(Rrel, A.t));
    const dRot = angleBetween(best!.pose.R, Rrel);
    const dir = scale3(trel, 1 / len3(trel));
    const cos = best!.pose.t[0] * dir[0] + best!.pose.t[1] * dir[1] + best!.pose.t[2] * dir[2];
    console.log(`ESSENTIAL ${fit.count}/150 inliers; rotation off by ${dRot.toFixed(3)} deg, translation direction off by ${((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toFixed(3)} deg`);
    expect(dRot).toBeLessThan(0.3);
    expect(cos).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
    void fitEssential;
  });

  it('rotations: exp and log are inverses, and the nearest rotation fixes a perturbed matrix', () => {
    for (let i = 0; i < 20; i++) {
      const w: Vec3 = [gauss(), gauss(), gauss()];
      const Rm = expSO3(w);
      const w2 = logSO3(Rm);
      const back = expSO3(w2);
      expect(angleBetween(Rm, back)).toBeLessThan(1e-4);
      const noisy = Rm.map((v) => v + 0.01 * gauss());
      expect(angleBetween(nearestRotation(noisy), Rm)).toBeLessThan(1.5);
    }
  });
});

describe('resection', () => {
  it('finds a camera from 3D-2D matches with noise', () => {
    const P = cloud(60);
    const T = camAt(3, 10);
    const x: Pt[] = P.map((X) => {
      const p = project(F, T, X)!;
      return [(p[0] + 0.5 * gauss()) / F, (p[1] + 0.5 * gauss()) / F];
    });
    const pose = resect(P, x, P.map((_, i) => i))!;
    expect(angleBetween(pose.R, T.R)).toBeLessThan(0.5);
    const c = centerOf(pose);
    const c0 = centerOf(T);
    expect(len3(sub3(c, c0))).toBeLessThan(0.15);
  });
});

describe('bundle adjustment', () => {
  it('recovers cameras, points and the focal length from rough starting values (measured against the known truth)', () => {
    const nCam = 24;
    const P = cloud(260);
    const cams = Array.from({ length: nCam }, (_, i) => camAt(i, nCam));
    const obs: Obs[] = [];
    P.forEach((X, p) =>
      cams.forEach((c, k) => {
        const q = project(F, c, X);
        if (q && Math.abs(q[0]) < 330 && Math.abs(q[1]) < 190) obs.push({ c: k, p, u: q[0] + 0.3 * gauss(), v: q[1] + 0.3 * gauss() });
      }),
    );
    // gross outliers in the observations
    for (let i = 0; i < obs.length; i += 40) (obs[i]!.u += 25 * gauss(), obs[i]!.v += 25 * gauss());
    // start: camera 0 right, the others turned and moved, points scattered, focal 12% off
    const start: Pose[] = cams.map((c, k) => (k === 0 ? c : { R: mul3(expSO3([0.03 * gauss(), 0.03 * gauss(), 0.03 * gauss()]), c.R), t: add3(c.t, [0.2 * gauss(), 0.2 * gauss(), 0.2 * gauss()]) }));
    const pts = P.map((X) => add3(X, [0.4 * gauss(), 0.4 * gauss(), 0.6 * gauss()]));
    const prob = { f: F * 0.88, cams: start, pts, obs, fixedCams: [0], optimizeF: true };
    const t0 = Date.now();
    const r = bundleAdjust(prob, { iters: 40, huber: 1.5 });
    const ms = Date.now() - t0;
    // compare to truth after the best similarity (the scale of the world is free)
    const al = similarityAlign(prob.cams.map(centerOf), cams.map(centerOf));
    const err = prob.cams.map((c, k) => len3(sub3(add3(scale3(rot(al.R, centerOf(c)), al.s), al.t), centerOf(cams[k]!))));
    const rotErr = prob.cams.map((c, k) => angleBetween(c.R, cams[k]!.R));
    const span = len3(sub3(centerOf(cams[0]!), centerOf(cams[nCam - 1]!)));
    console.log(`BA ${obs.length} observations, ${nCam} cameras, ${P.length} points, ${r.iterations} iterations in ${ms} ms: rms ${r.rms.toFixed(3)} px (noise 0.3 plus gross outliers), focal ${r.f.toFixed(1)} vs ${F} true, camera position error max ${Math.max(...err).toFixed(4)} (path ${span.toFixed(2)}), rotation error max ${Math.max(...rotErr).toFixed(3)} deg`);
    expect(Math.abs(r.f - F) / F).toBeLessThan(0.01);
    expect(Math.max(...err)).toBeLessThan(0.01 * span);
    expect(Math.max(...rotErr)).toBeLessThan(0.15);
  });
});
