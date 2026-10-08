import { run } from '@studio/engines';
import type { Span } from './audio.js';

export interface FrameSpan extends Span {
  frames: number;
}

/** Black spans of at least one frame. `fps` converts duration to frames. */
export async function blackFrames(file: string, fps: number): Promise<FrameSpan[]> {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      file,
      '-an',
      '-vf',
      `blackdetect=d=${(1 / fps).toFixed(4)}:pic_th=0.98:pix_th=0.10`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  const out: FrameSpan[] = [];
  for (const m of r.stderr.matchAll(
    /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g,
  )) {
    out.push({
      startMs: Math.round(Number(m[1]) * 1000),
      endMs: Math.round(Number(m[2]) * 1000),
      durMs: Math.round(Number(m[3]) * 1000),
      frames: Math.round(Number(m[3]) * fps),
    });
  }
  return out;
}

/** Frozen spans of at least `minS` seconds. */
export async function frozenFrames(file: string, minS = 1): Promise<Span[]> {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      file,
      '-an',
      '-vf',
      `freezedetect=n=-60dB:d=${minS}`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  const out: Span[] = [];
  let start: number | null = null;
  for (const m of r.stderr.matchAll(/lavfi\.freeze_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') start = Number(m[2]);
    else if (start !== null) {
      out.push({
        startMs: Math.round(start * 1000),
        endMs: Math.round(Number(m[2]) * 1000),
        durMs: Math.round((Number(m[2]) - start) * 1000),
      });
      start = null;
    }
  }
  return out;
}

export interface SceneCut {
  tMs: number;
  score: number;
}

/**
 * Scene changes by FFmpeg's scene score (0 to 1). Threshold 0.3 is a starting point: screen recordings
 * give false positives on scrolling and animation, so treat the result as candidates, not cuts.
 * With a range, times are relative to the start of the range.
 */
export async function scenes(
  file: string,
  threshold = 0.3,
  range?: { fromMs: number; toMs: number },
): Promise<SceneCut[]> {
  const rangeArgs = range
    ? [
        '-ss',
        (range.fromMs / 1000).toFixed(3),
        '-t',
        ((range.toMs - range.fromMs) / 1000).toFixed(3),
      ]
    : [];
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      ...rangeArgs,
      '-i',
      file,
      '-an',
      '-vf',
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  const out: SceneCut[] = [];
  let t: number | null = null;
  for (const line of r.stdout.split('\n')) {
    const a = /pts_time:([\d.]+)/.exec(line);
    if (a) t = Number(a[1]);
    const b = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (b && t !== null) {
      out.push({ tMs: Math.round(t * 1000), score: Math.round(Number(b[1]) * 1000) / 1000 });
      t = null;
    }
  }
  return out;
}
