import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { render, type RenderReport } from '@studio/engines';
import {
  blackFrames,
  frames,
  joinClicks,
  loudness,
  qc,
  sheets,
  silence,
  waveform,
} from '@studio/inspect';
import { ensureFixtures, fx } from './fixtures.js';
import { projectWith } from './helpers.js';

beforeAll(() => ensureFixtures(), 120_000);

/** Three clips on one video track: clean (0-3 s), blackmid (3-6 s, black at 4.0-4.5 s), quiet (7-9 s, after a 1 s gap). */
async function threeClip() {
  const p = await projectWith([fx('clean.mp4'), fx('blackmid.mp4'), fx('quiet.mp4')]);
  p.store.apply([
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
    {
      type: 'clip.add',
      args: {
        clip: {
          id: 'c_01',
          track: 't_v1',
          asset: p.ids['clean.mp4'],
          start: 0,
          dur: 3000,
          srcIn: 0,
        },
      },
    },
    {
      type: 'clip.add',
      args: {
        clip: {
          id: 'c_02',
          track: 't_v1',
          asset: p.ids['blackmid.mp4'],
          start: 3000,
          dur: 3000,
          srcIn: 1000,
        },
      },
    },
    {
      type: 'clip.add',
      args: {
        clip: {
          id: 'c_03',
          track: 't_v1',
          asset: p.ids['quiet.mp4'],
          start: 7000,
          dur: 2000,
          srcIn: 0,
        },
      },
    },
  ]);
  return p;
}
const reportOf = (dir: string, r: RenderReport) =>
  JSON.parse(readFileSync(join(dir, r.sidecar!.replace('.project.json', '.report.json')), 'utf8'));
const qcOpts = (r: any) => ({
  width: r.width,
  height: r.height,
  fps: r.fps,
  durationMs: r.durationMs,
  expectAudio: r.hasAudio,
  targetLufs: r.loudness?.targetI,
  truePeakMax: r.loudness?.targetTP,
  h264Delivery: true,
  joinsMs: r.joinsMs,
});

describe('P1 exit criterion: 3-clip timeline, render, contact sheet, planted black frame and planted loudness error', () => {
  it('detects both planted defects, and passes the loudness check when normalized', async () => {
    const { dir, store } = await threeClip();
    const project = store.load().project;

    // 1. Render with normalization on: loudness lands on target, but the planted black frame is found.
    const good = await render({ project, projectDir: dir, preset: 'youtube-1080p' });
    expect(good.durationMs).toBe(9000);
    const r1 = reportOf(dir, good);
    const q1 = await qc(join(dir, good.output!), qcOpts(r1));
    const by = (q: typeof q1, id: string) => q.checks.find((c) => c.id === id)!;
    expect(by(q1, 'loudness').status).toBe('pass');
    expect(by(q1, 'black-frames').status).toBe('fail');
    const black = (by(q1, 'black-frames').value as any[])[0];
    expect(black.frames).toBe(15);
    expect(Math.abs(black.startMs - 4000)).toBeLessThanOrEqual(34); // planted at 2.0 s of the source, srcIn 1.0 s, placed at 3.0 s
    // The timeline's gap (6-7 s) is also black on the background: both are reported, not just the planted one.
    expect(by(q1, 'duration').status).toBe('pass');
    expect(by(q1, 'codec').status).toBe('pass');
    expect(by(q1, 'resolution').status).toBe('pass');
    expect(q1.passed).toBe(false);

    // 2. Contact sheet: tiles map to times, and the sheet exists.
    const sh = await sheets(join(dir, good.output!), {
      fps: 1,
      cols: 6,
      width: 240,
      outDir: join(dir, 'renders/inspect'),
    });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.tiles).toHaveLength(9);
    expect(existsSync(sh[0]!.path)).toBe(true);

    // 3. Planted loudness error: same timeline, normalization off.
    const bad = await render({
      project,
      projectDir: dir,
      preset: 'youtube-1080p',
      noNormalize: true,
    });
    const q2 = await qc(join(dir, bad.output!), qcOpts(reportOf(dir, bad)));
    // reportOf says loudness mode none, so the target is passed explicitly: the point is the render is off target.
    const q2b = await qc(join(dir, bad.output!), {
      ...qcOpts(reportOf(dir, bad)),
      targetLufs: -14,
      truePeakMax: -1.5,
    });
    expect(by(q2b, 'loudness').status).toBe('fail');
    const li = (by(q2b, 'loudness').value as any).integratedLufs;
    console.log(
      `P1 EXIT: normalized I=${(by(q1, 'loudness').value as any).integratedLufs} LUFS; unnormalized I=${li} LUFS; black span ${black.startMs}-${black.endMs} ms (${black.frames} frames)`,
    );
    expect(li).toBeLessThan(-16);
    expect(by(q2, 'loudness').status).toBe('skipped'); // no target in the report: reported as skipped, never as passed
  }, 180_000);
});

describe('inspect tools', () => {
  it('frame: writes PNGs, rejects times past the end, and a render keeps colours within tolerance of the source', async () => {
    const { dir, store, ids } = await projectWith([fx('clean.mp4')]);
    store.apply([
      { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_01',
            track: 't_v1',
            asset: ids['clean.mp4'],
            start: 0,
            dur: 4000,
            srcIn: 1000,
          },
        },
      },
    ]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      noNormalize: true,
    });
    const [src] = await frames(fx('clean.mp4'), [2500], join(dir, 'renders/inspect'));
    const [out] = await frames(join(dir, r.output!), [1500], join(dir, 'renders/inspect')); // source 2.5 s = timeline 1.5 s
    expect(existsSync(src!.path) && existsSync(out!.path)).toBe(true);
    // 640x360 into 1920x1080 is an exact 3x fit: mean colour should match closely.
    const d = src!.meanRgb.map((v, i) => Math.abs(v - out!.meanRgb[i]!));
    console.log(`COLOR source ${src!.meanRgb} render ${out!.meanRgb} delta ${d}`);
    expect(Math.max(...d)).toBeLessThanOrEqual(6);
    await expect(
      frames(join(dir, r.output!), [99_000], join(dir, 'renders/inspect')),
    ).rejects.toThrow(/past the end/);
  }, 120_000);

  it('sheets: at most 24 tiles per sheet, with times', async () => {
    const dir = (await projectWith([])).dir;
    const s = await sheets(fx('blackmid.mp4'), {
      fps: 5,
      cols: 6,
      width: 160,
      outDir: join(dir, 'renders/inspect'),
    });
    expect(s.length).toBe(2); // 30 tiles -> 24 + 6
    expect(s[0]!.tiles).toHaveLength(24);
    expect(s[1]!.tiles).toHaveLength(6);
    expect(s[1]!.tiles[0]!.tMs).toBe(4800);
    expect(s.every((x) => existsSync(x.path))).toBe(true);
  }, 60_000);

  it('black frames: finds the planted 15-frame section in the source', async () => {
    const b = await blackFrames(fx('blackmid.mp4'), 30);
    expect(b).toHaveLength(1);
    expect(b[0]!.frames).toBe(15);
    expect(Math.abs(b[0]!.startMs - 2000)).toBeLessThanOrEqual(34);
  });

  it('loudness: quiet vs hot audio, clipping runs, noise floor', async () => {
    const quiet = await loudness(fx('quiet.mp4'));
    const hot = await loudness(fx('hot.wav'));
    expect(quiet.integratedLufs!).toBeLessThan(-35);
    expect(quiet.clippingRuns).toBe(0);
    expect(hot.clippingRuns!).toBeGreaterThan(0);
    expect(hot.samplePeakDbfs!).toBeGreaterThan(-0.1);
    const noisy = await loudness(fx('noisy.wav'));
    // white noise at amplitude 0.01 has RMS about -45 dBFS; the tone is gated off for 2 s so quiet windows exist.
    console.log(
      `NOISE FLOOR measured ${noisy.noiseFloorDbfs} dBFS (white noise a=0.01, expected about -45)`,
    );
    expect(noisy.noiseFloorDbfs!).toBeLessThan(-40);
    expect(noisy.noiseFloorDbfs!).toBeGreaterThan(-52);
    expect((await loudness(fx('noaudio.mp4'))).hasAudio).toBe(false);
  }, 60_000);

  it('silence: finds the gated-off spans, in ms', async () => {
    const s = await silence(fx('noisy.wav'), -30, 0.4);
    expect(s.spans.length).toBeGreaterThanOrEqual(1);
    expect(s.spans.some((x) => x.startMs >= 2900 && x.startMs <= 3100 && x.durMs >= 900)).toBe(
      true,
    );
  });

  it('joins: a hard splice is flagged, a faded join in a render is not', async () => {
    const hard = await joinClicks(fx('splice.wav'), [2001]);
    expect(hard[0]!.click).toBe(true);
    expect(hard[0]!.maxStep).toBeGreaterThan(0.25);

    const { dir, store, ids } = await projectWith([fx('tone.mp4')]);
    store.apply([
      { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_01',
            track: 't_v1',
            asset: ids['tone.mp4'],
            start: 0,
            dur: 2000,
            srcIn: 0,
          },
        },
      },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_02',
            track: 't_v1',
            asset: ids['tone.mp4'],
            start: 2000,
            dur: 2000,
            srcIn: 2113,
          },
        },
      }, // odd offset: phase mismatch at the cut
    ]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      noNormalize: true,
    });
    expect(r.joinsMs).toEqual([2000]);
    const c = await joinClicks(join(dir, r.output!), r.joinsMs);
    console.log(
      `JOIN hard splice: maxStep ${hard[0]!.maxStep} ratio ${hard[0]!.ratio}; faded join in render: maxStep ${c[0]!.maxStep} ratio ${c[0]!.ratio}`,
    );
    expect(c[0]!.click).toBe(false);
    // Control: the same two cuts without the render's edge fades would step by far more than the faded join does.
    expect(hard[0]!.maxStep).toBeGreaterThan(c[0]!.maxStep * 3);
  }, 120_000);

  it('waveform writes a PNG', async () => {
    const dir = (await projectWith([])).dir;
    expect(existsSync(await waveform(fx('noisy.wav'), join(dir, 'renders/inspect')))).toBe(true);
  });
});
