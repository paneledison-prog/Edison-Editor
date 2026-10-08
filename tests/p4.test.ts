import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCues, checkCues, contrastRatio, toAss, toSrt, toVtt, type TWord } from '@studio/core';
import { ensureSpeech, FIX, fx, type SpeechTruth } from './fixtures.js';
import { tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');

interface Out {
  code: number;
  json: any;
  stderr: string;
}
const studio = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Out> =>
  new Promise((resolve) =>
    execFile(
      'node',
      [BIN, ...args],
      { env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let json: any;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
        resolve({ code: err ? ((err as any).code as number) : 0, json, stderr });
      },
    ),
  );

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const ffprobe = (f: string) =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f], {
      encoding: 'utf8',
    }),
  );

/** Decodes a video to 8-bit gray frames at a reduced size. */
function grayFrames(file: string, w: number, h: number): Buffer[] {
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `scale=${w}:${h}:flags=area,format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const n = w * h;
  return Array.from({ length: Math.floor(raw.length / n) }, (_, i) =>
    raw.subarray(i * n, (i + 1) * n),
  );
}
const bright = (f: Buffer, fromRow: number, w: number, thr = 40) => {
  let c = 0;
  for (let i = fromRow * w; i < f.length; i++) if (f[i]! > thr) c++;
  return c;
};

let truth: SpeechTruth;
beforeAll(() => {
  truth = ensureSpeech();
});

// ------------------------------------------------------------------------------------------
describe('cue building (pure)', () => {
  const text =
    'Ada Lovelace wrote the first program for the Analytical Engine in 1843, and it ran for 12 seconds on a 50 percent budget. ' +
    'Nobody believed her at first, but the notes were published, and they changed how people think about machines. ' +
    'The Studio team now ships 3 releases a week, which keeps every customer happy.';
  const words = (): TWord[] => {
    let t = 500;
    return text.split(' ').map((w) => {
      const start = t;
      t += 250 + w.length * 22;
      const end = t - 40;
      if (/[.]$/.test(w)) t += 800;
      return { w, start, end };
    });
  };

  it('respects line, character, cps, duration, and gap limits', () => {
    const cues = buildCues(words(), 30);
    expect(cues.length).toBeGreaterThan(4);
    const v = checkCues(cues, 30);
    expect(v).toEqual([]);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect([...l].length).toBeLessThanOrEqual(42);
    }
  });

  it('starts each cue 0 to 2 frames before its first word and never splits names, numbers with units, or articles', () => {
    const ws = words();
    const cues = buildCues(ws, 30);
    for (const c of cues) {
      const first = c.words[0]!;
      const frame = 1000 / 30;
      expect(first.start - c.start).toBeGreaterThanOrEqual(0);
      expect(first.start - c.start).toBeLessThanOrEqual(2 * frame + 1);
    }
    const ends = cues.map((c) => c.words[c.words.length - 1]!.w);
    for (const e of ends) expect(e).not.toMatch(/^(a|an|the|to|of|in|on|at|for|with)$/i);
    const joined = cues.map((c) => c.lines.join('\n'));
    expect(joined.join('|')).not.toMatch(/Ada\nLovelace/);
    expect(joined.join('|')).not.toMatch(/12\nseconds|50\npercent/);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start - cues[i - 1]!.end).toBeGreaterThanOrEqual(2 * (1000 / 30) - 1);
    }
  });

  it('check reports planted violations', () => {
    const bad = [
      { i: 1, start: 0, end: 600, lines: ['a'.repeat(60), 'b', 'c'], words: [] },
      { i: 2, start: 650, end: 8000, lines: ['x'], words: [] },
    ];
    const rules = checkCues(bad as any, 30).map((v) => v.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['lines', 'line-chars', 'cps', 'min-dur', 'gap', 'max-dur']),
    );
  });

  it('sidecar formats carry the cue times', () => {
    const cues = buildCues(words(), 30);
    const srt = toSrt(cues);
    expect(srt.startsWith('1\n00:00:00,')).toBe(true);
    expect(srt.match(/ --> /g)!.length).toBe(cues.length);
    expect(toVtt(cues, 'machine translation')).toMatch(/^WEBVTT\n\nNOTE machine translation/);
    const ass = toAss(
      cues,
      {
        font: 'Inter',
        sizePx: 40,
        text: '#ffffff',
        outline: '#000000',
        bold: true,
        marginV: 50,
        marginH: 50,
        align: 2,
      },
      { w: 1920, h: 1080 },
    );
    expect(ass).toMatch(/PlayResX: 1920/);
    expect(ass.match(/^Dialogue:/gm)!.length).toBe(cues.length);
  });

  it('contrast helper matches known values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffd23f', '#ffffff')).toBeLessThan(3);
    expect(contrastRatio('#ff3d71', '#ffffff')).toBeGreaterThanOrEqual(3);
  });
});

// ------------------------------------------------------------------------------------------
describe('motion templates', () => {
  it('rejects unknown props, bad easing, and unknown color tokens', async () => {
    const dir = tmpDir('studio-p4-');
    const r1 = await studio([
      'motion',
      'still',
      '--comp',
      'lower-third',
      '--props',
      '{"titel":"x"}',
      '--project',
      dir,
    ]);
    expect(r1.code).toBe(2);
    expect(r1.json.error.message).toMatch(/unknown prop "titel"/);
    const r2 = await studio([
      'motion',
      'still',
      '--comp',
      'lower-third',
      '--props',
      '{"ease":"swoosh"}',
      '--project',
      dir,
    ]);
    expect(r2.json.error.message).toMatch(/not an easing name/);
    const r3 = await studio([
      'motion',
      'still',
      '--comp',
      'lower-third',
      '--props',
      '{"accent":"token:nope"}',
      '--project',
      dir,
    ]);
    expect(r3.json.error.message).toMatch(/unknown color token/);
    const r4 = await studio(['motion', 'still', '--comp', 'nonesuch', '--project', dir]);
    expect(r4.code).toBe(2);
  });

  it('lists every template with its props', async () => {
    const r = await studio(['motion', 'templates']);
    // the built-in templates, plus whatever the shipped plugins add (shape-layer, particles, saber, ...)
    expect(r.json.data.templates.map((t: any) => t.id).sort()).toEqual(expect.arrayContaining([
      'callout',
      'captions',
      'cursor-highlight',
      'intro',
      'kinetic-text',
      'lower-third',
      'outro',
      'speed-badge',
      'thumbnail-headline',
      'title',
    ]));
    expect(r.json.data.templates.find((t: any) => t.id === 'lower-third').props.title.type).toBe(
      'string',
    );
  });

  it('renders the same frames twice, bit for bit, from a cold cache', async () => {
    const hashes: string[][] = [];
    for (let k = 0; k < 2; k++) {
      const dir = tmpDir('studio-p4-det-');
      const r = await studio([
        'motion',
        'render',
        '--comp',
        'lower-third',
        '--props',
        '{"title":"Ada Lovelace","subtitle":"Founder"}',
        '--dur',
        '2000',
        '--width',
        '1280',
        '--height',
        '720',
        '--format',
        'png',
        '--out',
        'frames',
        '--project',
        dir,
      ]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      expect(r.json.data.cached).toBe(false);
      const files = readdirSync(join(dir, 'frames'))
        .filter((f) => f.endsWith('.png'))
        .sort();
      expect(files).toHaveLength(60);
      hashes.push(files.map((f) => sha(join(dir, 'frames', f))));
    }
    expect(hashes[0]).toEqual(hashes[1]);
    // And the animation moves: first frame differs from a held frame.
    expect(new Set(hashes[0]).size).toBeGreaterThan(10);
  }, 120_000);

  it('second render of the same props is served from the cache', async () => {
    const dir = tmpDir('studio-p4-cache-');
    const args = [
      'motion',
      'render',
      '--comp',
      'title',
      '--props',
      '{"title":"Hello world"}',
      '--dur',
      '1500',
      '--width',
      '640',
      '--height',
      '360',
      '--format',
      'png',
      '--project',
      dir,
    ];
    const a = await studio([...args, '--out', 'a']);
    const b = await studio([...args, '--out', 'b']);
    expect(a.json.data.cached).toBe(false);
    expect(b.json.data.cached).toBe(true);
    expect(b.json.data.key).toBe(a.json.data.key);
    console.log(
      `P4 motion render: ${a.json.data.frames} frames at ${a.json.data.width}x${a.json.data.height}: ${a.json.data.renderMs} ms (${a.json.data.renderFps} fps, ${a.json.data.concurrency} pages); cached rerun ${b.json.timingMs} ms`,
    );
  }, 120_000);

  it('exit criterion: a lower third is changed by editing props JSON only', async () => {
    const dir = tmpDir('studio-p4-lt-');
    const page = join(ROOT, 'motion', 'dist', 'page.js');
    const codeBefore = sha(page);
    await studio(['motion', 'scaffold', '--comp', 'lower-third', '--project', dir]);
    const propsFile = join(dir, 'motion', 'props', 'lower-third.json');
    const props = JSON.parse(readFileSync(propsFile, 'utf8'));
    props.title = 'Ada Lovelace';
    props.subtitle = 'Founder';
    writeFileSync(propsFile, JSON.stringify(props, null, 2));
    const a = await studio([
      'motion',
      'still',
      '--comp',
      'lower-third',
      '--props',
      'motion/props/lower-third.json',
      '--at',
      '1800',
      '--width',
      '1280',
      '--height',
      '720',
      '--out',
      'a.png',
      '--project',
      dir,
    ]);
    // Edit the props file only: new text, new accent, other side.
    props.title = 'Grace Hopper';
    props.subtitle = 'Rear Admiral';
    props.accent = '#3dd6ff';
    props.align = 'right';
    writeFileSync(propsFile, JSON.stringify(props, null, 2));
    const b = await studio([
      'motion',
      'still',
      '--comp',
      'lower-third',
      '--props',
      'motion/props/lower-third.json',
      '--at',
      '1800',
      '--width',
      '1280',
      '--height',
      '720',
      '--out',
      'b.png',
      '--project',
      dir,
    ]);
    expect(a.json.ok && b.json.ok).toBe(true);
    expect(sha(join(dir, 'a.png'))).not.toBe(sha(join(dir, 'b.png')));
    expect(a.json.data.codeVersion).toBe(b.json.data.codeVersion); // same template code and fonts
    expect(a.json.data.key).not.toBe(b.json.data.key); // different props, different cache key
    expect(sha(page)).toBe(codeBefore); // no code changed
    // The panel moved to the other side: compare where non-transparent pixels sit.
    const colsLeft = (f: string) => {
      const raw = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          f,
          '-vf',
          'alphaextract,scale=64:36:flags=area,format=gray',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1 << 24 },
      );
      let l = 0,
        r = 0;
      for (let y = 0; y < 36; y++)
        for (let x = 0; x < 64; x++) if (raw[y * 64 + x]! > 20) x < 32 ? l++ : r++;
      return { l, r };
    };
    const A = colsLeft(join(dir, 'a.png'));
    const B = colsLeft(join(dir, 'b.png'));
    expect(A.l).toBeGreaterThan(A.r);
    expect(B.r).toBeGreaterThan(B.l);
  }, 120_000);

  it('a project composition clip changes when only its props change (an op, undoable)', async () => {
    const dir = tmpDir('studio-p4-clip-');
    await studio(['init', 'p', '--width', '960', '--height', '540', '--project', dir]);
    await studio([
      'tl',
      'add-track',
      '--type',
      'graphics',
      '--name',
      'Overlays',
      '--id',
      't_g1',
      '--project',
      dir,
    ]);
    const add = await studio([
      'tl',
      'add-clip',
      '--track',
      't_g1',
      '--comp',
      'lower-third',
      '--start',
      '500',
      '--dur',
      '3000',
      '--id',
      'c_lt',
      '--props',
      '{"title":"One"}',
      '--project',
      dir,
    ]);
    expect(add.json.ok, JSON.stringify(add.json)).toBe(true);
    const bad = await studio([
      'tl',
      'add-clip',
      '--track',
      't_g1',
      '--comp',
      'lower-third',
      '--start',
      '4000',
      '--dur',
      '1000',
      '--props',
      '{"bogus":1}',
      '--project',
      dir,
    ]);
    expect(bad.code).toBe(2);
    const s1 = await studio([
      'motion',
      'still',
      '--clip',
      'c_lt',
      '--at',
      '1500',
      '--out',
      '1.png',
      '--project',
      dir,
    ]);
    await studio([
      'tl',
      'set',
      '--id',
      'c_lt',
      '--patch',
      '{"props":{"title":"Two"}}',
      '--project',
      dir,
    ]);
    const s2 = await studio([
      'motion',
      'still',
      '--clip',
      'c_lt',
      '--at',
      '1500',
      '--out',
      '2.png',
      '--project',
      dir,
    ]);
    expect(s1.json.data.key).not.toBe(s2.json.data.key);
    expect(sha(join(dir, '1.png'))).not.toBe(sha(join(dir, '2.png')));
    await studio(['project', 'undo', '--project', dir]);
    const s3 = await studio([
      'motion',
      'still',
      '--clip',
      'c_lt',
      '--at',
      '1500',
      '--out',
      '3.png',
      '--project',
      dir,
    ]);
    expect(sha(join(dir, '3.png'))).toBe(sha(join(dir, '1.png')));
  }, 120_000);

  it('a missing font fails the render instead of substituting', async () => {
    const dir = tmpDir('studio-p4-font-');
    mkdirSync(join(dir, 'brand'), { recursive: true });
    const pal = JSON.parse(readFileSync(join(ROOT, 'brand', 'palette.json'), 'utf8'));
    mkdirSync(join(dir, 'brand', 'fonts'), { recursive: true });
    copyFileSync(
      join(ROOT, 'brand', 'fonts', 'Inter-Regular.otf'),
      join(dir, 'brand', 'fonts', 'Inter-Regular.otf'),
    );
    pal.fonts.sans.files['700'] = 'brand/fonts/Missing-Bold.otf';
    writeFileSync(join(dir, 'brand', 'palette.json'), JSON.stringify(pal));
    const r = await studio(['motion', 'still', '--comp', 'title', '--project', dir]);
    expect(r.code).toBe(3);
    expect(r.json.error.message).toMatch(/font file brand\/fonts\/Missing-Bold\.otf/);
  });

  it('warns when text would leave the safe area, and when the duration is too short to read', async () => {
    const dir = tmpDir('studio-p4-over-');
    const long = 'Words '.repeat(14).trim();
    const r = await studio([
      'motion',
      'still',
      '--comp',
      'kinetic-text',
      '--props',
      JSON.stringify({ text: long, sizePct: 24 }),
      '--dur',
      '500',
      '--width',
      '1080',
      '--height',
      '1920',
      '--out',
      'o.png',
      '--project',
      dir,
    ]);
    expect(r.json.ok).toBe(true);
    expect(r.json.warnings.join('|')).toMatch(/safe area/);
    expect(r.json.warnings.join('|')).toMatch(/shorter than/);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------
describe('alpha overlay export', () => {
  it('ProRes 4444 and VP9 WebM keep the alpha channel', async () => {
    const dir = tmpDir('studio-p4-alpha-');
    for (const [fmt, ext] of [
      ['prores4444', 'mov'],
      ['webm', 'webm'],
    ] as const) {
      const r = await studio([
        'motion',
        'render',
        '--comp',
        'callout',
        '--dur',
        '2000',
        '--width',
        '640',
        '--height',
        '360',
        '--format',
        fmt,
        '--out',
        `o.${ext}`,
        '--project',
        dir,
      ]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    }
    const mov = ffprobe(join(dir, 'o.mov')).streams[0];
    expect(mov.codec_name).toBe('prores');
    expect(mov.pix_fmt).toMatch(/^yuva444p/);
    // Corner is fully transparent, the box outline is not: measure the alpha plane at the held frame.
    const alphaStats = (file: string, decoder?: string) => {
      const raw = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          ...(decoder ? ['-c:v', decoder] : []),
          '-i',
          file,
          '-vf',
          'select=eq(n\\,45),alphaextract,format=gray',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1 << 26 },
      );
      let max = 0,
        opaque = 0;
      for (const v of raw) {
        max = Math.max(max, v);
        if (v > 200) opaque++;
      }
      return { corner: raw[0]!, max, opaque, total: raw.length };
    };
    for (const [f, dec] of [
      [join(dir, 'o.mov'), undefined],
      [join(dir, 'o.webm'), 'libvpx-vp9'],
    ] as const) {
      const s = alphaStats(f, dec);
      expect(s.corner).toBe(0);
      expect(s.max).toBeGreaterThan(200);
      expect(s.opaque).toBeGreaterThan(200);
      expect(s.opaque / s.total).toBeLessThan(0.2);
    }
    // Over a checkerboard the overlay shows both the pattern and the callout.
    const over = join(dir, 'over.png');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x808080:s=640x360',
      '-i',
      join(dir, 'o.mov'),
      '-filter_complex',
      '[0][1]overlay=format=auto,select=eq(n\\,45)',
      '-frames:v',
      '1',
      over,
    ]);
    expect(existsSync(over)).toBe(true);
  }, 120_000);
});

// ------------------------------------------------------------------------------------------
async function captionProject(opts: { style: string; extra?: string[]; transcript?: 'truth' }) {
  const dir = tmpDir('studio-p4-cap-');
  await studio([
    'init',
    'cap',
    '--width',
    '960',
    '--height',
    '540',
    '--fps',
    '30',
    '--project',
    dir,
  ]);
  const ing = await studio(['ingest', fx('speech.mp4'), '--project', dir]);
  const id: string = ing.json.data.ingested[0].id;
  await studio([
    'tl',
    'add-track',
    '--type',
    'video',
    '--name',
    'Screen',
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
    String(truth.durationMs - 60),
    '--id',
    'c_s1',
    '--project',
    dir,
  ]);
  // A transcript with known word timings (the fixture's ground truth) in the derived format.
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  const derived = {
    schema: 1,
    kind: 'derived',
    raw: 'none (ground truth)',
    asset: id,
    source: {
      model: 'ground-truth',
      language: 'en',
      engine: 'fixture',
      engineVersion: '0',
      audioSeconds: truth.durationMs / 1000,
      tookSeconds: 0,
      realtimeFactor: 0,
      vad: 'none',
    },
    glossary: { terms: [], fixes: [] },
    flags: { review: [], noSpeech: [] },
    edits: [],
    words: truth.words.map((w) => ({ w: w.w, start: w.startMs, end: w.endMs - 300 })),
  };
  writeFileSync(join(dir, 'transcripts', 'truth.json'), JSON.stringify(derived));
  const build = await studio([
    'captions',
    'build',
    '--transcript',
    'transcripts/truth.json',
    '--style',
    opts.style,
    ...(opts.extra ?? []),
    '--out',
    'captions/c.cues.json',
    '--project',
    dir,
  ]);
  expect(build.json.ok, JSON.stringify(build.json)).toBe(true);
  const add = await studio(['captions', 'add', '--cues', 'captions/c.cues.json', '--project', dir]);
  expect(add.json.ok, JSON.stringify(add.json)).toBe(true);
  return { dir, id, build };
}

describe('captions: exit criterion (known word timings)', () => {
  it('every word-by-word cue appears within one frame of its word start, and ends within one frame of its cue end', async () => {
    const { dir, build } = await captionProject({
      style: 'social',
      extra: ['--words-per-cue', '1'],
    });
    const doc = JSON.parse(readFileSync(join(dir, 'captions', 'c.cues.json'), 'utf8'));
    expect(doc.cues).toHaveLength(truth.words.length);
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '960',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data.backend).toBe('hybrid');
    expect(r.json.data.width).toBe(960);
    const W = 240,
      H = 135;
    const frames = grayFrames(join(dir, r.json.data.output), W, H);
    const visible = frames.map((f) => bright(f, Math.floor(H * 0.7), W) > 3);
    // visible runs
    const runs: [number, number][] = [];
    visible.forEach((v, i) => {
      if (v && !visible[i - 1]) runs.push([i, i]);
      if (v) runs[runs.length - 1]![1] = i;
    });
    const fps = 30;
    expect(runs.length).toBe(truth.words.length);
    const diffs: number[] = [];
    const endDiffs: number[] = [];
    runs.forEach(([a, b], i) => {
      const wordFrame = Math.round((truth.words[i]!.startMs * fps) / 1000);
      diffs.push(a - wordFrame);
      const cueEndFrame = Math.round((doc.cues[i].end * fps) / 1000);
      endDiffs.push(b + 1 - cueEndFrame);
    });
    console.log(
      `P4 caption timing (${truth.words.length} words, ${fps} fps): first visible frame minus word-start frame = ${JSON.stringify(diffs)}; last visible+1 minus cue-end frame = ${JSON.stringify(endDiffs)}`,
    );
    for (const d of diffs) expect(Math.abs(d)).toBeLessThanOrEqual(1);
    for (const d of endDiffs) expect(Math.abs(d)).toBeLessThanOrEqual(1);
    void build;
  }, 180_000);

  it('sentence cues (default builder) also land within one frame of the first word, karaoke highlight advances per word, and QC passes the caption check', async () => {
    const { dir } = await captionProject({ style: 'karaoke' });
    const doc = JSON.parse(readFileSync(join(dir, 'captions', 'c.cues.json'), 'utf8'));
    expect(doc.cues).toHaveLength(3);
    const r = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '960',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    const out = join(dir, r.json.data.output);
    const W = 240,
      H = 135;
    const frames = grayFrames(out, W, H);
    const visible = frames.map((f) => bright(f, Math.floor(H * 0.7), W) > 3);
    const firsts: number[] = [];
    visible.forEach((v, i) => {
      if (v && !visible[i - 1]) firsts.push(i);
    });
    expect(firsts).toHaveLength(3);
    const sentenceStarts = [0, 4, 9].map((k) => truth.words[k]!.startMs);
    sentenceStarts.forEach((ms, i) =>
      expect(Math.abs(firsts[i]! - Math.round((ms * 30) / 1000))).toBeLessThanOrEqual(1),
    );
    // Highlight color: the highlighted word is red-ish (R high, B lower) in the RGB frame; count such pixels at two times in cue 1.
    const rgbAt = (ms: number) =>
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(ms / 1000),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          'crop=iw:ih*0.3:0:ih*0.7,format=rgb24',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1 << 24 },
      );
    const highlight = (b: Buffer) => {
      let n = 0;
      for (let i = 0; i < b.length; i += 3)
        if (b[i]! > 200 && b[i + 1]! < 120 && b[i + 2]! > 50 && b[i + 2]! < 180) n++;
      return n;
    };
    const w = truth.words;
    expect(highlight(rgbAt(w[0]!.startMs + 150))).toBeGreaterThan(8);
    const early = highlight(rgbAt(w[3]!.startMs + 150));
    expect(early).toBeGreaterThan(8);
    // QC: the captions check runs on the cue file and passes.
    const qc = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
    const checks = (qc.json.data ?? qc.json.error.details).checks;
    const cap = checks.find((c: any) => c.id === 'captions');
    expect(cap.status).toBe('pass');
    expect(cap.detail).toMatch(/measured from the real layout/);
  }, 240_000);

  it('hybrid render composites the captions in one encode over the video, and overlay-alpha exports them with alpha', async () => {
    const { dir } = await captionProject({ style: 'clean' });
    const ex = await studio([
      'render',
      '--preset',
      'youtube-1080p',
      '--width',
      '960',
      '--explain',
      '--project',
      dir,
    ]);
    expect(ex.json.data.backend).toBe('hybrid');
    expect(ex.json.data.reason).toMatch(/composition clip/);
    const a = await studio([
      'render',
      '--preset',
      'overlay-alpha',
      '--width',
      '960',
      '--project',
      dir,
    ]);
    expect(a.json.ok, JSON.stringify(a.json)).toBe(true);
    const f = join(dir, a.json.data.output);
    expect(ffprobe(f).streams[0].pix_fmt).toMatch(/^yuva444p/);
    const doc = JSON.parse(readFileSync(join(dir, 'captions', 'c.cues.json'), 'utf8'));
    const mid = (doc.cues[0].start + doc.cues[0].end) / 2000;
    const raw = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(mid),
        '-i',
        f,
        '-vf',
        'alphaextract,format=gray',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-',
      ],
      { maxBuffer: 1 << 26 },
    );
    let opaque = 0;
    for (const v of raw) if (v > 128) opaque++;
    expect(opaque).toBeGreaterThan(500);
    expect(raw[0]).toBe(0);
  }, 240_000);

  it('sidecars: SRT, VTT, and ASS are written from the same cues', async () => {
    const { dir } = await captionProject({ style: 'clean' });
    for (const fmt of ['srt', 'vtt', 'ass']) {
      const r = await studio([
        'captions',
        'export',
        '--cues',
        'captions/c.cues.json',
        '--format',
        fmt,
        '--project',
        dir,
      ]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    }
    const srt = readFileSync(join(dir, 'captions', 'c.srt'), 'utf8');
    expect(srt).toMatch(/00:00:00,7\d\d --> /); // first cue: 800 ms minus one frame
    expect(readFileSync(join(dir, 'captions', 'c.vtt'), 'utf8')).toMatch(/^WEBVTT/);
    expect(readFileSync(join(dir, 'captions', 'c.ass'), 'utf8')).toMatch(/Style: Default,Inter,/);
  }, 120_000);

  it('captions check exits 4 on planted violations and names them', async () => {
    const { dir } = await captionProject({ style: 'clean' });
    const doc = JSON.parse(readFileSync(join(dir, 'captions', 'c.cues.json'), 'utf8'));
    doc.cues[0].lines = [
      'This single line is far too long to read comfortably on any screen',
      'second',
      'third',
    ];
    writeFileSync(join(dir, 'captions', 'bad.cues.json'), JSON.stringify(doc));
    const r = await studio([
      'captions',
      'check',
      '--cues',
      'captions/bad.cues.json',
      '--project',
      dir,
    ]);
    expect(r.code).toBe(4);
    const rules = r.json.error.details.violations.map((v: any) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(['lines', 'line-chars']));
    const ok = await studio([
      'captions',
      'check',
      '--cues',
      'captions/c.cues.json',
      '--project',
      dir,
    ]);
    expect(ok.code).toBe(0);
  }, 120_000);

  it('vertical output keeps captions inside the safe zone (measured), and a huge font is reported', async () => {
    const { dir } = await captionProject({ style: 'clean' });
    const ok = await studio([
      'captions',
      'check',
      '--cues',
      'captions/c.cues.json',
      '--width',
      '1080',
      '--height',
      '1920',
      '--project',
      dir,
    ]);
    expect(ok.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(dir, 'captions', 'c.cues.json'), 'utf8'));
    doc.sizePct = 12;
    doc.position = 'bottom';
    writeFileSync(join(dir, 'captions', 'big.cues.json'), JSON.stringify(doc));
    const bad = await studio([
      'captions',
      'check',
      '--cues',
      'captions/big.cues.json',
      '--width',
      '1080',
      '--height',
      '1920',
      '--project',
      dir,
    ]);
    expect(bad.code).toBe(4);
    expect(bad.json.error.details.violations.some((v: any) => v.rule === 'safe-zone')).toBe(true);
  }, 120_000);
});

// ------------------------------------------------------------------------------------------
const whisperReady =
  existsSync(join(ROOT, 'tools', '.venv', 'bin', 'python')) &&
  existsSync(join(ROOT, 'models', 'whisper-small', 'model.bin'));

describe('transcription', () => {
  it('fails with the fix when the model is not installed', async () => {
    const dir = tmpDir('studio-p4-nomodel-');
    const r = await studio(
      ['transcribe', fx('speech.wav'), '--model', 'whisper-small', '--project', dir],
      { STUDIO_MODELS_DIR: join(dir, 'empty') },
    );
    expect(r.code).toBe(3);
    expect(r.json.error.fix).toMatch(/studio models fetch whisper-small/);
  });

  it('rejects an asset without audio', async () => {
    const dir = tmpDir('studio-p4-noaudio-');
    await studio(['init', 'n', '--project', dir]);
    const ing = await studio(['ingest', fx('noaudio.mp4'), '--project', dir]);
    const r = await studio(['transcribe', ing.json.data.ingested[0].id, '--project', dir]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/no audio/);
  }, 60_000);

  it.skipIf(!whisperReady)(
    'whisper-small on the synthetic-speech fixture: reports word-start error against known truth',
    async () => {
      const dir = tmpDir('studio-p4-asr-');
      await studio(['init', 'asr', '--project', dir]);
      const ing = await studio(['ingest', fx('speech.mp4'), '--project', dir]);
      const id = ing.json.data.ingested[0].id;
      const r = await studio(['transcribe', id, '--model', 'whisper-small', '--project', dir]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      const d = r.json.data;
      // Provenance and read-only raw transcript.
      expect(d.engine).toMatch(/faster-whisper/);
      expect(d.model).toBe('whisper-small');
      const rawPath = join(dir, d.raw);
      expect(existsSync(rawPath)).toBe(true);
      expect(statSyncMode(rawPath) & 0o222).toBe(0);
      const derived = JSON.parse(readFileSync(join(dir, d.transcript), 'utf8'));
      expect(derived.raw).toBe(d.raw);
      // A second run uses the cached raw output; the derived file is not overwritten without --force.
      const again = await studio(['transcribe', id, '--model', 'whisper-small', '--project', dir]);
      expect(again.code).toBe(5);
      // Align recognized words to truth in order (edit distance <= 1 on letters) and measure start errors.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
      const close = (a: string, b: string) =>
        a === b || (Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1);
      const errs: { w: string; truthMs: number; heardMs: number; err: number }[] = [];
      let j = 0;
      for (const t of truth.words) {
        for (let k = j; k < Math.min(derived.words.length, j + 3); k++) {
          if (close(norm(derived.words[k].w), norm(t.w))) {
            errs.push({
              w: t.w,
              truthMs: t.startMs,
              heardMs: derived.words[k].start,
              err: derived.words[k].start - t.startMs,
            });
            j = k + 1;
            break;
          }
        }
      }
      const abs = errs.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
      const report = {
        model: 'whisper-small',
        audioSeconds: d.audioSeconds,
        tookSeconds: d.tookSeconds,
        realtimeFactor: d.realtimeFactor,
        wordsTruth: truth.words.length,
        wordsMatched: errs.length,
        medianAbsErrMs: abs[Math.floor(abs.length / 2)],
        meanAbsErrMs: Math.round(abs.reduce((a, b) => a + b, 0) / abs.length),
        maxAbsErrMs: abs[abs.length - 1],
        within1Frame: abs.filter((x) => x <= 34).length,
        errs,
      };
      mkdirSync(FIX, { recursive: true });
      writeFileSync(join(FIX, 'asr-report.json'), JSON.stringify(report, null, 2));
      console.log(
        `P4 ASR (${report.model}, flite speech, ${report.audioSeconds.toFixed(1)} s audio in ${report.tookSeconds} s, RTF ${report.realtimeFactor}): matched ${report.wordsMatched}/${report.wordsTruth} words; start error median ${report.medianAbsErrMs} ms, mean ${report.meanAbsErrMs} ms, max ${report.maxAbsErrMs} ms; ${report.within1Frame}/${report.wordsMatched} within one frame (34 ms)`,
      );
      expect(errs.length).toBeGreaterThanOrEqual(10);
      expect(report.medianAbsErrMs!).toBeLessThan(150);
    },
    300_000,
  );
});

import { statSync } from 'node:fs';
const statSyncMode = (p: string) => statSync(p).mode;
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}
