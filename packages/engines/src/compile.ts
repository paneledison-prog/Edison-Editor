import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { displaySize, speedOf, type Clip, type Fx, type Project } from '@studio/core';
import { MAX_AUDIO_SPEED, clipAudioChain, dbToLin } from './audiofx.js';
import { EngineError } from './run.js';
import { blurRegionFilter, hasMotion, zoomFilter } from './zoom.js';
import { effectLines, pluginEffectDecl, type FxContext } from './plugins.js';
import { checkClipKeyframes, nodeLines } from './fxanim.js';
import type { MatteData } from './matte.js';
import type { TrackData } from './track.js';
import { PIN_MARGIN, correctionTable, pinQuads, pinWarpLines, stabilizeLines, stabilizePlan, type ClipTiming } from './trackfx.js';
import type { Preset } from './presets.js';

export interface Plan {
  backend: 'ffmpeg' | 'hybrid';
  reason: string;
  /** ffmpeg input arguments, in order (each input is `-ss .. -t .. -i file`) */
  inputs: string[];
  filter: string;
  /** `filter` without the audio chain, for outputs that carry no audio (stills, GIFs). */
  videoFilter: string;
  /** The audio-only part of `filter` (ends at [amix]); undefined when there is no audio. */
  audioFilter?: string;
  hasVideo: true;
  hasAudio: boolean;
  /** Label of the mixed audio before any loudness stage */
  audioMix?: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  notes: string[];
  /** Timeline join times (ms, relative to the render start) where two audio clips meet. */
  joinsMs: number[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);
const hex = (c: string) => '0x' + c.replace('#', '').slice(0, 6);

/**
 * Router. FFmpeg handles cuts, concat, fit-scale, image overlays, and the audio chain. Composition clips
 * (titles, lower thirds, callouts, captions) are rendered by the motion renderer as alpha frames and composited
 * by FFmpeg in the same pass, so the source video is still encoded once ("hybrid").
 * Keyframes and transforms on media clips (scale, x, y: zoom and pan) are one FFmpeg scale+crop per clip, see zoom.ts.
 * Anything else (rot, opacity, motion on a composition clip) fails with the reason instead of being ignored.
 */
export function routeBackend(p: Project): { backend: 'ffmpeg' | 'hybrid'; reason: string } {
  const unsupported: string[] = [];
  let comps = 0;
  for (const c of p.clips) {
    if (c.comp) comps++;
    if (c.comp && hasMotion(c))
      unsupported.push(
        `${c.id}: keyframes/transform on a composition clip (animate it with its props)`,
      );
  }
  if (unsupported.length) {
    throw new EngineError(
      'ENGINE_MISSING',
      `unsupported motion: ${unsupported.slice(0, 6).join('; ')}${unsupported.length > 6 ? ` (+${unsupported.length - 6} more)` : ''}`,
      'remove those properties (`studio project undo`); composition clips animate through their props',
    );
  }
  if (comps)
    return {
      backend: 'hybrid',
      reason: `${comps} composition clip${comps > 1 ? 's' : ''} rendered as alpha frames by the Chromium motion renderer, composited over the FFmpeg timeline in one encode`,
    };
  return {
    backend: 'ffmpeg',
    reason:
      'only cuts, concat, speed, fit/crop/blur reframing, overlay, and the audio chain are used',
  };
}

/** Restrict the timeline to [a, b) ms by cutting clips at the window edges and shifting them to start at 0. */
export function windowClips(clips: Clip[], a: number, b: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const s = Math.max(c.start, a);
    const e = Math.min(c.start + c.dur, b);
    if (e <= s) continue;
    out.push({
      ...c,
      start: s - a,
      dur: e - s,
      srcIn: c.asset
        ? (c.srcIn ?? 0) + Math.round((s - c.start) * speedOf(c))
        : (c.srcIn ?? 0) + (s - c.start),
      // Keyframe times are clip-local: a window that starts inside the clip shifts them.
      ...(c.keyframes && s > c.start
        ? {
            keyframes: Object.fromEntries(
              Object.entries(c.keyframes).map(([k, v]) => [
                k,
                v.map((x) => ({ ...x, t: x.t - (s - c.start) })),
              ]),
            ),
          }
        : {}),
    });
  }
  return out;
}

export function canvasFor(
  p: Project,
  preset: Preset,
  preview: boolean,
  widthOverride?: number,
): { width: number; height: number } {
  if (widthOverride) {
    const base =
      preset.w && preset.h ? { w: preset.w, h: preset.h } : { w: p.meta.width, h: p.meta.height };
    return { width: even(widthOverride), height: even((widthOverride * base.h) / base.w) };
  }
  if (preset.w && preset.h) return { width: preset.w, height: preset.h };
  const { width, height } = p.meta;
  if (preview || preset.kind === 'gif') {
    const maxW = preview ? 640 : 720;
    const k = Math.min(1, maxW / width);
    return { width: even(width * k), height: even(height * k) };
  }
  return { width: even(width), height: even(height) };
}

export interface CompileInput {
  project: Project;
  projectDir: string;
  preset: Preset;
  preview?: boolean;
  window?: [number, number];
  /** Render at this width (height follows the preset's or project's aspect). */
  width?: number;
  /** How a clip whose aspect differs from the canvas is fitted. Default: fit (letterbox on the project background). */
  reframe?: 'fit' | 'blur' | 'center-crop';
  /** Pre-rendered alpha frame sequences for composition clips, keyed by clip id (frames are canvas-sized). */
  overlays?: Record<string, { dir: string; fps: number; frames: number }>;
  /** Analysed trackers by id, for the clips' stabilize and pin effects (see ensureTracks). */
  tracks?: Record<string, TrackData>;
  /** Built mattes by id, for the clips' cutout effects and effects limited to a matte (see ensureMattes). */
  mattes?: Record<string, MatteData>;
}

type MatteUse = NonNullable<Extract<Fx, { type: 'cutout' }>['matte']>;

/** The matte's finishing: shrink or grow, soften, flip. Returns filter lines from `from` to `to`. */
function matteFinish(from: string, to: string, m: MatteUse): string[] {
  const f: string[] = [];
  const ch = Math.round(m.choke ?? 0);
  for (let i = 0; i < Math.abs(ch); i++) f.push(ch > 0 ? 'erosion' : 'dilation');
  if ((m.feather ?? 0) > 0) f.push(`gblur=sigma=${Math.max(0.3, (m.feather ?? 0) / 2).toFixed(2)}`);
  if (m.invert) f.push('negate');
  return [`[${from}]${f.length ? f.join(',') : 'null'}[${to}]`];
}

/** An effect that shows only inside a matte: the picture and the effected picture are laid together by the matte's opacity. */
function restrictLines(from: string, to: string, uid: string, inner: (i: string, o: string) => string[], mask: string, m: MatteUse): string[] {
  return [
    `[${from}]split=2[${uid}o][${uid}i]`,
    ...inner(`${uid}i`, `${uid}e`),
    ...matteFinish(mask, `${uid}m`, m),
    `[${uid}e][${uid}m]alphamerge[${uid}ea]`,
    `[${uid}o][${uid}ea]overlay=format=auto:eof_action=pass:repeatlast=0[${to}]`,
  ];
}

export function compile(inp: CompileInput): Plan {
  const { project: p, projectDir, preset } = inp;
  const route = routeBackend(p);
  const total = Math.max(0, ...p.clips.map((c) => c.start + c.dur));
  const [wa, wb] = inp.window ?? [0, total];
  if (!(wb > wa))
    throw new EngineError(
      'INVALID_INPUT',
      `render window ${wa}–${wb} ms is empty (timeline is ${total} ms)`,
    );
  const clips = windowClips(p.clips, wa, Math.min(wb, total));
  if (!clips.length)
    throw new EngineError(
      'INVALID_INPUT',
      'nothing to render: the timeline has no clips in that range',
    );
  const durationMs = Math.min(wb, total) - wa;

  const { width, height } = canvasFor(p, preset, !!inp.preview, inp.width);
  const fps = preset.fps ?? p.meta.fps;
  const notes: string[] = [];
  if (preset.w && (preset.w !== p.meta.width || preset.h !== p.meta.height)) {
    notes.push(
      `project canvas ${p.meta.width}x${p.meta.height} is fitted into ${width}x${height} (letterboxed on the project background, not stretched or cropped)`,
    );
  }

  const trackIdx = new Map(p.tracks.map((t, i) => [t.id, i]));
  const trackOf = (c: Clip) => p.tracks.find((t) => t.id === c.track)!;
  // Layer order: later tracks are on top; within a track, by start time.
  const ordered = [...clips].sort(
    (x, y) => trackIdx.get(x.track)! - trackIdx.get(y.track)! || x.start - y.start,
  );

  const inputs: string[] = [];
  const vLines: string[] = [];
  /** Per-clip audio after its own chain and fades, before ducking and mixing. */
  interface AItem {
    label: string;
    track: string;
    duck?: Extract<Fx, { type: 'duck' }>;
    clipId: string;
  }
  const aLines: string[] = [];
  const aItems: AItem[] = [];
  let nIn = 0;
  let nV = 0;
  const bg = hex(p.meta.background);
  const joinEdges: { track: string; start: number; end: number }[] = [];
  const reframe = inp.reframe ?? 'fit';

  for (const c of ordered) {
    const t = trackOf(c);
    if (c.comp) {
      if (t.hidden) continue;
      const ov = inp.overlays?.[c.id];
      if (!ov)
        throw new EngineError(
          'INVALID_INPUT',
          `composition clip ${c.id} (${c.comp}) has no rendered frames; the render step must prepare overlays first`,
        );
      const k = nIn++;
      const off = Math.round(((c.srcIn ?? 0) * ov.fps) / 1000);
      inputs.push(
        '-framerate',
        String(ov.fps),
        '-start_number',
        String(off),
        '-t',
        sec(c.dur),
        '-i',
        join(ov.dir, '%06d.png'),
      );
      vLines.push(`[${k}:v]fps=${fps},format=rgba,setpts=PTS-STARTPTS+${sec(c.start)}/TB[v${nV}]`);
      nV++;
      continue;
    }
    const a = c.asset ? p.assets[c.asset]! : undefined;
    if (!a) continue;
    const src = join(projectDir, a.workingCopy?.path ?? a.path);
    const speed = speedOf(c);
    const wantsVideo =
      (t.type === 'video' || t.type === 'graphics') && a.kind !== 'audio' && !t.hidden;
    let wantsAudio =
      !!a.probe.audio &&
      (a.kind === 'video' || a.kind === 'audio') &&
      !t.muted &&
      t.type !== 'graphics';
    if (wantsAudio && speed > MAX_AUDIO_SPEED) {
      wantsAudio = false;
      notes.push(`${c.id}: speed ${speed}x is above ${MAX_AUDIO_SPEED}x, so its audio is dropped`);
    }
    if (!wantsVideo && !wantsAudio) continue;
    if (speed < 0.5 && a.kind === 'video')
      notes.push(
        `${c.id}: speed ${speed}x is below 0.5x; there is no frame interpolation, so motion will judder`,
      );

    checkClipKeyframes(c);
    const k = nIn++;
    if (a.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(c.dur), '-i', src);
    } else {
      // dur is timeline time; at speed S the clip consumes dur x S of source.
      inputs.push('-ss', sec(c.srcIn ?? 0), '-t', sec(c.dur * speed), '-i', src);
    }
    if (wantsVideo) {
      const d = displaySize(a.probe);
      const at = sec(c.start);
      const head0 = a.kind === 'image' ? `fps=${fps}` : `setpts=(PTS-STARTPTS)/${speed},fps=${fps}`;
      const cm = 'flags=lanczos:out_color_matrix=bt709:out_range=tv';
      const lineStart = vLines.length;
      // Stabilize works on the source frames before anything else: the clip's frame grid is set first, then each frame is
      // warped by its own correction, and the rest of the chain sees a steady picture.
      const timing: ClipTiming = { srcIn: c.srcIn ?? 0, speed, fps, frames: Math.max(1, Math.round((c.dur * fps) / 1000)) };
      const trackFor = (id: string): TrackData => {
        const data = inp.tracks?.[id];
        if (!data) throw new EngineError('INVALID_INPUT', `${c.id}: tracker ${id} has not been analysed`, `studio track build ${id}`);
        const lastMs = data.fromMs + ((data.frames - 1) * 1000) / data.fps;
        const a0 = timing.srcIn;
        const b0 = timing.srcIn + c.dur * speed;
        if (a0 < data.fromMs - 1000 / data.fps || b0 > lastMs + 1000 / data.fps) {
          const msg = `${c.id}: tracker ${id} covers ${Math.round(data.fromMs)}–${Math.round(lastMs)} ms of the source but the clip plays ${Math.round(a0)}–${Math.round(b0)} ms; outside the tracked range the last tracked position is held`;
          if (!notes.includes(msg)) notes.push(msg);
        }
        return data;
      };
      const stab = a.kind === 'video' ? (c.fx ?? []).find((f): f is Extract<Fx, { type: 'stabilize' }> => f.type === 'stabilize' && !f.bypass) : undefined;
      let steady: ReturnType<typeof correctionTable> | null = null;
      let inLabel = `${k}:v`;
      let head = head0;
      if (stab) {
        if (!d.w || !d.h) throw new EngineError('INVALID_INPUT', `${c.id}: the size of ${c.asset} is not known, so it cannot be stabilized`, 'studio ingest it again');
        const data = trackFor(stab.tracker);
        const plan = stabilizePlan(data, stab);
        steady = correctionTable(plan, data, timing);
        vLines.push(`[${k}:v]${head0}[v${nV}h]`);
        vLines.push(...stabilizeLines(`v${nV}h`, `v${nV}st`, `v${nV}t`, steady, { w: d.w, h: d.h }));
        inLabel = `v${nV}st`;
        head = 'null';
        notes.push(
          `${c.id}: stabilize ${stab.tracker}: ${stab.lock ? 'held on the reference frame' : `smoothed over ${stab.smooth ?? 0.6} s`}, picture enlarged ${plan.zoom.toFixed(3)}x to hide the borders${plan.alpha < 0.999 ? `; the zoom limit ${stab.maxZoom ?? 1.25}x allowed only ${Math.round(plan.alpha * 100)}% of the correction` : ''}; the tracked path moved ${(plan.removed * (d.w ?? 0)).toFixed(1)} px rms (source pixels) from its smoothed version`,
        );
        if (d.w * d.h > 1920 * 1080 * 1.5) notes.push(`${c.id}: stabilize warps the full ${d.w}x${d.h} source frames; use a proxy or a smaller working copy for faster previews`);
      }
      const zf = zoomFilter(c, width, height);
      const bf = blurRegionFilter(c, width, height, nV);
      if (t.type === 'graphics' && a.kind === 'image') {
        vLines.push(
          `[${inLabel}]${head},scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease,format=yuva420p,${bf}${zf}setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else if (reframe === 'blur') {
        vLines.push(
          `[${inLabel}]${head},split=2[bs${nV}][fs${nV}]`,
          `[bs${nV}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2[bb${nV}]`,
          `[fs${nV}]scale=${width}:${height}:force_original_aspect_ratio=decrease:${cm}[ff${nV}]`,
          `[bb${nV}][ff${nV}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,${bf}${zf}setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else if (reframe === 'center-crop') {
        vLines.push(
          `[${inLabel}]${head},scale=${width}:${height}:force_original_aspect_ratio=increase:${cm},crop=${width}:${height},setsar=1,format=yuv420p,${bf}${zf}setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else {
        vLines.push(
          `[${inLabel}]${head},scale=${width}:${height}:force_original_aspect_ratio=decrease:${cm},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,format=yuv420p,${bf}${zf}setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      }
      // Mattes: each use of a matte (a cutout, or an effect limited to it) takes its own copy of the matte's picture, which is
      // fitted onto the canvas the way the clip is, so it lines up with the picture it works on.
      const liveFx = (c.fx ?? []).filter((f) => !('bypass' in f && f.bypass));
      const matteUses = liveFx.filter((f): f is Extract<Fx, { type: 'cutout' | 'plugin' | 'lut' }> => (f.type === 'cutout' || f.type === 'plugin' || f.type === 'lut') && !!f.matte);
      const matteCount = new Map<string, number>();
      for (const f of matteUses) matteCount.set(f.matte!.id, (matteCount.get(f.matte!.id) ?? 0) + 1);
      const matteLabels = new Map<string, string[]>();
      const matteTake = (id: string): string => matteLabels.get(id)!.shift()!;
      const fgLabels = new Map<string, string[]>();
      if (matteCount.size && a.kind !== 'video') throw new EngineError('INVALID_INPUT', `${c.id}: a matte needs a video clip`);
      const mLines: string[] = []; // the matte pictures are laid out after the clip's own chain (which later steps extend at its end)
      [...matteCount].forEach(([id, n], mi) => {
        const md = inp.mattes?.[id];
        if (!md) throw new EngineError('INVALID_INPUT', `${c.id}: matte ${id} has not been built`, `studio matte build ${id}`);
        const base = `v${nV}m${mi}`;
        const mk = nIn++;
        const fromMs = md.fromMs;
        const lastMs = fromMs + ((md.frames - 1) * 1000) / md.fps;
        const in0 = timing.srcIn;
        const out0 = timing.srcIn + c.dur * speed;
        if (in0 < fromMs - 1000 / md.fps || out0 > lastMs + 1000 / md.fps) {
          const msg = `${c.id}: matte ${id} covers ${Math.round(fromMs)}–${Math.round(lastMs)} ms of the source but the clip plays ${Math.round(in0)}–${Math.round(out0)} ms; outside it the matte's first or last picture is held`;
          if (!notes.includes(msg)) notes.push(msg);
        }
        inputs.push('-ss', sec(Math.max(0, in0 - fromMs)), '-t', sec(c.dur * speed), '-i', join(projectDir, md.file));
        const lead = in0 < fromMs ? `,tpad=start_duration=${((fromMs - in0) / 1000 / speed).toFixed(3)}:start_mode=clone` : '';
        let src = `${mk}:v`;
        const mhead = `setpts=(PTS-STARTPTS)/${speed},fps=${fps}${lead}`;
        if (stab && steady) {
          mLines.push(`[${src}]${mhead}[${base}h]`);
          mLines.push(...stabilizeLines(`${base}h`, `${base}st`, `${base}t`, steady, { w: d.w!, h: d.h! }));
          src = `${base}st`;
        }
        const fit = reframe === 'center-crop' ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
        const raw = `${base}r`;
        mLines.push(`[${src}]${stab && steady ? '' : `${mhead},`}${fit},format=gray,${zf ? `${zf}format=gray,` : ''}setpts=PTS-STARTPTS+${at}/TB[${raw}]`);
        const names = Array.from({ length: n }, (_, j) => `${base}u${j}`);
        if (n > 1) mLines.push(`[${raw}]split=${n}${names.map((x) => `[${x}]`).join('')}`);
        matteLabels.set(id, n > 1 ? names : [raw]);
        // The object's colour with the old background taken out of the edge pixels: laid out like the matte, one copy for each
        // cutout that uses this matte (it replaces the picture's colour at the edge only, see the cutout below).
        const nCuts = liveFx.filter((f) => f.type === 'cutout' && f.matte?.id === id).length;
        if (md.fgFile && nCuts) {
          const fk = nIn++;
          inputs.push('-ss', sec(Math.max(0, in0 - fromMs)), '-t', sec(c.dur * speed), '-i', join(projectDir, md.fgFile));
          let fsrc = `${fk}:v`;
          if (stab && steady) {
            mLines.push(`[${fsrc}]${mhead}[${base}fh]`);
            mLines.push(...stabilizeLines(`${base}fh`, `${base}fst`, `${base}ft`, steady, { w: d.w!, h: d.h! }));
            fsrc = `${base}fst`;
          }
          const fraw = `${base}fr`;
          mLines.push(`[${fsrc}]${stab && steady ? '' : `${mhead},`}${fit},format=gbrp,${zf ? `${zf}format=gbrp,` : ''}setpts=PTS-STARTPTS+${at}/TB[${fraw}]`);
          const fnames = Array.from({ length: nCuts }, (_, j) => `${base}fu${j}`);
          if (nCuts > 1) mLines.push(`[${fraw}]split=${nCuts}${fnames.map((x) => `[${x}]`).join('')}`);
          fgLabels.set(id, nCuts > 1 ? fnames : [fraw]);
        }
      });
      // LUTs run right after the clip's own scale and zoom, before plugin nodes: order of the fx array decides among nodes of
      // the same kind, and a LUT is always first, as camera conversions are on a colourist's first node.
      const fxCtxEarly: FxContext = { W: width, H: height, FPS: fps, SRCFPS: a.probe.fps || fps, SPEED: speed, T0: c.start / 1000 };
      const luts = (c.fx ?? []).filter((f): f is Extract<Fx, { type: 'lut' }> => f.type === 'lut' && !f.bypass);
      if (luts.length) {
        const base = `v${nV}`;
        const last = vLines.pop()!;
        let cur = `${base}lutin`;
        vLines.push(last.replace(new RegExp(`\\[${base}\\]$`), `[${cur}]`));
        luts.forEach((f, i) => {
          const out = i === luts.length - 1 ? base : `${base}lut${i}`;
          const path = join(projectDir, f.file).replace(/\\/g, '/');
          if (!existsSync(path))
            throw new EngineError(
              'INVALID_INPUT',
              `${c.id}: LUT file ${f.file} does not exist`,
              'put the .cube file inside the project folder',
            );
          const lut = (from: string, to: string) => [
            `[${from}]format=gbrp,lut3d=file='${path.replace(/'/g, "\\'")}':interp=tetrahedral,format=yuv420p[${to}]`,
          ];
          vLines.push(
            ...(f.matte
              ? restrictLines(cur, out, `${base}lm${i}`, (a2, b2) => nodeLines(c, f, a2, b2, `${base}l${i}`, fxCtxEarly, { fps, atSec: c.start / 1000, lut }), matteTake(f.matte.id), f.matte)
              : nodeLines(c, f, cur, out, `${base}l${i}`, fxCtxEarly, { fps, atSec: c.start / 1000, lut })),
          );
          cur = out;
        });
      }
      // Plugin effects: each is a small filter graph. `source` stage ones read the unretimed source frames (slow-motion
      // interpolation needs real neighbours); the rest read the clip's finished picture. A bypassed node is skipped.
      const live = (c.fx ?? []).filter(
        (f): f is Extract<Fx, { type: 'plugin' }> => f.type === 'plugin' && !f.bypass,
      );
      const fxCtx: FxContext = {
        W: width,
        H: height,
        FPS: fps,
        SRCFPS: a.probe.fps || fps,
        SPEED: speed,
        T0: c.start / 1000,
      };
      const isSource = (f: { id: string }) => pluginEffectDecl(f.id)?.stage === 'source';
      for (const f of live) {
        const decl = pluginEffectDecl(f.id);
        if (decl?.cost === 'heavy') {
          const msg = `${c.id}: effect "${f.id}" is heavy (per-pixel math or temporal search); expect a slower render`;
          if (!notes.includes(msg)) notes.push(msg);
        }
      }
      const pfx = live.filter((f) => !isSource(f));
      const sfx = live.filter(isSource);
      for (const f of sfx)
        if (f.mix !== undefined || f.matte || (f.node && Object.keys(c.keyframes ?? {}).some((p) => p.startsWith(`fx.${f.node}.`))))
          throw new EngineError('ENGINE_MISSING', `${c.id}: effect ${f.id} works on the source frames, so it cannot be mixed, keyframed or limited to a matte`, 'remove the mix, keyframes or matte, or use another effect');
      if (sfx.length) {
        const base = `v${nV}`;
        const firstIdx = vLines.findIndex((l, i) => i >= lineStart && l.includes(`[${k}:v]`));
        if (firstIdx >= 0) {
          let cur = `${k}:v`;
          const pre: string[] = [];
          sfx.forEach((f, i) => {
            const out = `${base}s${i}`;
            pre.push(...effectLines(f, cur, out, `${base}s${i}`, fxCtx));
            cur = out;
          });
          vLines[firstIdx] = vLines[firstIdx]!.replace(`[${k}:v]`, `[${cur}]`);
          vLines.splice(firstIdx, 0, ...pre);
        }
      }
      if (pfx.length) {
        const base = `v${nV}`;
        const last = vLines.pop()!;
        let cur = `${base}pre`;
        vLines.push(last.replace(new RegExp(`\\[${base}\\]$`), `[${cur}]`));
        pfx.forEach((f, i) => {
          const out = i === pfx.length - 1 ? base : `${base}fx${i}`;
          vLines.push(
            ...(f.matte
              ? restrictLines(cur, out, `${base}fm${i}`, (a2, b2) => nodeLines(c, f, a2, b2, `${base}f${i}`, fxCtx, { fps, atSec: c.start / 1000 }), matteTake(f.matte.id), f.matte)
              : nodeLines(c, f, cur, out, `${base}f${i}`, fxCtx, { fps, atSec: c.start / 1000 })),
          );
          if (f.node && Object.keys(c.keyframes ?? {}).some((p) => p.startsWith(`fx.${f.node}.`) && !p.endsWith('.mix'))) {
            const msg = `${c.id}: effect "${f.id}" is animated: it is rendered twice per slice and blended, so it costs about twice as much; temporal filters inside it restart at each sample`;
            if (!notes.includes(msg)) notes.push(msg);
          }
          cur = out;
        });
      }
      // A cutout makes everything outside the matte transparent, after the effects (which may drop alpha) and before pins.
      const cuts = liveFx.filter((f): f is Extract<Fx, { type: 'cutout' }> => f.type === 'cutout');
      if (cuts.length) {
        const base = `v${nV}`;
        const last = vLines.pop()!;
        let cur = `${base}cut`;
        vLines.push(last.replace(new RegExp(`\\[${base}\\]$`), `[${cur}]`));
        cuts.forEach((f, i) => {
          const out = i === cuts.length - 1 ? base : `${base}ct${i}`;
          const fgPic = fgLabels.get(f.matte.id)?.shift();
          if (fgPic) {
            // the edge pixels take the object's colour with the old background taken out; the rest of the picture is left as the
            // effects made it
            vLines.push(...matteFinish(matteTake(f.matte.id), `${base}cmx${i}`, f.matte));
            vLines.push(`[${base}cmx${i}]split=3[${base}cm${i}][${base}cb${i}][${base}cc${i}]`);
            vLines.push(`[${base}cb${i}]dilation,dilation[${base}cd${i}]`);
            vLines.push(`[${base}cc${i}]erosion,erosion[${base}ce${i}]`);
            vLines.push(`[${base}cd${i}][${base}ce${i}]blend=all_mode=subtract,gblur=sigma=1[${base}cband${i}]`);
            vLines.push(`[${cur}]format=gbrp[${base}cp${i}]`);
            vLines.push(`[${base}cp${i}][${fgPic}][${base}cband${i}]maskedmerge[${base}cq${i}]`);
            vLines.push(`[${base}cq${i}][${base}cm${i}]alphamerge[${out}]`);
          } else {
            vLines.push(...matteFinish(matteTake(f.matte.id), `${base}cm${i}`, f.matte));
            vLines.push(`[${cur}][${base}cm${i}]alphamerge[${out}]`);
          }
          cur = out;
        });
      }
      // Pins sit on top of the finished clip picture and follow the tracked plane (through the steadied picture when the clip
      // is stabilized). The pinned image is stretched over the canvas and warped so its corners land on the plane's.
      const pins = (c.fx ?? []).filter((f): f is Extract<Fx, { type: 'pin' }> => f.type === 'pin' && !f.bypass);
      if (pins.length) {
        if (!d.w || !d.h) throw new EngineError('INVALID_INPUT', `${c.id}: the size of ${c.asset} is not known, so a pin cannot be placed`, 'studio ingest it again');
        if (hasMotion(c)) throw new EngineError('ENGINE_MISSING', `${c.id}: a pin cannot be used on a clip with zoom or pan keyframes`, 'remove those keyframes, or put the pin on a clip without them');
        const base = `v${nV}`;
        const last = vLines.pop()!;
        let cur = `${base}pin`;
        vLines.push(last.replace(new RegExp(`\\[${base}\\]$`), `[${cur}]`));
        const s = reframe === 'center-crop' ? Math.max(width / d.w, height / d.h) : Math.min(width / d.w, height / d.h);
        const fit = { w: d.w * s, h: d.h * s, x: (width - d.w * s) / 2, y: (height - d.h * s) / 2 };
        pins.forEach((f, i) => {
          const data = trackFor(f.tracker);
          const tk = p.trackers![f.tracker]!;
          const pa = p.assets[f.asset]!;
          const pk = nIn++;
          const pfile = join(projectDir, pa.workingCopy?.path ?? pa.path);
          if (pa.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(c.dur), '-i', pfile);
          else inputs.push('-stream_loop', '-1', '-t', sec(c.dur), '-i', pfile);
          const quads = pinQuads(data, (f.quad ?? tk.quad) as never, timing, steady, fit);
          const op = f.opacity ?? 1;
          vLines.push(`[${pk}:v]fps=${fps},setpts=PTS-STARTPTS,scale=${width - 2 * PIN_MARGIN}:${height - 2 * PIN_MARGIN}:flags=bicubic,format=rgba${op < 1 ? `,colorchannelmixer=aa=${op}` : ''},pad=${width}:${height}:${PIN_MARGIN}:${PIN_MARGIN}:color=black@0[${base}pl${i}]`);
          vLines.push(...pinWarpLines(`${base}pl${i}`, `${base}pw${i}`, `${base}pq${i}`, quads, { w: width, h: height }));
          const out = i === pins.length - 1 ? base : `${base}pn${i}`;
          vLines.push(`[${base}pw${i}]setpts=PTS+${at}/TB[${base}pt${i}]`);
          vLines.push(`[${cur}][${base}pt${i}]overlay=format=auto:eof_action=pass:repeatlast=0[${out}]`);
          cur = out;
        });
      }
      vLines.push(...mLines);
      if (d.w && d.h && t.type === 'video') {
        const kFit = Math.min(width / d.w, height / d.h);
        const kCover = Math.max(width / d.w, height / d.h);
        const kUse = reframe === 'center-crop' ? kCover : kFit;
        const up = `${c.asset} (${d.w}x${d.h}) is upscaled ${kUse.toFixed(2)}x into ${width}x${height}; effective resolution stays ${d.w}x${d.h}`;
        if (kUse > 1.01 && !notes.includes(up)) notes.push(up);
        if (reframe === 'center-crop') {
          const keep = Math.min(1, width / height / (d.w / d.h));
          const keepH = Math.min(1, d.w / d.h / (width / height));
          const msg = `${c.asset}: center crop keeps ${Math.round(keep * 100)}% of the source width and ${Math.round(keepH * 100)}% of its height; anything outside is cut, so inspect frames for lost text`;
          if (!notes.includes(msg)) notes.push(msg);
        }
        if (reframe === 'blur' && Math.abs(width / height - d.w / d.h) > 0.01) {
          const msg = `${c.asset}: the sides or top/bottom are filled with a blurred, enlarged copy of the video (fit + blur background)`;
          if (!notes.includes(msg)) notes.push(msg);
        }
      }
      nV++;
    }
    if (wantsAudio) {
      const chain = clipAudioChain(a.probe.audio!.ch, c.fx, c.keyframes);
      const duck = c.fx?.find((f) => f.type === 'duck') as
        Extract<Fx, { type: 'duck' }> | undefined;
      // 10 ms edge fades at every clip edge so spliced joins cannot click.
      const fade = Math.min(0.01, c.dur / 2000);
      const ms = Math.round(c.start);
      const idx = aItems.length;
      aLines.push(
        `[${k}:a]${chain.join(',')},asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${sec(c.dur - fade * 1000)}:d=${fade},adelay=${ms}:all=1[a${idx}]`,
      );
      aItems.push({ label: `a${idx}`, track: c.track, duck, clipId: c.id });
      joinEdges.push({ track: c.track, start: c.start, end: c.start + c.dur });
    }
  }

  const lines: string[] = [
    `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${sec(durationMs)},format=yuv420p[base0]`,
    ...vLines,
  ];
  // Overlay chain: base0 + each placed clip in layer order.
  const placed = ordered.filter((c) => {
    const t = trackOf(c);
    if (c.comp) return !t.hidden;
    const a = c.asset ? p.assets[c.asset] : undefined;
    // exactly the clips that produced a video line above
    return !!a && (t.type === 'video' || t.type === 'graphics') && a.kind !== 'audio' && !t.hidden;
  });
  placed.forEach((c, i) => {
    const t = trackOf(c);
    const isGfx = t.type === 'graphics';
    const pos = c.comp ? ':x=0:y=0' : isGfx ? ':x=(W-w)/2:y=(H-h)/2' : '';
    lines.push(
      `[base${i}][v${i}]overlay=eof_action=pass:repeatlast=0${pos}:enable='between(t,${sec(c.start)},${sec(c.start + c.dur)})'[base${i + 1}]`,
    );
  });
  lines.push(`[base${placed.length}]null[vout]`);

  const videoFilter = lines.join(';\n');
  let audioMix: string | undefined;
  let audioFilter: string | undefined;
  if (aItems.length) {
    const alines = [...aLines];
    // Ducking: each ducked clip is compressed by a sidechain taken from the mix of the `by` track's clips.
    const finalLabels: string[] = [];
    const duckers = new Set(aItems.filter((i) => i.duck).map((i) => i.duck!.by));
    const sidechain = new Map<string, string[]>(); // by-track -> unused sidechain copies
    for (const by of duckers) {
      const members = aItems.filter((i) => i.track === by && !i.duck);
      const users = aItems.filter((i) => i.duck?.by === by).length;
      if (!members.length) {
        notes.push(
          `duck: track ${by} has no audio in this render, so clips ducked by it are not ducked here`,
        );
        continue;
      }
      const ins = members.map((m) => `[${m.label}]`).join('');
      const outs = [`busm_${by}`, ...Array.from({ length: users }, (_, i) => `busc_${by}_${i}`)];
      alines.push(
        `${ins}${members.length > 1 ? `amix=inputs=${members.length}:normalize=0:dropout_transition=0,` : ''}asplit=${outs.length}${outs.map((o) => `[${o}]`).join('')}`,
      );
      finalLabels.push(`busm_${by}`);
      sidechain.set(by, outs.slice(1));
    }
    for (const i of aItems) {
      if (duckers.has(i.track) && !i.duck && sidechain.has(i.track)) continue; // already inside its bus
      if (i.duck && sidechain.get(i.duck.by)?.length) {
        const sc = sidechain.get(i.duck.by)!.shift()!;
        const d = i.duck;
        alines.push(
          `[${i.label}][${sc}]sidechaincompress=threshold=${dbToLin(d.thresholdDb).toFixed(4)}:ratio=${d.ratio}:attack=${d.attackMs}:release=${d.releaseMs}:makeup=${dbToLin(d.makeupDb ?? 0).toFixed(4)}[${i.label}d]`,
        );
        finalLabels.push(`${i.label}d`);
      } else finalLabels.push(i.label);
    }
    const ins = finalLabels.map((l) => `[${l}]`).join('');
    alines.push(
      `${ins}amix=inputs=${finalLabels.length}:normalize=0:dropout_transition=0,aresample=48000,apad=whole_dur=${sec(durationMs)},atrim=duration=${sec(durationMs)}[amix]`,
    );
    audioFilter = alines.join(';\n');
    lines.push(...alines);
    audioMix = 'amix';
  }
  if (!audioMix)
    notes.push(
      'no audio: no clip with audio is on an unmuted track, so the output has no audio stream',
    );

  // Adjacent audio clips on one track meet at a join; report where for the click check.
  const joinsMs: number[] = [];
  const byTrack = new Map<string, { start: number; end: number }[]>();
  for (const e of joinEdges)
    (byTrack.get(e.track) ?? byTrack.set(e.track, []).get(e.track)!).push(e);
  for (const list of byTrack.values()) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i++)
      if (Math.abs(list[i]!.start - list[i - 1]!.end) <= 1) joinsMs.push(list[i]!.start);
  }

  return {
    backend: route.backend,
    reason: route.reason,
    inputs,
    filter: lines.join(';\n'),
    videoFilter,
    audioFilter,
    hasVideo: true,
    hasAudio: !!audioMix,
    audioMix,
    width,
    height,
    fps,
    durationMs,
    notes,
    joinsMs: joinsMs.sort((a, b) => a - b),
  };
}
