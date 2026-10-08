import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EngineError, ffmpeg, lastLine, run } from './run.js';

let versionMemo: string | undefined;
export async function ffmpegVersion(): Promise<string> {
  if (!versionMemo) {
    const r = await run('ffmpeg', ['-version'], { timeoutMs: 10_000 });
    versionMemo = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
  }
  return versionMemo;
}

export interface DeriveSource {
  /** Absolute path to read (the CFR working copy when one exists, else the original). */
  path: string;
  kind: 'video' | 'audio' | 'image';
  durMs?: number;
  hasAudio: boolean;
}
export type Artifact = 'proxy' | 'thumbs' | 'peaks';
export interface DeriveReport {
  artifact: Artifact | string;
  status: 'built' | 'cached' | 'skipped';
  reason?: string;
  ms?: number;
  bytes?: number;
}

export const cacheDir = (project: string, hex: string) => join(project, '.studio', 'cache', hex);

/** Keyed by tool version and exact args so a changed encoder or preset rebuilds. */
async function keyFor(args: unknown): Promise<string> {
  return createHash('sha256')
    .update(JSON.stringify([await ffmpegVersion(), args]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Builds `file` through `file.partial` then renames, so a killed job never leaves a finished-looking file.
 * Skips when the file and its `.key` exist and match.
 */
async function artifact(
  dir: string,
  file: string,
  args: unknown,
  build: (tmp: string) => Promise<void>,
): Promise<{ status: 'built' | 'cached'; ms: number }> {
  const out = join(dir, file);
  const keyFile = out + '.key';
  const key = await keyFor(args);
  if (existsSync(out) && existsSync(keyFile) && readFileSync(keyFile, 'utf8') === key)
    return { status: 'cached', ms: 0 };
  const tmp = out + '.partial';
  rmSync(tmp, { force: true });
  const t0 = performance.now();
  try {
    await build(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, out);
  writeFileSync(keyFile, key);
  return { status: 'built', ms: Math.round(performance.now() - t0) };
}

const STD_FPS = [24, 25, 30, 50, 60];
export function cfrTarget(avg: number): number {
  const near = STD_FPS.find((f) => Math.abs(avg - f) / f < 0.05);
  return near ?? Math.round(avg);
}

/** Constant-frame-rate working copy for VFR sources. Display matrix is preserved, not baked (-noautorotate). */
export async function buildCfr(dir: string, src: string, nominalFps: number): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const fps = cfrTarget(nominalFps);
  const enc = [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `fps=${fps}`,
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-preset',
    'fast',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
  ];
  const r = await artifact(dir, 'cfr.mp4', enc, async (tmp) => {
    await ffmpeg(['-noautorotate', '-i', src, ...enc, '-f', 'mp4', tmp]);
  });
  void r;
  return fps;
}

export async function buildProxy(
  dir: string,
  s: DeriveSource,
  h: number | undefined,
): Promise<DeriveReport> {
  if (s.kind !== 'video')
    return { artifact: 'proxy', status: 'skipped', reason: `${s.kind} assets have no video proxy` };
  const vf = h && h > 720 ? 'scale=-2:720' : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = [
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-g',
    '15',
    '-keyint_min',
    '15',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    ...(s.hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    '-movflags',
    '+faststart',
  ];
  const r = await artifact(dir, 'proxy.mp4', args, async (tmp) => {
    // Autorotate is on: the proxy is upright and the UI must not rotate it again.
    await ffmpeg([
      '-i',
      s.path,
      '-map',
      '0:v:0',
      ...(s.hasAudio ? ['-map', '0:a:0'] : []),
      ...args,
      '-f',
      'mp4',
      tmp,
    ]);
  });
  return { artifact: 'proxy', ...r, bytes: sizeOf(join(dir, 'proxy.mp4')) };
}

export async function buildThumbs(dir: string, s: DeriveSource): Promise<DeriveReport> {
  if (s.kind === 'audio')
    return { artifact: 'thumbs', status: 'skipped', reason: 'audio assets have no thumbnails' };
  const TW = 160,
    TH = 90,
    COLS = 10;
  if (s.kind === 'image') {
    const r = await artifact(dir, 'thumbs.jpg', 'image-320', async (tmp) => {
      await ffmpeg([
        '-i',
        s.path,
        '-vf',
        'scale=320:-2',
        '-frames:v',
        '1',
        '-q:v',
        '4',
        '-f',
        'image2',
        tmp,
      ]);
    });
    return { artifact: 'thumbs', ...r, bytes: sizeOf(join(dir, 'thumbs.jpg')) };
  }
  const durS = (s.durMs ?? 1000) / 1000;
  const interval = Math.max(1, Math.ceil(durS / 100));
  const count = Math.max(1, Math.ceil(durS / interval));
  const rows = Math.ceil(count / COLS);
  const vf = `fps=1/${interval},scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${rows}`;
  const r = await artifact(dir, 'thumbs.jpg', vf, async (tmp) => {
    await ffmpeg([
      '-i',
      s.path,
      '-map',
      '0:v:0',
      '-vf',
      vf,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      '-f',
      'image2',
      tmp,
    ]);
  });
  writeFileSync(
    join(dir, 'thumbs.json'),
    JSON.stringify({ intervalS: interval, cols: COLS, rows, tileW: TW, tileH: TH, count }) + '\n',
  );
  return { artifact: 'thumbs', ...r, bytes: sizeOf(join(dir, 'thumbs.jpg')) };
}

export const PEAK_SR = 8000;
export const PEAK_BASE_SPP = 80; // 10 ms per peak at level 0
export const PEAK_FACTOR = 8;
const PEAK_LEVELS = 4;

/** Multi-resolution min/max peaks from a streamed 8 kHz mono decode. Nothing is held in memory but the peaks. */
export async function buildPeaks(dir: string, s: DeriveSource): Promise<DeriveReport> {
  if (!s.hasAudio) return { artifact: 'peaks', status: 'skipped', reason: 'no audio stream' };
  const argsKey = { sr: PEAK_SR, spp: PEAK_BASE_SPP, f: PEAK_FACTOR, n: PEAK_LEVELS };
  const r = await artifact(dir, 'peaks.json', argsKey, async (tmp) => {
    const min: number[] = [];
    const max: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          s.path,
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          String(PEAK_SR),
          '-f',
          's16le',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let err = '';
      let carry: Buffer = Buffer.alloc(0);
      let n = 0,
        lo = 32767,
        hi = -32768;
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-8192)));
      child.stdout.on('data', (chunk: Buffer) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % 2);
        for (let i = 0; i < usable; i += 2) {
          const v = buf.readInt16LE(i);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          if (++n === PEAK_BASE_SPP) {
            min.push(lo);
            max.push(hi);
            n = 0;
            lo = 32767;
            hi = -32768;
          }
        }
        carry = buf.subarray(usable);
      });
      child.on('error', (e: NodeJS.ErrnoException) =>
        reject(
          e.code === 'ENOENT' ? new EngineError('ENGINE_MISSING', 'ffmpeg not found on PATH') : e,
        ),
      );
      child.on('close', (code) => {
        if (code !== 0)
          return reject(
            new EngineError('ENGINE_FAILED', `ffmpeg peaks decode failed: ${lastLine(err)}`),
          );
        if (n > 0) {
          min.push(lo);
          max.push(hi);
        }
        resolve();
      });
    });
    const levels = [{ spp: PEAK_BASE_SPP, min, max }];
    for (let l = 1; l < PEAK_LEVELS; l++) {
      const prev = levels[l - 1]!;
      const nmin: number[] = [],
        nmax: number[] = [];
      for (let i = 0; i < prev.min.length; i += PEAK_FACTOR) {
        nmin.push(Math.min(...prev.min.slice(i, i + PEAK_FACTOR)));
        nmax.push(Math.max(...prev.max.slice(i, i + PEAK_FACTOR)));
      }
      levels.push({ spp: prev.spp * PEAK_FACTOR, min: nmin, max: nmax });
    }
    writeFileSync(tmp, JSON.stringify({ sr: PEAK_SR, levels }));
  });
  return { artifact: 'peaks', ...r, bytes: sizeOf(join(dir, 'peaks.json')) };
}

function sizeOf(p: string): number | undefined {
  try {
    return readFileSync(p).length;
  } catch {
    return undefined;
  }
}

/** Runs thumbs, proxy, and peaks for one asset. Safe to re-run: completed artifacts are cached. */
export async function deriveAll(
  dir: string,
  s: DeriveSource,
  h: number | undefined,
): Promise<DeriveReport[]> {
  mkdirSync(dir, { recursive: true });
  const out: DeriveReport[] = [];
  for (const step of [
    () => buildThumbs(dir, s),
    () => buildProxy(dir, s, h),
    () => buildPeaks(dir, s),
  ])
    out.push(await step());
  return out;
}

/** One build per content hash at a time. A lock left by a dead process is taken over. */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const take = () => writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    take();
  } catch {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    // A reused pid must not block forever: a lock older than 6 h is stale whatever the pid says.
    if (alive && Date.now() - statSync(lock).mtimeMs > 6 * 3600_000) alive = false;
    if (alive)
      throw new EngineError(
        'ENGINE_FAILED',
        `cache build already running (pid ${pid}) for ${dir}`,
        'wait for it to finish, or kill it and retry',
      );
    rmSync(lock, { force: true });
    take();
  }
  return fn().finally(() => rmSync(lock, { force: true }));
}

import { displaySize } from '@studio/core';
/** Height after rotation, used to decide whether a 720p proxy is a downscale. */
export const displayHeight = (p: { w?: number; h?: number; rotation?: number }) => displaySize(p).h;

/**
 * Cache of a JSON analysis result under the asset's content hash. The key covers the tool version and
 * the exact arguments, so a different threshold or ffmpeg build recomputes.
 */
export async function cachedJson<T>(
  dir: string,
  name: string,
  args: unknown,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  mkdirSync(dir, { recursive: true });
  const key = await keyFor(args);
  const file = join(
    dir,
    `analysis-${name}-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)}.json`,
  );
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j.key === key) return { value: j.value as T, cached: true };
    } catch {
      /* unreadable cache: recompute */
    }
  }
  const value = await compute();
  writeFileSync(file + '.partial', JSON.stringify({ key, value }));
  renameSync(file + '.partial', file);
  return { value, cached: false };
}
