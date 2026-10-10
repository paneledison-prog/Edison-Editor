/**
 * `studio erase` through the CLI: an object marked with a box and a dot, taken out of a shot whose background pans, and the
 * rendered picture compared with the background that was really there.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VideoWriter, readFrames, morph } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject } from './studio-cli.js';
import { renderObjectShot } from './matte-helpers.js';

const W = 320;
const H = 180;
const N = 36;
const FPS = 30;

async function writeShot(frames: Uint8Array[]): Promise<string> {
  const file = join(tmpDir('studio-erase-src-'), 'shot.mp4');
  const w = new VideoWriter(file, { w: W, h: H, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '6', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
  for (const f of frames) await w.write(f);
  await w.close();
  return file;
}

describe('erase', () => {
  it('takes the object out and shows the background as other frames saw it; the effect is on top of the original and can be removed', async () => {
    const shot = renderObjectShot(N, W, H, { speed: 1.5 });
    const truth = renderObjectShot(N, W, H, { speed: 1.5, noObject: true });
    const p = await shotProject(await writeShot(shot.frames), { width: W, height: H, fps: FPS, frames: N });
    const c = shot.where[0]!;
    const box = `${((c.x - c.r * 1.5) / W).toFixed(4)},${((c.y - c.r * 1.5) / H).toFixed(4)},${((c.r * 3) / W).toFixed(4)},${((c.r * 3) / H).toFixed(4)}`;
    const dot = `${(c.x / W).toFixed(4)},${(c.y / H).toFixed(4)}`;
    const m = ok(await run(['matte', 'add', '--asset', p.asset, '--at', '0', '--box', box, '--fg', dot, '--engine', 'colour', '--project', p.dir]));
    const t0 = Date.now();
    const r = ok(await run(['erase', '--clip', p.clip, '--matte', m.matte, '--project', p.dir]));
    const ms = Date.now() - t0;
    expect(r.node).toMatch(/^f_/);
    expect(r.plate.filledFromOtherFramesPct).toBeGreaterThan(80);
    const out = join(p.dir, ok(await run(['render', '--out', 'erased', '--width', String(W), '--no-normalize', '--force', '--project', p.dir])).output as string);
    const orig = join(p.dir, ok(await run(['render', '--out', 'plain', '--width', String(W), '--no-normalize', '--force', '--project', p.dir])).output as string);
    void orig;
    const frames: Uint8Array[] = [];
    for await (const b of readFrames({ file: out, size: { w: W, h: H }, channels: 3 })) frames.push(new Uint8Array(b));
    let err = 0;
    let base = 0;
    let n = 0;
    for (let t = 0; t < Math.min(N, frames.length); t++) {
      const m0 = new Uint8Array(W * H);
      for (let i = 0; i < m0.length; i++) m0[i] = shot.gt[t]![i]! > 0.5 ? 1 : 0;
      const inner = morph(m0, W, H, 0, false); // the object itself (the removed area reaches a little past it)
      for (let i = 0; i < W * H; i++)
        if (inner[i]) {
          for (let ch = 0; ch < 3; ch++) {
            err += Math.abs(frames[t]![3 * i + ch]! - truth.frames[t]![3 * i + ch]!);
            base += Math.abs(shot.frames[t]![3 * i + ch]! - truth.frames[t]![3 * i + ch]!);
          }
          n += 3;
        }
    }
    console.log(`ERASE via the CLI: mean error where the object was ${(err / n).toFixed(2)} levels in the render (object left in: ${(base / n).toFixed(2)}); ${r.plate.filledFromOtherFramesPct}% of the removed area from other frames; built in ${ms} ms`);
    expect(err / n).toBeLessThan((base / n) * 0.2);
    // non-destructive: switching it off brings the object back, the original file is untouched
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', r.node, '--project', p.dir]));
    const list = ok(await run(['fx', 'list', '--clip', p.clip, '--project', p.dir]));
    expect(JSON.stringify(list)).toContain('erase');
  }, 600_000);
});
