import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Fx } from '@studio/core';
import {
  addToLibrary,
  loadLibrary,
  measureLoudnorm,
  render,
  renderAudioChain,
  searchLibrary,
  probeFile,
} from '@studio/engines';
import { frames, loudness } from '@studio/inspect';
import { ensureFixtures, fx } from './fixtures.js';
import { projectWith, tmpDir } from './helpers.js';

beforeAll(() => ensureFixtures(), 120_000);

const rgbMean = (file: string, ms: number, crop: string) => {
  const b = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    (ms / 1000).toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${crop},scale=1:1:flags=area,format=rgb24`,
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  return [b[0]!, b[1]!, b[2]!];
};
/** RMS (dB) of one frequency band over a window of a rendered file: isolates one component of a mix. */
const bandRms = (file: string, fromMs: number, toMs: number, hz: number) => {
  const r = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-ss',
      (fromMs / 1000).toFixed(3),
      '-t',
      ((toMs - fromMs) / 1000).toFixed(3),
      '-i',
      file,
      '-vn',
      '-af',
      `${hz < 500 ? 'lowpass=f=450,lowpass=f=450,lowpass=f=450' : 'highpass=f=900,highpass=f=900,highpass=f=900'},astats=metadata=0`,
      '-f',
      'null',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  void r;
  return 0;
};
const bandRmsDb = (file: string, fromMs: number, toMs: number, hz: number): number => {
  const out = execFileSyncStderr([
    '-hide_banner',
    '-nostdin',
    '-ss',
    (fromMs / 1000).toFixed(3),
    '-t',
    ((toMs - fromMs) / 1000).toFixed(3),
    '-i',
    file,
    '-vn',
    '-af',
    `${hz < 500 ? 'lowpass=f=450,lowpass=f=450,lowpass=f=450' : 'highpass=f=900,highpass=f=900,highpass=f=900'},astats=metadata=0`,
    '-f',
    'null',
    '-',
  ]);
  const m = [...out.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)];
  return Number(m[m.length - 1]![1]);
};
function execFileSyncStderr(args: string[]): string {
  return spawnSync('ffmpeg', args, { encoding: 'utf8' }).stderr;
}
void bandRms;

async function oneClip(file: string, extra: Record<string, unknown> = {}, dur = 4000, srcIn = 0) {
  const p = await projectWith([fx(file)]);
  p.store.apply([
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
    {
      type: 'clip.add',
      args: {
        clip: { id: 'c_01', track: 't_v1', asset: p.ids[file], start: 0, dur, srcIn, ...extra },
      },
    },
  ]);
  return p;
}

describe('speed', () => {
  it('2x: output length is dur, frames come from the sped-up source, audio length matches', async () => {
    const { dir, store } = await oneClip('clean.mp4', {}, 6000);
    store.apply([{ type: 'clip.speed', args: { id: 'c_01', factor: 2 } }]); // dur 3000, consumes 6000 ms of source
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      preview: true,
    });
    expect(r.durationMs).toBe(3000);
    const out = join(dir, r.output!);
    const pr = await probeFile(out);
    expect(Math.abs(pr.probe.durMs! - 3000)).toBeLessThanOrEqual(70);
    // frame at 1000 ms of the render should be the source frame at 2000 ms, not at 1000 ms
    const [got] = await frames(out, [1000], join(dir, 'renders/inspect'), 320);
    const [want] = await frames(fx('clean.mp4'), [2000], join(dir, 'renders/inspect'), 320);
    const [wrong] = await frames(fx('clean.mp4'), [1000], join(dir, 'renders/inspect'), 320);
    const ssim = (a: string, b: string) => {
      const e = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'],
        { encoding: 'utf8' },
      ).stderr;
      return Number(/All:([\d.]+)/.exec(e)![1]);
    };
    const good = ssim(got!.path, want!.path);
    const bad = ssim(got!.path, wrong!.path);
    console.log(
      `SPEED 2x: SSIM of render@1000ms vs source@2000ms ${good.toFixed(3)}, vs source@1000ms ${bad.toFixed(3)}`,
    );
    expect(good).toBeGreaterThan(0.9);
    expect(good).toBeGreaterThan(bad + 0.05);
  }, 120_000);

  it('above 8x the audio is dropped and the render says so; below 0.5x it warns about judder', async () => {
    const { dir, store } = await oneClip('clean.mp4', {}, 6000);
    store.apply([{ type: 'clip.speed', args: { id: 'c_01', factor: 12 } }]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      preview: true,
    });
    expect(r.acodec).toBeNull();
    expect(r.notes.join()).toMatch(/above 8x, so its audio is dropped/);
    const { dir: d2, store: s2 } = await oneClip('clean.mp4', {}, 2000);
    s2.apply([{ type: 'clip.speed', args: { id: 'c_01', factor: 0.25 } }]);
    const r2 = await render({
      project: s2.load().project,
      projectDir: d2,
      preset: 'youtube-1080p',
      preview: true,
      explain: true,
    });
    expect(r2.notes.join()).toMatch(/below 0\.5x.*judder/);
    expect(r2.ffmpegArgs!.join(' ')).toMatch(/atempo=0\.5,atempo=0\.5/);
  }, 120_000);
});

describe('audio fx', () => {
  it('denoise lowers the measured noise floor, and the numbers are reported', async () => {
    const { dir } = await projectWith([]);
    const fxs: Fx[] = [
      { type: 'highpass', hz: 80 },
      { type: 'denoise', method: 'afftdn', nr: 20, nf: -45 },
    ];
    const out = join(dir, 'renders/audio/noisy-denoised.wav');
    const graph = await renderAudioChain(
      { src: fx('noisy.wav'), srcInMs: 0, srcSpanMs: 6000, channels: 1, fx: fxs },
      out,
    );
    const before = await loudness(fx('noisy.wav'));
    const after = await loudness(out);
    console.log(
      `DENOISE noise floor ${before.noiseFloorDbfs} -> ${after.noiseFloorDbfs} dBFS; graph ${graph}`,
    );
    expect(after.noiseFloorDbfs!).toBeLessThan(before.noiseFloorDbfs! - 6);
    expect(graph).toBe('aresample=48000,pan=stereo|c0=c0|c1=c0,highpass=f=80,afftdn=nr=20:nf=-45');
  });

  it('arnndn without a model fails loudly with the fix, never silently skipping', async () => {
    const { dir } = await projectWith([]);
    await expect(
      renderAudioChain(
        {
          src: fx('noisy.wav'),
          srcInMs: 0,
          srcSpanMs: 1000,
          channels: 1,
          fx: [{ type: 'denoise', method: 'arnndn' }],
        },
        join(dir, 'x.wav'),
      ),
    ).rejects.toThrow(/arnndn needs an RNNoise model/);
  });

  it('loudnorm with measured values (two-pass, linear) lands on target within 0.5 LU and under the true-peak ceiling', async () => {
    const { dir } = await projectWith([]);
    const base = { src: fx('quiet.mp4'), srcInMs: 0, srcSpanMs: 5000, channels: 1 };
    const raw = join(dir, 'raw.wav');
    await renderAudioChain({ ...base, fx: [] }, raw);
    const measured = await measureLoudnorm(raw, { I: -16, TP: -1.5 });
    const out = join(dir, 'norm.wav');
    await renderAudioChain(
      { ...base, fx: [{ type: 'loudnorm', I: -16, TP: -1.5, measured }] },
      out,
    );
    const before = await loudness(raw);
    const after = await loudness(out);
    console.log(
      `LOUDNORM ${before.integratedLufs} LUFS -> ${after.integratedLufs} LUFS (target -16), true peak ${after.truePeakDbtp} dBTP`,
    );
    expect(before.integratedLufs!).toBeLessThan(-35);
    expect(Math.abs(after.integratedLufs! + 16)).toBeLessThan(0.5);
    expect(after.truePeakDbtp!).toBeLessThanOrEqual(-1.5);
  });
});

describe('ducking', () => {
  it('music drops by 12 to 18 dB under speech, and recovers after it', async () => {
    const { dir, store, ids } = await projectWith([fx('voice.wav'), fx('music.wav')]);
    store.apply([
      { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'VO' } },
      { type: 'track.add', args: { id: 't_a2', type: 'audio', name: 'Music', role: 'music' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_vo',
            track: 't_a1',
            asset: ids['voice.wav'],
            start: 0,
            dur: 9000,
            srcIn: 0,
          },
        },
      },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_mu',
            track: 't_a2',
            asset: ids['music.wav'],
            start: 0,
            dur: 9000,
            srcIn: 0,
            fx: [
              {
                type: 'duck',
                by: 't_a1',
                thresholdDb: -35,
                ratio: 8,
                attackMs: 20,
                releaseMs: 400,
              },
            ],
          },
        },
      },
    ]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      preview: true,
    });
    const out = join(dir, r.output!);
    const free = bandRmsDb(out, 500, 1500, 220); // music alone
    const duckedDb = bandRmsDb(out, 3000, 4500, 220); // under speech (2-5 s)
    const after = bandRmsDb(out, 6500, 8000, 220); // speech over, music back
    console.log(
      `DUCK music alone ${free.toFixed(1)} dB, under speech ${duckedDb.toFixed(1)} dB (reduction ${(free - duckedDb).toFixed(1)}), after ${after.toFixed(1)} dB`,
    );
    expect(free - duckedDb).toBeGreaterThan(12);
    expect(free - duckedDb).toBeLessThan(18);
    expect(Math.abs(free - after)).toBeLessThan(1.5);
    // the voice itself is not ducked
    expect(bandRmsDb(out, 3000, 4500, 1500)).toBeGreaterThan(-24);
  }, 120_000);

  it('a clip ducked by a track with no audio in the render is left alone, with a note', async () => {
    const { dir, store, ids } = await projectWith([fx('voice.wav'), fx('music.wav')]);
    store.apply([
      { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'VO' } },
      { type: 'track.add', args: { id: 't_a2', type: 'audio', name: 'Music' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_vo',
            track: 't_a1',
            asset: ids['voice.wav'],
            start: 8000,
            dur: 1000,
            srcIn: 0,
          },
        },
      },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_mu',
            track: 't_a2',
            asset: ids['music.wav'],
            start: 0,
            dur: 9000,
            srcIn: 0,
            fx: [
              {
                type: 'duck',
                by: 't_a1',
                thresholdDb: -35,
                ratio: 8,
                attackMs: 20,
                releaseMs: 400,
              },
            ],
          },
        },
      },
    ]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      preview: true,
      range: [0, 5000],
    });
    expect(r.notes.join()).toMatch(/has no audio in this render/);
  }, 120_000);
});

describe('reframe', () => {
  const sq = async (mode: 'fit' | 'blur' | 'center-crop') => {
    const { dir, store } = await oneClip('clean.mp4', {}, 3000);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'square-1080',
      width: 540,
      reframe: mode,
      noNormalize: true,
    });
    return { out: join(dir, r.output!), r };
  };
  it('fit letterboxes on the background; center-crop fills the canvas; blur fills it with a blurred copy', async () => {
    const fit = await sq('fit');
    const crop = await sq('center-crop');
    const blur = await sq('blur');
    for (const x of [fit, crop, blur]) {
      const pr = await probeFile(x.out);
      expect([pr.probe.w, pr.probe.h]).toEqual([540, 540]);
    }
    const top = '540:60:0:0'; // a strip that lies fully in the letterbox for a 16:9 source in a square
    const f = rgbMean(fit.out, 1000, top),
      c = rgbMean(crop.out, 1000, top),
      b = rgbMean(blur.out, 1000, top);
    console.log(`REFRAME top strip mean RGB: fit ${f}, center-crop ${c}, blur ${b}`);
    expect(Math.max(...f)).toBeLessThanOrEqual(2); // the project background is black
    expect(Math.max(...c)).toBeGreaterThan(20);
    expect(Math.max(...b)).toBeGreaterThan(10);
    expect(crop.r.reframe).toBe('center-crop');
    expect(crop.r.notes.join()).toMatch(
      /center crop keeps 56% of the source width and 100% of its height/,
    );
    expect(blur.r.notes.join()).toMatch(/blurred, enlarged copy/);
  }, 180_000);
});

describe('render options', () => {
  it('--width scales the canvas keeping the preset aspect; x264 preset override is reported', async () => {
    const { dir, store } = await oneClip('clean.mp4', {}, 2000);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      width: 320,
      x264Preset: 'ultrafast',
      noNormalize: true,
    });
    expect([r.width, r.height, r.x264Preset]).toEqual([320, 180, 'ultrafast']);
    expect((await probeFile(join(dir, r.output!))).probe.w).toBe(320);
  }, 60_000);
});

describe('sfx library', () => {
  it('requires a license note; searches names and tags only; merges duplicates; warns on unknown license at render', async () => {
    const { dir, store, ids } = await projectWith([fx('music.wav')]);
    await expect(
      addToLibrary(dir, fx('music.wav'), { tags: ['calm'], license: '  ' }),
    ).rejects.toThrow(/license note is required/);
    const a = await addToLibrary(dir, fx('music.wav'), {
      tags: ['Calm', 'Piano  loop'],
      license: 'unknown',
      bpm: 90,
    });
    expect(a.created).toBe(true);
    expect(a.warnings.join()).toMatch(/license is unknown/);
    await addToLibrary(dir, fx('hot.wav'), {
      tags: ['whoosh', 'sfx'],
      license: 'CC0, own recording',
    });
    expect(loadLibrary(dir).entries.map((e) => [e.id, e.license])).toEqual([
      ['s_001', 'unknown'],
      ['s_002', 'CC0, own recording'],
    ]);

    expect(searchLibrary(dir, 'calm piano').map((h) => [h.entry.name, h.score])).toEqual([
      ['music.wav', 2],
    ]);
    expect(searchLibrary(dir, 'whoosh')[0]!.entry.id).toBe('s_002');
    expect(searchLibrary(dir, 'violin')).toEqual([]); // no tag, no name match: nothing is invented
    expect(() => searchLibrary(dir, '  ')).toThrow(/empty query/);

    const dup = await addToLibrary(dir, fx('music.wav'), {
      tags: ['bed'],
      license: 'CC-BY 4.0, credit required',
    });
    expect(dup.created).toBe(false);
    expect(dup.entry.tags).toEqual(['calm', 'piano loop', 'bed']);
    expect(dup.entry.license).toBe('CC-BY 4.0, credit required');

    // unknown license -> warning in the render report
    await addToLibrary(dir, fx('music.wav'), { tags: [], license: 'unknown' }); // does not downgrade a known license
    expect(loadLibrary(dir).entries[0]!.license).toBe('CC-BY 4.0, credit required');
    const lib = join(dir, '.studio', 'library.json');
    const j = JSON.parse(readFileSync(lib, 'utf8'));
    j.entries[0].license = 'unknown';
    (await import('node:fs')).writeFileSync(lib, JSON.stringify(j));
    store.apply([
      { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'Music' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_mu',
            track: 't_a1',
            asset: ids['music.wav'],
            start: 0,
            dur: 2000,
            srcIn: 0,
          },
        },
      },
    ]);
    const r = await render({
      project: store.load().project,
      projectDir: dir,
      preset: 'youtube-1080p',
      preview: true,
    });
    expect(r.notes.join()).toMatch(/license unknown for music\.wav \(s_001/);
    expect(existsSync(join(dir, r.output!))).toBe(true);
    mkdirSync(join(tmpDir(), 'x'), { recursive: true });
  }, 120_000);
});
