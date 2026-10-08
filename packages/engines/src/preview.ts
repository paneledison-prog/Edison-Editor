import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectHash, timelineDuration, type Project } from '@studio/core';
import { canvasFor, compile } from './compile.js';
import { clipSpec, motionStill, prepare } from './motion.js';
import { PREVIEW } from './presets.js';
import { EngineError, ffmpeg } from './run.js';
import { ensureTracks } from './track.js';

export interface PreviewResult {
  file: string;
  cached: boolean;
  width: number;
  height: number;
  ms: number;
  /** composition clips drawn into this frame */
  overlays: number;
}

/**
 * One frame of the timeline at `tMs`, at preview size, through the same compiler as a render (cuts, speed, zoom, blur,
 * overlays), written to `.studio/cache/preview/`. Approximate: it uses the original media, not a proxy, and no audio.
 */
export async function previewFrame(
  project: Project,
  projectDir: string,
  tMs: number,
  width = 640,
): Promise<PreviewResult> {
  const t0 = Date.now();
  const total = timelineDuration(project);
  if (!Number.isFinite(tMs) || tMs < 0 || tMs >= Math.max(1, total))
    throw new EngineError(
      'INVALID_INPUT',
      `time ${tMs} ms is outside the timeline (0-${total} ms)`,
    );
  const w = Math.min(960, Math.max(160, Math.round(width)));
  const key = createHash('sha256')
    .update(JSON.stringify([projectHash(project), Math.round(tMs), w]))
    .digest('hex')
    .slice(0, 20);
  const dir = join(projectDir, '.studio', 'cache', 'preview');
  const out = join(dir, `${key}.png`);
  const { width: cw, height: ch } = canvasFor(project, PREVIEW, true, w);
  if (existsSync(out))
    return { file: out, cached: true, width: cw, height: ch, ms: Date.now() - t0, overlays: 0 };
  mkdirSync(dir, { recursive: true });
  const fps = project.meta.fps;
  const frameMs = 1000 / fps;
  const at = Math.round(tMs);
  const window: [number, number] = [at, Math.min(total, at + Math.ceil(frameMs * 2))];
  const tmp = mkdtempSync(join(tmpdir(), 'studio-preview-'));
  try {
    // A composition clip needs its frame for this instant: a still from the motion renderer, named as the clip's frame
    // sequence would be, so the compiler reads it as a one-frame overlay.
    const overlays: Record<string, { dir: string; fps: number; frames: number }> = {};
    let n = 0;
    for (const c of project.clips) {
      if (!c.comp || c.start > at || c.start + c.dur <= at) continue;
      if (project.tracks.find((tr) => tr.id === c.track)?.hidden) continue;
      const prep = prepare(clipSpec(c, projectDir, { width: cw, height: ch, fps }));
      const frame = Math.min(
        prep.frames - 1,
        Math.max(0, Math.round(((at - c.start) * fps) / 1000)),
      );
      const still = join(tmp, `${c.id}.png`);
      await motionStill(prep, frame, still);
      const sub = join(tmp, c.id);
      mkdirSync(sub);
      // the compiler asks for frame `round(srcIn x fps / 1000)` of the window start
      const off = Math.round(
        (((c.srcIn ?? 0) + (Math.max(c.start, window[0]) - c.start)) * fps) / 1000,
      );
      copyFileSync(still, join(sub, String(off).padStart(6, '0') + '.png'));
      overlays[c.id] = { dir: sub, fps, frames: 1 };
      n++;
    }
    // a frame preview does not wait for an analysis: stabilize and pin need their tracker built (studio track build)
    const here = new Set(project.clips.filter((c) => c.start < window[1] && c.start + c.dur > window[0]).map((c) => c.id));
    const tracks = await ensureTracks(project, projectDir, { build: false, clipIds: here });
    const plan = compile({
      project,
      projectDir,
      preset: PREVIEW,
      preview: true,
      window,
      width: w,
      overlays,
      tracks,
    });
    const partial = out + '.partial.png';
    rmSync(partial, { force: true });
    await ffmpeg(
      [
        ...plan.inputs,
        '-filter_complex',
        plan.videoFilter,
        '-map',
        '[vout]',
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'png',
        partial,
      ],
      120_000,
    );
    renameSync(partial, out);
    return {
      file: out,
      cached: false,
      width: plan.width,
      height: plan.height,
      ms: Date.now() - t0,
      overlays: n,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
