import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expr, propPoints, valueAt } from '../packages/engines/src/zoom.js';
import { easeFn } from '../motion/src/ease.js';
import { FIX, fx } from './fixtures.js';
import { ensureFixtures } from './fixtures.js';
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

import { clusterClicks, parseEvents, planZoom, type DemoEvent } from '@studio/core';

describe('events.jsonl', () => {
  const frame = { w: 1920, h: 1080 };
  it('parses valid lines and reports each bad one by line number', () => {
    const txt = [
      '{"t":100,"type":"move","x":10,"y":10}',
      '{"t":900,"type":"click","x":500,"y":300,"button":"left","target":"Save"}',
      'not json',
      '{"t":-5,"type":"click","x":1,"y":1}',
      '{"t":1000,"type":"tap","x":1,"y":1}',
      '{"t":1100,"type":"click","x":5000,"y":1}',
      '{"t":1200,"type":"key"}',
    ].join('\n');
    const r = parseEvents(txt, frame, 60_000);
    expect(r.events.map((e) => e.type)).toEqual(['move', 'click', 'key']);
    expect(r.problems).toHaveLength(4);
    expect(r.problems[0]).toMatch(/line 3/);
    expect(r.problems.join('|')).toMatch(/outside the 1920x1080 recording/);
    expect(r.outOfRange).toBe(1);
  });
});

describe('autozoom planner', () => {
  const click = (t: number, x: number, y: number): DemoEvent => ({ t, type: 'click', x, y });
  const opts = { frame: { w: 3840, h: 2160 }, clipDurMs: 60_000, outWidth: 1920 };

  it('merges nearby clicks into one cluster and splits distant ones', () => {
    const c = clusterClicks(
      [click(1000, 500, 500), click(1800, 600, 520), click(4000, 600, 520), click(4500, 2400, 500)],
      2560,
    );
    expect(c.map((x) => x.n)).toEqual([2, 1, 1]);
  });

  it('starts zooming before the click, eases expo.inOut, holds, and every keyframe is valid', () => {
    const p = planZoom([click(5000, 800, 600), click(5600, 840, 620)], opts);
    expect(p.steps.map((s) => s.kind)).toEqual(['zoom-in', 'zoom-out']);
    const zin = p.steps[0]!;
    expect(5000 - zin.startMs).toBeGreaterThanOrEqual(400);
    expect(5000 - zin.startMs).toBeLessThanOrEqual(600);
    expect(zin.endMs - zin.startMs).toBeGreaterThanOrEqual(450);
    expect(zin.endMs - zin.startMs).toBeLessThanOrEqual(600);
    expect(p.steps[1]!.startMs).toBeGreaterThanOrEqual(5600 + 800);
    expect(zin.scale).toBeGreaterThanOrEqual(1.7);
    expect(zin.scale).toBeLessThanOrEqual(2.5);
    for (const prop of ['scale', 'x', 'y'] as const) {
      const ts = p.keyframes.filter((k) => k.prop === prop).map((k) => k.t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
      expect(new Set(ts).size).toBe(ts.length);
    }
    expect(p.keyframes.find((k) => k.prop === 'scale' && k.t === zin.startMs)!.ease).toBe(
      'expo.inOut',
    );
    // the focus is clamped so the crop stays inside the frame
    for (const k of p.keyframes.filter((k) => k.prop !== 'scale'))
      expect(k.v).toBeGreaterThanOrEqual(0);
  });

  it('pans between nearby targets instead of zooming out, and zooms out when idle or far', () => {
    const near = planZoom([click(4000, 800, 600), click(7000, 1000, 700)], opts);
    expect(near.steps.map((s) => s.kind)).toEqual(['zoom-in', 'pan', 'zoom-out']);
    const far = planZoom([click(4000, 300, 300), click(8000, 2300, 1200)], opts);
    expect(far.steps.map((s) => s.kind)).toEqual(['zoom-in', 'zoom-out', 'zoom-in', 'zoom-out']);
    const idle = planZoom([click(4000, 800, 600), click(20000, 900, 600)], opts);
    expect(idle.steps.map((s) => s.kind)).toEqual(['zoom-in', 'zoom-out', 'zoom-in', 'zoom-out']);
  });

  it('never changes zoom more than once per 1.5 s, and reports what it skipped', () => {
    const evs = [
      click(3000, 300, 300),
      click(4200, 2300, 1200),
      click(5000, 300, 300),
      click(5600, 2300, 1200),
      click(9000, 1200, 700),
    ];
    const p = planZoom(evs, opts);
    for (let i = 1; i < p.steps.length; i++)
      expect(p.steps[i]!.startMs - p.steps[i - 1]!.startMs).toBeGreaterThanOrEqual(1500);
    expect(p.skipped.length).toBeGreaterThan(0);
  });

  it('limits zoom so the crop stays sharp when that is useful, otherwise zooms 1.7x and reports it as soft', () => {
    const strict = planZoom([click(4000, 800, 600)], {
      frame: { w: 1920, h: 1080 },
      clipDurMs: 30_000,
      outWidth: 1920,
      strictSharp: true,
    });
    expect(strict.steps).toHaveLength(0);
    expect(strict.notes.join(' ')).toMatch(/too low resolution/);
    const dflt = planZoom([click(4000, 800, 600)], {
      frame: { w: 1920, h: 1080 },
      clipDurMs: 30_000,
      outWidth: 1920,
    });
    expect(dflt.maxScale).toBeCloseTo(1.7, 3);
    expect(dflt.soft).toBe(true);
    expect(dflt.cropPx).toBeLessThan(1920);
    expect(dflt.notes.join(' ')).toMatch(/soft/);
    const sharp = planZoom([click(4000, 800, 600)], {
      frame: { w: 3840, h: 2160 },
      clipDurMs: 30_000,
      outWidth: 1920,
    });
    expect(sharp.maxScale).toBeLessThanOrEqual(2 + 1e-3);
    expect(sharp.soft).toBe(false);
    const free = planZoom([click(4000, 800, 600)], {
      frame: { w: 1920, h: 1080 },
      clipDurMs: 30_000,
      outWidth: 1920,
      allowSoft: true,
    });
    expect(free.maxScale).toBeCloseTo(2, 3);
  });

  it('a target box sets the scale with padding', () => {
    const p = planZoom(
      [{ t: 4000, type: 'click', x: 800, y: 600, box: { x: 700, y: 540, w: 400, h: 120 } }],
      { frame: { w: 3840, h: 2160 }, clipDurMs: 30_000, outWidth: 960 },
    );
    expect(p.steps[0]!.scale).toBe(2.5);
  });
});

import { copyFileSync, mkdirSync as mk, writeFileSync as wf } from 'node:fs';
import { planSegments } from '../packages/cli/src/cmds/demo.js';
import { activityProfile, activitySpans } from '../packages/engines/src/demo.js';
import { ensureDemo } from './fixtures.js';

describe('demo pipeline', () => {
  it('segments: still spans are cut (keeping a margin), low-activity spans ramp, the rest stays 1x', () => {
    const beats = [{ id: 'b', name: 'b', srcStartMs: 0, srcEndMs: 30_000 }];
    const spans = {
      still: [{ startMs: 10_000, endMs: 16_000 }],
      low: [{ startMs: 20_000, endMs: 26_000 }],
    };
    const { segs, end, cutMs } = planSegments(beats, spans, {
      keepMs: 300,
      rampSpeed: 6,
      startAt: 1000,
    });
    expect(segs.map((s) => [s.srcStart, s.srcEnd, s.speed])).toEqual([
      [0, 10_300, 1],
      [15_700, 20_000, 1],
      [20_000, 26_000, 6],
      [26_000, 30_000, 1],
    ]);
    expect(cutMs[0]!.ms).toBe(5400);
    // contiguous on the timeline, starting where asked
    expect(segs[0]!.tlStart).toBe(1000);
    for (let i = 1; i < segs.length; i++)
      expect(segs[i]!.tlStart).toBe(segs[i - 1]!.tlStart + segs[i - 1]!.dur);
    expect(end).toBe(segs.at(-1)!.tlStart + segs.at(-1)!.dur);
  });

  it('activity: the fixture hides 4 still spans and 2 low-activity spans, and they are found within 1 s', async () => {
    const truth = ensureDemo();
    const prof = await activityProfile(join(FIXDIR, 'demo', 'rec.mp4'));
    const s = activitySpans(prof);
    const near = (found: { startMs: number; endMs: number }[], want: [number, number][]) =>
      want.every(([a, b]) =>
        found.some((f) => Math.abs(f.startMs - a) < 1000 && Math.abs(f.endMs - b) < 1000),
      );
    expect(near(s.still, truth.still)).toBe(true);
    expect(near(s.low, truth.low)).toBe(true);
    console.log(
      `P5 activity: still ${JSON.stringify(s.still.map((x) => [x.startMs, x.endMs]))} low ${JSON.stringify(s.low.map((x) => [x.startMs, x.endMs]))}`,
    );
  }, 120_000);

  it('demo ingest rejects an events file with bad coordinates, and build refuses without the privacy statement', async () => {
    ensureDemo();
    const dir = tmpDir('studio-p5-demo-');
    await studio(['init', 'd', '--project', dir]);
    const bad = join(dir, 'bad.jsonl');
    wf(bad, '{"t":100,"type":"click","x":99999,"y":10}\n');
    const r = await studio([
      'demo',
      'ingest',
      fx('clean.mp4'),
      '--name',
      'x',
      '--events',
      bad,
      '--project',
      dir,
    ]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/outside the 640x360 recording/);
    const ok = join(dir, 'ok.jsonl');
    wf(ok, '{"t":1000,"type":"click","x":100,"y":100,"target":"mail ada@example.com"}\n');
    const g = await studio([
      'demo',
      'ingest',
      fx('clean.mp4'),
      '--name',
      'x',
      '--events',
      ok,
      '--project',
      dir,
    ]);
    expect(g.json.ok, JSON.stringify(g.json)).toBe(true);
    expect(g.json.data.privacy.reviewed).toBe(false);
    expect(g.json.data.privacy.textFindings).toBe(1); // the email in an event label
    expect(g.json.warnings.join('|')).toMatch(/privacy scan is NOT finished/);
    const b = await studio(['demo', 'build', '--name', 'x', '--project', dir]);
    expect(b.code).toBe(4);
    expect(b.json.error.code).toBe('PRIVACY_NOT_REVIEWED');
  }, 120_000);

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
const FIXDIR = FIX;
void copyFileSync;
void mk;
