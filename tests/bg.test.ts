/**
 * Removing a video's background through the CLI (`studio bg subjects`, `bg remove`, `bg check`): find what is in the shot, keep
 * things by number, check the result. Uses the promptable segmenter (SAM 2.1 tiny); skipped where it is not installed.
 *
 * The shot: a textured object that moves, turns and changes size over a panning textured background (tests/matte-helpers.ts), so
 * the true matte is known. The segmenter is made for natural pictures and is only roughly right on this flat synthetic object
 * (docs/masks.md); the numbers that matter are measured on real footage (docs/cutouts.md). What must hold here is the whole way
 * through: the moving object is found and numbered, keeping it by number gives a matte that follows it and a cutout on the clip,
 * two kept things are united, and the frames to look at are named.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samReady } from '../packages/engines/src/index.js';
import { VideoWriter, readFrames } from '../packages/vision/src/index.js';
import { tmpDir } from './helpers.js';
import { ok, run, shotProject } from './studio-cli.js';
import { iou, renderObjectShot } from './matte-helpers.js';

const W = 480;
const H = 270;
const N = 16;
const FPS = 30;
const ready = (await samReady()).ok;

async function matteFrames(dir: string, id: string): Promise<Float32Array[]> {
  ok(await run(['matte', 'export', id, '--out', `renders/${id}.mkv`, '--project', dir]));
  const out: Float32Array[] = [];
  for await (const b of readFrames({ file: join(dir, 'renders', `${id}.mkv`), size: { w: W, h: H }, channels: 1 })) out.push(Float32Array.from(b, (v) => v / 255));
  return out;
}

describe.skipIf(!ready)('background removal (bg)', () => {
  it('finds the moving object, keeps it by number, unites two things, and names the frames to look at', async () => {
    const shot = renderObjectShot(N, W, H);
    const file = join(tmpDir('studio-bg-src-'), 'shot.mp4');
    const wr = new VideoWriter(file, { w: W, h: H, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
    for (const f of shot.frames) await wr.write(f);
    await wr.close();
    const p = await shotProject(file, { width: W, height: H, fps: FPS, frames: N });

    // 1. what is in the shot
    const sub = ok(await run(['bg', 'subjects', '--asset', p.asset, '--at', '0', '--project', p.dir]));
    expect(sub.run).toMatch(/^sub_/);
    expect(existsSync(join(p.dir, sub.sheet))).toBe(true);
    expect(existsSync(join(p.dir, sub.each))).toBe(true);
    const things = sub.subjects.filter((s: { partOf?: string }) => !s.partOf);
    expect(things.length).toBeGreaterThanOrEqual(1);
    // the agent looks at the sheet and picks the object: here, the thing whose box is nearest the object's
    const c = shot.where[0]!;
    const near = (s: { bbox: number[] }) => Math.hypot(s.bbox[0]! + s.bbox[2]! / 2 - c.x / W, s.bbox[1]! + s.bbox[3]! / 2 - c.y / H);
    const obj = things.slice().sort((a: { bbox: number[] }, b: { bbox: number[] }) => near(a) - near(b))[0];
    console.log(`BG subjects: ${things.length} things, ${sub.subjects.length - things.length} parts; the object is ${obj.id} (${obj.areaPct}% of the frame, ${obj.colour}, ${obj.moves}); the truth covers ${((100 * shot.gt[0]!.reduce((s, v) => s + v, 0)) / (W * H)).toFixed(1)}%`);

    // 2. keep it: a matte that follows it, and a cutout on the clip
    const keep = obj.id.slice(1);
    const r = ok(await run(['bg', 'remove', '--run', sub.run, '--keep', keep, '--clip', p.clip, '--project', p.dir]));
    expect(r.cutout.clip).toBe(p.clip);
    expect(r.result.quality).toBeDefined();
    expect(existsSync(join(p.dir, r.preview))).toBe(true);
    const fx = JSON.parse(readFileSync(join(p.dir, 'project.studio.json'), 'utf8')).clips[0].fx;
    expect(fx.some((f: { type: string; matte?: { id: string } }) => f.type === 'cutout' && f.matte?.id === r.matte)).toBe(true);
    const frames = await matteFrames(p.dir, r.matte);
    const scores = frames.map((f, i) => iou(f, shot.gt[i]!));
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const first = iou(frames[0]!, shot.gt[0]!);
    console.log(`BG remove keep ${obj.id}: IoU with the truth mean ${mean.toFixed(3)}, min ${Math.min(...scores).toFixed(3)}, marked frame ${first.toFixed(3)}; ${r.wallMs} ms; quality ${JSON.stringify(r.result.quality)}`);
    // the marked frame is the subject's own mask; following keeps close to it (the segmenter is rough on this synthetic object)
    expect(mean).toBeGreaterThan(0.45);
    expect(Math.min(...scores)).toBeGreaterThan(first - 0.3);

    // 3. two things kept: the union holds both, pixel by pixel the larger of the two
    if (things.length >= 2) {
      const other = things.find((s: { id: string }) => s.id !== obj.id);
      const u = ok(await run(['bg', 'remove', '--run', sub.run, '--keep', `${keep},${other.id.slice(1)}`, '--project', p.dir, '--asset', p.asset, '--from', '0', '--to', String(Math.round(((N - 1) * 1000) / FPS))]));
      expect(u.members).toHaveLength(2);
      const uf = await matteFrames(p.dir, u.matte);
      const m0 = await matteFrames(p.dir, u.members[0]);
      const m1 = await matteFrames(p.dir, u.members[1]);
      for (const i of [0, Math.floor(N / 2), N - 1]) {
        let bad = 0;
        for (let k = 0; k < W * H; k++) if (Math.abs(uf[i]![k]! - Math.max(m0[i]![k]!, m1[i]![k]!)) > 2 / 255) bad++;
        expect(bad).toBe(0);
      }
      console.log(`BG union of ${obj.id} and ${other.id}: members ${u.members.join(', ')}; coverage ${JSON.stringify(u.result.coveragePct)}`);
    }

    // 4. the check: quality per frame and a sheet of the frames most likely to be wrong
    const chk = ok(await run(['bg', 'check', r.matte, '--project', p.dir]));
    expect(existsSync(join(p.dir, chk.file))).toBe(true);
    expect(chk.frames.length).toBeGreaterThanOrEqual(2);
    expect(chk.frames.every((f: { how?: string }) => typeof f.how === 'string')).toBe(true);

    // 5. --visible-until: after that time the kept thing is not in the picture, so the matte is empty there
    const until = Math.round((8 * 1000) / FPS);
    const v = ok(await run(['bg', 'remove', '--run', sub.run, '--keep', keep, '--asset', p.asset, '--visible-until', String(until), '--project', p.dir]));
    const vf = await matteFrames(p.dir, v.matte);
    const covAfter = vf.slice(10).map((f) => f.reduce((s, x) => s + x, 0) / (W * H));
    const covBefore = vf.slice(0, 8).map((f) => f.reduce((s, x) => s + x, 0) / (W * H));
    expect(Math.max(...covAfter)).toBeLessThan(0.002);
    expect(Math.min(...covBefore)).toBeGreaterThan(0.01);
  }, 900_000);

  it('refuses what it cannot do, and says how', async () => {
    const shot = renderObjectShot(4, 320, 180);
    const file = join(tmpDir('studio-bg-src-'), 'shot.mp4');
    const wr = new VideoWriter(file, { w: 320, h: 180, fps: FPS, channels: 3, codec: ['-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-pix_fmt', 'yuv420p'] });
    for (const f of shot.frames) await wr.write(f);
    await wr.close();
    const p = await shotProject(file, { width: 320, height: 180, fps: FPS, frames: 4 });
    const noKeep = await run(['bg', 'remove', '--clip', p.clip, '--project', p.dir]);
    expect(noKeep.json.ok).toBe(false);
    expect(JSON.stringify(noKeep.json)).toContain('--auto');
    const noRun = await run(['bg', 'remove', '--run', 'sub_zzzz', '--keep', '1', '--project', p.dir]);
    expect(noRun.json.ok).toBe(false);
    expect(noRun.json.error.message).toContain('sub_zzzz');
  }, 300_000);
});
