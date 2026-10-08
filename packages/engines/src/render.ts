import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalize, timelineDuration, type Project } from '@studio/core';
import { canvasFor, compile, type Plan } from './compile.js';
import { clipSpec, motionFrames, prepare } from './motion.js';
import { renderOverlayAlpha } from './overlay.js';
import { licenseWarnings } from './library.js';
import { PREVIEW, getPreset, type Preset } from './presets.js';
import { probeFile } from './probe.js';
import { EngineError, lastLine, run, withFilterScripts } from './run.js';
import { ensureTracks } from './track.js';

export interface RenderOptions {
  project: Project;
  projectDir: string;
  preset: string;
  preview?: boolean;
  /** [a, b] ms */
  range?: [number, number];
  /** a single frame at this timeline time (ms), written as PNG */
  still?: number;
  /** explicit output base name (no extension); versioned automatically when omitted */
  name?: string;
  force?: boolean;
  encoder?: string;
  /** skip two-pass loudness normalization */
  noNormalize?: boolean;
  /** render at this width; height follows the aspect */
  width?: number;
  /** how clips of a different aspect are fitted: fit (default), blur, center-crop */
  reframe?: 'fit' | 'blur' | 'center-crop';
  /** x264 preset override (ultrafast..veryslow); the preset's own default otherwise */
  x264Preset?: string;
  /** overlay-alpha only: ProRes 4444 (default) or VP9 WebM with alpha */
  alphaFormat?: 'prores4444' | 'webm';
  /** build and describe the plan, run nothing */
  explain?: boolean;
  log?: (m: string) => void;
}

export interface RenderReport {
  backend: 'ffmpeg' | 'hybrid';
  reason: string;
  preset: string;
  output?: string;
  sidecar?: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  encoder: string;
  acodec: string | null;
  bytes?: number;
  bitrateKbps?: number;
  renderMs?: number;
  reframe: 'fit' | 'blur' | 'center-crop';
  x264Preset?: string;
  streamCopy: false;
  loudness: null | {
    mode: 'two-pass' | 'none';
    targetI?: number;
    targetTP?: number;
    measured?: Record<string, string>;
    why?: string;
  };
  joinsMs: number[];
  notes: string[];
  ffmpegArgs?: string[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';

/** Active children, killed (and partials removed) if the CLI is interrupted. */
const TP_HEADROOM_DB = 0.5;
const active = new Set<{ child: ChildProcess; partial: string }>();
let hooked = false;
function hookSignals() {
  if (hooked) return;
  hooked = true;
  const bail = (code: number) => () => {
    for (const a of active) {
      a.child.kill('SIGKILL');
      rmSync(a.partial, { force: true });
    }
    process.exit(code);
  };
  process.on('SIGINT', bail(130));
  process.on('SIGTERM', bail(143));
}

function runFfmpeg(args: string[], partial?: string): Promise<{ code: number; stderr: string }> {
  hookSignals();
  const scripted = withFilterScripts(args);
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...scripted.args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const entry = { child, partial: partial ?? '' };
    active.add(entry);
    let stderr = '';
    child.stderr
      .setEncoding('utf8')
      .on('data', (d: string) => (stderr = (stderr + d).slice(-64 * 1024)));
    child.on('error', (e: NodeJS.ErrnoException) => {
      active.delete(entry);
      scripted.cleanup();
      reject(
        e.code === 'ENOENT'
          ? new EngineError(
              'ENGINE_MISSING',
              'ffmpeg not found on PATH',
              'install ffmpeg and run `studio doctor`',
            )
          : e,
      );
    });
    child.on('close', (code) => {
      active.delete(entry);
      scripted.cleanup();
      resolve({ code: code ?? 1, stderr });
    });
  });
}

function videoArgs(preset: Preset, plan: Plan, encoder: string, x264Preset?: string): string[] {
  if (preset.kind === 'gif') return ['-loop', '0'];
  if (encoder !== 'libx264') {
    throw new EngineError(
      'ENCODER_UNSUPPORTED',
      `encoder ${encoder} is not wired in yet; only libx264 is supported`,
      'omit --encoder to use libx264',
    );
  }
  return [
    '-c:v',
    'libx264',
    '-preset',
    x264Preset ?? preset.x264Preset,
    '-crf',
    String(preset.crf),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(Math.round(plan.fps * 2)),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-r',
    String(plan.fps),
  ];
}

/** Loudness parameters parsed from loudnorm's JSON summary on stderr. */
function parseLoudnorm(stderr: string): Record<string, string> {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m)
    throw new EngineError(
      'ENGINE_FAILED',
      'loudnorm pass 1 produced no measurement (is there audio?)',
    );
  return JSON.parse(m[0]);
}

export function nextVersionName(
  dir: string,
  project: Project,
  presetId: string,
  ext: string,
): string {
  const base = `${slug(project.meta.name)}-${presetId}`;
  let n = 1;
  while (existsSync(join(dir, 'renders', `${base}-v${n}.${ext}`))) n++;
  return `${base}-v${n}`;
}

export async function render(o: RenderOptions): Promise<RenderReport> {
  const log = o.log ?? (() => {});
  if (o.preset === 'overlay-alpha' && !o.preview) return renderOverlayAlpha(o);
  const preset = o.preview ? PREVIEW : getPreset(o.preset);
  const encoder = o.encoder ?? 'libx264';
  const total = timelineDuration(o.project);
  if (total === 0)
    throw new EngineError(
      'INVALID_INPUT',
      'the timeline is empty: add clips before rendering',
      'studio tl add-clip ...',
    );

  let window: [number, number] | undefined = o.range;
  const stillMode = o.still !== undefined;
  if (stillMode) {
    const frameMs = 1000 / (preset.fps ?? o.project.meta.fps);
    if (o.still! < 0 || o.still! >= total)
      throw new EngineError(
        'INVALID_INPUT',
        `--still ${o.still} ms is outside the timeline (0–${total} ms)`,
      );
    window = [o.still!, Math.min(total, o.still! + Math.ceil(frameMs * 2))];
  }
  if (window && (window[0] < 0 || window[1] > total || window[1] <= window[0])) {
    throw new EngineError(
      'INVALID_INPUT',
      `--range ${window[0]}:${window[1]} is outside the timeline (0–${total} ms)`,
    );
  }

  // Composition clips: render their alpha frames first (cached), then FFmpeg composites them in the same pass.
  const overlays: Record<string, { dir: string; fps: number; frames: number }> = {};
  const motionNotes: string[] = [];
  const comps = o.project.clips.filter((c) => c.comp);
  if (comps.length) {
    const cv = canvasFor(o.project, preset, !!o.preview, o.width);
    const fps = preset.fps ?? o.project.meta.fps;
    const cacheRoot = join(o.projectDir, '.studio', 'cache');
    for (const c of comps) {
      if (o.project.tracks.find((t) => t.id === c.track)?.hidden) continue;
      const prep = prepare(clipSpec(c, o.projectDir, { ...cv, fps }));
      if (o.explain) {
        overlays[c.id] = { dir: join(cacheRoot, 'motion', prep.key), fps, frames: prep.frames };
        motionNotes.push(
          `${c.id}: ${c.comp} ${prep.frames} frames at ${fps} fps (cache key ${prep.key}, rendered on demand)`,
        );
        continue;
      }
      log(`motion: ${c.id} ${c.comp}`);
      const r = await motionFrames(prep, cacheRoot);
      overlays[c.id] = { dir: r.dir, fps, frames: r.frames };
      motionNotes.push(
        r.cached
          ? `${c.id}: ${c.comp} ${r.frames} frames from cache (${prep.key})`
          : `${c.id}: ${c.comp} ${r.frames} frames rendered in ${r.ms} ms (${r.renderFps} fps, ${r.concurrency} pages)`,
      );
      for (const w of r.warnings) motionNotes.push(`${c.id}: ${w}`);
    }
  }
  // Stabilize and pin need their tracker analysed: a render does that (cached), an explain run only reads what exists.
  const inWindow = new Set(o.project.clips.filter((c) => !window || (c.start < window[1] && c.start + c.dur > window[0])).map((c) => c.id));
  const trackNotes: string[] = [];
  const tracks = await ensureTracks(o.project, o.projectDir, {
    build: !o.explain,
    log,
    clipIds: inWindow,
    placeholder: (id) => trackNotes.push(`tracker ${id} has not been analysed yet; this graph uses a placeholder for it (studio track build ${id})`),
  });
  const plan = compile({
    project: o.project,
    projectDir: o.projectDir,
    preset,
    preview: o.preview,
    window,
    width: o.width,
    reframe: o.reframe,
    overlays,
    tracks,
  });
  const ext = stillMode ? 'png' : preset.ext;
  const baseName =
    o.name ?? nextVersionName(o.projectDir, o.project, stillMode ? 'still' : preset.id, ext);
  const outRel = join('renders', `${baseName}.${ext}`);
  const out = join(o.projectDir, outRel);
  const tmpDir = join(o.projectDir, 'renders', '.tmp');
  const partial = join(tmpDir, `${baseName}.${ext}.partial`);

  const wantAudio = plan.hasAudio && preset.kind === 'video' && !stillMode;
  const normalize = wantAudio && !!preset.loudness && !o.noNormalize;
  const report: RenderReport = {
    backend: plan.backend,
    reason: plan.reason,
    preset: preset.id,
    durationMs: plan.durationMs,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    vcodec: stillMode ? 'png' : preset.kind === 'gif' ? 'gif' : 'h264',
    encoder: stillMode ? 'png' : preset.kind === 'gif' ? 'gif' : encoder,
    acodec: wantAudio ? 'aac' : null,
    reframe: o.reframe ?? 'fit',
    ...(o.x264Preset && preset.kind === 'video' ? { x264Preset: o.x264Preset } : {}),
    streamCopy: false,
    loudness: null,
    joinsMs: plan.joinsMs,
    notes: [...plan.notes, ...motionNotes, ...trackNotes],
  };
  report.notes.push(
    ...licenseWarnings(
      o.projectDir,
      o.project,
      o.project.clips.flatMap((c) => (c.asset ? [c.asset] : [])),
    ),
  );
  if (!wantAudio && !stillMode && preset.kind === 'video' && !plan.hasAudio)
    report.notes.push('output has no audio stream');
  if (preset.kind === 'gif')
    report.notes.push('gif has no audio; palettegen/paletteuse with sierra2_4a dither');

  // --- build args
  let vfinal = '[vout]';
  let graph = wantAudio ? plan.filter : plan.videoFilter;
  if (preset.kind === 'gif') {
    graph += `;[vout]scale='min(${plan.width},iw)':-2:flags=lanczos,split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=sierra2_4a[gif]`;
    vfinal = '[gif]';
  }
  const common = ['-filter_complex', graph];
  const mkMain = (norm?: string): string[] => {
    const args = [...plan.inputs, ...common, '-map', vfinal];
    if (stillMode) return [...args, '-frames:v', '1', '-f', 'image2', partial];
    if (wantAudio) {
      args.push('-map', norm ? '[aout]' : '[amix]');
    }
    args.push(...videoArgs(preset, plan, encoder, o.x264Preset));
    if (wantAudio)
      args.push('-c:a', 'aac', '-b:a', `${preset.audioKbps}k`, '-ar', '48000', '-ac', '2');
    if (preset.kind === 'video') args.push('-movflags', '+faststart');
    args.push(
      '-t',
      (plan.durationMs / 1000).toFixed(3),
      '-f',
      preset.kind === 'gif' ? 'gif' : 'mp4',
      partial,
    );
    return args;
  };

  if (normalize) {
    const t = preset.loudness!;
    report.loudness = { mode: 'two-pass', targetI: t.I, targetTP: t.TP };
  } else if (wantAudio) {
    report.loudness = {
      mode: 'none',
      why: o.preview
        ? 'preview renders skip normalization'
        : o.noNormalize
          ? '--no-normalize'
          : 'preset has no target',
    };
  }

  if (o.explain) {
    report.ffmpegArgs = mkMain(normalize ? 'x' : undefined);
    if (normalize)
      report.notes.push(
        'two-pass loudnorm: pass 1 measures the mix, pass 2 applies it with the measured values (linear)',
      );
    return report;
  }

  // --- safe write: refuse to overwrite, render to .tmp, verify, rename
  if (existsSync(out) && !o.force) {
    throw new EngineError(
      'WOULD_OVERWRITE',
      `${outRel} already exists`,
      'omit --out to get the next version name, or pass --force',
    );
  }
  mkdirSync(tmpDir, { recursive: true });
  for (const f of readdirSync(tmpDir))
    if (f.endsWith('.partial')) rmSync(join(tmpDir, f), { force: true }); // leftovers from a killed render
  const t0 = performance.now();

  let aoutGraph: string | undefined;
  if (normalize) {
    const t = preset.loudness!;
    log(`pass 1: measuring loudness (${(plan.durationMs / 1000).toFixed(1)} s of audio)`);
    const m = await runFfmpeg([
      ...plan.inputs,
      '-filter_complex',
      `${plan.audioFilter};[amix]loudnorm=I=${t.I}:TP=${t.TP}:LRA=11:print_format=json[mx]`,
      '-map',
      '[mx]',
      '-vn',
      '-f',
      'null',
      '-',
    ]);
    if (m.code !== 0)
      throw new EngineError('ENGINE_FAILED', `ffmpeg loudness pass failed: ${lastLine(m.stderr)}`);
    const meas = parseLoudnorm(m.stderr);
    report.loudness!.measured = meas;
    if (meas.input_i === '-inf')
      throw new EngineError(
        'ENGINE_FAILED',
        'the audio mix is silent; cannot normalize',
        'check the audio clips, or render with --no-normalize',
      );
    // AAC encoding raises the true peak by about 0.2 dB after loudnorm, so aim lower than the target.
    aoutGraph = `[amix]loudnorm=I=${t.I}:TP=${t.TP - TP_HEADROOM_DB}:LRA=${Math.min(50, Math.max(11, Math.ceil(Number(meas.input_lra)) + 1))}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=48000[aout]`;
    graph += `;${aoutGraph}`;
    common[1] = graph;
  }

  log(
    `rendering ${outRel} (${plan.width}x${plan.height} @ ${plan.fps} fps, ${(plan.durationMs / 1000).toFixed(1)} s)`,
  );
  const r = await runFfmpeg(mkMain(normalize ? 'x' : undefined), partial);
  if (r.code !== 0) {
    rmSync(partial, { force: true });
    throw new EngineError('ENGINE_FAILED', `ffmpeg render failed: ${lastLine(r.stderr)}`);
  }

  // --- verify the partial opens and has the expected length before it can look finished
  if (!stillMode) {
    const pr = await probeFile(partial).catch((e) => {
      rmSync(partial, { force: true });
      throw new EngineError(
        'ENGINE_FAILED',
        `render output failed verification: ${(e as Error).message}`,
      );
    });
    if (preset.kind === 'video') {
      const frameMs = 1000 / plan.fps;
      if (Math.abs((pr.probe.durMs ?? 0) - plan.durationMs) > frameMs * 2) {
        const got = pr.probe.durMs;
        rmSync(partial, { force: true });
        throw new EngineError(
          'ENGINE_FAILED',
          `rendered duration ${got} ms differs from the timeline ${plan.durationMs} ms by more than 2 frames`,
        );
      }
    }
  } else if (statSync(partial).size === 0) {
    rmSync(partial, { force: true });
    throw new EngineError('ENGINE_FAILED', 'still render produced an empty file');
  }
  mkdirSync(join(o.projectDir, 'renders'), { recursive: true });
  renameSync(partial, out);

  const sidecar = join('renders', `render-${baseName}.project.json`);
  writeFileSync(join(o.projectDir, sidecar), canonicalize(o.project));

  const bytes = statSync(out).size;
  const reportRel = join('renders', `render-${baseName}.report.json`);
  report.output = outRel;
  report.sidecar = sidecar;
  report.bytes = bytes;
  report.renderMs = Math.round(performance.now() - t0);
  if (!stillMode) report.bitrateKbps = Math.round((bytes * 8) / 1000 / (plan.durationMs / 1000));
  writeFileSync(
    join(o.projectDir, reportRel),
    JSON.stringify({ ...report, hasAudio: wantAudio }, null, 2) + '\n',
  );
  return report;
}

export { run };
