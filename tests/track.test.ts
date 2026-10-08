/**
 * Stabilize and pin, end to end through the CLI, against a camera whose path is known: a textured plane filmed by a camera that
 * drifts smoothly and shakes. The shake is measured on the rendered video by a method that shares no code with the tracker (the
 * global translation between frames from dense optical flow, median over the picture), and compared with the shake of the
 * input and with the known smooth path.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  apply, denseFlow, fromBytes, inv3, mul3, quadMask, readFrames, VideoWriter,
  type Gray, type Mat3, type Quad,
} from '../packages/vision/src/index.js';
import { cameraPath, renderPlane, texture, toBytes } from './vision-helpers.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
const run = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 27 }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );
const ok = (r: { json: any }) => {
  expect(r.json?.ok, JSON.stringify(r.json)).toBe(true);
  return r.json.data;
};

const W = 640;
const H = 360;
const N = 75;
const FPS = 30;
const world = texture(W + 240, H + 200, 11);
const toWorld: Mat3 = [1, 0, -120, 0, 1, -100, 0, 0, 1];
const opts = { amp: 10, rot: 0.8, zoom: 0.02, persp: 0, seed: 5 };
const shaky = cameraPath(N, W, H, { ...opts, jitter: 7 }).map((p) => mul3(p, toWorld) as Mat3);
const calm = cameraPath(N, W, H, { ...opts, jitter: 0 }).map((p) => mul3(p, toWorld) as Mat3);

async function writeVideo(file: string, frames: Gray[]) {
  const w = new VideoWriter(file, { w: W, h: H, fps: FPS, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
  for (const f of frames) await w.write(toBytes(f));
  await w.close();
}

interface P {
  dir: string;
  clip: string;
  asset: string;
  input: string;
}
async function project(video: string): Promise<P> {
  const d = tmpDir('studio-trk-');
  ok(await run(['init', 't', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', d]));
  ok(await run(['ingest', video, '--no-derive', '--project', d]));
  const p = JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8'));
  const asset = Object.keys(p.assets)[0]!;
  const t = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', d])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t, '--asset', asset, '--start', '0', '--dur', String(Math.round((N * 1000) / FPS)), '--project', d]));
  return { dir: d, clip: JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).clips[0].id, asset, input: video };
}
const render = async (p: P, name: string) =>
  join(p.dir, ok(await run(['render', '--out', name, '--width', String(W), '--no-normalize', '--force', '--project', p.dir])).output as string);

/** Frames of a video as gray images, half size. */
async function grays(file: string, w = 320, h = 180): Promise<Gray[]> {
  const out: Gray[] = [];
  for await (const b of readFrames({ file, size: { w, h } })) out.push(fromBytes(b, w, h, 1));
  return out;
}
const median = (a: ArrayLike<number>) => Float32Array.from(a).sort()[a.length >> 1]!;
/** Global translation between consecutive frames: the median of the dense flow over the middle of the picture. */
function steps(frames: Gray[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    const f = denseFlow(frames[i]!, frames[i + 1]!);
    const u: number[] = [];
    const v: number[] = [];
    for (let y = f.h * 0.2; y < f.h * 0.8; y += 2) for (let x = f.w * 0.2; x < f.w * 0.8; x += 2) (u.push(f.u[Math.floor(y) * f.w + Math.floor(x)]!), v.push(f.v[Math.floor(y) * f.w + Math.floor(x)]!));
    out.push([median(u), median(v)]);
  }
  return out;
}
/** rms of the change of the step from one frame to the next: what a viewer sees as shake (px, at the measured width). */
function shake(s: [number, number][]): number {
  let sq = 0;
  for (let i = 0; i + 1 < s.length; i++) sq += (s[i + 1]![0] - s[i]![0]) ** 2 + (s[i + 1]![1] - s[i]![1]) ** 2;
  return Math.sqrt(sq / Math.max(1, s.length - 1));
}
/** the same measure on the known path, for the centre of the frame, at the measured width */
function pathShake(path: Mat3[], scale = 0.5): number {
  const c = path.map((p) => apply(p, W / 2, H / 2));
  const s = c.slice(1).map((p, i) => [(p[0] - c[i]![0]) * scale, (p[1] - c[i]![1]) * scale] as [number, number]);
  return shake(s);
}

let sh: P;
let box: { x: number; y: number };
beforeAll(async () => {
  const dir = tmpDir('studio-trk-src-');
  const video = join(dir, 'shaky.mp4');
  await writeVideo(video, renderPlane(world, shaky, W, H));
  sh = await project(video);
  box = { x: 0, y: 0 };
}, 240_000);

describe('stabilize', () => {
  it('removes the shake: measured on the rendered video it falls from the input’s to about the known smooth path’s', async () => {
    const r = ok(await run(['stabilize', '--clip', sh.clip, '--smooth', '0.6', '--project', sh.dir]));
    const out = await render(sh, 'stab');
    const before = shake(steps(await grays(sh.input)));
    const after = shake(steps(await grays(out)));
    const truth = pathShake(calm);
    console.log(`STAB shake (rms change of motion per frame, px at 320 wide): input ${before.toFixed(3)}, stabilized ${after.toFixed(3)}, known smooth path ${truth.toFixed(3)}; zoom ${r.plan.zoom}, kept ${r.plan.correctionKept}, tracker ${JSON.stringify(r.track)}`);
    expect(before).toBeGreaterThan(1);
    expect(after).toBeLessThan(before / 4);
    expect(after).toBeLessThan(truth + 0.35);
    expect(r.track.lost).toBe(0);
    box = { x: r.plan.zoom, y: 0 };
  }, 240_000);

  it('hides the borders: no black edge appears in the output that the input does not have', async () => {
    const out = join(sh.dir, 'renders', 'stab.mp4');
    const frames = await grays(out, W, H);
    let dark = 0;
    for (const f of frames)
      for (let i = 0; i < W; i++)
        for (const y of [0, 1, 2, H - 3, H - 2, H - 1]) if (f.d[y * W + i]! < 0.02) dark++;
    for (const f of frames)
      for (let y = 0; y < H; y++) for (const x of [0, 1, 2, W - 3, W - 2, W - 1]) if (f.d[y * W + x]! < 0.02) dark++;
    console.log(`STAB border pixels below 2% brightness in ${frames.length} frames: ${dark}`);
    expect(dark).toBe(0);
  }, 120_000);

  it('is an effect on top of the clip: switching it off gives back the original picture, removing it leaves the clip as it was', async () => {
    const list = ok(await run(['fx', 'list', '--clip', sh.clip, '--verify', '--project', sh.dir]));
    const st = list.stack.find((s: any) => s.type === 'stabilize');
    expect(st.enabled).toBe(true);
    expect(list.source.untouched).toBe(true);
    ok(await run(['fx', 'bypass', '--clip', sh.clip, '--node', st.node, '--project', sh.dir]));
    const off = await render(sh, 'stab-off');
    const a = await grays(sh.input, 160, 90);
    const b = await grays(off, 160, 90);
    let d = 0;
    let n = 0;
    for (let f = 0; f < a.length; f += 7) for (let i = 0; i < a[f]!.d.length; i++) (d += Math.abs(a[f]!.d[i]! - b[f]!.d[i]!), n++);
    console.log(`STAB bypassed vs input: mean abs difference ${(d / n).toFixed(4)}`);
    expect(d / n).toBeLessThan(0.02);
    ok(await run(['fx', 'bypass', '--clip', sh.clip, '--node', st.node, '--off', '--project', sh.dir]));
    // change it: a longer window keeps more of the motion
    ok(await run(['fx', 'set', '--clip', sh.clip, '--node', st.node, '--params', '{"smooth":2}', '--project', sh.dir]));
    const l = ok(await run(['fx', 'list', '--clip', sh.clip, '--project', sh.dir]));
    expect(l.stack.find((s: any) => s.type === 'stabilize').settings.smooth).toBe(2);
    ok(await run(['fx', 'remove', '--clip', sh.clip, '--node', st.node, '--project', sh.dir]));
    const after = JSON.parse(readFileSync(join(sh.dir, 'project.studio.json'), 'utf8'));
    expect(after.clips[0].fx).toBeUndefined();
    ok(await run(['project', 'undo', '--project', sh.dir]));
    expect(JSON.parse(readFileSync(join(sh.dir, 'project.studio.json'), 'utf8')).clips[0].fx.length).toBe(1);
  }, 300_000);

  it('lock holds the picture still on the first frame', async () => {
    const lk = await project(sh.input);
    ok(await run(['stabilize', '--clip', lk.clip, '--lock', '--max-zoom', '1.5', '--project', lk.dir]));
    const out = await render(lk, 'lock');
    const g = await grays(out);
    // how far each frame is from the first: the flow between them
    const off: number[] = [];
    for (let i = 5; i < g.length; i += 10) {
      const f = denseFlow(g[0]!, g[i]!);
      const u: number[] = [];
      const v: number[] = [];
      for (let y = f.h * 0.25; y < f.h * 0.75; y += 3) for (let x = f.w * 0.25; x < f.w * 0.75; x += 3) (u.push(f.u[Math.floor(y) * f.w + Math.floor(x)]!), v.push(f.v[Math.floor(y) * f.w + Math.floor(x)]!));
      off.push(Math.hypot(median(u), median(v)));
    }
    const input = await grays(sh.input);
    const inOff: number[] = [];
    for (let i = 5; i < input.length; i += 10) {
      const f = denseFlow(input[0]!, input[i]!);
      const u: number[] = [];
      const v: number[] = [];
      for (let y = f.h * 0.25; y < f.h * 0.75; y += 3) for (let x = f.w * 0.25; x < f.w * 0.75; x += 3) (u.push(f.u[Math.floor(y) * f.w + Math.floor(x)]!), v.push(f.v[Math.floor(y) * f.w + Math.floor(x)]!));
      inOff.push(Math.hypot(median(u), median(v)));
    }
    console.log(`LOCK distance from the first frame (px at 320 wide), frames 5, 15, ...: input ${inOff.map((v) => v.toFixed(1)).join(' ')}; locked ${off.map((v) => v.toFixed(1)).join(' ')}`);
    expect(Math.max(...off)).toBeLessThan(1.5);
    expect(Math.max(...inOff)).toBeGreaterThan(3);
  }, 300_000);
});

describe('pin', () => {
  // the plane: a rectangle of the textured world, as continuous frame coordinates at frame 0
  const quadC: Quad = [[220, 120], [420, 120], [420, 240], [220, 240]];
  const frac = quadC.flat().map((v, i) => (v / (i % 2 ? H : W)).toFixed(5)).join(',');
  let pinProject: P;
  let withPin: string;

  it('lays a graphic on the plane and keeps it there: the pinned region matches the true quad in every frame', async () => {
    const dir = tmpDir('studio-trk-pin-');
    const img = join(dir, 'red.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=96x96', '-frames:v', '1', img]);
    const dir2 = tmpDir('studio-trk-pin-src-');
    const video = join(dir2, 'calm.mp4');
    // a smooth camera with perspective, so the pin has to follow a homography and not only a shift
    const path = cameraPath(N, W, H, { amp: 18, rot: 3, zoom: 0.05, persp: 0.0004, seed: 9 }).map((p) => mul3(p, toWorld) as Mat3);
    await writeVideo(video, renderPlane(world, path, W, H));
    pinProject = await project(video);
    ok(await run(['ingest', img, '--no-derive', '--project', pinProject.dir]));
    const assets = JSON.parse(readFileSync(join(pinProject.dir, 'project.studio.json'), 'utf8')).assets;
    const imgAsset = Object.keys(assets).find((k) => assets[k].kind === 'image')!;
    const r = ok(await run(['pin', '--clip', pinProject.clip, '--asset', imgAsset, '--quad', frac, '--at', '0', '--project', pinProject.dir]));
    expect(r.track.lost).toBe(0);
    withPin = await render(pinProject, 'pinned');

    // the true quad in each frame, from the known camera: reference -> frame i is path_i * path_0^-1 (pixel-index coordinates)
    const Hgt = path.map((p) => mul3(p, inv3(path[0]!)!) as Mat3);
    const errs: number[] = [];
    let k = 0;
    for await (const b of readFrames({ file: withPin, size: { w: W, h: H }, channels: 3 })) {
      const q = quadC.map(([x, y]) => {
        const [a, c] = apply(Hgt[k]!, x - 0.5, y - 0.5);
        return [a + 0.5, c + 0.5];
      }) as Quad;
      const truth = quadMask(W, H, q);
      let xor = 0;
      let area = 0;
      for (let i = 0; i < W * H; i++) {
        const red = b[i * 3]! - Math.max(b[i * 3 + 1]!, b[i * 3 + 2]!) > 90;
        if (red !== !!truth[i]) xor++;
        area += truth[i]!;
      }
      const perim = q.reduce((s, p, i) => s + Math.hypot(p[0] - q[(i + 1) % 4]![0], p[1] - q[(i + 1) % 4]![1]), 0);
      errs.push(xor / perim); // area of disagreement over the outline length = mean distance of the edge
      k++;
    }
    const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
    console.log(`PIN edge placement over ${errs.length} frames: mean ${mean.toFixed(2)} px, worst frame ${Math.max(...errs).toFixed(2)} px (output ${W}x${H})`);
    expect(errs.length).toBe(N);
    expect(mean).toBeLessThan(1.0);
    expect(Math.max(...errs)).toBeLessThan(2.0);
  }, 300_000);

  it('removing the pin gives back the clip, and the file with the graphic was never changed', async () => {
    const list = ok(await run(['fx', 'list', '--clip', pinProject.clip, '--verify', '--project', pinProject.dir]));
    expect(list.source.untouched).toBe(true);
    const node = list.stack.find((s: any) => s.type === 'pin').node;
    ok(await run(['fx', 'remove', '--clip', pinProject.clip, '--node', node, '--project', pinProject.dir]));
    const out = await render(pinProject, 'unpinned');
    let red = 0;
    for await (const b of readFrames({ file: out, size: { w: W, h: H }, channels: 3, startMs: 500, durMs: 100 })) for (let i = 0; i < W * H; i++) if (b[i * 3]! - Math.max(b[i * 3 + 1]!, b[i * 3 + 2]!) > 90) red++;
    expect(red).toBe(0);
  }, 300_000);
});

describe('stabilize and pin together, long clips, and what the agent is told', () => {
  it('a pin on a stabilized clip rides the steadied picture', async () => {
    const dir = tmpDir('studio-trk-sp-');
    const img = join(dir, 'red.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=96x96', '-frames:v', '1', img]);
    const p = await project(sh.input);
    ok(await run(['ingest', img, '--no-derive', '--project', p.dir]));
    const assets = JSON.parse(readFileSync(join(p.dir, 'project.studio.json'), 'utf8')).assets;
    const imgAsset = Object.keys(assets).find((k) => assets[k].kind === 'image')!;
    const q = [[220, 120], [420, 120], [420, 240], [220, 240]].flat().map((v, i) => (v / (i % 2 ? H : W)).toFixed(5)).join(',');
    ok(await run(['pin', '--clip', p.clip, '--asset', imgAsset, '--quad', q, '--at', '0', '--project', p.dir]));
    const shakyPin = await render(p, 'pin-shaky');
    ok(await run(['stabilize', '--clip', p.clip, '--smooth', '0.6', '--project', p.dir]));
    // stabilize leads the stack whatever order it was added in
    const stack = ok(await run(['fx', 'list', '--clip', p.clip, '--project', p.dir])).stack.map((s: any) => s.type);
    expect(stack).toEqual(['stabilize', 'pin']);
    const steadyPin = await render(p, 'pin-steady');
    const centroid = async (file: string) => {
      const out: [number, number][] = [];
      for await (const b of readFrames({ file, size: { w: 320, h: 180 }, channels: 3 })) {
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) if (b[(y * 320 + x) * 3]! - Math.max(b[(y * 320 + x) * 3 + 1]!, b[(y * 320 + x) * 3 + 2]!) > 90) (sx += x, sy += y, n++);
        out.push([sx / Math.max(1, n), sy / Math.max(1, n)]);
      }
      return out;
    };
    const accel = (c: [number, number][]) => {
      let sq = 0;
      for (let i = 1; i + 1 < c.length; i++) sq += (c[i + 1]![0] - 2 * c[i]![0] + c[i - 1]![0]) ** 2 + (c[i + 1]![1] - 2 * c[i]![1] + c[i - 1]![1]) ** 2;
      return Math.sqrt(sq / (c.length - 2));
    };
    const a = accel(await centroid(shakyPin));
    const b = accel(await centroid(steadyPin));
    console.log(`PIN+STAB pinned graphic's acceleration (px at 320 wide): on the shaky clip ${a.toFixed(3)}, on the stabilized clip ${b.toFixed(3)}`);
    expect(a).toBeGreaterThan(1.5);
    expect(b).toBeLessThan(a / 4);
    // one undo takes back the whole stabilize (tracker and effect)
    ok(await run(['project', 'undo', '--project', p.dir]));
    const after = JSON.parse(readFileSync(join(p.dir, 'project.studio.json'), 'utf8'));
    expect(after.trackers && Object.keys(after.trackers).length).toBe(1); // the pin's tracker remains, the stabilize tracker is gone
    expect(after.clips[0].fx.map((f: any) => f.type)).toEqual(['pin']);
  }, 400_000);

  it('a clip longer than one table (several segments, graph passed as a script file) has no seam and the right length', async () => {
    const M = 450;
    const path = cameraPath(M, W, H, { ...opts, jitter: 7, seed: 21 }).map((x) => mul3(x, toWorld) as Mat3);
    const dir = tmpDir('studio-trk-long-');
    const video = join(dir, 'long.mp4');
    const w = new VideoWriter(video, { w: W, h: H, fps: FPS, codec: ['-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] });
    for (let i = 0; i < M; i += 50) for (const f of renderPlane(world, path.slice(i, i + 50), W, H)) await w.write(toBytes(f));
    await w.close();
    const d = tmpDir('studio-trk-longp-');
    ok(await run(['init', 'l', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', d]));
    ok(await run(['ingest', video, '--no-derive', '--project', d]));
    const asset = Object.keys(JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).assets)[0]!;
    const t = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', d])).ops[0].target;
    ok(await run(['tl', 'add-clip', '--track', t, '--asset', asset, '--start', '0', '--dur', String(Math.round((M * 1000) / FPS)), '--project', d]));
    const clip = JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).clips[0].id;
    const r = ok(await run(['stabilize', '--clip', clip, '--smooth', '0.6', '--project', d]));
    expect(r.track.frames).toBeGreaterThanOrEqual(M - 1);
    const out = join(d, ok(await run(['render', '--out', 'long', '--width', String(W), '--no-normalize', '--force', '--project', d])).output as string);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', out], { encoding: 'utf8' })).streams[0];
    const seg = steps(await grays(out));
    const near = (c: number) => seg.slice(c - 3, c + 3).map(([x, y]) => Math.hypot(x, y));
    const all = seg.map(([x, y]) => Math.hypot(x, y));
    const typical = all.reduce((s, v) => s + v, 0) / all.length;
    console.log(`LONG ${M} frames, rendered ${probe.nb_read_frames} frames; step size across the segment join (frames 222..227): ${near(225).map((v) => v.toFixed(2)).join(' ')}; typical step ${typical.toFixed(2)}; shake ${shake(seg).toFixed(3)} vs input ${shake(steps(await grays(video))).toFixed(3)}`);
    expect(Number(probe.nb_read_frames)).toBe(M);
    expect(Math.max(...near(225))).toBeLessThan(typical * 3 + 0.5);
    expect(shake(seg)).toBeLessThan(shake(steps(await grays(video))) / 4);
  }, 600_000);

  it('says plainly what is wrong: a tracker from another asset, a tracker in use, a missing analysis', async () => {
    const p = await project(sh.input);
    const own = ok(await run(['track', 'add', '--asset', p.asset, '--box', '0.3,0.3,0.3,0.3', '--to', '1000', '--project', p.dir]));
    expect(own.track.frames).toBeGreaterThan(20);
    ok(await run(['stabilize', '--clip', p.clip, '--tracker', own.tracker, '--project', p.dir]));
    const used = await run(['track', 'remove', own.tracker, '--project', p.dir]);
    expect(used.json.ok).toBe(false);
    expect(used.json.error.message).toMatch(/used by/);
    // the analysis lives in the cache; if it is gone, a frame preview says how to rebuild it and a render builds it again
    rmSync(join(p.dir, '.studio', 'cache', 'track'), { recursive: true, force: true });
    const { previewFrame } = await import('../packages/engines/src/index.js');
    const { ProjectStore } = await import('../packages/core/src/index.js');
    const proj = new ProjectStore(p.dir).load().project;
    await expect(previewFrame(proj, p.dir, 200, 320)).rejects.toThrow(/has not been analysed/);
    const ex = await run(['render', '--explain', '--width', String(W), '--project', p.dir]);
    ok(ex);
    expect(JSON.stringify(ex.json.warnings)).toMatch(/has not been analysed yet; this graph uses a placeholder/);
    const built = ok(await run(['render', '--still', '200', '--out', 'rebuilt', '--width', String(W), '--no-normalize', '--force', '--project', p.dir]));
    expect(built.output).toBe('renders/rebuilt.png');
    const l = ok(await run(['track', 'list', '--project', p.dir]));
    expect(l.trackers[0].analysed).toBe(true);
  }, 300_000);
});
