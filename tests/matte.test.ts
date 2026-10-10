/**
 * Cut-outs through the CLI against footage whose true matte is known: an object turning and deforming in front of a panning
 * background. The matte is checked as a video (exported), the cutout as a render, and an effect limited to the matte as a
 * difference image.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VideoWriter, readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject, type Shot } from './studio-cli.js';
import { iou, renderObjectShot, type ObjectShot } from './matte-helpers.js';

const W = 480;
const H = 270;
const N = 60;
const FPS = 30;

async function writeShot(shot: ObjectShot): Promise<string> {
  const file = join(tmpDir('studio-matte-src-'), 'shot.mp4');
  const w = new VideoWriter(file, { w: W, h: H, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
  for (const f of shot.frames) await w.write(f);
  await w.close();
  return file;
}
const box = (shot: ObjectShot, i = 0) => {
  const c = shot.where[i]!;
  return `${((c.x - c.r * 1.5) / W).toFixed(4)},${((c.y - c.r * 1.5) / H).toFixed(4)},${((c.r * 3) / W).toFixed(4)},${((c.r * 3) / H).toFixed(4)}`;
};
const dot = (shot: ObjectShot, i = 0) => `${(shot.where[i]!.x / W).toFixed(4)},${(shot.where[i]!.y / H).toFixed(4)}`;
async function matteFrames(shotDir: string, out: string): Promise<Uint8Array[]> {
  const r: Uint8Array[] = [];
  for await (const b of readFrames({ file: join(shotDir, out), size: { w: W, h: H }, channels: 1 })) r.push(new Uint8Array(b));
  return r;
}
async function renderFrames(file: string): Promise<Uint8Array[]> {
  const r: Uint8Array[] = [];
  for await (const b of readFrames({ file, size: { w: W, h: H }, channels: 3 })) r.push(new Uint8Array(b));
  return r;
}
const render = async (p: Shot, name: string) => join(p.dir, ok(await run(['render', '--out', name, '--width', String(W), '--no-normalize', '--force', '--project', p.dir])).output as string);

describe('cut-outs', () => {
  const shot = renderObjectShot(N, W, H);
  let p: Shot;
  let id: string;

  it('cuts the object out of one frame and follows it: IoU against the truth on every frame, from a box and a dot', async () => {
    p = await shotProject(await writeShot(shot), { width: W, height: H, fps: FPS, frames: N });
    const r = ok(await run(['matte', 'add', '--asset', p.asset, '--at', '0', '--box', box(shot), '--fg', dot(shot), '--project', p.dir]));
    id = r.matte;
    ok(await run(['matte', 'export', id, '--out', 'renders/m.mkv', '--project', p.dir]));
    const fr = await matteFrames(p.dir, 'renders/m.mkv');
    const scores = fr.map((f, i) => iou(Float32Array.from(f, (v) => v / 255), shot.gt[i]!));
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`MATTE via CLI: ${fr.length} frames, IoU mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)}; built in ${r.wallMs} ms; coverage ${JSON.stringify(r.result.coveragePct)}`);
    expect(fr.length).toBe(N);
    expect(mean).toBeGreaterThan(0.97);
    expect(Math.min(...scores)).toBeGreaterThan(0.93);
    expect(r.result.agreementAtMarkedFrames).toMatch(/one marked frame/);
  }, 300_000);

  it('a contact sheet is written for the agent to look at', async () => {
    const r = ok(await run(['matte', 'preview', id, '--frames', '4', '--project', p.dir]));
    expect(r.frames.length).toBeGreaterThanOrEqual(4);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(p.dir, r.file), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 27 });
    expect(raw.length).toBeGreaterThan(W * H * 4);
  }, 120_000);

  it('cutout makes the picture transparent outside the matte (shown against black), keeping the object’s own pixels', async () => {
    const r = ok(await run(['cutout', '--clip', p.clip, '--matte', id, '--project', p.dir]));
    expect(r.node).toMatch(/^f_/);
    const out = await render(p, 'cut');
    const orig = await renderFrames(p.input);
    const cut = await renderFrames(out);
    // outside the true object (a few pixels clear of its edge) the picture is black; inside (a few pixels in) it is the original
    let outsideDark = 0;
    let outsideN = 0;
    let insideSame = 0;
    let insideN = 0;
    for (let i = 0; i < N; i += 3) {
      const g = shot.gt[i]!;
      for (let y = 6; y < H - 6; y++)
        for (let x = 6; x < W - 6; x++) {
          const k = y * W + x;
          let near = 0;
          for (let dy = -4; dy <= 4 && near === 0; dy += 2) for (let dx = -4; dx <= 4; dx += 2) near = Math.max(near, g[k + dy * W + dx]! > 0.02 ? 1 : 0);
          let far = 1;
          for (let dy = -4; dy <= 4 && far; dy += 2) for (let dx = -4; dx <= 4; dx += 2) if (g[k + dy * W + dx]! < 0.98) far = 0;
          if (!near) {
            outsideN++;
            if (cut[i]![3 * k]! + cut[i]![3 * k + 1]! + cut[i]![3 * k + 2]! < 40) outsideDark++;
          } else if (far) {
            insideN++;
            if (Math.abs(cut[i]![3 * k]! - orig[i]![3 * k]!) + Math.abs(cut[i]![3 * k + 1]! - orig[i]![3 * k + 1]!) + Math.abs(cut[i]![3 * k + 2]! - orig[i]![3 * k + 2]!) < 24) insideSame++;
          }
        }
    }
    console.log(`CUTOUT: outside the object ${((100 * outsideDark) / outsideN).toFixed(2)}% black; inside ${((100 * insideSame) / insideN).toFixed(2)}% the original picture`);
    expect(outsideDark / outsideN).toBeGreaterThan(0.99);
    expect(insideSame / insideN).toBeGreaterThan(0.99);
    // it is a stack entry like any other: listed, switchable, removable, and the source is untouched
    const list = ok(await run(['fx', 'list', '--clip', p.clip, '--verify', '--project', p.dir]));
    expect(list.stack.map((s: any) => s.type)).toEqual(['cutout']);
    expect(list.source.untouched).toBe(true);
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', r.node, '--project', p.dir]));
    const off = await renderFrames(await render(p, 'cut-off'));
    let diff = 0;
    for (let k = 0; k < W * H * 3; k += 7) diff += Math.abs(off[10]![k]! - orig[10]![k]!);
    expect(diff / (W * H * 3 / 7)).toBeLessThan(4); // a re-encode, not a copy
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', r.node, '--off', '--project', p.dir]));
    ok(await run(['fx', 'set', '--clip', p.clip, '--node', r.node, '--matte-invert', '--project', p.dir]));
    const inv = await renderFrames(await render(p, 'cut-inv'));
    // inverted: the object is gone and the background stays
    let invObjectDark = 0;
    let invObjectN = 0;
    const g = shot.gt[20]!;
    for (let k = 0; k < W * H; k += 5) if (g[k]! > 0.98) (invObjectN++, inv[20]![3 * k]! + inv[20]![3 * k + 1]! + inv[20]![3 * k + 2]! < 40 && invObjectDark++);
    expect(invObjectDark / invObjectN).toBeGreaterThan(0.97);
  }, 400_000);

  it('limits any effect to the object: brighter inside, untouched outside', async () => {
    const q = await shotProject(p.input, { width: W, height: H, fps: FPS, frames: N });
    const m = ok(await run(['matte', 'add', '--asset', q.asset, '--at', '0', '--box', box(shot), '--fg', dot(shot), '--project', q.dir])).matte;
    const base = await renderFrames(await render(q, 'base'));
    const fx = ok(await run(['fx', 'add', '--clip', q.clip, '--effect', 'lumetri', '--params', '{"exposure":1.2}', '--matte', m, '--feather', '1', '--project', q.dir]));
    const lit = await renderFrames(await render(q, 'lit'));
    const everywhere = ok(await run(['fx', 'add', '--clip', q.clip, '--effect', 'lumetri', '--params', '{"exposure":1.2}', '--project', q.dir]));
    void everywhere;
    let inside = 0;
    let insideN = 0;
    let outside = 0;
    let outsideN = 0;
    for (let i = 0; i < N; i += 6) {
      const g = shot.gt[i]!;
      for (let y = 8; y < H - 8; y += 2)
        for (let x = 8; x < W - 8; x += 2) {
          const k = y * W + x;
          const lum = (f: Uint8Array) => f[3 * k]! + f[3 * k + 1]! + f[3 * k + 2]!;
          let all1 = 1;
          let all0 = 1;
          for (let dy = -5; dy <= 5; dy += 5) for (let dx = -5; dx <= 5; dx += 5) (g[k + dy * W + dx]! < 0.98 && (all1 = 0), g[k + dy * W + dx]! > 0.02 && (all0 = 0));
          if (all1) (inside += lum(lit[i]!) - lum(base[i]!), insideN++);
          else if (all0) (outside += Math.abs(lum(lit[i]!) - lum(base[i]!)), outsideN++);
        }
    }
    console.log(`MATTE-LIMITED effect: inside brighter by ${(inside / insideN / 3).toFixed(1)} levels on average; outside changed by ${(outside / outsideN / 3).toFixed(2)} levels`);
    expect(inside / insideN / 3).toBeGreaterThan(15);
    expect(outside / outsideN / 3).toBeLessThan(1.5);
    const list = ok(await run(['fx', 'list', '--clip', q.clip, '--project', q.dir]));
    expect(list.stack[0].onlyInside.id).toBe(m);
    void fx;
  }, 400_000);
});

describe('marking more frames, and cut-outs on stabilized clips', () => {
  it('a second marked frame fixes the worst stretch, and the numbers say where to look', async () => {
    const shot = renderObjectShot(N, W, H, { occluder: true });
    const p = await shotProject(await writeShot(shot), { width: W, height: H, fps: FPS, frames: N });
    const first = ok(await run(['matte', 'add', '--asset', p.asset, '--at', '0', '--box', box(shot), '--fg', dot(shot), '--project', p.dir]));
    const id = first.matte;
    ok(await run(['matte', 'export', id, '--out', 'renders/one.mkv', '--project', p.dir]));
    const one = (await matteFrames(p.dir, 'renders/one.mkv')).map((f, i) => iou(Float32Array.from(f, (v) => v / 255), shot.gt[i]!));
    const worst = one.indexOf(Math.min(...one));
    const ms = Math.round((worst * 1000) / FPS);
    // an agent looking at the worst frame sees the bar in front of the object: a dot on a visible part of the object, a stroke
    // down the bar, and a box around the object
    const c = shot.where[worst]!;
    const g = shot.gt[worst]!;
    let best = { d: 1e9, x: 0, y: 0 };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x]! > 0.99) {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < best.d) best = { d, x, y };
    }
    const barX = Math.round(-50 + (worst / (N - 1)) * (W + 100)) + 18;
    const box2 = `${((c.x - c.r * 1.5) / W).toFixed(4)},${((c.y - c.r * 1.5) / H).toFixed(4)},${((c.r * 3) / W).toFixed(4)},${((c.r * 3) / H).toFixed(4)}`;
    const two = ok(await run(['matte', 'key', id, '--at', String(ms), '--box', box2, '--fg', `${(best.x / W).toFixed(4)},${(best.y / H).toFixed(4)}`, '--bg', `${(barX / W).toFixed(4)},0.25;${(barX / W).toFixed(4)},0.8`, '--project', p.dir]));
    ok(await run(['matte', 'export', id, '--out', 'renders/two.mkv', '--project', p.dir]));
    const both = (await matteFrames(p.dir, 'renders/two.mkv')).map((f, i) => iou(Float32Array.from(f, (v) => v / 255), shot.gt[i]!));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`MATTE second key at ${ms} ms (the worst frame of ${worst}): worst IoU ${Math.min(...one).toFixed(3)} -> ${Math.min(...both).toFixed(3)}, mean ${mean(one).toFixed(4)} -> ${mean(both).toFixed(4)}; agreement at the marked frames ${JSON.stringify(two.result.agreementAtMarkedFrames)}`);
    expect(both[worst]).toBeGreaterThan(0.95);
    expect(mean(both)).toBeGreaterThanOrEqual(mean(one) - 0.002);
    expect(Array.isArray(two.result.agreementAtMarkedFrames)).toBe(true);
    expect(two.markedFrames).toEqual([0, ms]);
    // marks are ops: one undo takes the second one back
    ok(await run(['project', 'undo', '--project', p.dir]));
    expect(ok(await run(['matte', 'list', '--project', p.dir])).mattes[0].markedFrames).toEqual([0]);
  }, 400_000);

  it('a cutout on a stabilized clip lines up with the object in the steadied picture', async () => {
    const shot = renderObjectShot(N, W, H);
    const p = await shotProject(await writeShot(shot), { width: W, height: H, fps: FPS, frames: N });
    ok(await run(['stabilize', '--clip', p.clip, '--lock', '--max-zoom', '1.3', '--project', p.dir]));
    const stab = await renderFrames(await render(p, 'steady'));
    ok(await run(['cutout', '--clip', p.clip, '--box', box(shot), '--fg', dot(shot), '--project', p.dir]));
    const cut = await renderFrames(await render(p, 'steady-cut'));
    // the object is the warm part of the picture (the background is blue): that is the truth, read from the steadied picture
    const scores: number[] = [];
    for (let i = 4; i < N; i += 5) {
      const warm = new Float32Array(W * H);
      const kept = new Float32Array(W * H);
      for (let k = 0; k < W * H; k++) {
        warm[k] = stab[i]![3 * k]! - stab[i]![3 * k + 2]! > 30 ? 1 : 0;
        kept[k] = cut[i]![3 * k]! + cut[i]![3 * k + 1]! + cut[i]![3 * k + 2]! > 45 ? 1 : 0;
      }
      scores.push(iou(kept, warm));
    }
    console.log(`CUTOUT on a stabilized clip: IoU of the kept region with the object read from the steadied picture ${scores.map((v) => v.toFixed(3)).join(' ')}`);
    expect(Math.min(...scores)).toBeGreaterThan(0.93);
  }, 400_000);
});

describe('an object that is not there', () => {
  it('a marked frame saying "absent" empties the matte there and keeps following from the other side', async () => {
    const n = 24;
    const shot = renderObjectShot(n, W, H);
    const p = await shotProject(await writeShot(shot), { width: W, height: H, fps: FPS, frames: n });
    const first = ok(await run(['matte', 'add', '--asset', p.asset, '--at', '0', '--box', box(shot), '--fg', dot(shot), '--engine', 'colour', '--project', p.dir]));
    const lastMs = Math.round(((n - 1) * 1000) / FPS);
    const r = ok(await run(['matte', 'key', first.matte, '--at', String(lastMs), '--absent', '--project', p.dir]));
    expect(r.markedFrames).toEqual([0, lastMs]);
    const d = JSON.parse(readFileSync(join(p.dir, '.studio', 'cache', 'matte', readdirSyncMeta(p.dir)), 'utf8'));
    expect(d.coverage[n - 1]).toBe(0); // empty where it is not there
    expect(d.coverage[0]).toBeGreaterThan(0.05); // still there at the first marked frame
    expect(d.drift).toEqual([]); // nothing to compare an absent frame with
    // marks are ops: undo takes the absent frame back
    ok(await run(['project', 'undo', '--project', p.dir]));
    expect(ok(await run(['matte', 'list', '--project', p.dir])).mattes[0].markedFrames).toEqual([0]);
  }, 300_000);
});

function readdirSyncMeta(dir: string): string {
  // the newest matte data file (the json next to the matte video)
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const base = join(dir, '.studio', 'cache', 'matte');
  return readdirSync(base).filter((f) => f.endsWith('.json')).sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs)[0]!;
}
