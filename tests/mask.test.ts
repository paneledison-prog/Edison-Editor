/**
 * The Object Mask Tool (`studio mask ...`): select an object by clicking on it, with the promptable segmenter (SAM 2.1 tiny,
 * run by tools/segment.py). Needs python with onnxruntime and the model files (`studio models fetch sam2.1-tiny`); skipped
 * (and reported as skipped) where they are not installed.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samReady } from '../packages/engines/src/index.js';
import { VideoWriter, readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject } from './studio-cli.js';
import { iou, renderObjectShot } from './matte-helpers.js';

const W = 480;
const H = 270;
const N = 12;
const FPS = 30;
const ready = (await samReady()).ok;

describe.skipIf(!ready)('Object Mask Tool', () => {
  it('a click and a box select the object, candidates are shown, and the mask follows it', async () => {
    const shot = renderObjectShot(N, W, H);
    const file = join(tmpDir('studio-mask-src-'), 'shot.mp4');
    const w = new VideoWriter(file, { w: W, h: H, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
    for (const f of shot.frames) await w.write(f);
    await w.close();
    const p = await shotProject(file, { width: W, height: H, fps: FPS, frames: N });
    const c = shot.where[0]!;
    const pt = `${(c.x / W).toFixed(4)},${(c.y / H).toFixed(4)}`;
    const box = `${((c.x - c.r * 1.5) / W).toFixed(4)},${((c.y - c.r * 1.5) / H).toFixed(4)},${((c.r * 3) / W).toFixed(4)},${((c.r * 3) / H).toFixed(4)}`;
    // look first: three candidates, nothing stored
    const pick = ok(await run(['mask', 'pick', '--asset', p.asset, '--at', '0', '--point', pt, '--box', box, '--project', p.dir]));
    expect(pick.candidates).toHaveLength(3);
    expect(pick.candidates.some((k: { keepsPointsInside: boolean }) => k.keepsPointsInside)).toBe(true);
    expect(ok(await run(['mask', 'list', '--project', p.dir])).mattes).toHaveLength(0);
    // then select
    const r = ok(await run(['mask', 'add', '--asset', p.asset, '--at', '0', '--point', pt, '--box', box, '--project', p.dir]));
    ok(await run(['mask', 'export', r.matte, '--out', 'renders/mask.mkv', '--project', p.dir]));
    const scores: number[] = [];
    let i = 0;
    for await (const b of readFrames({ file: join(p.dir, 'renders/mask.mkv'), size: { w: W, h: H }, channels: 1 })) scores.push(iou(Float32Array.from(b, (v) => v / 255), shot.gt[i++]!));
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`MASK TOOL on a synthetic shot: IoU mean ${mean.toFixed(3)}, min ${Math.min(...scores).toFixed(3)}, first frame ${scores[0]!.toFixed(3)}; built in ${r.wallMs} ms; picked candidate ${pick.auto} of ${JSON.stringify(pick.candidates.map((k: { areaPct: number }) => k.areaPct))} % areas`);
    // The segmenter is trained on natural pictures: on this flat, synthetic object it is only roughly right (see docs/masks.md,
    // measured on real clips instead). What must hold is that the tool ran and the mask is stable through time.
    expect(r.result.coveragePct.max).toBeGreaterThan(1);
    expect(mean).toBeGreaterThan(0.3);
    const frames: Float32Array[] = [];
    for await (const b of readFrames({ file: join(p.dir, 'renders/mask.mkv'), size: { w: W, h: H }, channels: 1 })) frames.push(Float32Array.from(b, (v) => v / 255));
    const steady = frames.slice(1).map((f, k) => iou(f, frames[k]!));
    console.log(`MASK TOOL steadiness: IoU of each frame with the previous ${steady.map((v) => v.toFixed(2)).join(' ')}`);
    // the object itself moves a lot between frames here, so the yardstick is the truth's own frame-to-frame overlap
    const truth = shot.gt.slice(1).map((g, k) => iou(g, shot.gt[k]!));
    const mean2 = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`MASK TOOL steadiness: mask ${mean2(steady).toFixed(3)} vs the truth's own ${mean2(truth).toFixed(3)}`);
    expect(mean2(steady)).toBeGreaterThan(mean2(truth) - 0.15);
    // a point on the background, given as "not the object", does not change what the point on the object selects
    const neg = ok(await run(['mask', 'pick', '--asset', p.asset, '--at', '0', '--point', pt, '--neg', '0.05,0.05', '--box', box, '--project', p.dir]));
    expect(neg.candidates.some((k: { keepsPointsOutside: boolean }) => k.keepsPointsOutside)).toBe(true);
  }, 600_000);
});
