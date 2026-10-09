/**
 * Mattes: cut-outs of an object in a video, made from marks on some frames and followed through the rest (see
 * packages/vision/src/segment.ts). The definition (a matte with its marked frames) is in the project; the result is a gray
 * video, one frame per analysed frame, brightness = how much of the object is there, cached under `.studio/cache/matte/` and
 * keyed by the source and the definition, so it is derived and can always be rebuilt.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Matte, Project } from '@studio/core';
import {
  VideoWriter, detectCuts, drawLine, drawPoly, followStep, probeVideo, readFrames, readSize, segmentFrame, segmentWithModel, startFollowing, tileRgb,
  type Seeds,
} from '@studio/vision';
import { grabFrame } from './grab.js';
import { pythonReady, removeBackground } from './bgremove.js';
import { requireModel, studioRoot } from './models.js';
import { EngineError, run } from './run.js';

export const MATTE_VERSION = 15;
const MAX_FRAMES = 700;

export interface MatteData {
  v: number;
  id: string;
  key: string;
  asset: string;
  /** the gray video, relative to the project folder */
  file: string;
  fps: number;
  w: number;
  h: number;
  fromMs: number;
  frames: number;
  keys: { at: number; frame: number }[];
  /** where shots change (ms of the asset); following does not cross them */
  cuts?: number[];
  /** per frame: the share of the picture the matte covers, and how much of the re-decided band stayed undecided (0..1) */
  coverage: number[];
  uncertain: number[];
  flagged: { frame: number; ms: number; why: string }[];
  /** following from one marked frame reaches the next: how well the result agrees with the marks there (IoU) */
  drift: { from: number; to: number; direction: 'forward' | 'backward'; iou: number }[];
  stats: { ms: number; keys: number; prior: string[]; /** what decided the boundary: a saliency model guided by the marks, or the marks and colours alone */ engine: string; engineNote?: string };
}

export function matteKey(project: Project, id: string): string {
  const m = project.mattes?.[id];
  if (!m) throw new EngineError('INVALID_INPUT', `no matte ${id}`, 'studio matte list');
  const a = project.assets[m.asset]!;
  const { label: _l, ...def } = m;
  return createHash('sha256')
    .update(JSON.stringify([MATTE_VERSION, a.hash, a.workingCopy?.path ?? a.path, def]))
    .digest('hex')
    .slice(0, 20);
}
const dirOf = (projectDir: string) => join(projectDir, '.studio', 'cache', 'matte');
export const matteVideo = (projectDir: string, key: string) => join(dirOf(projectDir), `${key}.mkv`);
const matteMeta = (projectDir: string, key: string) => join(dirOf(projectDir), `${key}.json`);

export function loadMatte(projectDir: string, project: Project, id: string): MatteData | null {
  const key = matteKey(project, id);
  if (!existsSync(matteVideo(projectDir, key)) || !existsSync(matteMeta(projectDir, key))) return null;
  try {
    return JSON.parse(readFileSync(matteMeta(projectDir, key), 'utf8')) as MatteData;
  } catch {
    return null;
  }
}

/** A saliency model's idea of the foreground for one frame (0..1), at the analysis size. Optional: needs the python models. */
async function modelPrior(rgb: Uint8Array, w: number, h: number, model: 'u2net' | 'u2netp'): Promise<Float32Array> {
  const sharp = (await import('sharp')).default;
  const tmp = mkdtempSync(join(tmpdir(), 'studio-prior-'));
  try {
    const png = join(tmp, 'frame.png');
    await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toFile(png);
    const out = join(tmp, 'cut.png');
    await removeBackground(png, out, { model, preview: false });
    const raw = await sharp(out).ensureAlpha().raw().toBuffer();
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = raw[4 * i + 3]! / 255;
    return a;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}


type ModelName = 'u2net' | 'u2netp';

/**
 * Saliency masks (0..255 per pixel) of the given frames. Kept on disk per source and size, so changing marks does not run the
 * model again. One python process does all that are missing.
 */
async function framePriors(o: { projectDir: string; tag: string; model: ModelName; frames: Uint8Array[]; need: number[]; w: number; h: number; log: (m: string) => void }): Promise<Map<number, Uint8Array>> {
  const { w, h } = o;
  const sharp = (await import('sharp')).default;
  const dir = join(dirOf(o.projectDir), `prior-${o.tag}-${o.model}`);
  mkdirSync(dir, { recursive: true });
  const out = new Map<number, Uint8Array>();
  const todo: number[] = [];
  for (const i of o.need) {
    const f = join(dir, `${i}.u8`);
    if (existsSync(f)) {
      const b = readFileSync(f);
      if (b.length === w * h) {
        out.set(i, new Uint8Array(b));
        continue;
      }
    }
    todo.push(i);
  }
  if (todo.length) {
    const tmp = mkdtempSync(join(tmpdir(), 'studio-prior-'));
    try {
      const jobs: { in: string; out: string }[] = [];
      for (const i of todo) {
        const png = join(tmp, `${i}.png`);
        await sharp(Buffer.from(o.frames[i]!), { raw: { width: w, height: h, channels: 3 } }).png().toFile(png);
        jobs.push({ in: png, out: join(tmp, `${i}.m.png`) });
      }
      writeFileSync(join(tmp, 'jobs.json'), JSON.stringify(jobs));
      o.log(`running ${o.model} on ${todo.length} frames`);
      const r = await run('python3', ['-I', join(studioRoot(), 'tools', 'bgremove.py'), '--model', requireModel(o.model), '--jobs', join(tmp, 'jobs.json')], { timeoutMs: 120_000 + 4_000 * todo.length });
      if (r.code !== 0) {
        let msg = r.stderr.trim().split('\n').pop() ?? '';
        try {
          msg = JSON.parse(msg).message;
        } catch {
          /* keep raw */
        }
        throw new Error(msg || 'the model run failed');
      }
      for (let k = 0; k < todo.length; k++) {
        const raw = await sharp(jobs[k]!.out).greyscale().raw().toBuffer();
        if (raw.length !== w * h) throw new Error('the model returned a mask of the wrong size');
        const u = new Uint8Array(raw);
        out.set(todo[k]!, u);
        writeFileSync(join(dir, `${todo[k]}.u8`), u);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}
const toFloat = (u: Uint8Array): Float32Array => Float32Array.from(u, (v) => v / 255);

export interface MatteBuildOptions {
  projectDir: string;
  project: Project;
  id: string;
  log?: (m: string) => void;
  force?: boolean;
}

const toBytes = (a: Float32Array): Uint8Array => Uint8Array.from(a, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
const iouBytes = (a: Uint8Array, b: Uint8Array): number => {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k]! > 127;
    const y = b[k]! > 127;
    if (x && y) i++;
    if (x || y) u++;
  }
  return u ? i / u : 1;
};

/** Builds (or reads from the cache) the matte video of a matte. */
export async function buildMatte(o: MatteBuildOptions): Promise<{ data: MatteData; cached: boolean }> {
  const { projectDir, project, id } = o;
  const log = o.log ?? (() => undefined);
  const m = project.mattes?.[id];
  if (!m) throw new EngineError('INVALID_INPUT', `no matte ${id}`, 'studio matte list');
  const key = matteKey(project, id);
  if (!o.force) {
    const have = loadMatte(projectDir, project, id);
    if (have) return { data: have, cached: true };
  }
  const t0 = Date.now();
  const a = project.assets[m.asset]!;
  const src = join(projectDir, a.workingCopy?.path ?? a.path);
  if (!existsSync(src)) throw new EngineError('INVALID_INPUT', `${m.asset}: the file ${a.workingCopy?.path ?? a.path} is missing`, 'studio ingest it again');
  const info = probeVideo(src);
  const fps = m.fps ?? Math.min(30, Math.round(info.fps * 100) / 100);
  const size = readSize(info, { width: Math.min(m.width ?? 480, info.w) });
  const { w, h } = { w: size.w, h: size.h };
  const step = 1000 / fps;
  const total = Math.max(2, Math.round((m.to - m.from) / step) + 1);
  if (total > MAX_FRAMES) throw new EngineError('INVALID_INPUT', `${total} frames is more than a cut-out follows in one go (${MAX_FRAMES})`, 'cut out a shorter range (--from/--to), or lower --fps');

  // all the frames, as bytes
  const frames: Uint8Array[] = [];
  for await (const b of readFrames({ file: src, startMs: m.from, durMs: Math.ceil(total * step) + 1, fps, size: { w, h }, channels: 3 })) {
    frames.push(new Uint8Array(b));
    if (frames.length >= total) break;
  }
  const N = frames.length;
  if (N < 2) throw new EngineError('INVALID_INPUT', `matte ${id}: fewer than two frames in ${m.from}..${m.to} ms of ${m.asset}`);
  log(`matte ${id}: ${N} frames at ${w}x${h}`);
  const keys = m.keys
    .map((k) => ({ ...k, frame: Math.min(N - 1, Math.max(0, Math.round((k.at - m.from) / step))) }))
    .sort((x, y) => x.frame - y.frame);
  for (let i = 1; i < keys.length; i++) if (keys[i]!.frame === keys[i - 1]!.frame) throw new EngineError('INVALID_INPUT', `matte ${id}: two marked frames fall on the same analysed frame (${keys[i]!.at} ms)`, 'keep marked frames at least one frame apart');

  // which engine: a saliency model guided by the marks, or the marks and colours alone
  const want = m.engine ?? 'auto';
  let model: ModelName | null = want === 'colour' ? null : want === 'auto' ? 'u2net' : want;
  let engineNote: string | undefined;
  if (model) {
    const py = await pythonReady();
    let missing = py.ok ? '' : `python is not ready (${py.detail})`;
    if (!missing)
      try {
        requireModel(model);
      } catch (e) {
        missing = (e as Error).message;
      }
    if (missing) {
      if (want !== 'auto') throw new EngineError('ENGINE_MISSING', `matte ${id}: engine ${want} cannot run: ${missing}`, 'studio doctor; or --engine colour (marks and colours alone, weaker on real footage)');
      engineNote = `the model engine is not available (${missing}); marks and colours alone were used`;
      model = null;
    }
  }
  const tag = createHash('sha256').update(JSON.stringify([a.hash, a.workingCopy?.path ?? a.path, m.from, fps, w, h, N])).digest('hex').slice(0, 16);
  const prior = new Map<number, Uint8Array>();
  const modelKey: boolean[] = [];

  // the marked frames
  const priors: string[] = [];
  const keyAlpha: Uint8Array[] = [];
  const states: ReturnType<typeof segmentFrame>[] = [];
  for (const k of keys) {
    let prior: Float32Array | undefined;
    if (k.prior) {
      try {
        prior = await modelPrior(frames[k.frame]!, w, h, k.prior);
        priors.push(k.prior);
      } catch (e) {
        throw new EngineError('ENGINE_MISSING', `matte ${id}: the ${k.prior} prior could not run: ${(e as Error).message}`, 'drop --prior (marks alone work), or set up the model (studio doctor)');
      }
    }
    let seg;
    try {
      seg = segmentFrame(frames[k.frame]!, w, h, k.seeds as Seeds, { prior });
    } catch (e) {
      throw new EngineError('INVALID_INPUT', `matte ${id} at ${k.at} ms: ${(e as Error).message}`, 'give a box, foreground marks, an outline or a prior');
    }
    let ok = false;
    if (model) {
      try {
        const got = await framePriors({ projectDir, tag, model, frames, need: [k.frame], w, h, log });
        const mk = segmentWithModel(frames[k.frame]!, w, h, k.seeds as Seeds, seg, toFloat(got.get(k.frame)!));
        ok = mk.ok;
        if (ok) seg = mk.seg;
        else {
          engineNote = `at ${k.at} ms ${mk.why}; marks and colours alone were used there`;
          log(`marked frame ${k.at} ms: ${engineNote}`);
          if (want !== 'auto') throw new EngineError('INVALID_INPUT', `matte ${id} at ${k.at} ms: ${mk.why}`, 'mark the object more exactly (--box around it, --fg on it), or --engine colour');
        }
      } catch (e) {
        if (e instanceof EngineError) throw e;
        if (want !== 'auto') throw new EngineError('ENGINE_FAILED', `matte ${id}: the ${model} model failed: ${(e as Error).message}`, 'studio doctor; or --engine colour');
        engineNote = `the model failed (${(e as Error).message}); marks and colours alone were used`;
        model = null;
      }
    }
    modelKey.push(ok);
    keyAlpha.push(toBytes(seg.alpha));
    states.push(seg);
    log(`marked frame ${k.at} ms: ${Math.round((100 * keyAlpha[keyAlpha.length - 1]!.reduce((s, v) => s + (v > 127 ? 1 : 0), 0)) / (w * h))}% of the picture`);
  }

  // the model's mask for every frame that is followed (marked frames done above)
  if (model && modelKey.some(Boolean)) {
    try {
      const all = await framePriors({ projectDir, tag, model, frames, need: Array.from({ length: N }, (_, i) => i), w, h, log });
      for (const [i, u] of all) prior.set(i, u);
    } catch (e) {
      if (want !== 'auto') throw new EngineError('ENGINE_FAILED', `matte ${id}: the ${model} model failed: ${(e as Error).message}`, 'studio doctor; or --engine colour');
      engineNote = `the model failed (${(e as Error).message}); marks and colours alone were used`;
      prior.clear();
    }
  }
  const final: Uint8Array[] = new Array(N);
  const unc: number[] = new Array(N).fill(0);
  const drift: MatteData['drift'] = [];
  /** follows from a marked frame over frame indices `idx` (in order) */
  const follow = (ki: number, idx: number[]): Map<number, Uint8Array> => {
    const out = new Map<number, Uint8Array>();
    const st = startFollowing(frames[keys[ki]!.frame]!, w, h, states[ki]!);
    for (const i of idx) {
      const pr = modelKey[ki] ? prior.get(i) : undefined;
      const r = followStep(st, frames[i]!, pr ? { prior: toFloat(pr) } : {});
      out.set(i, toBytes(r.alpha));
      unc[i] = Math.max(unc[i]!, r.uncertain);
    }
    return out;
  };
  const range = (from: number, to: number, dir: 1 | -1) => {
    const r: number[] = [];
    for (let i = from; dir > 0 ? i <= to : i >= to; i += dir) r.push(i);
    return r;
  };
  keys.forEach((k, ki) => (final[k.frame] = keyAlpha[ki]!));
  // A cut replaces the picture with an unrelated one: following never crosses one, and a shot with no marked frame has no matte.
  const cuts = detectCuts(frames, w, h);
  const starts = [0, ...cuts];
  const shotNotes: MatteData['flagged'] = [];
  starts.forEach((a0, si) => {
    const b0 = (starts[si + 1] ?? N) - 1;
    const inShot = keys.map((k, ki) => ({ k, ki })).filter(({ k }) => k.frame >= a0 && k.frame <= b0);
    if (si > 0) shotNotes.push({ frame: a0, ms: Math.round(m.from + a0 * step), why: inShot.length ? 'a cut: a new shot starts here and is followed from its own marked frame' : 'a cut: a new shot starts here with no marked frame, so the matte is empty until the next cut; mark the object in it (studio matte key)' });
    if (!inShot.length) {
      for (let i = a0; i <= b0; i++) final[i] = new Uint8Array(w * h);
      return;
    }
    const first = inShot[0]!;
    const last = inShot[inShot.length - 1]!;
    if (first.k.frame > a0) for (const [i, v] of follow(first.ki, range(first.k.frame - 1, a0, -1))) final[i] = v;
    if (last.k.frame < b0) for (const [i, v] of follow(last.ki, range(last.k.frame + 1, b0, 1))) final[i] = v;
    for (let j = 0; j + 1 < inShot.length; j++) {
      const ki = inShot[j]!.ki;
      const ia = keys[ki]!.frame;
      const ib = keys[ki + 1]!.frame;
      const fw = follow(ki, range(ia + 1, ib, 1));
      const bw = follow(ki + 1, range(ib - 1, ia, -1));
      drift.push({ from: keys[ki]!.at, to: keys[ki + 1]!.at, direction: 'forward', iou: iouBytes(fw.get(ib)!, keyAlpha[ki + 1]!) });
      drift.push({ from: keys[ki + 1]!.at, to: keys[ki]!.at, direction: 'backward', iou: iouBytes(bw.get(ia)!, keyAlpha[ki]!) });
      for (let i = ia + 1; i < ib; i++) {
        const wb = (i - ia) / (ib - ia);
        const f = fw.get(i)!;
        const bb = bw.get(i)!;
        const o2 = new Uint8Array(w * h);
        for (let p = 0; p < o2.length; p++) o2[p] = Math.round(f[p]! * (1 - wb) + bb[p]! * wb);
        final[i] = o2;
      }
      log(`between ${keys[ki]!.at} and ${keys[ki + 1]!.at} ms: following reaches the next marked frame with IoU ${drift[drift.length - 2]!.iou.toFixed(3)} (forward), ${drift[drift.length - 1]!.iou.toFixed(3)} (backward)`);
    }
  });

  // write the video and the numbers
  mkdirSync(dirOf(projectDir), { recursive: true });
  const video = matteVideo(projectDir, key);
  const tmp = `${video}.${process.pid}.partial.mkv`;
  const wr = new VideoWriter(tmp, { w, h, fps });
  const coverage: number[] = [];
  for (let i = 0; i < N; i++) {
    await wr.write(final[i]!);
    let s = 0;
    for (let p = 0; p < final[i]!.length; p++) s += final[i]![p]! / 255;
    coverage.push(Math.round((s / (w * h)) * 10000) / 10000);
  }
  await wr.close();
  renameSync(tmp, video);
  const peak = Math.max(...coverage, 1e-9);
  const flagged: MatteData['flagged'] = [...shotNotes];
  const ms = (i: number) => Math.round(m.from + i * step);
  for (let i = 1; i < N && flagged.length < 14; i++) {
    const jump = Math.abs(coverage[i]! - coverage[i - 1]!) / peak;
    if (jump > 0.3) flagged.push({ frame: i, ms: ms(i), why: `the matte's area changed by ${Math.round(jump * 100)}% of its peak in one frame` });
    else if (coverage[i]! < 0.0005 && coverage[i - 1]! >= 0.0005) flagged.push({ frame: i, ms: ms(i), why: 'the matte became empty' });
    else if (unc[i]! > 0.4) flagged.push({ frame: i, ms: ms(i), why: `the boundary stayed undecided (${Math.round(unc[i]! * 100)}% of the re-decided band is neither inside nor outside)` });
  }
  const data: MatteData = {
    v: MATTE_VERSION,
    id,
    key,
    asset: m.asset,
    file: join('.studio', 'cache', 'matte', `${key}.mkv`),
    fps,
    w,
    h,
    fromMs: m.from,
    frames: N,
    keys: keys.map((k) => ({ at: k.at, frame: k.frame })),
    cuts: cuts.map((c) => Math.round(m.from + c * step)),
    coverage,
    uncertain: unc.map((v) => Math.round(v * 1000) / 1000),
    flagged,
    drift: drift.map((d) => ({ ...d, iou: Math.round(d.iou * 1000) / 1000 })),
    stats: { ms: Date.now() - t0, keys: keys.length, prior: priors, engine: prior.size && modelKey.some(Boolean) ? model! : 'colour', ...(engineNote ? { engineNote } : {}) },
  };
  const metaTmp = `${matteMeta(projectDir, key)}.${process.pid}.tmp`;
  writeFileSync(metaTmp, JSON.stringify(data));
  renameSync(metaTmp, matteMeta(projectDir, key));
  return { data, cached: false };
}

/** The mattes that the project's effects use (not switched off). */
export function mattesUsed(project: Project, clipIds?: Set<string>): string[] {
  const ids = new Set<string>();
  for (const c of project.clips) {
    if (clipIds && !clipIds.has(c.id)) continue;
    for (const f of c.fx ?? []) if ((f.type === 'cutout' || f.type === 'plugin' || f.type === 'lut') && f.matte && !f.bypass) ids.add(f.matte.id);
  }
  return [...ids];
}

/** The data every enabled matte effect needs: a render builds what is missing; a frame preview says how to. */
export async function ensureMattes(
  project: Project,
  projectDir: string,
  o: { build: boolean; log?: (m: string) => void; clipIds?: Set<string>; placeholder?: (id: string) => void },
): Promise<Record<string, MatteData>> {
  const out: Record<string, MatteData> = {};
  for (const id of mattesUsed(project, o.clipIds)) {
    const m = project.mattes?.[id];
    if (!m) continue;
    const have = loadMatte(projectDir, project, id);
    if (have) out[id] = have;
    else if (o.build) out[id] = (await buildMatte({ projectDir, project, id, log: o.log })).data;
    else if (o.placeholder) {
      o.placeholder(id);
      out[id] = { v: MATTE_VERSION, id, key: '', asset: m.asset, file: '', fps: 30, w: 16, h: 9, fromMs: m.from, frames: 1, keys: [], coverage: [], uncertain: [], flagged: [], drift: [], stats: { ms: 0, keys: 0, prior: [], engine: 'colour' } };
    } else throw new EngineError('INVALID_INPUT', `matte ${id} has not been built yet`, `studio matte build ${id}`);
  }
  return out;
}

// ----- looking at a matte --------------------------------------------------------------------------------------------------------------------

/**
 * A contact sheet: for each chosen frame, the picture with the matte tinted over it and its outline drawn (and, on marked
 * frames, the marks: white box, green foreground, red background, cyan outline), next to the cut-out on a checkerboard.
 */
export async function matteSheet(o: { projectDir: string; project: Project; id: string; data: MatteData; out: string; frames?: number[]; count?: number }): Promise<{ file: string; frames: { frame: number; ms: number; marked: boolean; coverage: number }[] }> {
  const { data, project } = o;
  const m = project.mattes![o.id]!;
  const a = project.assets[m.asset]!;
  const src = join(o.projectDir, a.workingCopy?.path ?? a.path);
  const { w, h } = data;
  const count = Math.max(2, Math.min(8, o.count ?? 4));
  const chosen = new Set<number>(o.frames ?? []);
  if (!o.frames) {
    for (const k of data.keys.slice(0, 3)) chosen.add(k.frame);
    for (let i = 0; i < count; i++) chosen.add(Math.round((i * (data.frames - 1)) / (count - 1)));
  }
  const list = [...chosen].filter((f) => f >= 0 && f < data.frames).sort((x, y) => x - y).slice(0, 8);
  // the matte frames we need
  const alphas = new Map<number, Uint8Array>();
  let fi = 0;
  for await (const b of readFrames({ file: join(o.projectDir, data.file), size: { w, h }, channels: 1 })) {
    if (list.includes(fi)) alphas.set(fi, new Uint8Array(b));
    fi++;
    if (fi > list[list.length - 1]!) break;
  }
  const step = 1000 / data.fps;
  const tiles: Uint8Array[] = [];
  const rows: { frame: number; ms: number; marked: boolean; coverage: number }[] = [];
  for (const i of list) {
    const frame = await grabFrame(src, data.fromMs + i * step, data.fps, { w, h });
    const rgb = new Uint8Array(frame ?? Buffer.alloc(w * h * 3));
    const al = alphas.get(i) ?? new Uint8Array(w * h);
    const over = rgb.slice();
    const cut = new Uint8Array(w * h * 3);
    for (let p = 0; p < w * h; p++) {
      const k = al[p]! / 255;
      const chk = ((p % w >> 3) + (Math.floor(p / w) >> 3)) & 1 ? 170 : 110;
      for (let c = 0; c < 3; c++) {
        cut[3 * p + c] = Math.round(rgb[3 * p + c]! * k + chk * (1 - k));
        const tint = c === 0 ? 255 : c === 1 ? 0 : 200;
        over[3 * p + c] = Math.round(rgb[3 * p + c]! * (1 - 0.4 * k) + tint * 0.4 * k);
      }
    }
    // the outline of the matte
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (al[p]! > 127 && (al[p - 1]! <= 127 || al[p + 1]! <= 127 || al[p - w]! <= 127 || al[p + w]! <= 127)) (over[3 * p] = 255, (over[3 * p + 1] = 230), (over[3 * p + 2] = 0));
      }
    const key = m.keys.find((k) => data.keys.find((d) => d.at === k.at)?.frame === i);
    if (key) {
      const px = (pt: [number, number]): [number, number] => [pt[0] * w, pt[1] * h];
      const s = key.seeds;
      if (s.box) drawPoly(over, w, h, [[s.box[0], s.box[1]], [s.box[0] + s.box[2], s.box[1]], [s.box[0] + s.box[2], s.box[1] + s.box[3]], [s.box[0], s.box[1] + s.box[3]]].map((q) => px(q as [number, number])), [255, 255, 255], 1);
      if (s.outline) drawPoly(over, w, h, s.outline.p.map(px), [0, 255, 255], 1);
      const stroke = (shapes: typeof s.fg, col: [number, number, number]) => {
        for (const sh of shapes ?? []) {
          const pts = sh.p.map(px);
          if (sh.closed && pts.length > 2) drawPoly(over, w, h, pts, col, 2);
          else if (pts.length === 1) drawLine(over, w, h, [pts[0]![0] - 2, pts[0]![1]], [pts[0]![0] + 2, pts[0]![1]], col, 4);
          else for (let q = 0; q + 1 < pts.length; q++) drawLine(over, w, h, pts[q]!, pts[q + 1]!, col, 3);
        }
      };
      stroke(s.fg, [0, 255, 70]);
      stroke(s.bg, [255, 50, 50]);
    }
    tiles.push(over, cut);
    rows.push({ frame: i, ms: Math.round(data.fromMs + i * step), marked: !!key, coverage: data.coverage[i] ?? 0 });
  }
  const sheet = tileRgb(tiles, w, h, 4);
  mkdirSync(join(o.out, '..'), { recursive: true });
  const { spawn } = await import('node:child_process');
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

/** Copies the matte video out of the cache (gray, lossless). */
export function exportMatte(projectDir: string, data: MatteData, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(join(projectDir, data.file), to);
}
export type { Matte };
