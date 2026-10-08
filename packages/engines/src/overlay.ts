import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, timelineDuration } from '@studio/core';
import { canvasFor } from './compile.js';
import { clipSpec, motionFrames, prepare } from './motion.js';
import { PRESETS } from './presets.js';
import { nextVersionName, type RenderOptions, type RenderReport } from './render.js';
import { EngineError, ffmpeg } from './run.js';

/**
 * `overlay-alpha`: the project's composition clips (titles, lower thirds, captions...) alone, on a transparent
 * canvas, as ProRes 4444 (yuva444p10le) or VP9 WebM with alpha, for use in another editor.
 */
export async function renderOverlayAlpha(o: RenderOptions): Promise<RenderReport> {
  const t0 = performance.now();
  const log = o.log ?? (() => {});
  const fmt = o.alphaFormat ?? 'prores4444';
  const ext = fmt === 'webm' ? 'webm' : 'mov';
  const comps = o.project.clips.filter(
    (c) => c.comp && !o.project.tracks.find((t) => t.id === c.track)?.hidden,
  );
  if (!comps.length)
    throw new EngineError(
      'INVALID_INPUT',
      'overlay-alpha needs at least one composition clip (title, lower-third, captions...) on a visible track',
      'add one with `studio captions add` or `studio tl add-clip --comp ...`',
    );
  const total = timelineDuration(o.project);
  const [a, b] = o.range ?? [0, total];
  if (!(b > a) || a < 0 || b > total)
    throw new EngineError(
      'INVALID_INPUT',
      `range ${a}:${b} is outside the timeline (0-${total} ms)`,
    );
  const preset = PRESETS['overlay-alpha']!;
  const { width, height } = canvasFor(o.project, preset, false, o.width);
  const fps = o.project.meta.fps;
  const cacheRoot = join(o.projectDir, '.studio', 'cache');
  const trackIdx = new Map(o.project.tracks.map((t, i) => [t.id, i]));
  const ordered = [...comps].sort(
    (x, y) => trackIdx.get(x.track)! - trackIdx.get(y.track)! || x.start - y.start,
  );
  const notes: string[] = [];
  const inputs: string[] = [];
  const lines: string[] = [
    `color=c=black@0.0:s=${width}x${height}:r=${fps}:d=${((b - a) / 1000).toFixed(3)},format=rgba[base0]`,
  ];
  let n = 0;
  for (const c of ordered) {
    const s = Math.max(c.start, a);
    const e = Math.min(c.start + c.dur, b);
    if (e <= s) continue;
    const prep = prepare(clipSpec(c, o.projectDir, { width, height, fps }));
    log(`motion: ${c.id} ${c.comp}`);
    const r = await motionFrames(prep, cacheRoot);
    notes.push(
      r.cached
        ? `${c.id}: ${c.comp} ${r.frames} frames from cache`
        : `${c.id}: ${c.comp} ${r.frames} frames in ${r.ms} ms (${r.renderFps} fps)`,
    );
    for (const w of r.warnings) notes.push(`${c.id}: ${w}`);
    const off = Math.round(((s - c.start) * fps) / 1000);
    inputs.push(
      '-framerate',
      String(fps),
      '-start_number',
      String(off),
      '-t',
      ((e - s) / 1000).toFixed(3),
      '-i',
      join(r.dir, '%06d.png'),
    );
    lines.push(
      `[${n}:v]fps=${fps},format=rgba,setpts=PTS-STARTPTS+${((s - a) / 1000).toFixed(3)}/TB[v${n}]`,
      `[base${n}][v${n}]overlay=format=auto:eof_action=pass:repeatlast=0:enable='between(t,${((s - a) / 1000).toFixed(3)},${((e - a) / 1000).toFixed(3)})'[base${n + 1}]`,
    );
    n++;
  }
  const baseName = o.name ?? nextVersionName(o.projectDir, o.project, 'overlay-alpha', ext);
  const outRel = join('renders', `${baseName}.${ext}`);
  const out = join(o.projectDir, outRel);
  const partial = join(o.projectDir, 'renders', '.tmp', `${baseName}.${ext}.partial.${ext}`);
  const pixfmt = fmt === 'webm' ? 'yuva420p' : 'yuva444p10le';
  const codec =
    fmt === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-auto-alt-ref', '0']
      : ['-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0'];
  const report: RenderReport = {
    backend: 'hybrid',
    reason:
      'composition clips only, rendered by the Chromium motion renderer on a transparent canvas',
    preset: 'overlay-alpha',
    durationMs: b - a,
    width,
    height,
    fps,
    vcodec: fmt === 'webm' ? 'vp9' : 'prores',
    encoder: fmt === 'webm' ? 'libvpx-vp9' : 'prores_ks',
    acodec: null,
    reframe: 'fit',
    streamCopy: false,
    loudness: null,
    notes: [...notes, `pixel format ${pixfmt} (alpha channel kept)`],
  } as RenderReport;
  if (o.explain) return report;
  if (!o.force) {
    const { existsSync } = await import('node:fs');
    if (existsSync(out))
      throw new EngineError(
        'WOULD_OVERWRITE',
        `${outRel} exists`,
        'omit --out to get the next version, or pass --force',
      );
  }
  mkdirSync(join(o.projectDir, 'renders', '.tmp'), { recursive: true });
  rmSync(partial, { force: true });
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${lines.join(';\n')};[base${n}]format=${pixfmt}[vout]`,
    '-map',
    '[vout]',
    ...codec,
    '-pix_fmt',
    pixfmt,
    '-an',
    '-t',
    ((b - a) / 1000).toFixed(3),
    partial,
  ]);
  renameSync(partial, out);
  const sidecar = join('renders', `render-${baseName}.project.json`);
  writeFileSync(join(o.projectDir, sidecar), canonicalize(o.project));
  report.output = outRel;
  report.sidecar = sidecar;
  report.bytes = statSync(out).size;
  report.renderMs = Math.round(performance.now() - t0);
  writeFileSync(
    join(o.projectDir, 'renders', `render-${baseName}.report.json`),
    JSON.stringify({ ...report, hasAudio: false }, null, 2) + '\n',
  );
  return report;
}
