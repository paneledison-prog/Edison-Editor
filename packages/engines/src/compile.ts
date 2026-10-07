import { join } from 'node:path';
import { displaySize, speedOf, type Clip, type Fx, type Project } from '@studio/core';
import { MAX_AUDIO_SPEED, clipAudioChain, dbToLin } from './audiofx.js';
import { EngineError } from './run.js';
import type { Preset } from './presets.js';

export interface Plan {
  backend: 'ffmpeg';
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
 * Router. The FFmpeg backend handles cuts, concat, fit-scale, overlays, and the audio chain.
 * Keyframes, transforms, fx, and compositions need the Remotion backend, which does not exist yet:
 * fail with the reason instead of rendering something that ignores them.
 */
export function routeBackend(p: Project): { backend: 'ffmpeg'; reason: string } {
  const unsupported: string[] = [];
  for (const c of p.clips) {
    if (c.comp) unsupported.push(`${c.id}: composition "${c.comp}"`);
    if (c.keyframes && Object.keys(c.keyframes).length) unsupported.push(`${c.id}: keyframes`);
    if (c.transform && Object.keys(c.transform).length) unsupported.push(`${c.id}: transform`);
  }
  if (unsupported.length) {
    throw new EngineError(
      'ENGINE_MISSING',
      `these need the Remotion backend, which is not implemented yet: ${unsupported.slice(0, 6).join('; ')}${unsupported.length > 6 ? ` (+${unsupported.length - 6} more)` : ''}`,
      'remove those clips/properties (undo them, or use `studio project undo`), or wait for Phase 4',
    );
  }
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
      srcIn: c.asset ? (c.srcIn ?? 0) + Math.round((s - c.start) * speedOf(c)) : c.srcIn,
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
      const head = a.kind === 'image' ? `fps=${fps}` : `setpts=(PTS-STARTPTS)/${speed},fps=${fps}`;
      const cm = 'flags=lanczos:out_color_matrix=bt709:out_range=tv';
      if (t.type === 'graphics' && a.kind === 'image') {
        vLines.push(
          `[${k}:v]${head},scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease,format=yuva420p,setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else if (reframe === 'blur') {
        vLines.push(
          `[${k}:v]${head},split=2[bs${nV}][fs${nV}]`,
          `[bs${nV}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2[bb${nV}]`,
          `[fs${nV}]scale=${width}:${height}:force_original_aspect_ratio=decrease:${cm}[ff${nV}]`,
          `[bb${nV}][ff${nV}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else if (reframe === 'center-crop') {
        vLines.push(
          `[${k}:v]${head},scale=${width}:${height}:force_original_aspect_ratio=increase:${cm},crop=${width}:${height},setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      } else {
        vLines.push(
          `[${k}:v]${head},scale=${width}:${height}:force_original_aspect_ratio=decrease:${cm},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${at}/TB[v${nV}]`,
        );
      }
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
      const chain = clipAudioChain(a.probe.audio!.ch, c.fx);
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
    const a = c.asset ? p.assets[c.asset] : undefined;
    // exactly the clips that produced a video line above
    return !!a && (t.type === 'video' || t.type === 'graphics') && a.kind !== 'audio' && !t.hidden;
  });
  placed.forEach((c, i) => {
    const t = trackOf(c);
    const isGfx = t.type === 'graphics';
    const pos = isGfx ? ':x=(W-w)/2:y=(H-h)/2' : '';
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
