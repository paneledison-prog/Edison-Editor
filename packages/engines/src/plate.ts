/**
 * Clean plates for `erase`: the background behind an object, rebuilt from the other frames of the shot (see
 * packages/vision/src/plate.ts), as a video the size of the matte, cached under `.studio/cache/plate/`. Derived data: the
 * original is never touched, and the plate can always be rebuilt.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@studio/core';
import { VideoWriter, cleanPlate, morph, readFrames, registerBackground, resizePlane, type Gray } from '@studio/vision';
import { buildMatte, matteKey, type MatteData } from './matte.js';
import { probeVideo } from '@studio/vision';
import { EngineError } from './run.js';

export const PLATE_VERSION = 1;
const MAX_FRAMES = 300;
/** the default reach of the removed area past the matte, in thousandths of the picture's width */
export const DEFAULT_PAD = 8;

export interface PlateData {
  v: number;
  /** `mt_xxxx@pad` */
  id: string;
  matte: string;
  pad: number;
  key: string;
  file: string;
  fps: number;
  w: number;
  h: number;
  fromMs: number;
  frames: number;
  /** per frame: the share of the removed area filled from other frames, and the share that no frame showed (spread in from its surroundings) */
  filled: number[];
  spread: number[];
  /** the removed area as a share of the picture, per frame */
  holePct: number[];
  registration: { shots: number; lost: number[]; meanInliers: number; maxRms: number };
  flagged: { frame: number; ms: number; why: string }[];
  stats: { ms: number };
}

export const plateId = (matte: string, pad: number | undefined): string => `${matte}@${pad ?? DEFAULT_PAD}`;
export function plateKey(project: Project, matte: string, pad: number): string {
  return createHash('sha256').update(JSON.stringify([PLATE_VERSION, matteKey(project, matte), pad])).digest('hex').slice(0, 20);
}
const dirOf = (projectDir: string) => join(projectDir, '.studio', 'cache', 'plate');
const metaOf = (projectDir: string, key: string) => join(dirOf(projectDir), `${key}.json`);

export function loadPlate(projectDir: string, project: Project, matte: string, pad: number): PlateData | null {
  const key = plateKey(project, matte, pad);
  const f = metaOf(projectDir, key);
  if (!existsSync(f) || !existsSync(join(dirOf(projectDir), `${key}.mkv`))) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as PlateData;
  } catch {
    return null;
  }
}

export interface PlateBuildOptions {
  projectDir: string;
  project: Project;
  matte: string;
  pad?: number;
  log?: (m: string) => void;
  force?: boolean;
}

/** Builds (or reads from the cache) the clean plate of an object (a matte). */
export async function buildPlate(o: PlateBuildOptions): Promise<{ data: PlateData; cached: boolean; matteData: MatteData }> {
  const { projectDir, project } = o;
  const log = o.log ?? (() => undefined);
  const pad = o.pad ?? DEFAULT_PAD;
  const m = project.mattes?.[o.matte];
  if (!m) throw new EngineError('INVALID_INPUT', `no matte ${o.matte}`, 'studio mask list');
  const built = await buildMatte({ projectDir, project, id: o.matte, log });
  const md = built.data;
  if (!o.force) {
    const have = loadPlate(projectDir, project, o.matte, pad);
    if (have) return { data: have, cached: true, matteData: md };
  }
  const t0 = Date.now();
  const a = project.assets[m.asset]!;
  const src = join(projectDir, a.workingCopy?.path ?? a.path);
  const N = md.frames;
  if (N > MAX_FRAMES) throw new EngineError('INVALID_INPUT', `${N} frames is more than a clean plate is built from in one go (${MAX_FRAMES})`, 'erase a shorter range: a matte with --from/--to, or a lower --fps');
  const { w, h, fps } = md;
  const info = probeVideo(src);
  void info;
  log(`plate ${plateId(o.matte, pad)}: ${N} frames at ${w}x${h}`);
  // the pictures and the matte, at the matte's size
  const frames: Uint8Array[] = [];
  for await (const b of readFrames({ file: src, startMs: md.fromMs, durMs: Math.ceil((N * 1000) / fps) + 1, fps, size: { w, h }, channels: 3 })) {
    frames.push(new Uint8Array(b));
    if (frames.length >= N) break;
  }
  const alphas: Uint8Array[] = [];
  for await (const b of readFrames({ file: join(projectDir, md.file), size: { w, h }, channels: 1 })) {
    alphas.push(new Uint8Array(b));
    if (alphas.length >= N) break;
  }
  if (frames.length < N || alphas.length < N) throw new EngineError('INVALID_INPUT', `plate: expected ${N} frames, read ${frames.length} pictures and ${alphas.length} matte frames`);
  const padPx = Math.max(2, Math.round((pad / 1000) * w));
  const holes = alphas.map((al) => {
    const mk = new Uint8Array(w * h);
    for (let i = 0; i < mk.length; i++) mk[i] = al[i]! > 12 ? 1 : 0;
    return morph(mk, w, h, padPx, true);
  });
  const holePct = holes.map((hm) => Math.round((hm.reduce((s, v) => s + v, 0) / (w * h)) * 10000) / 100);

  // the camera's motion, per shot, fitted to the background at a smaller size
  const rw = Math.min(480, w);
  const rh = Math.max(2, Math.round((h * rw) / w));
  const k = w / rw;
  const grays: Gray[] = frames.map((f) => {
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (0.299 * f[3 * i]! + 0.587 * f[3 * i + 1]! + 0.114 * f[3 * i + 2]!) / 255;
    return { w: rw, h: rh, d: resizePlane(g, w, h, rw, rh) };
  });
  const smallHoles = holes.map((hm) => {
    const s = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) s[y * rw + x] = hm[Math.min(h - 1, Math.floor(y * k)) * w + Math.min(w - 1, Math.floor(x * k))]!;
    return s;
  });
  const cuts = (md.cuts ?? []).map((ms) => Math.round(((ms - md.fromMs) * fps) / 1000)).filter((f) => f > 0 && f < N);
  const bounds = [0, ...cuts, N];
  const H: (import('@studio/vision').Mat3 | null)[] = new Array(N).fill(null);
  const lost: number[] = [];
  let inl = 0;
  let maxRms = 0;
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a0 = bounds[s]!;
    const b0 = bounds[s + 1]!;
    if (b0 - a0 < 2) {
      for (let i = a0; i < b0; i++) H[i] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      continue;
    }
    log(`following the camera through frames ${a0}..${b0 - 1}`);
    const reg = await registerBackground(grays.slice(a0, b0), smallHoles.slice(a0, b0));
    for (let i = a0; i < b0; i++) H[i] = reg.H[i - a0] ?? null;
    for (const l of reg.lost) lost.push(a0 + l);
    inl += reg.meanInliers;
    maxRms = Math.max(maxRms, reg.maxRms);
  }
  const plate = cleanPlate(frames, holes, w, h, H, { scale: k, cuts });

  mkdirSync(dirOf(projectDir), { recursive: true });
  const key = plateKey(project, o.matte, pad);
  const video = join(dirOf(projectDir), `${key}.mkv`);
  const tmp = `${video}.${process.pid}.partial.mkv`;
  const wr = new VideoWriter(tmp, { w, h, fps, channels: 3, codec: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgr0'] });
  for (const f of plate.frames) await wr.write(f);
  await wr.close();
  renameSync(tmp, video);
  const flagged: PlateData['flagged'] = [];
  const ms = (i: number) => Math.round(md.fromMs + (i * 1000) / fps);
  for (let i = 0; i < N && flagged.length < 14; i++) {
    if (plate.spread[i]! > 0.05) flagged.push({ frame: i, ms: ms(i), why: `${Math.round(plate.spread[i]! * 100)}% of the removed area is never visible in any other frame of the shot, so it was spread in from its surroundings (blurry, not real background)` });
    else if (lost.includes(i)) flagged.push({ frame: i, ms: ms(i), why: 'the camera could not be followed here; the motion of the nearest frame was used' });
    else if (holePct[i]! > 40) flagged.push({ frame: i, ms: ms(i), why: `the removed area is ${holePct[i]}% of the picture` });
  }
  const data: PlateData = {
    v: PLATE_VERSION,
    id: plateId(o.matte, pad),
    matte: o.matte,
    pad,
    key,
    file: join('.studio', 'cache', 'plate', `${key}.mkv`),
    fps,
    w,
    h,
    fromMs: md.fromMs,
    frames: N,
    filled: plate.filled.map((v) => Math.round(v * 1000) / 1000),
    spread: plate.spread.map((v) => Math.round(v * 1000) / 1000),
    holePct,
    registration: { shots: bounds.length - 1, lost: lost.sort((x, y) => x - y), meanInliers: Math.round(inl / Math.max(1, bounds.length - 1)), maxRms: Math.round(maxRms * 100) / 100 },
    flagged,
    stats: { ms: Date.now() - t0 },
  };
  const metaTmp = `${metaOf(projectDir, key)}.${process.pid}.tmp`;
  writeFileSync(metaTmp, JSON.stringify(data));
  renameSync(metaTmp, metaOf(projectDir, key));
  return { data, cached: false, matteData: md };
}

/** The plates that the project's effects use (erase, not switched off), as [matte, pad] pairs. */
export function platesUsed(project: Project, clipIds?: Set<string>): { matte: string; pad: number }[] {
  const seen = new Map<string, { matte: string; pad: number }>();
  for (const c of project.clips) {
    if (clipIds && !clipIds.has(c.id)) continue;
    for (const f of c.fx ?? []) if (f.type === 'erase' && !f.bypass) seen.set(plateId(f.matte.id, f.pad), { matte: f.matte.id, pad: f.pad ?? DEFAULT_PAD });
  }
  return [...seen.values()];
}

/** The plates every enabled erase effect needs: a render builds what is missing; a frame preview says how to. */
export async function ensurePlates(
  project: Project,
  projectDir: string,
  o: { build: boolean; log?: (m: string) => void; clipIds?: Set<string>; placeholder?: (id: string) => void },
): Promise<Record<string, PlateData>> {
  const out: Record<string, PlateData> = {};
  for (const u of platesUsed(project, o.clipIds)) {
    const id = plateId(u.matte, u.pad);
    const have = loadPlate(projectDir, project, u.matte, u.pad);
    if (have) out[id] = have;
    else if (o.build) out[id] = (await buildPlate({ projectDir, project, matte: u.matte, pad: u.pad, log: o.log })).data;
    else if (o.placeholder) {
      o.placeholder(id);
      out[id] = { v: PLATE_VERSION, id, matte: u.matte, pad: u.pad, key: '', file: '', fps: 30, w: 16, h: 9, fromMs: 0, frames: 1, filled: [], spread: [], holePct: [], registration: { shots: 0, lost: [], meanInliers: 0, maxRms: 0 }, flagged: [], stats: { ms: 0 } };
    } else throw new EngineError('INVALID_INPUT', `the clean plate for ${id} has not been built yet`, `studio erase build ${u.matte}`);
  }
  return out;
}

/** A contact sheet to look at: for some frames, the picture, the removed area tinted, and the rebuilt picture. */
export async function plateSheet(o: { projectDir: string; project: Project; data: PlateData; matteData: MatteData; out: string; frames?: number[]; count?: number }): Promise<{ file: string; frames: { frame: number; ms: number; filledPct: number; spreadPct: number }[] }> {
  const { data, matteData } = o;
  const m = o.project.mattes![data.matte]!;
  const a = o.project.assets[m.asset]!;
  const src = join(o.projectDir, a.workingCopy?.path ?? a.path);
  const { grabFrame } = await import('./grab.js');
  const { tileRgb } = await import('@studio/vision');
  const tw = Math.min(data.w, 480);
  const w = tw;
  const h = Math.round((data.h * tw) / data.w);
  const count = Math.max(2, Math.min(6, o.count ?? 3));
  const list = (o.frames ?? Array.from({ length: count }, (_, i) => Math.round((i * (data.frames - 1)) / (count - 1)))).filter((f) => f >= 0 && f < data.frames).slice(0, 6);
  const want = new Set(list);
  const alphas = new Map<number, Uint8Array>();
  const plates = new Map<number, Uint8Array>();
  let fi = 0;
  for await (const b of readFrames({ file: join(o.projectDir, matteData.file), size: { w, h }, channels: 1 })) {
    if (want.has(fi)) alphas.set(fi, new Uint8Array(b));
    if (++fi > list[list.length - 1]!) break;
  }
  fi = 0;
  for await (const b of readFrames({ file: join(o.projectDir, data.file), size: { w, h }, channels: 3 })) {
    if (want.has(fi)) plates.set(fi, new Uint8Array(b));
    if (++fi > list[list.length - 1]!) break;
  }
  const tiles: Uint8Array[] = [];
  const rows: { frame: number; ms: number; filledPct: number; spreadPct: number }[] = [];
  for (const i of list) {
    const frame = await grabFrame(src, data.fromMs + (i * 1000) / data.fps, data.fps, { w, h });
    const rgb = new Uint8Array(frame ?? Buffer.alloc(w * h * 3));
    const al = alphas.get(i) ?? new Uint8Array(w * h);
    const over = rgb.slice();
    for (let p = 0; p < w * h; p++) {
      const k = al[p]! / 255;
      over[3 * p] = Math.round(rgb[3 * p]! * (1 - 0.45 * k) + 255 * 0.45 * k);
      over[3 * p + 1] = Math.round(rgb[3 * p + 1]! * (1 - 0.45 * k));
      over[3 * p + 2] = Math.round(rgb[3 * p + 2]! * (1 - 0.45 * k) + 200 * 0.45 * k);
    }
    tiles.push(rgb, over, plates.get(i) ?? new Uint8Array(w * h * 3));
    rows.push({ frame: i, ms: Math.round(data.fromMs + (i * 1000) / data.fps), filledPct: Math.round((data.filled[i] ?? 0) * 1000) / 10, spreadPct: Math.round((data.spread[i] ?? 0) * 1000) / 10 });
  }
  const sheet = tileRgb(tiles, w, h, 3);
  mkdirSync(join(o.out, '..'), { recursive: true });
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheet.w}x${sheet.h}`, '-i', '-', '-frames:v', '1', o.out], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stdin.on('error', () => undefined);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new EngineError('ENGINE_FAILED', 'ffmpeg could not write the sheet'))));
    p.stdin.end(Buffer.from(sheet.data));
  });
  return { file: o.out, frames: rows };
}
