import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
const studio = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 28 }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );
beforeAll(() => ensureFixtures());

const probe = (f: string) =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], {
      encoding: 'utf8',
    }),
  );

describe('acceptance C beyond ingest: hostile inputs render and pass QC', () => {
  it('VFR + rotated + 44.1 kHz + 48 kHz + a file with no audio, on one timeline, render to a valid file at the canvas size', async () => {
    const dir = tmpDir('studio-hostile-');
    await studio([
      'init',
      'hostile',
      '--width',
      '640',
      '--height',
      '360',
      '--fps',
      '30',
      '--project',
      dir,
    ]);
    const ing = await studio([
      'ingest',
      fx('vfr.mp4'),
      fx('rotated.mp4'),
      fx('audio44.wav'),
      fx('audio48.wav'),
      fx('noaudio.mp4'),
      '--sync',
      '--project',
      dir,
    ]);
    expect(ing.json.ok, JSON.stringify(ing.json)).toBe(true);
    const id = (name: string) =>
      ing.json.data.ingested.find((i: any) => i.assetPath.endsWith(name)).id as string;
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
      'add-track',
      '--type',
      'audio',
      '--name',
      'A',
      '--id',
      't_a1',
      '--project',
      dir,
    ]);
    let at = 0;
    for (const [n, name, dur] of [
      [1, 'vfr.mp4', 3000],
      [2, 'rotated.mp4', 3000],
      [3, 'noaudio.mp4', 3000],
    ] as const) {
      const r = await studio([
        'tl',
        'add-clip',
        '--track',
        't_v1',
        '--asset',
        id(name),
        '--start',
        String(at),
        '--dur',
        String(dur),
        '--id',
        `c_v0${n}`,
        '--project',
        dir,
      ]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      at += dur;
    }
    // two audio files with different sample rates, back to back
    expect(
      (
        await studio([
          'tl',
          'add-clip',
          '--track',
          't_a1',
          '--asset',
          id('audio44.wav'),
          '--start',
          '0',
          '--dur',
          '4000',
          '--id',
          'c_a01',
          '--project',
          dir,
        ])
      ).json.ok,
    ).toBe(true);
    expect(
      (
        await studio([
          'tl',
          'add-clip',
          '--track',
          't_a1',
          '--asset',
          id('audio48.wav'),
          '--start',
          '4000',
          '--dur',
          '4000',
          '--id',
          'c_a02',
          '--project',
          dir,
        ])
      ).json.ok,
    ).toBe(true);
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '640',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    const out = join(dir, r.json.data.output);
    const p = probe(out);
    const v = p.streams.find((s: any) => s.codec_type === 'video');
    const a = p.streams.find((s: any) => s.codec_type === 'audio');
    expect([v.width, v.height]).toEqual([640, 360]); // the rotated clip is fitted, not stretched or left sideways
    expect(a.sample_rate).toBe('48000'); // 44.1 kHz and 48 kHz inputs end up on one rate
    expect(Math.abs(Number(p.format.duration) - 9)).toBeLessThan(0.1);
    const qc = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
    const checks = (qc.json.data ?? qc.json.error.details).checks as {
      id: string;
      status: string;
      value?: unknown;
    }[];
    const failed = checks.filter((c) => c.status === 'fail');
    // a sine tone is not speech, so only the checks about the file itself must pass
    for (const id of ['container', 'streams', 'resolution', 'fps', 'duration', 'codec', 'av-sync'])
      expect(checks.find((c) => c.id === id)?.status, `${id}: ${JSON.stringify(failed)}`).toBe(
        'pass',
      );
  }, 180_000);
});
