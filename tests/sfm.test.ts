/**
 * 3D camera tracking against a known camera: a scene of textured planes at different depths filmed by a camera that moves and
 * turns. The camera path recovered from the pictures alone is compared with the true one (after the one similarity the problem
 * leaves free, the world's scale and placement).
 */
import { describe, expect, it } from 'vitest';
import {
  angleBetween, centerOf, inv3, len3, mul3, nearestRotation, project, similarityAlign, solveCamera, SolveError, sub3, trackFeatures, transpose3, rot, scale3, add3,
  type Mat3, type Pose, type Vec3,
} from '../packages/vision/src/index.js';
import { lookAt, renderScene, texture, type ScenePlane } from './vision-helpers.js';

const W = 480;
const H = 270;
const F_TRUE = 1.1 * W;

function scene(): ScenePlane[] {
  return [
    { O: [-12, -7, 12], U: [24, 0, 0], V: [0, 14, 0], tex: texture(960, 560, 21) }, // back wall
    { O: [-10, 3, 2], U: [20, 0, 0], V: [0, 0, 12], tex: texture(800, 480, 22) }, // ground (y points down)
    { O: [-5, -4, 3], U: [0, 0, 9], V: [0, 7, 0], tex: texture(540, 420, 23) }, // wall on the left
    { O: [0.5, -1.2, 6], U: [3.5, 0, 0], V: [0, 2.7, 0], tex: texture(420, 324, 24) }, // a board in front
  ];
}
/** a camera that moves sideways and forward while looking around */
function path(n: number): Pose[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / Math.max(1, n - 1);
    const C: Vec3 = [-1.5 + 4 * t + 0.25 * Math.sin(6 * t), 0.3 * Math.sin(5 * t), 1.6 * t];
    const target: Vec3 = [0.5 + 1.2 * Math.sin(2.5 * t), 0.2 * Math.sin(4 * t), 9];
    return lookAt(C, target, 0.04 * Math.sin(3 * t));
  });
}

describe('camera solve from pictures', () => {
  const N = 60;
  const truth = path(N);
  const planes = scene();
  const frames = renderScene(planes, F_TRUE, truth, W, H, { noise: 0.01 });

  it('recovers the camera path, the focal length and a point cloud from tracked features alone', async () => {
    const t0 = Date.now();
    const set = await trackFeatures(frames, { max: 350 });
    const tTrack = Date.now() - t0;
    const t1 = Date.now();
    const sol = solveCamera(set, { maxKeyframes: 40 });
    const tSolve = Date.now() - t1;
    const known = sol.poses.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    expect(known.length).toBe(N);
    // The solve leaves one similarity free: where the world sits (a rotation and a shift) and how big it is. The rotation is
    // taken from the cameras' orientations (their mean offset from the truth), the scale and shift from their positions with
    // that rotation held, so neither number is flattered by a near-straight path leaving the roll about it undetermined.
    const M = new Array(9).fill(0) as number[];
    for (const i of known) {
      const r = mul3(transpose3(truth[i]!.R), sol.poses[i]!.R);
      for (let k = 0; k < 9; k++) M[k] = M[k]! + r[k]!;
    }
    const Ral = nearestRotation(M);
    const est = known.map((i) => rot(Ral, centerOf(sol.poses[i]!)));
    const gt = known.map((i) => centerOf(truth[i]!));
    const mean = (a: Vec3[]): Vec3 => scale3(a.reduce((m, p) => add3(m, p), [0, 0, 0] as Vec3), 1 / a.length);
    const me = mean(est);
    const mg = mean(gt);
    let num = 0;
    let den = 0;
    est.forEach((e, i) => {
      const a = sub3(e, me);
      const b = sub3(gt[i]!, mg);
      num += a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      den += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    });
    const sc = num / den;
    const posErr = est.map((e, i) => len3(sub3(add3(scale3(sub3(e, me), sc), mg), gt[i]!)));
    const rotErr = known.map((i) => angleBetween(sol.poses[i]!.R, mul3(truth[i]!.R, Ral)));
    void similarityAlign;
    const span = len3(sub3(centerOf(truth[0]!), centerOf(truth[N - 1]!)));
    console.log(
      `SOLVE ${N} frames: ${set.tracks.length} tracks (${tTrack} ms), solve ${tSolve} ms; registered ${sol.stats.registered}, ${sol.stats.points} points, rms ${sol.stats.rmsPx.toFixed(3)} px (median ${sol.stats.medianPx.toFixed(3)}, p95 ${sol.stats.p95Px.toFixed(2)}); ` +
        `focal ${sol.f.toFixed(1)} vs true ${F_TRUE.toFixed(1)} (started at ${sol.fInit.toFixed(1)}; hfov ${sol.stats.hfovDeg.toFixed(1)}); ` +
        `camera position error mean ${(posErr.reduce((a, b) => a + b, 0) / N).toFixed(4)} max ${Math.max(...posErr).toFixed(4)} of a path of ${span.toFixed(2)} (${((100 * Math.max(...posErr)) / span).toFixed(2)}%); rotation error mean ${(rotErr.reduce((a, b) => a + b, 0) / N).toFixed(3)} max ${Math.max(...rotErr).toFixed(3)} deg; first pair ${sol.stats.initPair} at ${sol.stats.initAngleDeg.toFixed(1)} deg`,
    );
    expect(sol.stats.rmsPx).toBeLessThan(0.8);
    expect(Math.abs(sol.f - F_TRUE) / F_TRUE).toBeLessThan(0.03);
    expect(Math.max(...posErr)).toBeLessThan(0.03 * span);
    expect(Math.max(...rotErr)).toBeLessThan(0.6);
    expect(sol.stats.points).toBeGreaterThan(150);
    void project;
    void inv3;
  }, 300_000);

  it('says so when the camera only turns: no parallax, no depth', async () => {
    // the same scene, but the camera stays still and pans: there is nothing to triangulate
    const C: Vec3 = [0, 0, 0];
    const pan = Array.from({ length: 40 }, (_, i) => lookAt(C, [-1 + (2 * i) / 39, 0, 9], 0));
    const fr = renderScene(planes, F_TRUE, pan, W, H, { noise: 0.01 });
    const set = await trackFeatures(fr, { max: 300 });
    let err: unknown;
    try {
      solveCamera(set, { maxKeyframes: 30 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SolveError);
    expect((err as SolveError).code).toBe('NO_PARALLAX');
    void ({} as Mat3);
  }, 300_000);
});
