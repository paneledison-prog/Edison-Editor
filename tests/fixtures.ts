import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIX = join(import.meta.dirname, '.fixtures');
export const fx = (name: string) => join(FIX, name);

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    stdio: 'pipe',
  });
}
const once = (name: string, make: (out: string) => void) => {
  const out = fx(name);
  if (!existsSync(out)) make(out);
};

const SRC = (d: number, r = 30) => ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=${r}:d=${d}`];
const SINE = (d: number, sr: number, hz = 440) => [
  '-f',
  'lavfi',
  '-i',
  `sine=f=${hz}:r=${sr}:d=${d}`,
];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30'];

/** Deterministic fixtures made by ffmpeg. No binaries are committed (rules: tests/). */
export function ensureFixtures(): void {
  mkdirSync(FIX, { recursive: true });
  once('clean.mp4', (o) =>
    ff([...SRC(6), ...SINE(6, 48000), ...H264, '-c:a', 'aac', '-shortest', o]),
  );
  once('noaudio.mp4', (o) => ff([...SRC(4), ...H264, '-an', o]));
  // Irregular timestamps: drop frames by a fixed pattern and keep the original pts.
  once('vfr.mp4', (o) =>
    ff([
      ...SRC(8, 30),
      ...SINE(8, 48000),
      '-vf',
      "select='not(mod(n\\,5))+not(mod(n\\,3))+not(mod(n\\,7))'",
      '-fps_mode',
      'vfr',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  once('rotated.mp4', (o) => {
    const tmp = fx('_portrait_src.mp4');
    ff([...SRC(4), ...SINE(4, 48000), ...H264, '-c:a', 'aac', '-shortest', tmp]);
    // Display matrix only: the coded frame stays 640x360, players show it rotated.
    ff(['-display_rotation', '90', '-i', tmp, '-c', 'copy', o]);
  });
  once('audio44.wav', (o) => ff([...SINE(5, 44100, 330), '-ac', '1', o]));
  once('audio48.wav', (o) => ff([...SINE(5, 48000, 550), '-ac', '2', o]));
  // P1 fixtures. blackmid: a 0.5 s black section planted at 2.0 s (15 frames at 30 fps).
  once('blackmid.mp4', (o) =>
    ff([
      ...SRC(6),
      ...SINE(6, 48000, 440),
      '-vf',
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,2)*lt(t,2.5)'",
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  // Level fixtures: tone at very different levels, for planted loudness errors.
  once('quiet.mp4', (o) =>
    ff([
      ...SRC(5),
      ...SINE(5, 48000, 440),
      '-af',
      'volume=0.03',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  // Loud (0.75 FS) tone with video, for join tests where a cut without fades would step by up to 0.75.
  once('tone.mp4', (o) =>
    ff([
      ...SRC(6),
      ...SINE(6, 48000, 440),
      '-af',
      'volume=6',
      ...H264,
      '-c:a',
      'aac',
      '-shortest',
      o,
    ]),
  );
  once('hot.wav', (o) => ff([...SINE(5, 48000, 440), '-af', 'volume=12', '-c:a', 'pcm_s16le', o]));
  // Hard splice with no fade: two tones at different phase/frequency, joined at exactly 2.0 s.
  once('splice.wav', (o) => {
    const a = fx('_sp_a.wav'),
      b = fx('_sp_b.wav');
    ff([
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:r=48000:d=2.0013',
      '-af',
      'volume=6',
      '-c:a',
      'pcm_s16le',
      a,
    ]);
    ff([...SINE(2, 48000, 777), '-af', 'volume=6', '-c:a', 'pcm_s16le', b]);
    ff(['-i', a, '-i', b, '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-c:a', 'pcm_s16le', o]);
  });
  // Tone plus steady noise: noise floor is measurable.
  once('noisy.wav', (o) =>
    ff([
      ...SINE(6, 48000, 440),
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=6:c=white:a=0.01:r=48000:seed=7',
      '-filter_complex',
      "[0]volume=0.2,volume='if(between(t,1,3)+between(t,4,6),1,0)':eval=frame[t];[t][1]amix=inputs=2:normalize=0",
      '-c:a',
      'pcm_s16le',
      o,
    ]),
  );
  // P2 fixtures. voice: 1500 Hz at 0.15 (about -19 dBFS RMS) present only from 2 s to 5 s of 9 s.
  once('voice.wav', (o) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.15*sin(2*PI*1500*t)*between(t\\,2\\,5):s=48000:d=9',
      '-c:a',
      'pcm_s16le',
      o,
    ]),
  );
  once('music.wav', (o) => ff([...SINE(9, 48000, 220), '-ac', '2', '-c:a', 'pcm_s16le', o]));
  once('still.png', (o) => ff([...SRC(1, 1), '-frames:v', '1', o]));
  once('corrupt.mp4', (o) => writeFileSync(o, 'this is not a media file\n'));
  once('empty.mp4', (o) => writeFileSync(o, ''));
}

// ---------------------------------------------------------------------------------------------
// P2 fixtures
// ---------------------------------------------------------------------------------------------
export interface Truth {
  durationMs: number;
  /** pauses planted between sentences: these are what cut-silence must find */
  pauses: { startMs: number; endMs: number }[];
  /** 0.25 s dips inside a sentence: shorter than 0.4 s, so they must NOT be cut */
  microGaps: { startMs: number; endMs: number }[];
  speech: { startMs: number; endMs: number }[];
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The schedule is deterministic (seeded), so the planted pauses are known exactly. */
export function talkSchedule(totalS = 600, seed = 5): Truth {
  const r = mulberry(seed);
  const truth: Truth = { durationMs: totalS * 1000, pauses: [], microGaps: [], speech: [] };
  let t = 1.2;
  const ms = (s: number) => Math.round(s * 1000);
  while (t < totalS - 12) {
    const sentence = 6 + r() * 6; // 6 to 12 s
    const end = t + sentence;
    let a = t;
    while (a < end - 0.1) {
      const b = Math.min(end, a + 2 + r() * 1.2);
      truth.speech.push({ startMs: ms(a), endMs: ms(b) });
      if (b < end - 0.5) truth.microGaps.push({ startMs: ms(b), endMs: ms(b + 0.25) });
      a = b + (b < end - 0.5 ? 0.25 : 0);
      if (b >= end) break;
    }
    const pause = 1.5 + r() * 1.5; // 1.5 to 3 s
    truth.pauses.push({ startMs: ms(end), endMs: ms(end + pause) });
    t = end + pause;
  }
  return truth;
}

/**
 * 10 minutes: synthetic speech-like audio over a pink-noise floor, with a test-pattern video.
 * The speech gate is applied with `volume=enable=...`, which is evaluated per audio frame, not per sample.
 */
export async function ensureTalk(): Promise<Truth> {
  mkdirSync(FIX, { recursive: true });
  const truthPath = fx('talk.truth.json');
  const out = fx('talk.mp4');
  if (existsSync(out) && existsSync(truthPath)) return JSON.parse(readFileSync(truthPath, 'utf8'));
  const truth = talkSchedule();
  const gate = truth.speech
    .map((s) => `between(t,${(s.startMs / 1000).toFixed(3)},${(s.endMs / 1000).toFixed(3)})`)
    .join('+');
  const voice =
    '0.18*(sin(2*PI*140*t)+0.6*sin(2*PI*280*t)+0.4*sin(2*PI*420*t)+0.25*sin(2*PI*1300*t))*(0.55+0.45*sin(2*PI*3.7*t))';
  const script = fx('_talk.filter');
  writeFileSync(
    script,
    `aevalsrc=exprs=${voice.replace(/,/g, '\\,')}:s=48000:d=600[v0];[v0]volume=volume=0:enable='lt(${gate},0.5)'[v];` +
      `anoisesrc=d=600:c=pink:a=0.004:r=48000:seed=3[n];[v][n]amix=inputs=2:normalize=0[a]`,
  );
  await new Promise<void>((resolve, reject) => {
    const c = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=640x360:r=30:d=600',
        '-filter_complex_script',
        script,
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '34',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '60',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        out,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('talk fixture failed: ' + err.slice(-500))),
    );
  });
  writeFileSync(truthPath, JSON.stringify(truth));
  return truth;
}

/** Three 2 s scenes with hard cuts at 2000 ms and 4000 ms. */
export function ensureScenes(): void {
  mkdirSync(FIX, { recursive: true });
  once('scenes.mp4', (o) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'smptebars=s=640x360:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2060c0:s=640x360:r=30:d=2',
      '-filter_complex',
      '[0][1][2]concat=n=3:v=1:a=0',
      ...H264,
      o,
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// P4 fixtures: speech with known word starts
// ---------------------------------------------------------------------------------------------
export interface SpeechWord {
  w: string;
  startMs: number;
  endMs: number;
}
export interface SpeechTruth {
  durationMs: number;
  words: SpeechWord[];
}

const SENTENCES = [
  'Studio edits real media',
  'The captions follow every word',
  'Whisper names matter most',
];

/**
 * Synthetic speech from ffmpeg's flite voice. Each word is synthesized alone, its leading silence is removed, and it
 * is placed at an exact offset, so a word's start in the mix is known to the millisecond (no recognizer involved).
 */
export function ensureSpeech(): SpeechTruth {
  mkdirSync(FIX, { recursive: true });
  const truthPath = fx('speech.truth.json');
  if (existsSync(truthPath) && existsSync(fx('speech.wav')) && existsSync(fx('speech.mp4')))
    return JSON.parse(readFileSync(truthPath, 'utf8'));
  const words: SpeechWord[] = [];
  const inputs: string[] = [];
  const filters: string[] = [];
  let t = 800;
  let n = 0;
  for (const s of SENTENCES) {
    for (const w of s.split(' ')) {
      const wav = fx(`word-${n}.wav`);
      ff([
        '-f',
        'lavfi',
        '-i',
        `flite=text='${w}':voice=slt`,
        '-af',
        'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0',
        '-ar',
        '16000',
        '-ac',
        '1',
        wav,
      ]);
      const dur = Math.round(
        Number(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav],
            { encoding: 'utf8' },
          ).trim(),
        ) * 1000,
      );
      words.push({ w, startMs: t, endMs: t + dur });
      inputs.push('-i', wav);
      filters.push(`[${n}:a]adelay=${t}:all=1[w${n}]`);
      t += dur + 120;
      n++;
    }
    t += 880; // sentence pause: 1 s between sentences in total
  }
  const total = t + 400;
  const mix = filters.map((_, i) => `[w${i}]`).join('');
  ff([
    ...inputs,
    '-filter_complex',
    `${filters.join(';')};${mix}amix=inputs=${n}:normalize=0:dropout_transition=0,apad=whole_dur=${total / 1000}[o]`,
    '-map',
    '[o]',
    '-t',
    String(total / 1000),
    '-ar',
    '16000',
    fx('speech.wav'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=960x540:r=30:d=${total / 1000}`,
    '-i',
    fx('speech.wav'),
    ...H264,
    '-c:a',
    'aac',
    '-shortest',
    fx('speech.mp4'),
  ]);
  const truth = { durationMs: total, words };
  writeFileSync(truthPath, JSON.stringify(truth, null, 2));
  return truth;
}

// ---------------------------------------------------------------------------------------------
// P5 fixtures: a synthetic 3-minute 1440p "screen recording" with known clicks, dead spans and a loading span
// ---------------------------------------------------------------------------------------------
export interface DemoTruth {
  durationMs: number;
  width: number;
  height: number;
  /** nothing changes */
  still: [number, number][];
  /** small changes only (spinner, typing) */
  low: [number, number][];
  clicks: { t: number; x: number; y: number }[];
  vo: { text: string; startMs: number }[];
}

const SEC = (s: number) => Math.round(s * 1000);
const DEMO_STILL: [number, number][] = [
  [0, 4],
  [20, 27],
  [60, 75],
  [140, 170],
];
const DEMO_LOW: [number, number][] = [
  [27, 40],
  [95, 120],
];
const DEMO_ACTIVE: [number, number][] = [
  [4, 20],
  [40, 60],
  [75, 95],
  [120, 140],
  [170, 180],
];
const DEMO_CLICKS = [
  [6, 400, 300],
  [7.2, 460, 330],
  [12, 1900, 500],
  [44, 1900, 500],
  [46, 1960, 540],
  [52, 1950, 520],
  [80, 1200, 900],
  [90, 600, 1100],
  [125, 2200, 300],
  [133, 2250, 350],
  [172, 1280, 720],
] as const;
const DEMO_VO = [
  { text: 'This is how fast a new project comes together', startMs: 3000 },
  { text: 'Open the dashboard and pick the template', startMs: 13500 },
  { text: 'Loading takes a moment, so we skip ahead', startMs: 22000 },
  { text: 'Set the options on the right', startMs: 34000 },
  { text: 'Then review the result', startMs: 52000 },
  { text: 'That is all it takes', startMs: 66000 },
];

/** Deterministic. The recording is built from drawbox layers; events.jsonl carries the exact click times. */
export function ensureDemo(): DemoTruth {
  const dir = join(FIX, 'demo');
  mkdirSync(dir, { recursive: true });
  const truthPath = join(dir, 'truth.json');
  const W = 2560;
  const H = 1440;
  const truth: DemoTruth = {
    durationMs: SEC(180),
    width: W,
    height: H,
    still: DEMO_STILL.map(([a, b]) => [SEC(a), SEC(b)]),
    low: DEMO_LOW.map(([a, b]) => [SEC(a), SEC(b)]),
    clicks: DEMO_CLICKS.map(([t, x, y]) => ({ t: SEC(t), x, y })),
    vo: DEMO_VO,
  };
  if (
    ['rec.mp4', 'events.jsonl', 'vo.wav', 'music.wav', 'logo.png', 'truth.json'].every((f) =>
      existsSync(join(dir, f)),
    )
  )
    return truth;
  const act = DEMO_ACTIVE.map(([a, b]) => `between(t,${a},${b})`).join('+');
  const layers: string[] = [
    'drawbox=x=0:y=0:w=2560:h=90:color=0x2b3440:t=fill',
    'drawbox=x=0:y=90:w=420:h=1350:color=0x232a34:t=fill',
    'drawbox=x=480:y=140:w=1100:h=620:color=0x2d3643:t=fill',
    'drawbox=x=1640:y=140:w=860:h=620:color=0x2d3643:t=fill',
    'drawbox=x=480:y=820:w=2020:h=560:color=0x293240:t=fill',
    // active spans: panels flash and a bar slides, so a large share of the screen changes
    `drawbox=x=500:y=160:w=1060:h=580:color=0x3d6fb0@0.9:t=fill:enable='(${act})*lt(mod(t,0.8),0.4)'`,
    `drawbox=x=1660:y=160:w=820:h=580:color=0xb06f3d@0.9:t=fill:enable='(${act})*gte(mod(t,0.8),0.4)'`,
    `drawbox=x=500:y=860:w=100:h=480:color=0x7fd18b:t=fill:enable='(${act})*lt(mod(t,1.2),0.6)'`,
    // loading and typing spans: a small box that alternates between two spots
    ...DEMO_LOW.flatMap(([a, b]) => [
      `drawbox=x=1160:y=700:w=40:h=40:color=0xffffff:t=fill:enable='between(t,${a},${b})*lt(mod(t,0.6),0.3)'`,
      `drawbox=x=1240:y=700:w=40:h=40:color=0xffffff:t=fill:enable='between(t,${a},${b})*gte(mod(t,0.6),0.3)'`,
    ]),
    // click flashes
    ...DEMO_CLICKS.map(
      ([t, x, y]) =>
        `drawbox=x=${x - 30}:y=${y - 30}:w=60:h=60:color=0xffe066:t=fill:enable='between(t,${t},${t + 0.3})'`,
    ),
  ];
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1b1f27:s=${W}x${H}:r=30:d=180`,
    '-vf',
    layers.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-an',
    join(dir, 'rec.mp4'),
  ]);
  writeFileSync(
    join(dir, 'events.jsonl'),
    [
      ...DEMO_CLICKS.flatMap(([t, x, y]) => [
        JSON.stringify({ t: SEC(t) - 400, type: 'move', x: x - 40, y: y - 20 }),
        JSON.stringify({ t: SEC(t), type: 'click', x, y, button: 'left' }),
      ]),
    ].join('\n') + '\n',
  );
  // VO: each sentence from flite at its start time, mono 16 kHz.
  const ins: string[] = [];
  const fl: string[] = [];
  DEMO_VO.forEach((v, i) => {
    ins.push('-f', 'lavfi', '-i', `flite=text='${v.text}':voice=slt`);
    fl.push(`[${i}:a]adelay=${v.startMs}:all=1[v${i}]`);
  });
  ff([
    ...ins,
    '-filter_complex',
    `${fl.join(';')};${DEMO_VO.map((_, i) => `[v${i}]`).join('')}amix=inputs=${DEMO_VO.length}:normalize=0:dropout_transition=0,apad=whole_dur=75[o]`,
    '-map',
    '[o]',
    '-t',
    '75',
    '-ar',
    '48000',
    '-ac',
    '1',
    join(dir, 'vo.wav'),
  ]);
  // Music: a quiet chord with slow tremolo over pink noise.
  ff([
    '-f',
    'lavfi',
    '-i',
    'sine=f=220:r=48000:d=95',
    '-f',
    'lavfi',
    '-i',
    'sine=f=277.18:r=48000:d=95',
    '-f',
    'lavfi',
    '-i',
    'sine=f=329.63:r=48000:d=95',
    '-filter_complex',
    '[0][1][2]amix=inputs=3:normalize=0,tremolo=f=0.4:d=0.4,volume=0.5,aformat=channel_layouts=stereo[o]',
    '-map',
    '[o]',
    join(dir, 'music.wav'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x1b1f27:s=480x140:d=1',
    '-vf',
    "drawtext=fontfile=/usr/share/fonts/opentype/inter/Inter-Bold.otf:text='ACME':fontcolor=white:fontsize=84:x=(w-text_w)/2:y=(h-text_h)/2",
    '-frames:v',
    '1',
    join(dir, 'logo.png'),
  ]);
  writeFileSync(truthPath, JSON.stringify(truth, null, 2));
  return truth;
}
