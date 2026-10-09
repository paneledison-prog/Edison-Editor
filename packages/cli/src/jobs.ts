/**
 * The job governor: at most N heavy Studio commands run at once on this machine, however many workspaces and agents
 * are busy. Five agents may each start a render, but the machine runs two or three and the rest wait their turn, so
 * the box does not thrash, run out of memory or let a render time out. Without it five Chromium and five FFmpeg
 * processes start together.
 *
 * A slot is a file created exclusively in a shared folder (`wx`, atomic), named slot-0..slot-(N-1), holding the owner's
 * pid. A slot whose process is gone is taken over. It limits Studio's own commands and servers; it cannot limit a
 * program someone starts by hand.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Commands that run FFmpeg, a headless browser or a model for longer than a moment. */
const HEAVY = new Set([
  'render', 'cache.build', 'transcribe', 'captions.build',
  'video.cut-silence', 'video.scenes', 'video.speed', 'video.reframe',
  'audio.denoise', 'audio.clean-podcast', 'audio.normalize', 'audio.duck',
  'image.batch', 'image.bgremove', 'image.upscale', 'image.thumbnail', 'image.grade',
  'motion.still', 'motion.render', 'plugins.check',
  'color.apply', 'color.still', 'color.scopes', 'color.analyze', 'color.auto', 'color.match',
  'design.render', 'design.still',
  'track.add', 'track.build', 'track.set', 'track.preview', 'track.solve', 'stabilize', 'pin', 'matte.add', 'matte.key', 'matte.unkey', 'matte.build', 'matte.preview', 'cutout',
  'inspect.frame', 'inspect.sheet', 'inspect.waveform', 'inspect.loudness', 'inspect.silence', 'inspect.black', 'inspect.qc',
]);
export function isHeavy(name: string, flags: Record<string, unknown>): boolean {
  if (name === 'ingest') return flags['sync'] === true; // otherwise the derive step is a separate process that asks for its own slot
  if (name === 'render' && flags['explain'] === true) return false;
  return HEAVY.has(name);
}

export function maxJobs(): number {
  const e = Number(process.env['STUDIO_MAX_JOBS']);
  if (Number.isInteger(e) && e >= 1) return Math.min(e, 64);
  return Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));
}
export const jobsDir = (): string => process.env['STUDIO_JOBS_DIR'] ?? join(tmpdir(), `studio-jobs-${process.getuid?.() ?? 'user'}`);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Removes the slot file if its owner is gone (or it has sat empty for seconds: a writer that died between create and write). */
function reclaimIfStale(file: string): void {
  try {
    let pid = NaN;
    try {
      pid = JSON.parse(readFileSync(file, 'utf8')).pid;
    } catch {
      /* being written, or damaged */
    }
    const ageMs = Date.now() - statSync(file).mtimeMs;
    if (Number.isFinite(pid) ? !alive(pid) : ageMs > 5000) unlinkSync(file);
  } catch {
    /* released by its owner in the meantime */
  }
}

export interface Held {
  release: () => void;
  /** ms spent waiting for a slot */
  waitedMs: number;
}

/**
 * Waits for a slot and takes it. With `inherit`, the process tree below this command (the studio commands it runs
 * itself) counts as part of the same job and does not ask again; a server must not set it, because it runs many jobs.
 */
export async function acquireJob(label: string, o: { inherit?: boolean; log?: (m: string) => void } = {}): Promise<Held> {
  if (o.inherit && process.env['STUDIO_JOB_HELD']) return { release: () => {}, waitedMs: 0 };
  const dir = jobsDir();
  mkdirSync(dir, { recursive: true });
  const max = maxJobs();
  const t0 = Date.now();
  let nextNote = 10_000;
  for (;;) {
    for (let i = 0; i < max; i++) {
      const file = join(dir, `slot-${i}`);
      try {
        const fd = openSync(file, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, label, t: Date.now() }));
        closeSync(fd);
        if (o.inherit) process.env['STUDIO_JOB_HELD'] = file;
        let done = false;
        const release = () => {
          if (done) return;
          done = true;
          if (o.inherit) delete process.env['STUDIO_JOB_HELD'];
          try {
            unlinkSync(file);
          } catch {
            /* already reclaimed */
          }
        };
        if (o.inherit) process.once('exit', release);
        return { release, waitedMs: Date.now() - t0 };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        reclaimIfStale(file);
      }
    }
    if (o.log && Date.now() - t0 > nextNote) {
      o.log(`waiting for a free job slot: ${max} heavy command${max === 1 ? '' : 's'} already running (waited ${Math.round((Date.now() - t0) / 1000)} s)`);
      nextNote += 30_000;
    }
    await sleep(100 + Math.random() * 150);
  }
}

/** Runs `fn` holding a slot, for work a server does in-process. */
export async function withJob<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const h = await acquireJob(label);
  try {
    return await fn();
  } finally {
    h.release();
  }
}
