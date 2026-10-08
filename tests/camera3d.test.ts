/**
 * 3D camera tracking through the CLI, against a scene whose camera is known: the solve is run on a rendered video, then a flat
 * surface of the scene is followed through it (a `plane3d` tracker) and a graphic is pinned to it. Positions are compared with
 * the true projection of the surface in every frame.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VideoWriter, quadMask, readFrames, type Pose, type Quad, type Vec3, project } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject, type Shot } from './studio-cli.js';
import { lookAt, renderScene, texture, toBytes, type ScenePlane } from './vision-helpers.js';
import { grays, shake, steps } from './shake.js';

const W = 640;
const H = 360;
const N = 60;
const FPS = 30;
const F_TRUE = 1.1 * W;

const board = { O: [0.5, -1.2, 6] as Vec3, U: [3.5, 0, 0] as Vec3, V: [0, 2.7, 0] as Vec3 };
const scene = (): ScenePlane[] => [
  { O: [-12, -7, 12], U: [44, 0, 0], V: [0, 14, 0], tex: texture(1760, 560, 21) },
  { O: [-10, 3, 2], U: [40, 0, 0], V: [0, 0, 12], tex: texture(1600, 480, 22) },
  { O: [-5, -4, 3], U: [0, 0, 9], V: [0, 7, 0], tex: texture(540, 420, 23) },
  { ...board, tex: texture(420, 324, 24) },
];
/** the part of the board that is tracked and pinned: 10% in from each edge */
const sub: Vec3[] = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]].map(([s, t]) => [board.O[0] + s! * board.U[0] + t! * board.V[0], board.O[1] + s! * board.U[1] + t! * board.V[1], board.O[2] + s! * board.U[2] + t! * board.V[2]] as Vec3);
const camera = (n: number, sweep: number): Pose[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / Math.max(1, n - 1);
    const C: Vec3 = [-1.5 + 4 * t + 0.25 * Math.sin(6 * t), 0.3 * Math.sin(5 * t), 1.6 * t];
    const target: Vec3 = [0.5 + sweep * t + 1.2 * Math.sin(2.5 * t) * (1 - sweep / 8), 0.2 * Math.sin(4 * t), 9];
    return lookAt(C, target, 0.04 * Math.sin(3 * t));
  });
/** the true quad of the board's tracked part in frame i, in index coordinates of the W x H picture */
const trueQuad = (pose: Pose): Quad => sub.map((X) => {
  const q = project(F_TRUE, pose, X)!;
  return [q[0] + (W - 1) / 2, q[1] + (H - 1) / 2];
}) as Quad;
/** the same as fractions of the frame (a pixel's centre at +0.5), which is how a region is given to the tracker */
const asFractions = (q: Quad) => q.flatMap(([x, y]) => [(x + 0.5) / W, (y + 0.5) / H].map((v) => v.toFixed(5))).join(',');

async function shoot(poses: Pose[], occlude: boolean): Promise<string> {
  const frames = renderScene(scene(), F_TRUE, poses, W, H, { noise: 0.01 });
  if (occlude)
    frames.forEach((f, i) => {
      // a dark block that walks across the picture
      const x0 = Math.round(-90 + (i / (N - 1)) * (W + 180));
      for (let y = 60; y < 300; y++) for (let x = x0; x < x0 + 90; x++) if (x >= 0 && x < W) f.d[y * W + x] = 0.06 + 0.08 * (((x >> 2) + (y >> 2)) % 3) / 3;
    });
  const dir = tmpDir('studio-cam3d-');
  const file = join(dir, 'shot.mp4');
  const w = new VideoWriter(file, { w: W, h: H, fps: FPS, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
  for (const f of frames) await w.write(toBytes(f));
  await w.close();
  return file;
}

describe('3D camera tracking and a plane in it', () => {
  const poses = camera(N, 0);
  let shot: Shot;
  let redAsset: string;

  it('solves the camera from the video and reports what it found, with an export and a preview', async () => {
    const file = await shoot(poses, true);
    shot = await shotProject(file, { width: W, height: H, fps: FPS, frames: N });
    const r = ok(await run(['track', 'solve', '--asset', shot.asset, '--out', 'renders/camera.json', '--preview', '--project', shot.dir]));
    console.log(`SOLVE via CLI: focal ${r.camera.focalPx} px (true ${F_TRUE}), hfov ${r.camera.horizontalFovDeg}, ${r.quality.framesSolved}/${r.quality.frames} frames, ${r.quality.points} points, rms ${r.quality.reprojectionRmsPx} px (median ${r.quality.reprojectionMedianPx}), ${r.wallMs} ms`);
    // the analysis runs at 480 wide; the focal length is reported at that width
    expect(Math.abs(r.camera.focalPx / (480 / W) - F_TRUE) / F_TRUE).toBeLessThan(0.06); // the focal length is the weakest part of a solve (0.2% to 4% off across these scenes); the plane results do not depend on it being exact
    expect(r.quality.framesSolved).toBe(N);
    expect(r.quality.reprojectionRmsPx).toBeLessThan(1);
    const exp = JSON.parse(readFileSync(join(shot.dir, 'renders', 'camera.json'), 'utf8'));
    expect(exp.format).toBe('studio-camera-solve/1');
    expect(exp.frames.length).toBe(N);
    expect(exp.frames[10].rotation.length).toBe(4);
    expect(exp.points.length).toBe(r.quality.points);
    // every tile of the preview sheet shows a picture, the last frame included (a black tile means the frame could not be read)
    const sheet = join(shot.dir, r.preview.file);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', sheet, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
    const sw = 480 * 3 + 4;
    const sh = Math.floor(raw.length / sw);
    let lastTile = 0;
    for (let y = sh - 100; y < sh - 10; y++) for (let x = sw - 300; x < sw - 10; x++) lastTile += raw[y * sw + x]!;
    expect(lastTile / (90 * 290)).toBeGreaterThan(30);
    const again = ok(await run(['track', 'solve', '--asset', shot.asset, '--project', shot.dir]));
    expect(again.cached).toBe(true);
  }, 300_000);

  it('follows the board through the solved camera and pins a graphic to it: edges within a pixel of the true projection, with an occluder walking across', async () => {
    const img = join(tmpDir('studio-cam3d-img-'), 'red.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=96x96', '-frames:v', '1', img]);
    ok(await run(['ingest', img, '--no-derive', '--project', shot.dir]));
    const assets = JSON.parse(readFileSync(join(shot.dir, 'project.studio.json'), 'utf8')).assets;
    redAsset = Object.keys(assets).find((k) => assets[k].kind === 'image')!;
    const q0 = trueQuad(poses[0]!);
    const r = ok(await run(['pin', '--clip', shot.clip, '--asset', redAsset, '--quad', asFractions(q0), '--at', '0', '--model', 'plane3d', '--project', shot.dir]));
    console.log(`PLANE3D track: ${JSON.stringify(r.track.camera)}; ${r.track.followed}/${r.track.frames} frames followed, ${r.track.ms} ms`);
    expect(r.track.lost).toBe(0);
    const out = join(shot.dir, ok(await run(['render', '--out', 'pin3d', '--width', String(W), '--no-normalize', '--force', '--project', shot.dir])).output as string);
    const errs: number[] = [];
    let k = 0;
    for await (const b of readFrames({ file: out, size: { w: W, h: H }, channels: 3 })) {
      const q = trueQuad(poses[k]!).map(([x, y]) => [x + 0.5, y + 0.5]) as Quad;
      const truth = quadMask(W, H, q);
      let xor = 0;
      for (let i = 0; i < W * H; i++) if ((b[i * 3]! - Math.max(b[i * 3 + 1]!, b[i * 3 + 2]!) > 90) !== !!truth[i]) xor++;
      errs.push(xor / q.reduce((s, p, i) => s + Math.hypot(p[0] - q[(i + 1) % 4]![0], p[1] - q[(i + 1) % 4]![1]), 0));
      k++;
    }
    const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
    console.log(`PLANE3D pin edge placement over ${errs.length} frames: mean ${mean.toFixed(2)} px, worst frame ${Math.max(...errs).toFixed(2)} px (output ${W}x${H})`);
    expect(errs.length).toBe(N);
    expect(mean).toBeLessThan(1.0);
    expect(Math.max(...errs)).toBeLessThan(2.0);
  }, 300_000);

  it('keeps the plane when the camera swings away and the surface leaves the frame: corners match the true projection', async () => {
    const swing = camera(N, 11); // the camera ends up looking far to the right of the board
    const file = await shoot(swing, false);
    const s2 = await shotProject(file, { width: W, height: H, fps: FPS, frames: N });
    const q0 = trueQuad(swing[0]!);
    const r = ok(await run(['track', 'add', '--asset', s2.asset, '--quad', asFractions(q0), '--at', '0', '--model', 'plane3d', '--project', s2.dir]));
    const shown = ok(await run(['track', 'show', r.tracker, '--every', '1', '--project', s2.dir]));
    let worstSeen = 0;
    let worstGone = 0;
    let offscreen = 0;
    const profile: string[] = [];
    shown.samples.forEach((smp: any, i: number) => {
      const truth = trueQuad(swing[i]!).map(([x, y]) => [(x + 0.5) / W, (y + 0.5) / H]);
      const err = Math.max(...smp.corners.map((c: number[], j: number) => Math.hypot((c[0]! - truth[j]![0]!) * W, (c[1]! - truth[j]![1]!) * H)));
      const left = Math.max(...truth.map(([x]) => x!)) * W;
      profile.push(`${i}:${err.toFixed(1)}@${Math.round(left)}`);
      const gone = truth.every(([x, y]) => x! < 0 || x! > 1 || y! < 0 || y! > 1);
      if (gone) (offscreen++, (worstGone = Math.max(worstGone, err)));
      else worstSeen = Math.max(worstSeen, err);
    });
    console.log(`PLANE3D swing: ${shown.samples.length} frames, the surface is entirely out of the picture in ${offscreen}; worst corner error ${worstSeen.toFixed(2)} px while any of it is in the picture, ${worstGone.toFixed(2)} px once it is gone (extrapolated); ${W} wide; camera solve ${JSON.stringify(r.track.camera)}`);
    console.log(`PLANE3D swing profile frame:error@rightmost-corner-x ${profile.filter((_, i) => i % 3 === 0).join(' ')}`);
    expect(offscreen).toBeGreaterThan(5);
    expect(worstSeen).toBeLessThan(3);
    expect(worstGone).toBeLessThan(25); // still continuous and plausible where nothing can be seen to check it against
  }, 300_000);

  it('stabilizes a hand-held move through a scene with real depth: the planar camera model leaves some shake, and the number says how much', async () => {
    // a smooth move plus hand shake: small random turns of the camera and small shifts of its position
    let jr: Vec3 = [0, 0, 0];
    let jp: Vec3 = [0, 0, 0];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    const calm = camera(N, 0);
    const shaky = calm.map((p, i) => {
      jr = [jr[0] * 0.5 + rnd() * 0.012, jr[1] * 0.5 + rnd() * 0.012, jr[2] * 0.5 + rnd() * 0.004];
      jp = [jp[0] * 0.5 + rnd() * 0.05, jp[1] * 0.5 + rnd() * 0.05, 0];
      const C = [-p.R[0] * p.t[0] - p.R[3] * p.t[1] - p.R[6] * p.t[2], -p.R[1] * p.t[0] - p.R[4] * p.t[1] - p.R[7] * p.t[2], -p.R[2] * p.t[0] - p.R[5] * p.t[1] - p.R[8] * p.t[2]] as Vec3;
      void i;
      return lookAt([C[0] + jp[0], C[1] + jp[1], C[2]], [0.5 + 1.2 * Math.sin((2.5 * i) / (N - 1)) + jr[0] * 9, 0.2 * Math.sin((4 * i) / (N - 1)) + jr[1] * 9, 9], 0.04 * Math.sin((3 * i) / (N - 1)) + jr[2]);
    });
    const file = await shoot(shaky, false);
    const s = await shotProject(file, { width: W, height: H, fps: FPS, frames: N });
    const r = ok(await run(['stabilize', '--clip', s.clip, '--smooth', '0.8', '--max-zoom', '1.4', '--project', s.dir]));
    const out = join(s.dir, ok(await run(['render', '--out', 'stab', '--width', String(W), '--no-normalize', '--force', '--project', s.dir])).output as string);
    const before = shake(steps(await grays(file)));
    const after = shake(steps(await grays(out)));
    console.log(`STAB with depth: shake ${before.toFixed(3)} -> ${after.toFixed(3)} px (rms change of motion per frame, 320 wide); zoom ${r.plan.zoom}, correction kept ${r.plan.correctionKept}`);
    expect(after).toBeLessThan(before * 0.6);
  }, 300_000);

  it('refuses a camera that only turns, and says which tool to use instead', async () => {
    const pan = Array.from({ length: 40 }, (_, i) => lookAt([0, 0, 0], [-1 + (2 * i) / 39, 0, 9], 0));
    const frames = renderScene(scene(), F_TRUE, pan, W, H, { noise: 0.01 });
    const dir = tmpDir('studio-cam3d-pan-');
    const file = join(dir, 'pan.mp4');
    const w = new VideoWriter(file, { w: W, h: H, fps: FPS, codec: ['-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p'] });
    for (const f of frames) await w.write(toBytes(f));
    await w.close();
    const s = await shotProject(file, { width: W, height: H, fps: FPS, frames: 40 });
    const r = await run(['track', 'solve', '--asset', s.asset, '--project', s.dir]);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.message).toMatch(/does not move enough/);
    expect(r.json.error.fix).toMatch(/homography|stabilize/);
  }, 300_000);
});
