/**
 * Tracker data: the analysis behind `stabilize` and `pin`. A tracker (in the project file) names a region of a video; building it
 * follows that region through the source range and stores one homography per analysed frame in `.studio/cache/track/`. The
 * data is derived (rebuilt from the tracker and the source at any time) and keyed by both, so it is never part of the project's
 * state and never edited by hand.
 *
 * Coordinates are fractions of the displayed frame with a pixel's centre at (i + 0.5) / size, so they mean the same at any
 * resolution.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Tracker } from '@studio/core';
import {
  apply, cornersOf, drawPoly, fillGaps, fromBytes, inv3, lerpCorners, fromCorners, mul3, probeVideo, readFrames, readSize, tileRgb, trackPlane,
  type Gray, type Mat3, type Quad,
} from '@studio/vision';
import { grabFrame } from './grab.js';
import { EngineError } from './run.js';
import { ensureSolve, fitScenePlane, planeHomographies } from './solve.js';

/** Bump when the tracking changes in a way that makes old data wrong. */
const TRACK_VERSION = 1;
/** Frames kept in memory for the part of a track that runs backward from the reference. */
const MAX_BACK_FRAMES = 4000;

export interface TrackData {
  v: number;
  tracker: string;
  asset: string;
  key: string;
  /** analysis rate and size */
  fps: number;
  w: number;
  h: number;
  /** time of frame 0 in the asset (ms) and the index of the reference frame */
  fromMs: number;
  refIndex: number;
  frames: number;
  /** per frame: the homography taking the reference frame to this one, h0..h7 (h8 = 1), unit coordinates; lost frames are filled in */
  H: number[][];
  /** per frame: r = aligned to the reference image, f = point fit only, x = lost (interpolated) */
  state: string;
  inliers: number[];
  stats: {
    lost: number;
    refined: number;
    meanInliers: number;
    ms: number;
    model: string;
    lostRanges: [number, number][];
    /** plane3d: what the camera solve and the plane fit found */
    solve?: { f: number; hfovDeg: number; rmsPx: number; points: number; planeInliers: number; planePoints: number; planeRms: number; cached: boolean; frames: number; registered: number };
  };
}

const mat = (h: number[]): Mat3 => [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
export const pathOf = (d: TrackData): Mat3[] => d.H.map(mat);

export function trackKey(project: Project, id: string): string {
  const t = project.trackers?.[id];
  if (!t) throw new EngineError('INVALID_INPUT', `no tracker ${id}`, 'studio track list');
  const a = project.assets[t.asset]!;
  return createHash('sha256')
    .update(JSON.stringify([TRACK_VERSION, a.hash, a.workingCopy?.path ?? a.path, t]))
    .digest('hex')
    .slice(0, 20);
}
export const trackFile = (projectDir: string, key: string): string => join(projectDir, '.studio', 'cache', 'track', `${key}.json`);

export function loadTrack(projectDir: string, project: Project, id: string): TrackData | null {
  const f = trackFile(projectDir, trackKey(project, id));
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as TrackData;
  } catch {
    return null;
  }
}

/** Analysis rate and size a tracker uses on this source. */
export function analysisOf(t: Tracker, info: { w: number; h: number; fps: number }): { fps: number; size: { w: number; h: number } } {
  const fps = t.fps ?? Math.min(30, Math.round(info.fps * 100) / 100);
  const width = Math.min(t.width ?? 480, info.w);
  return { fps, size: readSize(info, { width: width % 2 ? width + 1 : width }) };
}

export interface TrackBuildOptions {
  projectDir: string;
  project: Project;
  id: string;
  log?: (m: string) => void;
  force?: boolean;
}

/** Builds (or reads from the cache) the data of one tracker. */
export async function buildTrack(o: TrackBuildOptions): Promise<{ data: TrackData; cached: boolean }> {
  const { projectDir, project, id } = o;
  const log = o.log ?? (() => undefined);
  const t = project.trackers?.[id];
  if (!t) throw new EngineError('INVALID_INPUT', `no tracker ${id}`, 'studio track list');
  const key = trackKey(project, id);
  const file = trackFile(projectDir, key);
  if (!o.force) {
    const have = loadTrack(projectDir, project, id);
    if (have) return { data: have, cached: true };
  }
  const t0 = Date.now();
  const a = project.assets[t.asset]!;
  const src = join(projectDir, a.workingCopy?.path ?? a.path);
  if (!existsSync(src)) throw new EngineError('INVALID_INPUT', `${t.asset}: the file ${a.workingCopy?.path ?? a.path} is missing`, 'studio ingest it again');
  const info = probeVideo(src);
  const { fps, size } = analysisOf(t, info);
  const step = 1000 / fps;
  const r = Math.max(0, Math.round((t.at - t.from) / step));
  const total = Math.max(r + 1, Math.round((t.to - t.from) / step) + 1);
  const toIdx = (u: number, n: number) => u * n - 0.5;
  const quad = t.quad.map(([x, y]) => [toIdx(x, size.w), toIdx(y, size.h)]) as Quad;
  const gray = (b: Buffer): Gray => fromBytes(b, size.w, size.h, 1);

  if (t.model === 'plane3d') {
    const { solve, cached: solveCached } = await ensureSolve({
      projectDir, file: a.workingCopy?.path ?? a.path, assetHash: a.hash, fromMs: t.from, toMs: t.to, fps, width: size.w,
      ...(t.focal ? { focalDeg: t.focal } : {}), fixFocal: t.fixFocal, log: o.log, force: o.force,
    });
    const refI = Math.min(solve.frames - 1, r);
    const plane = fitScenePlane(solve, quad, refI);
    const Hs = planeHomographies(solve, plane, quad, refI);
    const T3: Mat3 = [1 / solve.w, 0, 0.5 / solve.w, 0, 1 / solve.h, 0.5 / solve.h, 0, 0, 1];
    const T3i = inv3(T3)!;
    const unit3 = Hs.map((H) => (H ? (mul3(mul3(T3, H), T3i) as Mat3) : null));
    const filled3 = fillGaps(unit3);
    const st = Hs.map((H, i) => (!H ? 'x' : solve.how[i] === 'b' || solve.how[i] === 'r' ? 'r' : 'f')).join('');
    const lost3: [number, number][] = [];
    [...st].forEach((c, i) => {
      if (c !== 'x') return;
      const last = lost3[lost3.length - 1];
      if (last && last[1] === i - 1) last[1] = i;
      else lost3.push([i, i]);
    });
    const data3: TrackData = {
      v: TRACK_VERSION, tracker: id, asset: t.asset, key, fps, w: solve.w, h: solve.h, fromMs: t.from, refIndex: refI, frames: filled3.length,
      H: filled3.map((H) => [H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7]].map((v) => Math.round(v * 1e9) / 1e9)),
      state: st, inliers: st.split('').map(() => plane.inliers),
      stats: {
        lost: [...st].filter((c) => c === 'x').length,
        refined: [...st].filter((c) => c === 'r').length,
        meanInliers: plane.inliers,
        ms: Date.now() - t0,
        model: t.model,
        lostRanges: lost3.map(([x, y]) => [Math.round(t.from + x * step), Math.round(t.from + y * step)]),
        solve: {
          f: solve.f, hfovDeg: solve.stats.hfovDeg, rmsPx: solve.stats.rmsPx, points: solve.stats.points, planeInliers: plane.inliers, planePoints: plane.candidates,
          planeRms: plane.rms, cached: solveCached, frames: solve.frames, registered: solve.stats.registered,
        },
      },
    };
    mkdirSync(join(projectDir, '.studio', 'cache', 'track'), { recursive: true });
    const tmp3 = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp3, JSON.stringify(data3));
    renameSync(tmp3, file);
    return { data: data3, cached: false };
  }

  // the reference frame, then the frames after it
  const fwdSpec = { file: src, startMs: t.from + r * step, durMs: Math.ceil((total - r) * step) + 1, fps, size, channels: 1 as const };
  const fwd = readFrames(fwdSpec)[Symbol.asyncIterator]();
  const first = await fwd.next();
  if (first.done) throw new EngineError('INVALID_INPUT', `tracker ${id}: no frame at ${t.at} ms of ${t.asset}`, `the asset is ${info.durMs} ms long`);
  const ref = gray(first.value);

  // the frames before it, kept as bytes (small) and walked backward
  const back: Buffer[] = [];
  if (r > 0) {
    if (r > MAX_BACK_FRAMES)
      throw new EngineError('INVALID_INPUT', `tracker ${id}: ${r} frames lie before the reference frame`, 'move --at nearer the start, track a shorter range, or lower --fps or --width');
    for await (const b of readFrames({ file: src, startMs: t.from, durMs: Math.ceil(r * step), fps, size, channels: 1 })) back.push(b);
    if (back.length > r) back.splice(0, back.length - r);
  }

  const opts = { model: t.model as Exclude<typeof t.model, 'plane3d'>, refine: t.refine !== false } as const;
  const forward: { H: Mat3 | null; ok: boolean; refined: boolean; inliers: number }[] = [];
  const nFwd = total - r - 1;
  let seen = 0;
  async function* after(): AsyncGenerator<Gray> {
    for (;;) {
      const n = await fwd.next();
      if (n.done || seen >= nFwd) return;
      seen++;
      if (seen % 25 === 0) log(`tracker ${id}: frame ${r + seen + 1} of ${total}`);
      yield gray(n.value);
    }
  }
  for await (const f of trackPlane(ref, quad, after(), opts)) forward.push(f);
  const backward: typeof forward = [];
  if (back.length) {
    function* walk(): Generator<Gray> {
      for (let i = back.length - 1; i >= 0; i--) yield gray(back[i]!);
    }
    for await (const f of trackPlane(ref, quad, walk(), opts)) backward.push(f);
  }

  // frame order: backward reversed, the reference (identity), forward
  const known: (Mat3 | null)[] = [];
  const state: string[] = [];
  const inl: number[] = [];
  const push = (f: { H: Mat3 | null; ok: boolean; refined: boolean; inliers: number } | null) => {
    if (!f) (known.push([1, 0, 0, 0, 1, 0, 0, 0, 1]), state.push('r'), inl.push(0));
    else (known.push(f.ok && f.H ? f.H : null), state.push(f.ok && f.H ? (f.refined ? 'r' : 'f') : 'x'), inl.push(f.inliers));
  };
  for (let i = backward.length - 1; i >= 0; i--) push(backward[i]!);
  push(null);
  for (const f of forward) push(f);
  // to unit coordinates
  const T: Mat3 = [1 / size.w, 0, 0.5 / size.w, 0, 1 / size.h, 0.5 / size.h, 0, 0, 1];
  const Ti = inv3(T)!;
  const unit = known.map((H) => (H ? (mul3(mul3(T, H), Ti) as Mat3) : null));
  const refIndex = backward.length;
  const filled = fillGaps(unit);
  const lostRanges: [number, number][] = [];
  state.forEach((s, i) => {
    if (s !== 'x') return;
    const last = lostRanges[lostRanges.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else lostRanges.push([i, i]);
  });
  const fromMs = t.from + (r - backward.length) * step;
  const data: TrackData = {
    v: TRACK_VERSION,
    tracker: id,
    asset: t.asset,
    key,
    fps,
    w: size.w,
    h: size.h,
    fromMs,
    refIndex,
    frames: filled.length,
    H: filled.map((H) => [H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7]].map((v) => Math.round(v * 1e9) / 1e9)),
    state: state.join(''),
    inliers: inl,
    stats: {
      lost: state.filter((s) => s === 'x').length,
      refined: state.filter((s) => s === 'r').length - 1,
      meanInliers: Math.round(inl.reduce((x, y) => x + y, 0) / Math.max(1, inl.length - 1)),
      ms: Date.now() - t0,
      model: t.model,
      lostRanges: lostRanges.map(([x, y]) => [Math.round(fromMs + x * step), Math.round(fromMs + y * step)]),
    },
  };
  mkdirSync(join(projectDir, '.studio', 'cache', 'track'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
  return { data, cached: false };
}

/** The tracker ids that clips of this project use (stabilize and pin effects that are on). */
export function trackersUsed(project: Project, clipIds?: Set<string>): string[] {
  const ids = new Set<string>();
  for (const c of project.clips) {
    if (clipIds && !clipIds.has(c.id)) continue;
    for (const f of c.fx ?? []) if ((f.type === 'stabilize' || f.type === 'pin') && !f.bypass) ids.add(f.tracker);
  }
  return [...ids];
}

/**
 * The data every enabled stabilize and pin needs. `build` makes what is missing (a render does); without it a missing
 * tracker is an error that says how to build it (a frame preview does not wait for an analysis).
 */
export async function ensureTracks(
  project: Project,
  projectDir: string,
  o: { build: boolean; log?: (m: string) => void; clipIds?: Set<string>; placeholder?: (id: string) => void },
): Promise<Record<string, TrackData>> {
  const out: Record<string, TrackData> = {};
  for (const id of trackersUsed(project, o.clipIds)) {
    const t = project.trackers?.[id];
    if (!t) continue; // validation reports it
    const have = loadTrack(projectDir, project, id);
    if (have) out[id] = have;
    else if (o.build) out[id] = (await buildTrack({ projectDir, project, id, log: o.log })).data;
    else if (o.placeholder) {
      o.placeholder(id);
      out[id] = { v: TRACK_VERSION, tracker: id, asset: t.asset, key: '', fps: 30, w: 1, h: 1, fromMs: t.from, refIndex: 0, frames: 2, H: [[1, 0, 0, 0, 1, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0]], state: 'rr', inliers: [0, 0], stats: { lost: 0, refined: 0, meanInliers: 0, ms: 0, model: t.model, lostRanges: [] } };
    } else throw new EngineError('INVALID_INPUT', `tracker ${id} has not been analysed yet`, `studio track build ${id}`);
  }
  return out;
}

// ----- reading the data at a time --------------------------------------------------------------------------------------------

/** Fractional analysis-frame position of a source time, clamped to the data. */
export function frameAt(d: TrackData, srcMs: number): { i: number; t: number; outside: boolean } {
  const x = ((srcMs - d.fromMs) * d.fps) / 1000;
  const c = Math.min(d.frames - 1, Math.max(0, x));
  const i = Math.min(d.frames - 2, Math.floor(c));
  return i < 0 ? { i: 0, t: 0, outside: x < -0.5 || x > d.frames - 0.5 } : { i, t: c - i, outside: x < -0.5 || x > d.frames - 0.5 };
}

/** The reference-to-frame homography at a source time (corners interpolated between the two nearest analysed frames). */
export function homographyAt(d: TrackData, srcMs: number, path: Mat3[] = pathOf(d)): Mat3 {
  const { i, t } = frameAt(d, srcMs);
  if (d.frames < 2 || t === 0) return path[i]!;
  const c = lerpCorners(cornersOf(path[i]!), cornersOf(path[i + 1]!), t);
  return fromCorners(c) ?? path[i]!;
}

/** Where four points of the reference frame are at a source time (unit coordinates). */
export function quadAt(d: TrackData, srcMs: number, q: Quad, path?: Mat3[]): Quad {
  const H = homographyAt(d, srcMs, path);
  return q.map(([x, y]) => apply(H, x, y)) as Quad;
}

// ----- looking at a track ---------------------------------------------------------------------------------------------------

/**
 * A contact sheet of frames across a track with the tracked region drawn on each: the way to check by eye that a track
 * stayed on its plane. Green outlines are frames the tracker followed; red are frames it lost (interpolated). The reference
 * frame is always included and outlined in yellow.
 */
export async function trackSheet(o: { projectDir: string; project: Project; id: string; data: TrackData; out: string; count?: number; quad?: Quad }): Promise<{ file: string; frames: { index: number; ms: number; state: string }[] }> {
  const { project, id, data } = o;
  const t = project.trackers![id]!;
  const a = project.assets[t.asset]!;
  const src = join(o.projectDir, a.workingCopy?.path ?? a.path);
  const count = Math.max(2, Math.min(12, o.count ?? 6));
  const idx = new Set<number>([data.refIndex]);
  for (let i = 0; i < count; i++) idx.add(Math.round((i * (data.frames - 1)) / (count - 1)));
  const list = [...idx].sort((x, y) => x - y);
  const size = { w: data.w, h: data.h };
  const step = 1000 / data.fps;
  const path = pathOf(data);
  const q = o.quad ?? t.quad;
  const tiles: Uint8Array[] = [];
  const rows: { index: number; ms: number; state: string }[] = [];
  for (const i of list) {
    const ms = data.fromMs + i * step;
    const frame = await grabFrame(src, ms, data.fps, size);
    const buf = new Uint8Array(frame ?? Buffer.alloc(size.w * size.h * 3));
    const pts = quadAt(data, ms, q, path).map(([x, y]) => [x * size.w - 0.5, y * size.h - 0.5] as [number, number]);
    const st = data.state[i] ?? 'f';
    drawPoly(buf, size.w, size.h, pts, i === data.refIndex ? [255, 220, 0] : st === 'x' ? [255, 60, 60] : [60, 255, 90], 2);
    tiles.push(buf);
    rows.push({ index: i, ms: Math.round(ms), state: st === 'r' ? 'aligned' : st === 'f' ? 'points' : 'lost' });
  }
  const cols = Math.min(3, tiles.length);
  const sheet = tileRgb(tiles, size.w, size.h, cols);
  mkdirSync(join(o.out, '..'), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheet.w}x${sheet.h}`, '-i', '-', '-frames:v', '1', o.out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => undefined);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new EngineError('ENGINE_FAILED', `ffmpeg could not write the sheet: ${err.trim().split('\n').pop()}`))));
    p.stdin.end(Buffer.from(sheet.data));
  });
  return { file: o.out, frames: rows };
}
