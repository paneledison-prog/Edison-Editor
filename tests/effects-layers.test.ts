/**
 * Effects on cut-out elements (layers), checked on rendered pixels. No model is needed: a grey square over a magenta
 * background is cut out by its outline (marks and colours alone) and laid over a blue clip. Magenta is the old background the
 * cutout hides, so any of it reaching the result is a leak; grey and blue are all a correct result may mix.
 *
 * What must hold (measured on real footage in docs/layers.md): effects that move or mix pixels move the element's edge with it
 * and bring in nothing hidden; light falls around the element; a keyer keeps the element's transparency; a colour effect gives
 * the same picture before or after the cutout; a padded (letterboxed) element is transparent in its bars; a still shows a
 * time-driven effect where the full render has it; slow motion interpolates the matte with the picture.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { windowClips } from '../packages/engines/src/index.js';
import { readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run } from './studio-cli.js';

const W = 320;
const H = 180;
const FPS = 30;
// the colours as rendered (the conversion to the output's colour matrix moves them a few levels): set from the element alone
let GREY = [128, 128, 128];
let BLUE = [30, 96, 255];
// the square, in pixels of the frame
const SQ = { x: 120, y: 50, w: 80, h: 80 };

interface Scene {
  p: string;
  below: string;
  el: string;
}

/** Blue below; above it the square shot, cut out by the square's outline (a cutout on the clip: an element). */
async function scene(opts: { shotW?: number; hidden?: string } = {}): Promise<Scene> {
  const d = tmpDir('studio-fxl-src-');
  const shot = join(d, 'square.mp4');
  const blue = join(d, 'blue.mp4');
  const sw = opts.shotW ?? W;
  const sq = { ...SQ, x: SQ.x - (W - sw) / 2 };
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${opts.hidden ?? '0xff00ff'}:s=${sw}x${H}:r=${FPS}:d=1`, '-vf', `drawbox=x=${sq.x}:y=${sq.y}:w=${sq.w}:h=${sq.h}:color=0x808080:t=fill`, '-c:v', 'libx264', '-crf', '2', '-pix_fmt', 'yuv444p', shot]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e60ff:s=${W}x${H}:r=${FPS}:d=1`, '-c:v', 'libx264', '-crf', '2', '-pix_fmt', 'yuv444p', blue]);
  const p = tmpDir('studio-fxl-');
  ok(await run(['init', 'fxl', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', p]));
  ok(await run(['ingest', blue, shot, '--no-derive', '--project', p]));
  const proj = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8'));
  const ids = Object.entries(proj.assets as Record<string, { path: string }>);
  const aBlue = ids.find(([, a]) => a.path.includes('blue'))![0];
  const aSq = ids.find(([, a]) => a.path.includes('square'))![0];
  const t1 = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'below', '--project', p])).ops[0].target;
  const t2 = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'element', '--project', p])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t1, '--asset', aBlue, '--start', '0', '--dur', '1000', '--project', p]));
  ok(await run(['tl', 'add-clip', '--track', t2, '--asset', aSq, '--start', '0', '--dur', '1000', '--project', p]));
  const clips = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips as { id: string; track: string }[];
  const el = clips.find((c) => c.track === t2)!.id;
  const o = `${sq.x},${sq.y};${sq.x + sq.w},${sq.y};${sq.x + sq.w},${sq.y + sq.h};${sq.x},${sq.y + sq.h}`;
  ok(await run(['cutout', '--clip', el, '--outline', o, '--px', '--at', '0', '--engine', 'colour', '--project', p]));
  return { p, below: clips.find((c) => c.track === t1)!.id, el };
}

let n = 0;
async function still(p: string, ms = 500, w = W, h = H): Promise<Uint8Array> {
  const name = `fxl${n++}`;
  const r = ok(await run(['render', '--still', String(ms), '--out', name, '--width', String(w), '--project', p]));
  for await (const b of readFrames({ file: join(p, r.output ?? `renders/${name}.png`), size: { w, h }, channels: 3 })) return new Uint8Array(b);
  throw new Error('no frame');
}
const at = (img: Uint8Array, x: number, y: number, w = W) => [img[3 * (y * w + x)]!, img[3 * (y * w + x) + 1]!, img[3 * (y * w + x) + 2]!];
/** How far a pixel is from every mix of grey and blue (levels): a soft edge that brings in something else makes it large. */
function offMix(c: number[]): number {
  // the mix a*grey + (1-a)*blue nearest in red and green, then the distance of all three channels from it
  let best = 1e9;
  for (let a = 0; a <= 1.0001; a += 0.01) best = Math.min(best, Math.max(...c.map((v, i) => Math.abs(v - (a * GREY[i]! + (1 - a) * BLUE[i]!)))));
  return best;
}
/** Pixels in a ring around the square, from `inner` px outside its outline to `outer` px. */
function ring(inner: number, outer: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = SQ.y - outer; y < SQ.y + SQ.h + outer; y++)
    for (let x = SQ.x - outer; x < SQ.x + SQ.w + outer; x++) {
      const dx = Math.max(SQ.x - x, x - (SQ.x + SQ.w - 1), 0);
      const dy = Math.max(SQ.y - y, y - (SQ.y + SQ.h - 1), 0);
      const d = Math.max(dx, dy);
      if (d >= inner && d <= outer) out.push([x, y]);
    }
  return out;
}
const fxAdd = async (s: Scene, effect: string, params: object, ...flags: string[]) => ok(await run(['fx', 'add', '--clip', s.el, '--effect', effect, '--params', JSON.stringify(params), ...flags, '--project', s.p]));

/** How far apart two renders are around the square's outline (from 3 px inside to `outer` px outside): mean and 99th percentile. */
function edgeDiff(a: Uint8Array, b: Uint8Array, outer: number): { mean: number; p99: number } {
  const d = ring(0, outer)
    .concat(ring(-3, -1))
    .map(([x, y]) => Math.max(...at(a, x, y).map((v, i) => Math.abs(v - at(b, x, y)[i]!))))
    .sort((p, q) => p - q);
  return { mean: Math.round((10 * d.reduce((s, v) => s + v, 0)) / d.length) / 10, p99: d[Math.floor(d.length * 0.99)]! };
}

describe('effects on a cut-out element', () => {
  let s: Scene;
  let twin: Scene; // the same shot with a green background hidden by the cutout instead of magenta
  let base: Uint8Array;
  beforeAll(async () => {
    s = await scene();
    twin = await scene({ hidden: '0x00ff00' });
    base = await still(s.p);
    GREY = at(base, SQ.x + 40, SQ.y + 40);
    BLUE = at(base, 40, 40);
  }, 300_000);

  it('the element alone: grey inside, blue around, nothing of the hidden background', async () => {
    // as rendered: near the sources' grey (128) and blue (30, 96, 255)
    expect(Math.max(...GREY.map((v) => Math.abs(v - 128)))).toBeLessThan(8);
    expect(Math.max(...BLUE.map((v, i) => Math.abs(v - [30, 96, 255][i]!)))).toBeLessThan(12);
    // what remains is the two mattes differing a little and colour kept at half resolution (4:2:0) at a hard, saturated edge
    const e = edgeDiff(base, await still(twin.p), 4);
    console.log(`FXL element alone: magenta or green hidden behind it moves its edge by ${e.mean} levels on average (99th percentile ${e.p99})`);
    expect(e.mean).toBeLessThan(5.5);
    expect(e.p99).toBeLessThan(24);
  }, 120_000);

  it('a blur after the cutout softens the edge outward and brings in nothing hidden', async () => {
    const r = await fxAdd(s, 'gaussian-blur', { radius: 6 }, '--after-cutout');
    const img = await still(s.p);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', r.node, '--project', s.p]));
    const r2 = await fxAdd(twin, 'gaussian-blur', { radius: 6 }, '--after-cutout');
    const img2 = await still(twin.p);
    ok(await run(['fx', 'remove', '--clip', twin.el, '--node', r2.node, '--project', twin.p]));
    const hidden = edgeDiff(img, img2, 14);
    // outside the square, a few px out: no longer pure blue (the soft edge reaches it)
    const out3 = ring(3, 3).map(([x, y]) => Math.max(...at(img, x, y).map((v, i) => Math.abs(v - BLUE[i]!))));
    const leak = Math.max(...ring(0, 14).map(([x, y]) => offMix(at(img, x, y))));
    console.log(`FXL blur after the cutout: 3 px outside the square ${(out3.reduce((a, b) => a + b, 0) / out3.length).toFixed(1)} levels from blue; nearest grey-blue mix within 14 px: worst ${leak.toFixed(1)} levels off; magenta or green hidden: ${hidden.mean} levels apart on average (99th percentile ${hidden.p99})`);
    expect(out3.reduce((a, b) => a + b, 0) / out3.length).toBeGreaterThan(8);
    expect(leak).toBeLessThan(14);
    expect(hidden.mean).toBeLessThan(2);
    expect(hidden.p99).toBeLessThan(8);
  }, 120_000);

  it('placed after the cutout by default when it moves pixels or adds light; colour effects before', async () => {
    const blur = await fxAdd(s, 'gaussian-blur', { radius: 4 });
    expect(blur.placed).toMatch(/^after the cutout, by default/);
    const look = await fxAdd(s, 'lumetri', { exposure: 0.5 });
    expect(look.placed).toBe('before the cutout');
    const forced = await run(['fx', 'add', '--clip', s.el, '--effect', 'wave-warp', '--before-cutout', '--project', s.p]);
    expect(forced.json.ok).toBe(true);
    expect(JSON.stringify(forced.json.warnings)).toContain('old background');
    const fx = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((c: { id: string }) => c.id === s.el).fx as { node: string; id?: string; after?: boolean }[];
    expect(fx.find((f) => f.node === blur.node)!.after).toBe(true);
    expect(fx.find((f) => f.node === look.node)!.after).toBeUndefined();
    for (const node of [blur.node, look.node, forced.json.data.node]) ok(await run(['fx', 'remove', '--clip', s.el, '--node', node, '--project', s.p]));
  }, 120_000);

  it('glow after the cutout falls around the element, on what is below', async () => {
    const r = await fxAdd(s, 'glow', { radius: 10, amount: 1 }, '--after-cutout');
    const img = await still(s.p);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', r.node, '--project', s.p]));
    const lift = ring(3, 6).map(([x, y]) => at(img, x, y)[0]! - at(base, x, y)[0]!);
    const far = Math.max(...at(img, 20, 20).map((v, i) => Math.abs(v - at(base, 20, 20)[i]!)));
    console.log(`FXL glow after the cutout: red raised ${(lift.reduce((a, b) => a + b, 0) / lift.length).toFixed(1)} levels 3..6 px around the square; far away ${far}`);
    expect(lift.reduce((a, b) => a + b, 0) / lift.length).toBeGreaterThan(4);
    expect(far).toBeLessThanOrEqual(1);
  }, 120_000);

  it('a keyer after the cutout keeps the element transparent where the cutout made it so', async () => {
    const r = await fxAdd(s, 'keyer', { key: '#00ff00' }, '--after-cutout');
    const img = await still(s.p);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', r.node, '--project', s.p]));
    const worst = Math.max(...[[20, 20], [300, 160], [60, 90], [260, 90]].map(([x, y]) => Math.max(...at(img, x!, y!).map((v, i) => Math.abs(v - at(base, x!, y!)[i]!)))));
    console.log(`FXL keyer after the cutout: away from the element ${worst} levels from the element alone`);
    expect(worst).toBeLessThanOrEqual(2);
  }, 120_000);

  it('a colour effect gives the same picture before or after the cutout, edge included', async () => {
    const a = await fxAdd(s, 'lumetri', { exposure: 1, saturation: 50 }, '--after-cutout');
    const after = await still(s.p);
    ok(await run(['fx', 'set', '--clip', s.el, '--node', a.node, '--before-cutout', '--project', s.p]));
    const before = await still(s.p);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', a.node, '--project', s.p]));
    let worst = 0;
    for (let k = 0; k < after.length; k++) worst = Math.max(worst, Math.abs(after[k]! - before[k]!));
    console.log(`FXL colour effect before vs after the cutout: worst pixel ${worst} levels apart`);
    expect(worst).toBeLessThanOrEqual(3);
  }, 120_000);

  it('light rays render before the cutout (an effect whose graph does not end on its output)', async () => {
    const r = await fxAdd(s, 'light-rays', { threshold: 0.4 }, '--before-cutout');
    await still(s.p);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', r.node, '--project', s.p]));
  }, 120_000);

  it('a one-pass stabilizer is refused on an element (its matte would not move with it)', async () => {
    const r = await run(['fx', 'add', '--clip', s.el, '--effect', 'stabilize', '--project', s.p]);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.fix).toContain('studio stabilize');
  });

  it('slow motion interpolates the matte, its edge colours and the picture alike', async () => {
    ok(await run(['video', 'speed', '--clip', s.el, '--factor', '0.5', '--project', s.p]));
    const r = await fxAdd(s, 'slowmo', { mode: 'blend' });
    const g = ok(await run(['render', '--still', '300', '--explain', '--project', s.p]));
    const fc: string = g.ffmpegArgs[g.ffmpegArgs.indexOf('-filter_complex') + 1];
    const inputs = fc.split(';').filter((l) => /^\[\d+:v\]tpad=stop=2:stop_mode=clone/.test(l.trim())).length;
    // the picture, its matte (and its edge colours when the matte has them) are each interpolated, then cut back to length
    expect(inputs).toBeGreaterThanOrEqual(2);
    expect(fc.split(';').filter((l) => l.includes('trim=duration=')).length).toBe(inputs);
    await still(s.p, 300);
    ok(await run(['fx', 'remove', '--clip', s.el, '--node', r.node, '--project', s.p]));
    ok(await run(['video', 'speed', '--clip', s.el, '--factor', '1', '--project', s.p]));
  }, 180_000);
});

describe('cut-out elements and the render window', () => {
  it('a letterboxed element is transparent in its bars, even moved over the picture', async () => {
    // a 4:3 element in a 16:9 picture is padded left and right (with the project background); moving it brings its left bar
    // (x 0..40) over the blue at x 60..100
    const s = await scene({ shotW: 240 });
    ok(await run(['project', 'set', '--background', '#ffffff', '--project', s.p]));
    ok(await run(['layer', 'move', '--clip', s.el, '--dx', '60', '--project', s.p]));
    const img = await still(s.p, 500, W, H);
    // the blue there, against the blue at x 300 (inside the element's frame, outside its square and bars)
    const worst = Math.max(...[65, 75, 85, 95].flatMap((x) => [20, 90, 160].map((y) => Math.max(...at(img, x, y).map((v, i) => Math.abs(v - at(img, 300, y)[i]!))))));
    console.log(`FXL letterboxed element moved over the picture: its bar is ${worst} levels from the blue below`);
    expect(worst).toBeLessThanOrEqual(3);
  }, 300_000);

  it('a still or preview range keeps time-driven effects on the clip\'s own clock', () => {
    const c = { id: 'c_aaaa', track: 't_aaaa', asset: 'a_aaaa', start: 1000, dur: 3000, srcIn: 0 } as never;
    const [w] = windowClips([c], 2500, 2600) as { start: number; headCutMs?: number }[];
    expect(w!.start).toBe(0);
    expect(w!.headCutMs).toBe(1500);
    // the effect clock: start less what was cut, = -1.5 s on the window's timeline, 1 s on the full one
    expect((w!.start - w!.headCutMs!) / 1000 + 2.5).toBe(1);
  });
});
