import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expr, propPoints, valueAt } from '../packages/engines/src/zoom.js';
import { easeFn } from '../motion/src/ease.js';
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

describe('keyframe sampling', () => {
  const clip: any = {
    id: 'c_ab',
    keyframes: {
      scale: [
        { id: 'k_1', t: 1000, v: 1, ease: 'expo.inOut' },
        { id: 'k_2', t: 2000, v: 2 },
      ],
    },
  };
  it('hits the keyframe values exactly and follows the easing in between', () => {
    const pts = propPoints(clip, 'scale', 1);
    expect(valueAt(pts, 0.5)).toBe(1);
    expect(valueAt(pts, 1)).toBeCloseTo(1, 9);
    expect(valueAt(pts, 2)).toBeCloseTo(2, 9);
    expect(valueAt(pts, 3)).toBe(2);
    const e = easeFn('expo.inOut');
    for (const u of [0.25, 0.5, 0.75]) expect(valueAt(pts, 1 + u)).toBeCloseTo(1 + e(u), 1);
    expect(valueAt(pts, 1.5)).toBeCloseTo(1.5, 6);
  });
  it('expression evaluates like the samples (checked by ffmpeg itself)', () => {
    const e = expr(propPoints(clip, 'scale', 1));
    for (const t of [0, 1.25, 1.5, 1.9, 2.5]) {
      const out = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'nullsrc=s=16x16:r=1:d=1',
          '-vf',
          `geq=lum='255*(${e.replace(/\bt\b/g, String(t))})/4'`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-',
        ],
        { encoding: 'buffer' },
      );
      // geq writes limited-range luma; the gray conversion expands it back.
      const y = (255 * valueAt(propPoints(clip, 'scale', 1), t)) / 4;
      expect(Math.abs(out[0]! - ((y - 16) * 255) / 219)).toBeLessThanOrEqual(2);
    }
  });
});

describe('zoom render (frame-exact crop)', () => {
  it('a scale keyframe renders: frame at scale 2 equals a 2x center crop of the source', async () => {
    ensureFixtures();
    const dir = tmpDir('studio-p5-zoom-');
    await studio(['init', 'z', '--width', '640', '--height', '360', '--project', dir]);
    const ing = await studio(['ingest', fx('clean.mp4'), '--project', dir]);
    const id = ing.json.data.ingested[0].id;
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'S',
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
      id,
      '--start',
      '0',
      '--dur',
      '4000',
      '--id',
      'c_zm',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'keyframe',
      '--clip',
      'c_zm',
      '--prop',
      'scale',
      '--t',
      '1000',
      '--v',
      '1',
      '--ease',
      'linear',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'keyframe',
      '--clip',
      'c_zm',
      '--prop',
      'scale',
      '--t',
      '2000',
      '--v',
      '2',
      '--project',
      dir,
    ]);
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '640',
      '--no-normalize',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data.backend).toBe('ffmpeg');
    const out = join(dir, r.json.data.output);
    const grab = (file: string, vf: string, t: number) =>
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(t),
          '-i',
          file,
          '-vf',
          `${vf},scale=160:90:flags=area,format=rgb24`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ],
        { encoding: 'buffer' },
      );
    const mad = (a: Buffer, b: Buffer) =>
      a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
    // At t=3 (after the zoom) the frame is the center half of the source frame at that time.
    const zoomed = grab(out, 'null', 3);
    const src = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '3',
        '-i',
        fx('clean.mp4'),
        '-vf',
        'scale=1280:720:flags=lanczos,crop=640:360:320:180,scale=160:90:flags=area,format=rgb24',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-',
      ],
      { encoding: 'buffer' },
    );
    expect(mad(zoomed, src)).toBeLessThan(12);
    const before = grab(out, 'null', 0.5);
    const srcFull = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '0.5',
        '-i',
        fx('clean.mp4'),
        '-vf',
        'scale=640:360,scale=160:90:flags=area,format=rgb24',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-',
      ],
      { encoding: 'buffer' },
    );
    expect(mad(before, srcFull)).toBeLessThan(12);
    // and the zoomed frame is clearly different from the unzoomed one
    expect(mad(zoomed, grab(out, 'null', 0.5))).toBeGreaterThan(15);
  }, 120_000);
});

describe('blur-region fx', () => {
  it('blur-region fx blurs only its rectangle', async () => {
    ensureFixtures();
    const dir = tmpDir('studio-p5-blur-');
    await studio(['init', 'b', '--width', '640', '--height', '360', '--project', dir]);
    const id = (await studio(['ingest', fx('clean.mp4'), '--project', dir])).json.data.ingested[0]
      .id;
    await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'S',
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
      id,
      '--start',
      '0',
      '--dur',
      '2000',
      '--id',
      'c_bl',
      '--project',
      dir,
    ]);
    const set = await studio([
      'tl',
      'set',
      '--id',
      'c_bl',
      '--patch',
      JSON.stringify({ fx: [{ type: 'blur-region', x: 0, y: 0, w: 0.25, h: 0.25, strength: 30 }] }),
      '--project',
      dir,
    ]);
    expect(set.json.ok, JSON.stringify(set.json)).toBe(true);
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '640',
      '--no-normalize',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    const out = join(dir, r.json.data.output);
    const edges = (vf: string, file: string) => {
      const raw = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '1',
          '-i',
          file,
          '-vf',
          `${vf},format=gray,sobel`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1 << 24, encoding: 'buffer' },
      );
      return raw.reduce((s, v) => s + v, 0) / raw.length;
    };
    // the testsrc2 clock lives in the top-left corner: blurred there, sharp elsewhere
    const blurred = edges('crop=160:90:0:0', out);
    const rest = edges('crop=160:90:480:270', out);
    const srcBlurred = edges('crop=160:90:0:0', fx('clean.mp4'));
    expect(blurred).toBeLessThan(srcBlurred * 0.6);
    expect(Math.abs(rest - edges('crop=160:90:480:270', fx('clean.mp4')))).toBeLessThan(
      srcBlurred * 0.3,
    );
  }, 120_000);
});
