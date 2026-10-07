import { join } from 'node:path';
import { displaySize, type Clip, type Project } from '@studio/core';
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
    if (c.fx?.length) unsupported.push(`${c.id}: fx`);
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
    reason: 'only cuts, concat, fit-scale, overlay, and audio mixing are used',
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
      srcIn: c.asset ? (c.srcIn ?? 0) + (s - c.start) : c.srcIn,
    });
  }
  return out;
}

export function canvasFor(
  p: Project,
  preset: Preset,
  preview: boolean,
): { width: number; height: number } {
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

  const { width, height } = canvasFor(p, preset, !!inp.preview);
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
  const aLabels: string[] = [];
  let nIn = 0;
  let nV = 0;
  const bg = hex(p.meta.background);
  const joinEdges: { track: string; start: number; end: number }[] = [];

  for (const c of ordered) {
    const t = trackOf(c);
    const a = c.asset ? p.assets[c.asset]! : undefined;
    if (!a) continue;
    const src = join(projectDir, a.workingCopy?.path ?? a.path);
    const wantsVideo =
      (t.type === 'video' || t.type === 'graphics') && a.kind !== 'audio' && !t.hidden;
    const wantsAudio =
      !!a.probe.audio &&
      (a.kind === 'video' || a.kind === 'audio') &&
      !t.muted &&
      t.type !== 'graphics';
    if (!wantsVideo && !wantsAudio) continue;

    const k = nIn++;
    if (a.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(c.dur), '-i', src);
    } else {
      inputs.push('-ss', sec(c.srcIn ?? 0), '-t', sec(c.dur), '-i', src);
    }
    if (wantsVideo) {
      const d = displaySize(a.probe);
      if (d.w && d.h && t.type === 'video') {
        const k2 = Math.min(width / d.w, height / d.h);
        const note = `${c.asset} (${d.w}x${d.h}) is upscaled ${k2.toFixed(2)}x to fit ${width}x${height}; effective resolution stays ${d.w}x${d.h}`;
        if (k2 > 1.01 && !notes.includes(note)) notes.push(note);
      }
      const at = sec(c.start);
      const fit =
        t.type === 'graphics' && a.kind === 'image'
          ? `scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease,format=yuva420p`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos:out_color_matrix=bt709:out_range=tv,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,format=yuv420p`;
      vLines.push(`[${k}:v]fps=${fps},${fit},setpts=PTS-STARTPTS+${at}/TB[v${nV}]`);
      nV++;
    }
    if (wantsAudio) {
      const ch = a.probe.audio!.ch;
      const mono = ch === 1 ? 'pan=stereo|c0=c0|c1=c0,' : 'aformat=channel_layouts=stereo,';
      // 10 ms edge fades at every clip edge so spliced joins cannot click.
      const fade = Math.min(0.01, c.dur / 2000);
      const ms = Math.round(c.start);
      aLabels.push(
        `[${k}:a]aresample=48000,${mono}asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${sec(c.dur - fade * 1000)}:d=${fade},adelay=${ms}:all=1[a${aLabels.length}]`,
      );
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
  if (aLabels.length) {
    const ins = aLabels.map((_, i) => `[a${i}]`).join('');
    const alines = [
      ...aLabels,
      `${ins}amix=inputs=${aLabels.length}:normalize=0:dropout_transition=0,aresample=48000,apad=whole_dur=${sec(durationMs)},atrim=duration=${sec(durationMs)}[amix]`,
    ];
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
