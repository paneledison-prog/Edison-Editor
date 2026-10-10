/**
 * Clips as layers (`studio layer ...`, `studio bg layers`): a clip's picture placed over what is below it, moved, sized, turned
 * about an anchor, keyframed; linked layers moving together in time; a shot split into elements over a rebuilt background.
 * Checked on rendered pixels.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samReady } from '../packages/engines/src/index.js';
import { VideoWriter, readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject } from './studio-cli.js';
import { renderObjectShot } from './matte-helpers.js';

const W = 320;
const H = 180;
const FPS = 30;
const ready = (await samReady()).ok;

/** A project: a solid blue clip below, a test pattern above it (both 2 s). */
async function twoLayers() {
  const d = tmpDir('studio-layer-src-');
  const pat = join(d, 'pattern.mp4');
  const blue = join(d, 'blue.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=2`, '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv444p', pat]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e60ff:s=${W}x${H}:r=${FPS}:d=2`, '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv444p', blue]);
  const p = tmpDir('studio-layer-');
  ok(await run(['init', 'layers', '--width', String(W), '--height', String(H), '--fps', String(FPS), '--project', p]));
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
  return { p, below: clips.find((c) => c.track === t1)!.id, above: clips.find((c) => c.track === t2)!.id };
}

async function still(p: string, ms: number, name: string): Promise<Uint8Array> {
  const r = ok(await run(['render', '--still', String(ms), '--out', name, '--width', String(W), '--force', '--project', p]));
  const file = join(p, r.output ?? `renders/${name}.png`);
  for await (const b of readFrames({ file, size: { w: W, h: H }, channels: 3 })) return new Uint8Array(b);
  throw new Error('no frame');
}
const px = (img: Uint8Array, x: number, y: number) => [img[3 * (y * W + x)]!, img[3 * (y * W + x) + 1]!, img[3 * (y * W + x) + 2]!];
const diff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

describe('layers', () => {
  it('moves, sizes and turns a clip over the one below it, to the pixel', async () => {
    const { p, above } = await twoLayers();
    const orig = await still(p, 500, 'orig');
    // a move by whole pixels moves the picture, it does not resample it
    ok(await run(['layer', 'move', '--clip', above, '--dx', '40', '--dy', '20', '--project', p]));
    const moved = await still(p, 500, 'moved');
    let worst = 0;
    for (let y = 22; y < H - 2; y += 3) for (let x = 42; x < W - 2; x += 3) worst = Math.max(worst, diff(px(moved, x, y), px(orig, x - 40, y - 20)));
    // what it uncovers is the clip below: one even blue
    const BLUE = px(moved, 3, 3);
    expect(BLUE[2]).toBeGreaterThan(200);
    expect(BLUE[0]).toBeLessThan(80);
    let uncovered = 0;
    for (let y = 2; y < H - 2; y += 4) for (let x = 2; x < 36; x += 4) uncovered = Math.max(uncovered, diff(px(moved, x, y), BLUE));
    console.log(`LAYER move by (40, 20): worst difference from the original picture moved by hand ${worst} levels; uncovered area against the clip below ${uncovered}`);
    expect(worst).toBeLessThanOrEqual(6);
    expect(uncovered).toBeLessThanOrEqual(2);
    expect(worst).toBe(0); // a whole-pixel move is exact

    // half size about an anchor: the anchor stays put, a point twice as far from it lands halfway
    ok(await run(['layer', 'reset', '--clip', above, '--project', p]));
    ok(await run(['layer', 'move', '--clip', above, '--size', '0.5', '--ax', '0.25', '--ay', '0.25', '--project', p]));
    const half = await still(p, 500, 'half');
    const A = [W * 0.25, H * 0.25];
    let worstHalf = 0;
    for (const [x, y] of [[100, 60], [180, 120], [240, 150], [60, 140]] as const) {
      // the picture's point (x, y) is drawn at A + (p - A) / 2
      const qx = Math.round(A[0]! + (x - A[0]!) / 2);
      const qy = Math.round(A[1]! + (y - A[1]!) / 2);
      worstHalf = Math.max(worstHalf, diff(px(half, qx, qy), px(orig, x, y)));
    }
    expect(diff(px(half, W - 10, H - 10), BLUE)).toBeLessThanOrEqual(8); // what it no longer covers shows the clip below
    console.log(`LAYER size 0.5 about (0.25, 0.25): worst difference at four mapped points ${worstHalf} levels`);
    expect(worstHalf).toBeLessThanOrEqual(40); // a pattern with hard edges, sampled at half size: close, not identical

    // a quarter turn about the centre: the top-left of the picture lands at the top-right of where it was turned to
    // (a reset keeps the anchor: it is set again, to the centre)
    ok(await run(['layer', 'reset', '--clip', above, '--project', p]));
    ok(await run(['layer', 'move', '--clip', above, '--rot', '90', '--ax', '0.5', '--ay', '0.5', '--project', p]));
    const turned = await still(p, 500, 'turned');
    // with y down, clockwise: the canvas point p shows the picture's point c + R^T (p - c); for a quarter turn about the centre
    // of a 320 x 180 canvas that is the pixel (y + 70, 249 - x), a whole pixel: compared over the middle square
    let eTurn = 0;
    let eLuma = 0;
    let nTurn = 0;
    const luma = (v: number[]) => 0.299 * v[0]! + 0.587 * v[1]! + 0.114 * v[2]!;
    for (let y = 10; y < H - 10; y++)
      for (let x = 75; x < 245; x++) {
        const sx = y + 70;
        const sy = 249 - x;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        eTurn += diff(px(turned, x, y), px(orig, sx, sy));
        eLuma += Math.abs(luma(px(turned, x, y)) - luma(px(orig, sx, sy)));
        nTurn++;
      }
    const meanTurn = eTurn / nTurn;
    const meanLuma = eLuma / nTurn;
    // brightness is turned exactly; colour, kept at half resolution (4:2:0), is resampled at colour edges
    console.log(`LAYER rot 90 about the centre: mean difference from the picture turned by hand ${meanTurn.toFixed(2)} levels (brightness alone ${meanLuma.toFixed(2)}) over ${nTurn} pixels`);
    expect(meanLuma).toBeLessThan(1.5);
    expect(meanTurn).toBeLessThan(6);

    // keyframes: from 0 at the start to 100 px at 1000 ms, linear: at 500 ms it is 50 px across
    ok(await run(['layer', 'reset', '--clip', above, '--project', p]));
    ok(await run(['layer', 'move', '--clip', above, '--t', '0', '--dx', '0', '--project', p]));
    ok(await run(['layer', 'move', '--clip', above, '--t', '1000', '--dx', '100', '--project', p]));
    const mid = await still(p, 500, 'mid');
    let worstMid = 0;
    for (let y = 10; y < H - 10; y += 5) for (let x = 60; x < W - 10; x += 5) worstMid = Math.max(worstMid, diff(px(mid, x, y), px(orig, x - 50, y)));
    console.log(`LAYER keyframed dx 0 -> 100 over 1 s, at 0.5 s: worst difference from the picture moved by 50 px ${worstMid} levels`);
    expect(worstMid).toBeLessThanOrEqual(6);
    const list = ok(await run(['layer', 'list', '--project', p]));
    expect(list.layers[0].clip).toBe(above);
    expect(list.layers[0].animated).toEqual(['dx']);
    // a constant value cannot be set over keyframes (they would win): it says so instead of doing nothing
    const clash = await run(['layer', 'move', '--clip', above, '--dx', '5', '--project', p]);
    expect(clash.json.ok).toBe(false);
    // undo takes the keyframe back
    ok(await run(['project', 'undo', '--project', p]));
    const after = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips.find((c: { id: string }) => c.id === above);
    expect(after.keyframes.dx).toHaveLength(1);
  }, 300_000);

  it('linked layers move, trim and split together in time', async () => {
    const { p, below, above } = await twoLayers();
    ok(await run(['tl', 'set', '--id', below, '--patch', '{"link":"ly_test"}', '--project', p]));
    ok(await run(['tl', 'set', '--id', above, '--patch', '{"link":"ly_test"}', '--project', p]));
    const clip = (id: string) => JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips.find((c: { id: string }) => c.id === id);
    ok(await run(['tl', 'move', '--id', above, '--start', '500', '--project', p]));
    expect(clip(below).start).toBe(500);
    ok(await run(['tl', 'trim', '--id', below, '--dur', '1200', '--src-in', '100', '--project', p]));
    expect(clip(above).dur).toBe(1200);
    expect(clip(above).srcIn).toBe(100);
    ok(await run(['tl', 'split', '--id', above, '--at', '1000', '--project', p]));
    const all = JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips as { id: string; link?: string; start: number; dur: number }[];
    expect(all).toHaveLength(4);
    const right = all.filter((c) => c.start === 1000);
    expect(right).toHaveLength(2);
    expect(new Set(right.map((c) => c.link)).size).toBe(1);
    expect(right[0]!.link).toBe('ly_test@1000');
    // one undo takes the whole split back
    ok(await run(['project', 'undo', '--project', p]));
    expect(JSON.parse(readFileSync(join(p, 'project.studio.json'), 'utf8')).clips).toHaveLength(2);
  }, 300_000);

  describe.skipIf(!ready)('a shot split into layers', () => {
    it('the element moves, and where it was the background is rebuilt, not a copy of it', async () => {
      const N = 24;
      const WW = 480;
      const HH = 270;
      const shot = renderObjectShot(N, WW, HH, { speed: 1.5 });
      const clean = renderObjectShot(N, WW, HH, { speed: 1.5, noObject: true });
      const file = join(tmpDir('studio-layers-src-'), 'shot.mp4');
      const wr = new VideoWriter(file, { w: WW, h: HH, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '6', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
      for (const f of shot.frames) await wr.write(f);
      await wr.close();
      const p = await shotProject(file, { width: WW, height: HH, fps: FPS, frames: N });
      const sub = ok(await run(['bg', 'subjects', '--asset', p.asset, '--at', '0', '--project', p.dir]));
      const c0 = shot.where[0]!;
      const things = sub.subjects.filter((s: { partOf?: string }) => !s.partOf);
      const near = (s: { bbox: number[] }) => Math.hypot(s.bbox[0]! + s.bbox[2]! / 2 - c0.x / WW, s.bbox[1]! + s.bbox[3]! / 2 - c0.y / HH);
      const obj = things.slice().sort((a: { bbox: number[] }, b: { bbox: number[] }) => near(a) - near(b))[0];
      const r = ok(await run(['bg', 'layers', '--run', sub.run, '--keep', obj.id.slice(1), '--clip', p.clip, '--project', p.dir]));
      expect(r.layers).toHaveLength(2);
      const el = r.layers.find((l: { kind: string }) => l.kind === 'element');
      expect(r.background.filledFromOtherFramesPct).toBeGreaterThan(90);
      const ll = ok(await run(['layer', 'list', '--project', p.dir]));
      expect(Object.values(ll.groups)[0]).toHaveLength(2);
      // move the element far to the right of where it was
      const DX = 150;
      ok(await run(['layer', 'move', '--clip', el.clip, '--dx', String(DX), '--project', p.dir]));
      const k = 12;
      const ms = Math.round((k * 1000) / FPS);
      const rr = ok(await run(['render', '--still', String(ms), '--out', 'moved', '--width', String(WW), '--force', '--project', p.dir]));
      let img: Uint8Array | undefined;
      for await (const b of readFrames({ file: join(p.dir, rr.output ?? 'renders/moved.png'), size: { w: WW, h: HH }, channels: 3 })) img = new Uint8Array(b);
      const g = shot.gt[k]!;
      // where the object was (and is no longer): the background as it really is
      let eBack = 0, nBack = 0, eLeft = 0;
      // where it went: the object's own pixels
      let eObj = 0, nObj = 0;
      for (let y = 2; y < HH - 2; y++)
        for (let x = 2; x < WW - 2; x++) {
          const i = y * WW + x;
          const inside = g[i]! > 0.99 && g[i - 3]! > 0.99 && g[i + 3]! > 0.99 && g[i - 3 * WW]! > 0.99 && g[i + 3 * WW]! > 0.99;
          if (!inside) continue;
          const there = x + DX < WW - 2 && !(g[i + DX]! > 0.01);
          if (there) {
            // the background at the old place: it must not still show the object
            for (let c = 0; c < 3; c++) {
              eBack += Math.abs(img![3 * i + c]! - clean.frames[k]![3 * i + c]!);
              eLeft += Math.abs(img![3 * i + c]! - shot.frames[k]![3 * i + c]!);
            }
            nBack += 3;
          }
          if (x + DX < WW - 2) {
            const j = i + DX;
            for (let c = 0; c < 3; c++) eObj += Math.abs(img![3 * j + c]! - shot.frames[k]![3 * i + c]!);
            nObj += 3;
          }
        }
      const back = eBack / Math.max(1, nBack);
      const left = eLeft / Math.max(1, nBack);
      const objE = eObj / Math.max(1, nObj);
      console.log(`LAYERS element moved ${DX} px: where it was, ${back.toFixed(1)} levels from the true background (${left.toFixed(1)} from the object it was); where it went, ${objE.toFixed(1)} levels from the object's own pixels; background ${r.background.filledFromOtherFramesPct}% rebuilt from other frames`);
      expect(back).toBeLessThan(12);
      expect(left).toBeGreaterThan(back * 2);
      expect(objE).toBeLessThan(12);
    }, 900_000);
  });
});
