/**
 * Transitions (`studio tl transition`), checked on rendered pixels at exact moments.
 *
 * A red clip then a blue one on the same track (each 1 s, cut at 1000 ms; both sources 2 s long, so the red one has media after
 * its out point and the blue one before its in point). A transition on the blue clip's start is centred on the cut: 400 ms means
 * 800..1200 ms. Linear easing makes the expected values exact: a dissolve is 50% blue at the cut, 25% at 900 ms; a dip is black at
 * the cut; a wipe or a push has its edge at the middle of the frame at the cut.
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
const FPS = 25;
// the colours as rendered (the conversion to the output's colour matrix moves pure red and blue a little): measured
let RED = [255, 0, 0];
let BLUE = [0, 0, 255];

interface Seq {
  p: string;
  a: string; // red, 0..1000
  b: string; // blue, 1000..2000
  track: string;
  assets: Record<string, string>;
}

function colourClip(dir: string, name: string, hex: string, extra = ''): string {
  const f = join(dir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hex}:s=${W}x${H}:r=${FPS}:d=2`, ...(extra ? ['-vf', extra] : []), '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', '-c:a', 'aac', f]);
  return f;
}

async function sequence(opts: { bIn?: number; moving?: boolean } = {}): Promise<Seq> {
  const d = tmpDir('studio-tr-src-');
  // the clip going out: red, or (moving) a test pattern that changes every frame, under the same name
  const red = opts.moving ? join(d, 'red.mp4') : colourClip(d, 'red', '0xff0000');
  if (opts.moving) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=2`, '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', '-c:a', 'aac', red]);
  const blue = colourClip(d, 'blue', '0x0000ff');
  const below = colourClip(d, 'green', '0x00ff00');
  const p = tmpDir('studio-tr-');
  ok(await run(['init', 'tr', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', p]));
  ok(await run(['ingest', red, blue, below, '--no-derive', '--project', p]));
  const proj = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8'));
  const assets = Object.fromEntries(Object.entries(proj.assets as Record<string, { path: string }>).map(([id, a]) => [a.path.replace(/^.*\//, '').replace(/\..*$/, ''), id]));
  const track = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', p])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', track, '--asset', assets['red']!, '--start', '0', '--dur', '1000', '--src-in', '0', '--project', p]));
  ok(await run(['tl', 'add-clip', '--track', track, '--asset', assets['blue']!, '--start', '1000', '--dur', '1000', '--src-in', String(opts.bIn ?? 500), '--project', p]));
  const clips = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips as { id: string; start: number }[];
  return { p, a: clips.find((c) => c.start === 0)!.id, b: clips.find((c) => c.start === 1000)!.id, track, assets };
}

let n = 0;
async function still(p: string, ms: number): Promise<Uint8Array> {
  const name = `tr${n++}`;
  const r = ok(await run(['render', '--still', String(ms), '--out', name, '--width', String(W), '--project', p]));
  for await (const b of readFrames({ file: join(p, r.output ?? `renders/${name}.png`), size: { w: W, h: H }, channels: 3 })) return new Uint8Array(b);
  throw new Error('no frame');
}
const at = (img: Uint8Array, x: number, y: number) => [img[3 * (y * W + x)]!, img[3 * (y * W + x) + 1]!, img[3 * (y * W + x) + 2]!];
/** The share of blue in a red-blue mix (from the blue channel, against the blue as rendered). */
const blueShare = (c: number[]) => c[2]! / BLUE[2]!;
const near = (c: number[], want: number[], tol: number) => c.every((v, i) => Math.abs(v - want[i]!) <= tol);
const tr = (s: Seq, ...args: string[]) => run(['tl', 'transition', ...args, '--project', s.p]);

describe('transitions between two clips', () => {
  let s: Seq;
  beforeAll(async () => {
    s = await sequence();
    RED = at(await still(s.p, 500), W / 2, H / 2);
    BLUE = at(await still(s.p, 1500), W / 2, H / 2);
  }, 300_000);

  it('a dissolve is centred on the cut and mixes the two pictures by its progress', async () => {
    const r = ok(await tr(s, '--clip', s.b, '--in', 'dissolve', '--dur', '400', '--ease', 'linear'));
    expect(r.between).toEqual([s.a, s.b]);
    expect(r.window).toEqual([800, 1200]);
    const shares: number[] = [];
    for (const ms of [760, 900, 1000, 1100, 1240]) shares.push(blueShare(at(await still(s.p, ms), W / 2, H / 2)));
    console.log(`TRANSITION dissolve 800..1200 ms, share of blue at 760, 900, 1000, 1100, 1240 ms: ${shares.map((v) => v.toFixed(2)).join(' ')}`);
    // frames sit on the 25 fps grid: 900 ms is frame 22.5 -> 880 or 920; allow one frame of progress (0.1)
    expect(shares[0]!).toBeLessThan(0.02);
    expect(Math.abs(shares[1]! - 0.25)).toBeLessThan(0.11);
    expect(Math.abs(shares[2]! - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(shares[3]! - 0.75)).toBeLessThan(0.11);
    expect(shares[4]!).toBeGreaterThan(0.98);
  }, 300_000);

  it('a dip goes through the colour at the cut', async () => {
    ok(await tr(s, '--clip', s.b, '--in', 'dip', '--dur', '400', '--ease', 'linear', '--color', '#000000'));
    const mid = at(await still(s.p, 1000), W / 2, H / 2);
    const q = at(await still(s.p, 900), W / 2, H / 2);
    const q3 = at(await still(s.p, 1100), W / 2, H / 2);
    console.log(`TRANSITION dip to black: at the cut ${mid}, at 900 ms ${q}, at 1100 ms ${q3}`);
    expect(Math.max(...mid)).toBeLessThan(16);
    expect(q[2]!).toBeLessThan(10); // still red, darkened
    expect(Math.abs(q[0]! - RED[0]! / 2)).toBeLessThan(15);
    expect(q3[0]!).toBeLessThan(10); // already blue, coming out of black
    expect(Math.abs(q3[2]! - BLUE[2]! / 2)).toBeLessThan(15);
  }, 300_000);

  it('a wipe moves its edge across the frame; a push moves both pictures', async () => {
    ok(await tr(s, '--clip', s.b, '--in', 'wipe', '--dir', 'right', '--dur', '400', '--ease', 'linear'));
    const w = await still(s.p, 1000);
    // the edge moves right: blue on the left of the middle, red on the right
    expect(near(at(w, W / 2 - 20, H / 2), BLUE, 12)).toBe(true);
    expect(near(at(w, W / 2 + 20, H / 2), RED, 12)).toBe(true);
    ok(await tr(s, '--clip', s.b, '--in', 'push', '--dir', 'left', '--dur', '400', '--ease', 'linear'));
    const pu = await still(s.p, 1000);
    // the blue clip comes in from the right: its left edge is at the middle; the red one went half out to the left
    expect(near(at(pu, W / 2 + 20, H / 2), BLUE, 12)).toBe(true);
    expect(near(at(pu, W / 2 - 20, H / 2), RED, 12)).toBe(true);
    ok(await tr(s, '--clip', s.b, '--in', 'slide', '--dir', 'up', '--dur', '400', '--ease', 'linear'));
    const sl = await still(s.p, 1000);
    expect(near(at(sl, W / 2, H / 2 + 20), BLUE, 12)).toBe(true);
    expect(near(at(sl, W / 2, H / 2 - 20), RED, 12)).toBe(true);
    console.log(`TRANSITION wipe right / push left / slide up at the cut: edges at the middle of the frame`);
  }, 300_000);

  it('removes it, and undo brings it back', async () => {
    ok(await tr(s, '--clip', s.b, '--remove'));
    const c = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((x: { id: string }) => x.id === s.b);
    expect(c.transIn).toBeUndefined();
    expect(near(at(await still(s.p, 900), W / 2, H / 2), RED, 4)).toBe(true);
    ok(await run(['project', 'undo', '--project', s.p]));
    expect(JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((x: { id: string }) => x.id === s.b).transIn.kind).toBe('slide');
  }, 300_000);

  it('the audio is not touched: the output is as long as the timeline, one clip after the other', async () => {
    ok(await tr(s, '--clip', s.b, '--in', 'dissolve', '--dur', '400'));
    const r = ok(await run(['render', '--out', 'tr-full', '--preset', 'youtube-1080p', '--width', String(W), '--project', s.p]));
    const file = join(s.p, r.output);
    const durs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', file]).toString().trim().split('\n');
    console.log(`TRANSITION full render streams: ${durs.join(' | ')}`);
    for (const l of durs) expect(Math.abs(Number(l.split(',')[1]) - 2)).toBeLessThan(0.08);
  }, 300_000);
});

describe('the media past the cut', () => {
  it('the clip going out plays on from its own file (not a frozen frame), and a preview range shows what the stills show', async () => {
    // a moving test pattern going out, a wipe right: the right part of the frame at the cut is the pattern 1000 ms into its file
    const s = await sequence({ moving: true });
    const mov = join(s.p, JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).assets[s.assets['red']!].path);
    ok(await tr(s, '--clip', s.b, '--in', 'wipe', '--dir', 'right', '--dur', '400', '--ease', 'linear'));
    const img = await still(s.p, 1000);
    // references from the render itself: the clip's own last frame before the cut, and its file at 1000 ms (shown by making it
    // longer for a moment: the blue clip moved out of the way, then everything undone)
    const frozen = await still(s.p, 960);
    ok(await run(['tl', 'move', '--id', s.b, '--start', '1100', '--project', s.p]));
    ok(await run(['tl', 'trim', '--id', s.a, '--dur', '1100', '--project', s.p]));
    const src = await still(s.p, 1000);
    ok(await run(['project', 'undo', '--project', s.p]));
    ok(await run(['project', 'undo', '--project', s.p]));
    let dSrc = 0;
    let dFrozen = 0;
    let n2 = 0;
    for (let y = 10; y < H - 10; y += 2)
      for (let x = W / 2 + 8; x < W - 4; x += 2) {
        const k = 3 * (y * W + x);
        for (let c = 0; c < 3; c++) {
          dSrc += Math.abs(img[k + c]! - src[k + c]!);
          dFrozen += Math.abs(img[k + c]! - frozen[k + c]!);
        }
        n2 += 3;
      }
    console.log(`TRANSITION the clip going out at 1000 ms, past its out point: ${(dSrc / n2).toFixed(1)} levels from its file at 1000 ms, ${(dFrozen / n2).toFixed(1)} from its last frame before the cut`);
    expect(dSrc / n2).toBeLessThan(dFrozen / n2 / 2);
    // a preview range through the transition: its frame at the cut is the still at the cut (within the video's compression)
    const r = ok(await run(['render', '--range', '800:1200', '--out', 'tr-range', '--width', String(W), '--project', s.p]));
    const frames: Uint8Array[] = [];
    for await (const f of readFrames({ file: join(s.p, r.output), size: { w: W, h: H }, channels: 3 })) frames.push(new Uint8Array(f));
    const md = (x: Uint8Array, y: Uint8Array) => {
      let t = 0;
      for (let k = 0; k < x.length; k++) t += Math.abs(x[k]! - y[k]!);
      return t / x.length;
    };
    const k0 = Math.round((200 * FPS) / 1000);
    const near3 = [k0 - 1, k0, k0 + 1].map((k) => md(frames[k]!, img));
    // the same frame of a still with nothing moving in it (a frame of blue only, after the wipe): the video's compression alone
    const codec = md(frames[frames.length - 1]!, await still(s.p, 1160));
    console.log(`TRANSITION preview range 800..1200, against the still at the cut: frames ${k0 - 1}, ${k0}, ${k0 + 1}: ${near3.map((v) => v.toFixed(2)).join(' ')} levels (the same check at 1160 ms: ${codec.toFixed(2)})`);
    expect(near3[1]!).toBeLessThan(Math.min(near3[0]!, near3[2]!));
  }, 300_000);
});

describe('transitions without media to spare, and on one clip alone', () => {
  it('shortens and says so when a clip has no media past the cut', async () => {
    const s = await sequence({ bIn: 0 }); // the blue clip starts at the very start of its file
    const r = await tr(s, '--clip', s.b, '--in', 'dissolve', '--dur', '400', '--ease', 'linear');
    expect(r.json.ok).toBe(true);
    // no media before the blue clip's in point: the dissolve runs from the cut on, over the red clip's media after it
    expect(r.json.data.window).toEqual([1000, 1400]);
    expect(JSON.stringify(r.json.warnings)).toContain('before its in point');
    expect(blueShare(at(await still(s.p, 960), W / 2, H / 2))).toBeLessThan(0.02);
    expect(Math.abs(blueShare(at(await still(s.p, 1200), W / 2, H / 2)) - 0.5)).toBeLessThan(0.06);
  }, 300_000);

  it('fades a clip on an upper track in over what is below, and out again', async () => {
    const s = await sequence();
    const t2 = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'over', '--project', s.p])).ops[0].target;
    // a green clip over the red and blue from 400 to 1400 ms
    ok(await run(['tl', 'add-clip', '--track', t2, '--asset', s.assets['green']!, '--start', '400', '--dur', '1000', '--project', s.p]));
    const g = JSON.parse(readFileSync(join(s.p, 'project.studio.json'), 'utf8')).clips.find((c: { start: number; track: string }) => c.track === t2).id;
    const r = ok(await tr(s, '--clip', g, '--in', 'dissolve', '--dur', '400', '--ease', 'linear'));
    expect(r.between).toBeUndefined();
    expect(r.window).toEqual([400, 800]);
    ok(await tr(s, '--clip', g, '--out', 'dissolve', '--dur', '200', '--ease', 'linear'));
    const mid = at(await still(s.p, 600), W / 2, H / 2);
    const out = at(await still(s.p, 1300), W / 2, H / 2);
    console.log(`TRANSITION green fading in over red at 600 ms: ${mid}; fading out over blue at 1300 ms: ${out}`);
    // half green over half red; then half green over half blue (the green as rendered is about 0, 240, 0)
    expect(Math.abs(mid[1]! / 240 - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(mid[0]! / 240 - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(out[1]! / 240 - 0.5)).toBeLessThan(0.12);
  }, 300_000);
});
