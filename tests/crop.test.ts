/**
 * Cropping a layer (`studio layer crop`): what is cut from each side of a clip's picture is transparent and shows the tracks
 * below; the cut can be soft (feather), animated (keyframes), in pixels of the picture; it travels with the layer, applies to a
 * cut-out element as cut out (its shadow follows the cropped shape), follows the picture inside a letterboxed frame, and is an
 * effect like any other (bypass, reset and undo bring the exact picture back). Checked on rendered pixels.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run } from './studio-cli.js';

const W = 320;
const H = 180;
const FPS = 30;

/** Blue below; above it a test pattern (or the file given), both 2 s. */
async function twoLayers(aboveSize = `${W}x${H}`, above?: (file: string) => void) {
  const d = tmpDir('studio-crop-src-');
  const pat = join(d, 'pattern.mp4');
  const blue = join(d, 'blue.mp4');
  if (above) above(pat);
  else execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${aboveSize}:r=${FPS}:d=2`, '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv444p', pat]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e60ff:s=${W}x${H}:r=${FPS}:d=2`, '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv444p', blue]);
  const p = tmpDir('studio-crop-');
  ok(await run(['init', 'crop', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', p]));
  ok(await run(['ingest', blue, pat, '--no-derive', '--project', p]));
  const proj = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8'));
  const ids = Object.entries(proj.assets as Record<string, { path: string }>);
  const aBlue = ids.find(([, a]) => a.path.includes('blue'))![0];
  const aPat = ids.find(([, a]) => a.path.includes('pattern'))![0];
  const t1 = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'below', '--project', p])).ops[0].target;
  const t2 = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'above', '--project', p])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t1, '--asset', aBlue, '--start', '0', '--dur', '2000', '--project', p]));
  ok(await run(['tl', 'add-clip', '--track', t2, '--asset', aPat, '--start', '0', '--dur', '2000', '--project', p]));
  const clips = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips as { id: string; track: string }[];
  return { p, below: clips.find((c) => c.track === t1)!.id, above: clips.find((c) => c.track === t2)!.id, asset: aPat };
}

let n = 0;
async function still(p: string, ms = 500): Promise<Uint8Array> {
  const name = `crop${n++}`;
  const r = ok(await run(['render', '--still', String(ms), '--out', name, '--width', String(W), '--project', p]));
  for await (const b of readFrames({ file: join(p, r.output ?? `renders/${name}.png`), size: { w: W, h: H }, channels: 3 })) return new Uint8Array(b);
  throw new Error('no frame');
}
const at = (img: Uint8Array, x: number, y: number) => [img[3 * (y * W + x)]!, img[3 * (y * W + x) + 1]!, img[3 * (y * W + x) + 2]!];
const dist = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
/** The worst difference between two renders over a rectangle (x0..x1, y0..y1, ends excluded). */
function worst(a: Uint8Array, b: Uint8Array, x0: number, y0: number, x1: number, y1: number): number {
  let m = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m = Math.max(m, dist(at(a, x, y), at(b, x, y)));
  return m;
}

describe('layer crop', () => {
  let s: Awaited<ReturnType<typeof twoLayers>>;
  let full: Uint8Array; // the pattern over everything
  let blue: Uint8Array; // the blue alone (pattern hidden)
  beforeAll(async () => {
    s = await twoLayers();
    full = await still(s.p);
    ok(await run(['layer', 'hide', '--clip', s.above, '--project', s.p]));
    blue = await still(s.p);
    ok(await run(['layer', 'show', '--clip', s.above, '--project', s.p]));
  }, 300_000);

  it('cuts each side away to the pixel: the blue below shows there, the pattern stays elsewhere', async () => {
    const r = ok(await run(['layer', 'crop', '--clip', s.above, '--left', '0.25', '--right', '0.1', '--top', '0.2', '--project', s.p]));
    expect(r.crop).toMatchObject({ left: 0.25, right: 0.1, top: 0.2, bottom: 0 });
    expect(r.pictureKeeps).toEqual({ w: 208, h: 144, of: '320x180' });
    const img = await still(s.p);
    // cut: left 80 px, right 32 px, top 36 px; one pixel of margin either side of each line for the 4:2:0 colour
    const cut = Math.max(worst(img, blue, 0, 0, 79, H), worst(img, blue, 289, 0, W, H), worst(img, blue, 0, 0, W, 35));
    const kept = worst(img, full, 81, 37, 287, H);
    console.log(`CROP cut parts ${cut} levels from the blue below, kept part ${kept} from the uncropped pattern`);
    expect(cut).toBeLessThanOrEqual(3);
    expect(kept).toBeLessThanOrEqual(3);
    // bypass: exactly the uncropped picture; and the layer list says it is cropped
    expect(ok(await run(['layer', 'list', '--project', s.p])).layers.find((l: { clip: string }) => l.clip === s.above).crop).toMatchObject({ left: 0.25 });
    ok(await run(['fx', 'bypass', '--clip', s.above, '--node', r.node, '--project', s.p]));
    expect(worst(await still(s.p), full, 0, 0, W, H)).toBe(0);
    ok(await run(['fx', 'bypass', '--clip', s.above, '--node', r.node, '--off', '--project', s.p]));
    // reset removes it with its keyframes: the clip is as it was
    const before = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((c: { id: string }) => c.id === s.above);
    ok(await run(['layer', 'crop', '--clip', s.above, '--reset', '--project', s.p]));
    const reset = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((c: { id: string }) => c.id === s.above);
    expect(reset.fx).toBeUndefined();
    expect(before.fx).toHaveLength(1);
    expect(worst(await still(s.p), full, 0, 0, W, H)).toBe(0);
  }, 300_000);

  it('in pixels of the picture, soft with a feather, and refused when nothing would be left', async () => {
    ok(await run(['layer', 'crop', '--clip', s.above, '--left', '64', '--px', '--feather', '8', '--project', s.p]));
    const img = await still(s.p);
    const y = 120;
    // at the cut line the blue, 2 feathers in the pattern, in between a mix that rises steadily
    const mixAt = (x: number) => {
      const b = at(blue, x, y);
      const f = at(full, x, y);
      const c = at(img, x, y);
      const k = [0, 1, 2].filter((i) => Math.abs(f[i]! - b[i]!) > 30);
      return k.length ? k.reduce((s2, i) => s2 + (c[i]! - b[i]!) / (f[i]! - b[i]!), 0) / k.length : NaN;
    };
    const ramp = [62, 66, 70, 74, 78, 82].map(mixAt);
    console.log(`CROP feather 8 px at the cut line x=64: share of the picture ${ramp.map((v) => v.toFixed(2)).join(' ')}`);
    expect(ramp[0]!).toBeLessThan(0.05);
    expect(ramp[ramp.length - 1]!).toBeGreaterThan(0.9);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!).toBeGreaterThanOrEqual(ramp[i - 1]! - 0.05);
    const bad = await run(['layer', 'crop', '--clip', s.above, '--right', '0.95', '--project', s.p]);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error.message).toContain('nothing of the picture');
    ok(await run(['layer', 'crop', '--clip', s.above, '--reset', '--project', s.p]));
  }, 300_000);

  it('animated: keyframes move a side over time, and a still shows it where the full render has it', async () => {
    ok(await run(['layer', 'crop', '--clip', s.above, '--t', '0', '--left', '0', '--project', s.p]));
    const r = ok(await run(['layer', 'crop', '--clip', s.above, '--t', '1000', '--left', '0.5', '--project', s.p]));
    expect(r.keyframes.left).toHaveLength(2);
    // halfway the cut line is at a quarter of the width (x 80)
    const img = await still(s.p, 500);
    const line = [70, 75, 78, 82, 85, 90].map((x) => dist(at(img, x, 100), at(blue, x, 100)) <= 3);
    console.log(`CROP left 0 -> 0.5 over 1 s, at 0.5 s: blue at x 70,75,78 / pattern at 82,85,90: ${line.join(' ')}`);
    expect(line).toEqual([true, true, true, false, false, false]);
    // a constant over keyframes is refused, with the way out
    const bad = await run(['layer', 'crop', '--clip', s.above, '--left', '0.3', '--project', s.p]);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error.fix).toContain('--t');
    // one undo takes the last keyframe back
    ok(await run(['project', 'undo', '--project', s.p]));
    const c = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((x: { id: string }) => x.id === s.above);
    expect(Object.values(c.keyframes as Record<string, unknown[]>)[0]).toHaveLength(1);
    ok(await run(['layer', 'crop', '--clip', s.above, '--reset', '--project', s.p]));
    expect(JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((x: { id: string }) => x.id === s.above).keyframes).toBeUndefined();
  }, 300_000);

  it('travels with the layer: crop, then move', async () => {
    ok(await run(['layer', 'crop', '--clip', s.above, '--left', '0.25', '--project', s.p]));
    ok(await run(['layer', 'move', '--clip', s.above, '--dx', '40', '--project', s.p]));
    const img = await still(s.p);
    // blue over 0..120 (40 uncovered by the move + 80 cut); from 121 on the pattern moved by 40
    const cut = worst(img, blue, 0, 0, 119, H);
    let moved = 0;
    for (let y = 0; y < H; y++) for (let x = 122; x < W; x++) moved = Math.max(moved, dist(at(img, x, y), at(full, x - 40, y)));
    console.log(`CROP then move 40 px: cut and uncovered part ${cut} levels from blue, the rest ${moved} from the pattern moved`);
    expect(cut).toBeLessThanOrEqual(3);
    expect(moved).toBeLessThanOrEqual(3);
    ok(await run(['layer', 'reset', '--clip', s.above, '--project', s.p]));
    ok(await run(['layer', 'crop', '--clip', s.above, '--reset', '--project', s.p]));
  }, 300_000);
});

describe('layer crop on a cut-out element and in a letterboxed picture', () => {
  it('crops a cut-out element as cut out; its drop shadow follows the cropped shape', async () => {
    // a grey square over magenta, cut out by its outline, over blue
    const s = await twoLayers(`${W}x${H}`, (f) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xff00ff:s=${W}x${H}:r=${FPS}:d=2`, '-vf', 'drawbox=x=120:y=50:w=80:h=80:color=0x808080:t=fill', '-c:v', 'libx264', '-crf', '2', '-pix_fmt', 'yuv444p', f]),
    );
    ok(await run(['cutout', '--clip', s.above, '--outline', '120,50;200,50;200,130;120,130', '--px', '--at', '0', '--engine', 'colour', '--project', s.p]));
    const shadow = ok(await run(['fx', 'add', '--clip', s.above, '--effect', 'drop-shadow', '--params', '{"dx":0,"dy":20,"blur":0,"opacity":1}', '--project', s.p]));
    expect(shadow.placed).toMatch(/^after the cutout/);
    const whole = await still(s.p);
    // keep the right half of the square only: cut from the left up to x 160
    ok(await run(['layer', 'crop', '--clip', s.above, '--left', '0.5', '--project', s.p]));
    const img = await still(s.p);
    const blueAt = at(img, 20, 20);
    const leftHalf = dist(at(img, 140, 90), blueAt); // was grey, now cut
    const rightHalf = dist(at(img, 180, 90), at(whole, 180, 90)); // still the square
    const shadowLeft = dist(at(img, 140, 140), blueAt); // under the cut half: no shadow
    const shadowRight = dist(at(img, 180, 140), at(whole, 180, 140)); // under the kept half: the shadow as before
    console.log(`CROP cut-out element: cut half ${leftHalf} from blue, kept half ${rightHalf} from before; shadow under the cut half ${shadowLeft} from blue, under the kept half ${shadowRight} from before`);
    expect(leftHalf).toBeLessThanOrEqual(3);
    expect(rightHalf).toBeLessThanOrEqual(3);
    expect(shadowLeft).toBeLessThanOrEqual(3);
    expect(shadowRight).toBeLessThanOrEqual(3);
    expect(dist(at(whole, 180, 140), blueAt)).toBeGreaterThan(40); // there is a shadow there
  }, 300_000);

  it('cuts a fraction of the picture, not of the frame, when the picture is letterboxed', async () => {
    // a 4:3 picture (240 x 180) in the 16:9 frame: it sits at x 40..280
    const s = await twoLayers('240x180');
    ok(await run(['layer', 'crop', '--clip', s.above, '--left', '0.5', '--project', s.p]));
    const img = await still(s.p);
    ok(await run(['layer', 'hide', '--clip', s.above, '--project', s.p]));
    const blue = await still(s.p);
    ok(await run(['layer', 'show', '--clip', s.above, '--project', s.p]));
    // half of 240 from x 40: blue up to x 160, the picture after it
    const left = worst(img, blue, 0, 0, 159, H);
    const right = dist(at(img, 200, 90), at(blue, 200, 90));
    console.log(`CROP letterboxed picture, left 0.5: ${left} levels from blue up to x 159; at x 200 the picture (${right} from blue)`);
    expect(left).toBeLessThanOrEqual(3);
    expect(right).toBeGreaterThan(20);
  }, 300_000);
});
