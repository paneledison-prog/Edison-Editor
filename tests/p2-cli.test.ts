import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, ensureScenes, ensureTalk, fx, type Truth } from './fixtures.js';
import { projectWith, tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
let truth: Truth;
beforeAll(async () => {
  // the CLI bundle is built once by tests/global-setup.ts
  ensureFixtures();
  ensureScenes();
  truth = await ensureTalk();
}, 300_000);

interface Out {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
}
const studio = (args: string[]): Promise<Out> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: err ? ((err as any).code as number) : 0, json, stdout, stderr });
    }),
  );
const bytes = (dir: string) => readFileSync(join(dir, 'project.studio.json'));
const bandDb = (file: string, fromMs: number, toMs: number, hz: number) => {
  const e = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-ss',
      String(fromMs / 1000),
      '-t',
      String((toMs - fromMs) / 1000),
      '-i',
      file,
      '-vn',
      '-af',
      `${hz < 500 ? 'lowpass=f=450,lowpass=f=450,lowpass=f=450' : 'highpass=f=900,highpass=f=900,highpass=f=900'},astats=metadata=0`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  ).stderr;
  const m = [...e.matchAll(/RMS level dB: (-?[\d.]+)/g)];
  return Number(m[m.length - 1]![1]);
};

/** Silences expected from the schedule: gaps between speech of at least 0.4 s, plus leading and trailing. */
function expectedSilences(t: Truth) {
  const out: { startMs: number; endMs: number }[] = [];
  const sp = t.speech;
  if (sp[0]!.startMs >= 400) out.push({ startMs: 0, endMs: sp[0]!.startMs });
  for (let i = 1; i < sp.length; i++)
    if (sp[i]!.startMs - sp[i - 1]!.endMs >= 400)
      out.push({ startMs: sp[i - 1]!.endMs, endMs: sp[i]!.startMs });
  if (t.durationMs - sp.at(-1)!.endMs >= 400)
    out.push({ startMs: sp.at(-1)!.endMs, endMs: t.durationMs });
  return out;
}

describe('P2 exit criterion: 10-minute talking head with planted pauses', () => {
  it('cuts every planted pause, keeps speech and micro-gaps, then QC passes: loudness within 1 LU, no clicks at joins', async () => {
    const dir = tmpDir('studio-p2-');
    await studio([
      'init',
      'Talk',
      '--width',
      '640',
      '--height',
      '360',
      '--fps',
      '30',
      '--project',
      dir,
    ]);
    const ing = await studio(['ingest', fx('talk.mp4'), '--no-derive', '--project', dir]);
    const aid = ing.json.data.ingested[0].id;
    expect(ing.json.data.ingested[0].probe.durMs).toBe(600_000);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'Talk',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    const add = await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      aid,
      '--start',
      '0',
      '--dur',
      '600000',
      '--src-in',
      '0',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    expect(add.json.ok, add.stdout).toBe(true);
    const before = bytes(dir);

    // 1. Plan (dry run) and compare with the planted truth.
    let t0 = performance.now();
    const plan = await studio([
      'video',
      'cut-silence',
      '--clip',
      'c_01',
      '--dry-run',
      '--project',
      dir,
    ]);
    const planMs = performance.now() - t0;
    expect(plan.json.ok, plan.stdout).toBe(true);
    const d = plan.json.data;
    const want = expectedSilences(truth);
    console.log(
      `P2 cut-silence plan: ${d.silencesFound} silences (truth ${want.length}), ${d.cuts} cuts, removed ${d.removedMs} ms (${(d.removedFraction * 100).toFixed(1)}%), threshold ${d.thresholdDb} dB, analysis ${planMs.toFixed(0)} ms`,
    );
    expect(d.thresholdDb).toBe(-50);
    expect(d.silencesFound).toBe(want.length);
    expect(d.silencesFound).toBeGreaterThanOrEqual(truth.pauses.length - 1);
    expect(d.removedFraction).toBeLessThan(0.4);
    // every removed span matches a planted silence trimmed by the 100 ms padding, within detector tolerance
    let worst = 0;
    for (const w of want) {
      const rs = w.startMs === 0 ? 0 : w.startMs + 100;
      const re = w.endMs >= truth.durationMs ? truth.durationMs : w.endMs - 100;
      const got = d.removed.find((r: any) => r.startMs < re && r.endMs > rs);
      expect(got, `planted silence ${w.startMs}-${w.endMs} was not cut`).toBeTruthy();
      worst = Math.max(worst, Math.abs(got.startMs - rs), Math.abs(got.endMs - re));
    }
    console.log(`P2 worst edge error vs planted truth: ${worst} ms`);
    expect(worst).toBeLessThanOrEqual(80);
    // nothing speech-bearing is removed: every removed span lies inside a planted silence
    for (const r of d.removed) {
      expect(
        want.some((w) => r.startMs >= w.startMs - 80 && r.endMs <= w.endMs + 80),
        `removed ${r.startMs}-${r.endMs} overlaps speech`,
      ).toBe(true);
    }
    // micro-gaps (0.25 s) survive: no removed span touches one
    for (const g of truth.microGaps)
      expect(d.removed.some((r: any) => r.startMs < g.endMs && r.endMs > g.startMs)).toBe(false);
    expect(bytes(dir).equals(before)).toBe(true); // a dry run changes nothing

    // 2. Apply, check the timeline, undo, redo.
    const cut = await studio(['video', 'cut-silence', '--clip', 'c_01', '--project', dir]);
    expect(cut.json.ok, cut.stdout).toBe(true);
    expect(cut.json.data.analysisCached).toBe(true); // second run reuses the cached analysis
    const show = await studio(['project', 'show', '--project', dir]);
    const expectedDur = 600_000 - d.removedMs;
    expect(show.json.data.timelineMs).toBe(expectedDur);
    expect(show.json.data.clips).toBe(d.keptSegments);
    const after = bytes(dir);
    await studio(['project', 'undo', '--project', dir]);
    expect(bytes(dir).equals(before)).toBe(true);
    await studio(['project', 'redo', '--project', dir]);
    expect(bytes(dir).equals(after)).toBe(true);
    expect((await studio(['project', 'validate', '--project', dir])).json.ok).toBe(true);

    // 3. Render and QC.
    t0 = performance.now();
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '640',
      '--x264-preset',
      'veryfast',
      '--project',
      dir,
    ]);
    const renderMs = performance.now() - t0;
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.durationMs).toBe(expectedDur);
    expect(r.json.data.loudness).toMatchObject({ mode: 'two-pass', targetI: -14 });
    t0 = performance.now();
    const qc = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
    const qcMs = performance.now() - t0;
    const checks = (qc.json.ok ? qc.json.data : qc.json.error.details).checks as any[];
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    console.log(
      `P2 render ${(renderMs / 1000).toFixed(1)} s for ${(expectedDur / 1000).toFixed(0)} s of output; qc ${(qcMs / 1000).toFixed(1)} s; loudness ${JSON.stringify(by.loudness.value)}; joins checked ${by.joins.value?.length}, clicks ${by.joins.value?.filter((j: any) => j.click).length}`,
    );
    expect(qc.json.ok, JSON.stringify(checks.filter((c) => c.status === 'fail'))).toBe(true);
    expect(by.loudness.status).toBe('pass');
    expect(Math.abs(by.loudness.value.integratedLufs + 14)).toBeLessThanOrEqual(1);
    expect(by.joins.status).toBe('pass');
    expect(by.joins.value.length).toBe(d.keptSegments - 1);
    expect(by.duration.status).toBe('pass');
    expect(by.clipping.status).toBe('pass');

    // 4. The long pauses are really gone from the output.
    const sil = await studio([
      'inspect',
      'silence',
      r.json.data.output,
      '--noise-db',
      '-50',
      '--min-s',
      '0.9',
      '--project',
      dir,
    ]);
    console.log(
      `P2 silences >= 0.9 s left in the render: ${sil.json.data.count} (original had ${want.length})`,
    );
    expect(sil.json.data.count).toBe(0);
  }, 600_000);
});

describe('cut-silence guards', () => {
  it('refuses to remove more than 40% without --yes, then applies exactly the speech plus padding', async () => {
    const { dir, ids } = await projectWith([fx('voice.wav')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'audio',
      '--name',
      'VO',
      '--id',
      't_a1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_a1',
      '--asset',
      ids['voice.wav']!,
      '--start',
      '0',
      '--dur',
      '9000',
      '--src-in',
      '0',
      '--id',
      'c_vo',
      '--project',
      dir,
    ]);
    const before = bytes(dir);
    const g = await studio(['video', 'cut-silence', '--clip', 'c_vo', '--project', dir]);
    expect(g.code).toBe(2);
    expect(g.json.error.code).toBe('NEEDS_CONFIRMATION');
    expect(g.json.error.details.removedFraction).toBeGreaterThan(0.4);
    expect(bytes(dir).equals(before)).toBe(true);
    const ok = await studio(['video', 'cut-silence', '--clip', 'c_vo', '--yes', '--project', dir]);
    expect(ok.json.ok, ok.stdout).toBe(true);
    // speech is 2000-5000 ms; kept = 1900..5100 (100 ms padding each side)
    expect(ok.json.data.removed.map((r: any) => [r.startMs, r.endMs])).toEqual([
      [0, 1900],
      [5100, 9000],
    ]);
    const show = await studio(['project', 'show', '--project', dir]);
    expect(show.json.data.timelineMs).toBe(3200);
  }, 120_000);

  it('refuses --min-s under 0.4, sped-up clips, and clips without audio', async () => {
    const { dir, ids } = await projectWith([fx('noaudio.mp4'), fx('clean.mp4')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['noaudio.mp4']!,
      '--start',
      '0',
      '--dur',
      '3000',
      '--id',
      'c_na',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['clean.mp4']!,
      '--start',
      '3000',
      '--dur',
      '4000',
      '--id',
      'c_cl',
      '--project',
      dir,
    ]);
    expect(
      (await studio(['video', 'cut-silence', '--clip', 'c_na', '--project', dir])).json.error
        .message,
    ).toMatch(/no audio/);
    expect(
      (await studio(['video', 'cut-silence', '--clip', 'c_cl', '--min-s', '0.2', '--project', dir]))
        .json.error.message,
    ).toMatch(/natural rhythm/);
    await studio(['video', 'speed', '--clip', 'c_cl', '--factor', '2', '--project', dir]);
    expect(
      (await studio(['video', 'cut-silence', '--clip', 'c_cl', '--project', dir])).json.error
        .message,
    ).toMatch(/sped up 2x/);
    expect((await studio(['video', 'cut-silence', '--clip', 'c_zzz', '--project', dir])).code).toBe(
      2,
    );
  }, 120_000);
});

describe('scenes', () => {
  it('finds the planted cuts at 2.0 s and 4.0 s, adds markers on request, and never cuts', async () => {
    const { dir, store, ids } = await projectWith([fx('scenes.mp4')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['scenes.mp4']!,
      '--start',
      '1000',
      '--dur',
      '6000',
      '--src-in',
      '0',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    const r = await studio(['video', 'scenes', '--asset', ids['scenes.mp4']!, '--project', dir]);
    expect(r.json.data.cuts.map((c: any) => c.tMs)).toEqual([2000, 4000]);
    expect(r.json.warnings[0]).toMatch(/candidates, not cuts/);
    const clips0 = store.load().project.clips.length;
    const a = await studio(['video', 'scenes', '--clip', 'c_01', '--apply', '--project', dir]);
    expect(a.json.data.cuts.map((c: any) => c.timelineMs)).toEqual([3000, 5000]); // clip starts at 1 s
    const p = store.load().project;
    expect(p.markers.map((m) => [m.t, m.label])).toEqual([
      [3000, 'Scene 2'],
      [5000, 'Scene 3'],
    ]);
    expect(p.clips.length).toBe(clips0);
    expect(
      (
        await studio([
          'video',
          'scenes',
          '--asset',
          ids['scenes.mp4']!,
          '--threshold',
          '0.99',
          '--project',
          dir,
        ])
      ).json.data.count,
    ).toBe(0);
    expect(
      (
        await studio([
          'video',
          'scenes',
          '--asset',
          ids['scenes.mp4']!,
          '--apply',
          '--project',
          dir,
        ])
      ).code,
    ).toBe(2);
  }, 120_000);
});

describe('speed and reframe commands', () => {
  it('speed: reports duration, ripples on request, warns above 8x', async () => {
    const { dir, ids } = await projectWith([fx('clean.mp4')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['clean.mp4']!,
      '--start',
      '0',
      '--dur',
      '4000',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['clean.mp4']!,
      '--start',
      '4000',
      '--dur',
      '2000',
      '--id',
      'c_02',
      '--project',
      dir,
    ]);
    const s = await studio([
      'video',
      'speed',
      '--clip',
      'c_01',
      '--factor',
      '4',
      '--ripple',
      '--project',
      dir,
    ]);
    expect(s.json.data).toMatchObject({ durBeforeMs: 4000, durAfterMs: 1000, rippled: true });
    const show = await studio(['project', 'show', '--project', dir]);
    expect(show.json.data.timelineMs).toBe(3000);
    const fast = await studio([
      'video',
      'speed',
      '--clip',
      'c_02',
      '--factor',
      '12',
      '--project',
      dir,
    ]);
    expect(fast.json.warnings.join()).toMatch(/above 8x the audio is dropped/);
    expect(
      (await studio(['video', 'speed', '--clip', 'c_02', '--factor', '99', '--project', dir])).code,
    ).toBe(2);
  }, 120_000);

  it('reframe: records an export, reports the cost, renders it with --export, and refuses reframe "auto"', async () => {
    const { dir, ids, store } = await projectWith([fx('clean.mp4')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['clean.mp4']!,
      '--start',
      '0',
      '--dur',
      '3000',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    const r = await studio([
      'video',
      'reframe',
      '--to',
      'vertical',
      '--method',
      'center-crop',
      '--still',
      '1000',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data).toMatchObject({
      export: 'vert',
      preset: 'vertical-1080x1920',
      method: 'center-crop',
      canvas: '1080x1920',
    });
    expect(r.json.warnings.join()).toMatch(/center crop keeps 32% of the source width/);
    expect(r.json.warnings.join()).toMatch(/look before you rely on it/);
    expect(existsSync(join(dir, r.json.data.still))).toBe(true);
    expect(store.load().project.exports).toEqual([
      { id: 'vert', preset: 'vertical-1080x1920', reframe: 'center-crop' },
    ]);
    const out = await studio([
      'render',
      '--export',
      'vert',
      '--width',
      '270',
      '--no-normalize',
      '--x264-preset',
      'ultrafast',
      '--project',
      dir,
    ]);
    expect(out.json.data).toMatchObject({
      width: 270,
      height: 480,
      reframe: 'center-crop',
      preset: 'vertical-1080x1920',
    });
    store.apply([
      { type: 'export.set', args: { id: 'auto', preset: 'square-1080', reframe: 'auto' } },
    ]);
    const bad = await studio(['render', '--export', 'auto', '--project', dir]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/needs tracking data that is not available/);
    expect(
      (await studio(['render', '--export', 'nope', '--project', dir])).json.error.message,
    ).toMatch(/export nope not found/);
  }, 180_000);
});

describe('audio commands: measure, change, measure again', () => {
  it('denoise reports the noise floor before and after, undo restores, arnndn without a model changes nothing', async () => {
    const { dir, ids } = await projectWith([fx('noisy.wav')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'audio',
      '--name',
      'VO',
      '--id',
      't_a1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_a1',
      '--asset',
      ids['noisy.wav']!,
      '--start',
      '0',
      '--dur',
      '6000',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    const before = bytes(dir);
    const r = await studio([
      'audio',
      'denoise',
      '--clip',
      'c_01',
      '--nr',
      '20',
      '--nf',
      '-45',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.noiseFloorDeltaDb).toBeLessThan(-6);
    expect(r.json.data.before.noiseFloorDbfs).toBeLessThan(-40);
    expect(r.json.data.filtergraph).toContain('afftdn=nr=20:nf=-45');
    expect(r.json.warnings.join()).toMatch(/Timbre and naturalness are not measured/);
    const proj = JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8'));
    expect(proj.clips[0].fx.map((f: any) => f.type)).toEqual(['highpass', 'denoise']);
    await studio(['project', 'undo', '--project', dir]);
    expect(bytes(dir).equals(before)).toBe(true);
    const m = await studio([
      'audio',
      'denoise',
      '--clip',
      'c_01',
      '--method',
      'arnndn',
      '--project',
      dir,
    ]);
    expect(m.code).toBe(3);
    expect(m.json.error.fix).toMatch(/record its license/);
    expect(bytes(dir).equals(before)).toBe(true);
    const dry = await studio(['audio', 'denoise', '--clip', 'c_01', '--dry-run', '--project', dir]);
    expect(dry.json.data.applied).toBe(false);
    expect(bytes(dir).equals(before)).toBe(true);
  }, 120_000);

  it('clean-podcast prints its filtergraph and lands within 1 LU of -16; normalize hits its target; both are re-measured through the render chain', async () => {
    const { dir, ids } = await projectWith([fx('quiet.mp4')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--id',
      't_v1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      ids['quiet.mp4']!,
      '--start',
      '0',
      '--dur',
      '5000',
      '--id',
      'c_01',
      '--project',
      dir,
    ]);
    const p = await studio([
      'audio',
      'clean-podcast',
      '--clip',
      'c_01',
      '--presence',
      '--project',
      dir,
    ]);
    expect(p.json.ok, p.stdout).toBe(true);
    expect(p.json.data.steps).toEqual([
      'highpass',
      'denoise',
      'eq',
      'compress',
      'limit',
      'loudnorm',
    ]);
    expect(p.json.data.filtergraph).toMatch(
      /highpass=f=80,afftdn=nr=12:nf=-50,equalizer=f=250.*equalizer=f=3000.*acompressor=.*alimiter=.*loudnorm=I=-16.*measured_I=.*linear=true,aresample=48000/,
    );
    expect(Math.abs(p.json.data.after.integratedLufs + 16)).toBeLessThanOrEqual(1);
    expect(p.json.data.before.integratedLufs).toBeLessThan(-30);
    const n = await studio([
      'audio',
      'normalize',
      '--clip',
      'c_01',
      '--target',
      '-14',
      '--project',
      dir,
    ]);
    expect(n.json.ok, n.stdout).toBe(true);
    expect(Math.abs(n.json.data.after.integratedLufs + 14)).toBeLessThanOrEqual(1);
    const fxTypes = JSON.parse(
      readFileSync(join(dir, 'project.studio.json'), 'utf8'),
    ).clips[0].fx.map((f: any) => f.type);
    expect(fxTypes.at(-1)).toBe('loudnorm'); // loudness is always last
    expect(fxTypes.filter((t: string) => t === 'loudnorm')).toHaveLength(1);
    // the same chain renders: final loudness with the preset normalization off equals the clip's own target
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '320',
      '--no-normalize',
      '--x264-preset',
      'ultrafast',
      '--project',
      dir,
    ]);
    const l = await studio(['inspect', 'loudness', r.json.data.output, '--project', dir]);
    console.log(
      `P2 podcast chain -> normalize -14: render measures ${l.json.data.integratedLufs} LUFS, TP ${l.json.data.truePeakDbtp}`,
    );
    expect(Math.abs(l.json.data.integratedLufs + 14)).toBeLessThanOrEqual(1);
  }, 180_000);

  it('duck: threshold is derived from the voice level, music sits under the voice, and the measured reduction is 12 to 18 dB', async () => {
    const { dir, ids } = await projectWith([fx('voice.wav'), fx('music.wav')]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'audio',
      '--name',
      'VO',
      '--id',
      't_a1',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'audio',
      '--name',
      'Music',
      '--id',
      't_a2',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_a1',
      '--asset',
      ids['voice.wav']!,
      '--start',
      '0',
      '--dur',
      '9000',
      '--id',
      'c_vo',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'add-clip',
      '--track',
      't_a2',
      '--asset',
      ids['music.wav']!,
      '--start',
      '0',
      '--dur',
      '9000',
      '--id',
      'c_mu',
      '--project',
      dir,
    ]);
    const d = await studio(['audio', 'duck', '--clip', 'c_mu', '--by', 't_a1', '--project', dir]);
    expect(d.json.ok, d.stdout).toBe(true);
    console.log(
      `P2 duck: speech ${d.json.data.speechLufs} LUFS, music ${d.json.data.musicLufs} LUFS, music gain ${d.json.data.musicGainDb} dB, threshold ${d.json.data.thresholdDb} dB`,
    );
    expect(d.json.data.musicGainDb).toBeLessThan(0);
    expect(
      (await studio(['audio', 'duck', '--clip', 'c_mu', '--by', 't_a2', '--project', dir])).code,
    ).not.toBe(0); // own track
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '320',
      '--no-normalize',
      '--x264-preset',
      'ultrafast',
      '--project',
      dir,
    ]);
    const out = join(dir, r.json.data.output);
    const free = bandDb(out, 500, 1500, 220);
    const under = bandDb(out, 3000, 4500, 220);
    const speech = bandDb(out, 3000, 4500, 1500);
    console.log(
      `P2 duck measured: music alone ${free.toFixed(1)} dB, under speech ${under.toFixed(1)} dB (reduction ${(free - under).toFixed(1)}), voice ${speech.toFixed(1)} dB`,
    );
    expect(free - under).toBeGreaterThan(12);
    expect(free - under).toBeLessThan(18);
    // music bed about 20 dB below the voice, measured by loudness over the voice-free and voice windows is approximate: check the band levels
    expect(speech - free).toBeGreaterThan(14);
  }, 180_000);
});

describe('sfx library through the CLI', () => {
  it('requires a license, searches by name and tags only, and warns on unknown licenses', async () => {
    const dir = tmpDir('studio-sfx-');
    await studio(['init', 'Lib', '--project', dir]);
    const noLic = await studio([
      'audio',
      'sfx',
      'add',
      fx('hot.wav'),
      '--tags',
      'whoosh',
      '--project',
      dir,
    ]);
    expect(noLic.code).toBe(2);
    expect(noLic.json.error.fix).toMatch(/--license unknown/);
    const a = await studio([
      'audio',
      'sfx',
      'add',
      fx('hot.wav'),
      '--tags',
      'whoosh,transition',
      '--license',
      'CC0',
      '--project',
      dir,
    ]);
    expect(a.json.data.created).toBe(true);
    const b = await studio([
      'audio',
      'sfx',
      'add',
      fx('music.wav'),
      '--tags',
      'calm,piano',
      '--license',
      'unknown',
      '--bpm',
      '80',
      '--project',
      dir,
    ]);
    expect(b.json.warnings.join()).toMatch(/license is unknown/);
    const s = await studio(['audio', 'sfx', 'search', 'calm', 'piano', '--project', dir]);
    expect(s.json.data.results.map((x: any) => [x.name, x.score])).toEqual([['music.wav', 2]]);
    expect(s.json.warnings.join()).toMatch(/names and tags only/);
    expect(s.json.warnings.join()).toMatch(/license unknown/);
    const none = await studio(['audio', 'sfx', 'search', 'violin', '--project', dir]);
    expect(none.json.data.count).toBe(0);
    expect(none.json.warnings.join()).toMatch(/nothing is fetched from the internet/);
    const l = await studio(['audio', 'sfx', 'list', '--project', dir]);
    expect(l.json.data.count).toBe(2);
  }, 120_000);
});

describe('tools registry after P2', () => {
  it('lists the P2 commands and still no stubs for later phases', async () => {
    const r = await studio(['tools']);
    const names: string[] = r.json.data.commands.map((c: any) => c.name);
    for (const n of [
      'video cut-silence',
      'video scenes',
      'video speed',
      'video reframe',
      'audio denoise',
      'audio clean-podcast',
      'audio normalize',
      'audio duck',
      'audio sfx add',
      'audio sfx search',
      'audio sfx list',
    ])
      expect(names).toContain(n);
    for (const absent of ['video broll', 'captions transcribe', 'demo build'])
      expect(names).not.toContain(absent);
  });
});
