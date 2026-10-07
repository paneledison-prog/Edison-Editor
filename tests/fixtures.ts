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
