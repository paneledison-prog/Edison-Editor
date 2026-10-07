import { spawn } from 'node:child_process';
import { EngineError, run } from '@studio/engines';

export interface Loudness {
  hasAudio: boolean;
  durationS?: number;
  integratedLufs?: number | null;
  lra?: number | null;
  truePeakDbtp?: number | null;
  samplePeakDbfs?: number | null;
  /** RMS of the quietest 10% of 50 ms windows */
  noiseFloorDbfs?: number | null;
  /** Runs of 3+ consecutive full-scale samples */
  clippingRuns?: number;
  clippedSamples?: number;
}

const num = (s: string | undefined) => (s === undefined || /inf/i.test(s) ? null : Number(s));

/** Stream signed 16-bit PCM through `onChunk` without holding the file in memory. */
function pcm(file: string, args: string[], onChunk: (b: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      ...args.slice(0, args.indexOf('%IN%')),
      '-i',
      file,
      ...args.slice(args.indexOf('%IN%') + 1),
      '-f',
      's16le',
      'pipe:1',
    ]);
    let err = '';
    c.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-4096)));
    c.stdout.on('data', onChunk);
    c.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        e.code === 'ENOENT' ? new EngineError('ENGINE_MISSING', 'ffmpeg not found on PATH') : e,
      ),
    );
    c.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new EngineError(
              'ENGINE_FAILED',
              `ffmpeg audio decode failed: ${err.trim().split('\n').pop()}`,
            ),
          ),
    );
  });
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Measure before you change anything (rules/03): LUFS, LRA, true peak, noise floor, clipping. */
export async function loudness(file: string): Promise<Loudness> {
  const probe = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'csv=p=0',
      file,
    ],
    { timeoutMs: 30_000 },
  );
  if (!probe.stdout.trim()) return { hasAudio: false };

  const eb = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      file,
      '-vn',
      '-filter_complex',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  if (eb.code !== 0)
    throw new EngineError('ENGINE_FAILED', `ebur128 failed: ${eb.stderr.trim().split('\n').pop()}`);
  const sum = eb.stderr.slice(eb.stderr.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(sum)?.[1];
  const LRA = /LRA:\s+(-?[\d.]+)\s+LU/.exec(sum)?.[1];
  const TP = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(sum)?.[1];

  // PCM pass: sample peak, clipping, noise floor. Native channels and sample rate: any resample or
  // channel remix changes levels (mono to stereo drops 3 dB) and would hide clipping.
  const fmt = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels,sample_rate',
      '-of',
      'json',
      file,
    ],
    { timeoutMs: 30_000 },
  );
  const st = JSON.parse(fmt.stdout).streams?.[0] ?? {};
  const CH = Math.max(1, Number(st.channels) || 2);
  const SR = Number(st.sample_rate) || 48000;
  const WIN = Math.round(SR * 0.05); // 50 ms of frames
  let frameCount = 0,
    accPow = 0,
    accN = 0,
    peak = 0,
    runs = 0,
    clipped = 0;
  const run0: number[] = new Array(CH).fill(0);
  const winDb: number[] = [];
  let carry: Buffer = Buffer.alloc(0);
  await pcm(file, ['-vn', '%IN%'], (chunk) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const stride = CH * 2;
    const frames = Math.floor(buf.length / stride);
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < CH; ch++) {
        const v = buf.readInt16LE(i * stride + ch * 2);
        const a = Math.abs(v);
        if (a > peak) peak = a;
        accPow += (v / 32768) ** 2;
        if (a >= 32767) {
          run0[ch]!++;
          clipped++;
          if (run0[ch] === 3) runs++;
        } else run0[ch] = 0;
      }
      accN++;
      if (accN === WIN) {
        winDb.push(10 * Math.log10(Math.max(accPow / (accN * CH), 1e-12)));
        accPow = 0;
        accN = 0;
      }
      frameCount++;
    }
    carry = buf.subarray(frames * stride);
  });
  if (accN >= WIN / 2) winDb.push(10 * Math.log10(Math.max(accPow / (accN * CH), 1e-12)));
  winDb.sort((a, b) => a - b);
  const q = winDb.slice(0, Math.max(1, Math.floor(winDb.length * 0.1)));
  const noise = q.length
    ? 10 * Math.log10(q.reduce((s, d) => s + 10 ** (d / 10), 0) / q.length)
    : null;

  return {
    hasAudio: true,
    durationS: frameCount / SR,
    integratedLufs: num(I),
    lra: num(LRA),
    truePeakDbtp: num(TP),
    samplePeakDbfs: peak ? Math.round(db(peak / 32768) * 100) / 100 : null,
    noiseFloorDbfs: noise === null ? null : Math.round(noise * 100) / 100,
    clippingRuns: runs,
    clippedSamples: clipped,
  };
}

export interface Span {
  startMs: number;
  endMs: number;
  durMs: number;
}

/** Spans below `noiseDb` for at least `minS` seconds. Look at the list before cutting anything (rules/02). */
export async function silence(
  file: string,
  noiseDb: number,
  minS: number,
): Promise<{ spans: Span[]; totalMs: number }> {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      file,
      '-vn',
      '-af',
      `silencedetect=noise=${noiseDb}dB:d=${minS}`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  const spans: Span[] = [];
  let start: number | null = null;
  for (const m of r.stderr.matchAll(
    /silence_(start|end): (-?[\d.]+)(?: \| silence_duration: ([\d.]+))?/g,
  )) {
    if (m[1] === 'start') start = Math.max(0, Number(m[2]));
    else if (start !== null) {
      spans.push({
        startMs: Math.round(start * 1000),
        endMs: Math.round(Number(m[2]) * 1000),
        durMs: Math.round(Number(m[3]) * 1000),
      });
      start = null;
    }
  }
  return { spans, totalMs: spans.reduce((s, x) => s + x.durMs, 0) };
}

export interface Click {
  atMs: number;
  maxStep: number;
  medianStep: number;
  ratio: number;
  click: boolean;
}

/**
 * Peak sample-to-sample step in a 50 ms window around each join. A click is a step of at least 0.10 full scale
 * that is also at least 6x the window's median step. Heuristic: a loud, bright signal can step this much
 * without a click, and a very small discontinuity under the threshold will pass.
 */
export async function joinClicks(
  file: string,
  timesMs: number[],
  minStep = 0.1,
  minRatio = 6,
): Promise<Click[]> {
  const out: Click[] = [];
  for (const t of timesMs) {
    const start = Math.max(0, t - 25) / 1000;
    const samples: number[] = [];
    let carry: Buffer = Buffer.alloc(0);
    await pcm(
      file,
      ['-vn', '-ss', start.toFixed(4), '-t', '0.05', '%IN%', '-ar', '48000', '-ac', '1'],
      (chunk) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const n = Math.floor(buf.length / 2);
        for (let i = 0; i < n; i++) samples.push(buf.readInt16LE(i * 2) / 32768);
        carry = buf.subarray(n * 2);
      },
    );
    const d = samples.slice(1).map((v, i) => Math.abs(v - samples[i]!));
    if (!d.length) {
      out.push({ atMs: t, maxStep: 0, medianStep: 0, ratio: 0, click: false });
      continue;
    }
    const sorted = [...d].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    const max = sorted[sorted.length - 1]!;
    const ratio = max / Math.max(med, 1e-4);
    out.push({
      atMs: t,
      maxStep: round(max),
      medianStep: round(med),
      ratio: Math.round(ratio * 10) / 10,
      click: max >= minStep && ratio >= minRatio,
    });
  }
  return out;
}
const round = (x: number) => Math.round(x * 10000) / 10000;
