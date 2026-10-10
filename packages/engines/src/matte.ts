/**
 * Mattes: cut-outs of an object in a video, made from marks on some frames and followed through the rest (see
 * packages/vision/src/segment.ts). The definition (a matte with its marked frames) is in the project; the result is a gray
 * video, one frame per analysed frame, brightness = how much of the object is there, cached under `.studio/cache/matte/` and
 * keyed by the source and the definition, so it is derived and can always be rebuilt.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Matte, Project } from '@studio/core';
import {
  VideoWriter, components, rleToMask, colourEvidence, neverSeen, consensusMask, proposalPrompts, detectCuts, estimateForeground, flowsOf, morph, refineEdge, resizePlane, smoothMattes, smoothMattesBytes, drawLine, drawPoly, followPrepare, followStep, probeVideo, promptsFromMask, promptsFromSeeds, segmentFromPrompted, readFrames, readSize, segmentFrame, segmentWithModel, startFollowing, tileRgb,
  type Seeds,
} from '@studio/vision';
import { grabFrame } from './grab.js';
import { pythonReady, removeBackground } from './bgremove.js';
import { requireModel, studioRoot } from './models.js';
import { EngineError, run } from './run.js';
import { SamServer } from './sam.js';
import { VitMatteServer } from './vitmatte.js';

export const MATTE_VERSION = 34;
/** a followed matte whose pixels look less than this much like the marked object (colour evidence 0..1) is not shown */
const MIN_CONFIDENCE = 0.3;
const MAX_FRAMES = 700;

export interface MatteQuality {
  /** per analysed frame: how the matte was decided, and what the cleaning took out */
  frames: { how: 'key' | 'consensus' | 'best' | 'prediction' | 'colour' | 'hidden' | 'union'; /** other things (a neighbour, something passing in front) kept out of the matte */ keptOut: number; /** specks removed (px at the analysis size) */ specks: number; /** pieces left besides the main one */ islands: number; /** change of the matte's area from the frame before (% of its peak) */ areaChangePct: number }[];
  summary: { consensusPct: number; fallbackFrames: number; framesWithNeighboursKeptOut: number; specksRemoved: number; framesWithIslands: number; worstAreaChangePct: number };
}

export interface MatteData {
  v: number;
  id: string;
  key: string;
  asset: string;
  /** the gray video, relative to the project folder */
  file: string;
  /** the object's colour with the old background taken out of the edge pixels (RGB video, same size), when it was made */
  fgFile?: string;
  /** the size the marks were followed at; `w` and `h` are the size of the matte video */
  analysis?: { w: number; h: number };
  /** what the edge engine did, and how steady the matte is (flicker 0..1, lower is steadier) */
  edge?: { refined: boolean; hair: boolean; model?: string; smoothed: number; decontaminated: boolean; flicker?: { before: number; after: number }; jitter?: { before: number; after: number } };
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
  /** how each frame was made and how clean it is, for judging a matte without looking at every frame */
  quality?: MatteQuality;
  /** following from one marked frame reaches the next: how well the result agrees with the marks there (IoU) */
  drift: { from: number; to: number; direction: 'forward' | 'backward'; iou: number }[];
  stats: { ms: number; keys: number; prior: string[]; /** a union: its members */ members?: string[]; /** what decided the boundary: a saliency model guided by the marks, or the marks and colours alone */ engine: string; engineNote?: string };
}

export function matteKey(project: Project, id: string): string {
  const m = project.mattes?.[id];
  if (!m) throw new EngineError('INVALID_INPUT', `no matte ${id}`, 'studio matte list');
  const a = project.assets[m.asset]!;
  const { label: _l, ...def } = m;
  // a union is made from its members: what they are made from is part of what it is
  const members = (m.union ?? []).map((u) => matteKey(project, u));
  return createHash('sha256')
    .update(JSON.stringify([MATTE_VERSION, a.hash, a.workingCopy?.path ?? a.path, def, members]))
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


/**
 * The segmenter's encodings of the frames are about 8 MB a frame, kept so that changing marks does not encode again. Kept up to
 * `maxBytes` in all (the least recently used folders go first); whatever is removed is simply encoded again when needed.
 */
export function pruneEmbeddingCache(projectDir: string, keep: string[], maxBytes = 1.2e9): { removed: string[]; bytes: number } {
  const root = dirOf(projectDir);
  if (!existsSync(root)) return { removed: [], bytes: 0 };
  const sizeOf = (dir: string) => readdirSync(dir).reduce((s, f) => s + (statSync(join(dir, f)).size || 0), 0);
  const dirs = readdirSync(root)
    .filter((n) => n.startsWith('sam-'))
    .map((n) => ({ n, p: join(root, n), t: statSync(join(root, n)).mtimeMs, b: sizeOf(join(root, n)) }))
    .sort((a, b) => a.t - b.t);
  let total = dirs.reduce((s, d) => s + d.b, 0);
  const removed: string[] = [];
  for (const d of dirs) {
    if (total <= maxBytes) break;
    if (keep.includes(d.n)) continue;
    rmSync(d.p, { recursive: true, force: true });
    total -= d.b;
    removed.push(d.n);
  }
  return { removed, bytes: total };
}

/** Builds (or reads from the cache) the matte video of a matte. */
export async function buildMatte(o: MatteBuildOptions): Promise<{ data: MatteData; cached: boolean }> {
  if (o.project.mattes?.[o.id]?.union) return buildUnion(o);
  const holder: { sam?: SamServer; tag?: string } = {};
  try {
    return await buildMatteCore(o, holder);
  } finally {
    await holder.sam?.close();
    if (holder.sam) pruneEmbeddingCache(o.projectDir, [holder.tag ?? '']);
  }
}

async function buildMatteCore(o: MatteBuildOptions, holder: { sam?: SamServer; tag?: string }): Promise<{ data: MatteData; cached: boolean }> {
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
  let model: ModelName | null = want === 'colour' || want === 'sam' ? null : want === 'auto' ? 'u2net' : want;
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
  // the promptable segmenter (Object Mask Tool): every frame is encoded once (cached), then asked with prompts
  let sam: SamServer | undefined;
  if (want === 'sam') {
    holder.tag = `sam-${tag}`;
    sam = holder.sam = await SamServer.start(join(dirOf(projectDir), `sam-${tag}`));
    let encMs = 0;
    for (let i = 0; i < N; i++) {
      if (i % 10 === 0) log(`encoding frames for the segmenter: ${i}/${N}`);
      encMs += await sam.embed(`f${i}`, frames[i]!, w, h);
    }
    log(`encoded ${N} frames in ${(encMs / 1000).toFixed(1)} s (cached frames cost nothing)`);
  }

  // the marked frames
  const priors: string[] = [];
  const keyAlpha: Uint8Array[] = [];
  const states: ReturnType<typeof segmentFrame>[] = [];
  for (const k of keys) {
    if (k.absent) {
      // a frame where the person says the object is not there: an empty matte, nothing to follow from it
      keyAlpha.push(new Uint8Array(w * h));
      states.push(undefined as unknown as ReturnType<typeof segmentFrame>);
      modelKey.push(false);
      log(`marked frame ${k.at} ms: the object is not here`);
      continue;
    }
    let prior: Float32Array | undefined;
    if (k.prior) {
      try {
        prior = await modelPrior(frames[k.frame]!, w, h, k.prior);
        priors.push(k.prior);
      } catch (e) {
        throw new EngineError('ENGINE_MISSING', `matte ${id}: the ${k.prior} prior could not run: ${(e as Error).message}`, 'drop --prior (marks alone work), or set up the model (studio doctor)');
      }
    }
    let seg: ReturnType<typeof segmentFrame>;
    if ((k.seeds as Seeds).mask) {
      // the exact mask that was found and chosen (`studio bg subjects`): no prompts to the segmenter that could disturb it; marks still correct it
      const exact = rleToMask((k.seeds as Seeds).mask!, w, h);
      seg = segmentFromPrompted(frames[k.frame]!, w, h, k.seeds as Seeds, exact);
      modelKey.push(!!sam);
      keyAlpha.push(toBytes(seg.alpha));
      states.push(seg);
      log(`marked frame ${k.at} ms: the chosen subject's own mask, ${Math.round((100 * keyAlpha[keyAlpha.length - 1]!.reduce((t, v) => t + (v > 127 ? 1 : 0), 0)) / (w * h))}% of the picture`);
      continue;
    }
    if (sam) {
      const pr = promptsFromSeeds(w, h, k.seeds as Seeds);
      if (!pr.points.length && !pr.box) throw new EngineError('INVALID_INPUT', `matte ${id} at ${k.at} ms: the segmenter needs a point on the object, a box, or an outline`, 'studio mask add --point x,y   or   --box x,y,w,h');
      const got = await sam.decode(`f${k.frame}`, w, h, { ...pr, ...(k.index !== undefined ? { index: k.index } : k.pick ? { pick: k.pick } : {}) });
      seg = segmentFromPrompted(frames[k.frame]!, w, h, k.seeds as Seeds, got.prob);
      modelKey.push(true);
      keyAlpha.push(toBytes(seg.alpha));
      states.push(seg);
      log(`marked frame ${k.at} ms: candidate ${got.picked} of 3 (predicted quality ${got.iou.join(' / ')}), ${Math.round((100 * keyAlpha[keyAlpha.length - 1]!.reduce((t, v) => t + (v > 127 ? 1 : 0), 0)) / (w * h))}% of the picture`);
      continue;
    }
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
  const hidden = new Set<number>(); // frames where the followed matte did not look like the marked object
  const howRank = ['key', 'consensus', 'colour', 'best', 'prediction', 'hidden'] as const;
  const how: (typeof howRank[number] | undefined)[] = new Array(N).fill(undefined);
  const keptOut: number[] = new Array(N).fill(0);
  const note = (i: number, h: typeof howRank[number], k = 0) => {
    if (how[i] === undefined || howRank.indexOf(h) >= howRank.indexOf(how[i]!)) how[i] = h;
    keptOut[i] = Math.max(keptOut[i]!, k);
  };
  const drift: MatteData['drift'] = [];
  /** follows from a marked frame over frame indices `idx` (in order) */
  let lastHid = new Set<number>(); // the frames the last call of follow found the object not to be in
  const follow = async (ki: number, idx: number[]): Promise<Map<number, Uint8Array>> => {
    lastHid = new Set<number>();
    const out = new Map<number, Uint8Array>();
    if (keys[ki]!.absent) {
      for (const i of idx) out.set(i, new Uint8Array(w * h));
      return out;
    }
    const st = startFollowing(frames[keys[ki]!.frame]!, w, h, states[ki]!);
    for (const i of idx) {
      let r;
      if (sam && modelKey[ki]) {
        // the segmenter is asked about this frame with prompts taken from the matte carried over to it
        const t0 = Date.now();
        const pre = followPrepare(st, frames[i]!);
        const prompts = proposalPrompts(pre.warped, w, h);
        let prior: Float32Array | undefined;
        if (prompts.length) {
          const t1 = Date.now();
          const props = await sam.proposals(`f${i}`, w, h, prompts);
          const t2 = Date.now();
          const c = consensusMask(pre.warped, props, w, h, { flow: pre.flow, frames: { prev: st.gray, cur: pre.gray }, evidence: colourEvidence(st, frames[i]!), never: neverSeen(st, frames[i]!) });
          if (c.how === 'hidden') {
            // the object's motion says it is behind something here: nothing is shown, and the state waits for it to come back
            st.rgb = frames[i]!;
            st.gray = pre.gray;
            out.set(i, new Uint8Array(w * h));
            unc[i] = 1;
            hidden.add(i);
            lastHid.add(i);
            note(i, 'hidden');
            continue;
          }
          if (process.env['STUDIO_DEBUG_FOLLOW']) log(`TIMING ${i} prepare ${t1 - t0} ms, proposals ${t2 - t1} ms, consensus ${Date.now() - t2} ms`);
          if (process.env['STUDIO_DEBUG_FOLLOW'] === '2') log(`TRACE ${i} ${JSON.stringify(c.trace)}`);
          if (process.env['STUDIO_DEBUG_FOLLOW']) log(`frame ${i}: ${c.how}, ${c.accepted} proposals accepted, ${c.foreign} foreign, coverage ${c.coverage.toFixed(2)}, motion separation ${c.motionSeparation?.toFixed(1) ?? 'n/a'} px`);
          prior = c.alpha;
          note(i, c.how, c.foreign);
        } else note(i, 'colour');
        r = followStep(st, frames[i]!, { pre, minConfidence: MIN_CONFIDENCE, ...(prior ? { prior } : {}) });
      } else {
        const pr = modelKey[ki] ? prior.get(i) : undefined;
        r = followStep(st, frames[i]!, { minConfidence: MIN_CONFIDENCE, ...(pr ? { prior: toFloat(pr) } : {}) });
      }
      out.set(i, toBytes(r.alpha));
      unc[i] = Math.max(unc[i]!, r.uncertain);
      if (r.hidden) (hidden.add(i), lastHid.add(i), note(i, 'hidden'));
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
  for (let si = 0; si < starts.length; si++) {
    const a0 = starts[si]!;
    const b0 = (starts[si + 1] ?? N) - 1;
    const inShot = keys.map((k, ki) => ({ k, ki })).filter(({ k }) => k.frame >= a0 && k.frame <= b0);
    if (si > 0) shotNotes.push({ frame: a0, ms: Math.round(m.from + a0 * step), why: inShot.length ? 'a cut: a new shot starts here and is followed from its own marked frame' : 'a cut: a new shot starts here with no marked frame, so the matte is empty until the next cut; mark the object in it (studio matte key)' });
    if (!inShot.length) {
      for (let i = a0; i <= b0; i++) final[i] = new Uint8Array(w * h);
      continue;
    }
    const first = inShot[0]!;
    const last = inShot[inShot.length - 1]!;
    if (first.k.frame > a0) for (const [i, v] of await follow(first.ki, range(first.k.frame - 1, a0, -1))) final[i] = v;
    if (last.k.frame < b0) for (const [i, v] of await follow(last.ki, range(last.k.frame + 1, b0, 1))) final[i] = v;
    for (let j = 0; j + 1 < inShot.length; j++) {
      const ki = inShot[j]!.ki;
      const ia = keys[ki]!.frame;
      const ib = keys[ki + 1]!.frame;
      const fw = await follow(ki, range(ia + 1, ib, 1));
      const hf = lastHid;
      const bw = await follow(ki + 1, range(ib - 1, ia, -1));
      const hb = lastHid;
      if (!keys[ki]!.absent && !keys[ki + 1]!.absent) {
        drift.push({ from: keys[ki]!.at, to: keys[ki + 1]!.at, direction: 'forward', iou: iouBytes(fw.get(ib)!, keyAlpha[ki + 1]!) });
        drift.push({ from: keys[ki + 1]!.at, to: keys[ki]!.at, direction: 'backward', iou: iouBytes(bw.get(ia)!, keyAlpha[ki]!) });
      }
      for (let i = ia + 1; i < ib; i++) {
        // where one side did not find the object the other side decides; where neither did, it is not there
        // an absent frame ends where the object is: from it the matte comes from the other side alone, not faded over the gap
        const wb = keys[ki]!.absent ? 1 : keys[ki + 1]!.absent ? 0 : hf.has(i) && !hb.has(i) ? 1 : hb.has(i) && !hf.has(i) ? 0 : (i - ia) / (ib - ia);
        const f = fw.get(i)!;
        const bb = bw.get(i)!;
        const o2 = new Uint8Array(w * h);
        for (let p = 0; p < o2.length; p++) o2[p] = Math.round(f[p]! * (1 - wb) + bb[p]! * wb);
        final[i] = o2;
      }
      if (!keys[ki]!.absent && !keys[ki + 1]!.absent) log(`between ${keys[ki]!.at} and ${keys[ki + 1]!.at} ms: following reaches the next marked frame with IoU ${drift[drift.length - 2]!.iou.toFixed(3)} (forward), ${drift[drift.length - 1]!.iou.toFixed(3)} (backward)`);
    }
  }

  // The edge engine. (1) Flicker control, at the size the marks were followed at. (2) The matte at the picture's own size, with a
  // band around the boundary decided again from the full-resolution picture, and the object's colour cleaned of the old background.
  const edgeCfg = m.edge ?? {};
  const smoothAmt = edgeCfg.smooth ?? 0.7;
  const refine = edgeCfg.refine !== false;
  const hair = !!edgeCfg.hair;
  const decontaminate = edgeCfg.decontaminate !== false;
  const edgeInfo: NonNullable<MatteData['edge']> = { refined: refine, hair, smoothed: smoothAmt, decontaminated: decontaminate };
  let work: Float32Array[] = final.map((f) => Float32Array.from(f, (v) => v / 255));
  // Specks: pieces of the picture far smaller than the object that were joined to nothing are glitches, not the object. Marked
  // frames are the person's word and stay as they are.
  const specks: number[] = new Array(N).fill(0);
  {
    const marked = new Set(keys.map((k) => k.frame));
    for (let i = 0; i < N; i++) {
      if (marked.has(i)) continue;
      specks[i] = despeckle(work[i]!, w, h);
    }
  }
  if (smoothAmt > 0 && N >= 3) {
    log(`steadying the matte over time (strength ${smoothAmt})`);
    const r = smoothMattes(work, frames, w, h, { cuts, fixed: new Set(keys.map((k) => k.frame)), strength: smoothAmt });
    work = r.alphas;
    edgeInfo.flicker = { before: Math.round(r.before.flicker * 10000) / 10000, after: Math.round(r.after.flicker * 10000) / 10000 };
    edgeInfo.jitter = { before: Math.round(r.before.jitter * 10000) / 10000, after: Math.round(r.after.jitter * 10000) / 10000 };
    log(`flicker ${edgeInfo.flicker.before} -> ${edgeInfo.flicker.after}, jitter ${edgeInfo.jitter.before} -> ${edgeInfo.jitter.after}`);
  }
  const outW = Math.max(w, Math.min(info.w, edgeCfg.width ?? 960));
  const outSize = outW > w ? readSize(info, { width: outW }) : { w, h };
  const ow = outSize.w;
  const oh = outSize.h;
  mkdirSync(dirOf(projectDir), { recursive: true });
  const video = matteVideo(projectDir, key);
  const tmp = `${video}.${process.pid}.partial.mkv`;
  const fgVideo = video.replace(/\.mkv$/, '.fg.mkv');
  const fgTmp = `${fgVideo}.${process.pid}.partial.mkv`;
  const useModel = edgeCfg.model === 'vitmatte';
  const coverage: number[] = [];
  const needPictures = refine || decontaminate || useModel;
  if (needPictures) log(`the edge at ${ow}x${oh}${refine ? ' (band decided again from the picture)' : ''}${useModel ? ', opacity in the band from the hair matting model' : ''}${decontaminate ? ', object colour cleaned of the old background' : ''}`);
  const readPictures = () => readFrames({ file: src, startMs: m.from, durMs: Math.ceil(total * step) + 1, fps, size: { w: ow, h: oh }, channels: 3 });
  const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < N; i++) {
    let cov = 0;
    for (let p = 0; p < work[i]!.length; p++) cov += work[i]![p]!;
    coverage.push(Math.round((cov / (w * h)) * 10000) / 10000);
  }
  // Pass 1: the matte at the picture's size, one frame at a time (the hair model, if asked for, decides the opacity in the band).
  const big: Uint8Array[] = [];
  let vit: VitMatteServer | undefined;
  let vitMs = 0;
  if (useModel) {
    vit = await VitMatteServer.start().catch((e: Error) => {
      throw new EngineError('ENGINE_MISSING', `matte ${id}: the hair matting model cannot run: ${e.message}`, 'studio models fetch vitmatte-small; or drop --edge-model');
    });
  }
  try {
    let idx = 0;
    const one = async (pic: Uint8Array | null) => {
      const a = work[idx]!;
      let b: Float32Array = pic && refine ? refineEdge(pic, ow, oh, a, w, h, { hair }) : resizePlane(a, w, h, ow, oh);
      if (vit && pic) {
        // the trimap: sure inside, sure outside, and an unknown band around the boundary (wider with --hair)
        const bin = new Uint8Array(ow * oh);
        for (let p = 0; p < bin.length; p++) bin[p] = b[p]! > 0.5 ? 1 : 0;
        const r = Math.max(3, Math.round((hair ? 0.03 : 0.015) * ow));
        const grown = morph(bin, ow, oh, r, true);
        const shrunk = morph(bin, ow, oh, r, false);
        const tri = new Uint8Array(ow * oh);
        for (let p = 0; p < tri.length; p++) tri[p] = shrunk[p] ? 255 : !grown[p] ? 0 : 128;
        const got = await vit.matte(pic, tri, ow, oh);
        vitMs += got.ms;
        b = got.alpha;
      }
      big.push(Uint8Array.from(b, toByte));
      idx++;
    };
    if (needPictures) {
      for await (const b of readPictures()) {
        if (idx >= N) break;
        await one(new Uint8Array(b));
      }
    }
    while (idx < N) await one(null);
  } finally {
    await vit?.close();
  }
  if (useModel) {
    edgeInfo.model = 'vitmatte';
    log(`hair matting model: ${Math.round(vitMs / Math.max(1, N))} ms a frame`);
    if (smoothAmt > 0 && N >= 3) {
      // the model's opacity differs a little from frame to frame: steadied again at the finished size, along the same motion
      const flows = flowsOf(frames, w, h, new Set(cuts));
      const steady = smoothMattesBytes(big, ow, oh, flows, { fixed: new Set(keys.map((k) => k.frame)), strength: smoothAmt });
      for (let i = 0; i < N; i++) big[i] = steady[i]!;
    }
  }
  // Pass 2: write the matte, and the object's colour with the old background taken out of the edge pixels.
  const wr = new VideoWriter(tmp, { w: ow, h: oh, fps });
  const wf = decontaminate ? new VideoWriter(fgTmp, { w: ow, h: oh, fps, channels: 3, codec: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgr0'] }) : null;
  for (let i = 0; i < N; i++) await wr.write(big[i]!);
  await wr.close();
  if (wf) {
    let j = 0;
    for await (const b of readPictures()) {
      if (j >= N) break;
      await wf.write(estimateForeground(new Uint8Array(b), Float32Array.from(big[j]!, (v) => v / 255), ow, oh, 1));
      j++;
    }
    while (j++ < N) await wf.write(new Uint8Array(ow * oh * 3));
    await wf.close();
  }
  renameSync(tmp, video);
  if (wf) renameSync(fgTmp, fgVideo);
  for (let i = 0; i < N; i++) final[i] = Uint8Array.from(work[i]!, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  const peak = Math.max(...coverage, 1e-9);
  const flagged: MatteData['flagged'] = [...shotNotes];
  {
    // runs of frames where the object was not found: said once, at the start of each run
    const hs = [...hidden].sort((x, y) => x - y);
    for (let k = 0; k < hs.length && flagged.length < 14; ) {
      let e = k;
      while (e + 1 < hs.length && hs[e + 1] === hs[e]! + 1) e++;
      flagged.push({ frame: hs[k]!, ms: Math.round(m.from + hs[k]! * step), why: `from here for ${e - k + 1} frame(s) the followed matte did not look like the marked object (hidden, out of the picture, or lost), so nothing is shown; mark it again where it is back (studio mask key)` });
      k = e + 1;
    }
  }
  const ms = (i: number) => Math.round(m.from + i * step);
  for (let i = 1; i < N && flagged.length < 14; i++) {
    const jump = Math.abs(coverage[i]! - coverage[i - 1]!) / peak;
    if (jump > 0.3) flagged.push({ frame: i, ms: ms(i), why: `the matte's area changed by ${Math.round(jump * 100)}% of its peak in one frame` });
    else if (coverage[i]! < 0.0005 && coverage[i - 1]! >= 0.0005) flagged.push({ frame: i, ms: ms(i), why: 'the matte became empty' });
    else if (unc[i]! > 0.4) flagged.push({ frame: i, ms: ms(i), why: `the boundary stayed undecided (${Math.round(unc[i]! * 100)}% of the re-decided band is neither inside nor outside)` });
  }
  // how clean each frame is, and the frames where the matte was carried by motion alone
  const qFrames: MatteQuality['frames'] = [];
  const keyFrames = new Set(keys.map((k) => k.frame));
  for (let i = 0; i < N; i++) {
    const bin = Uint8Array.from(work[i]!, (v) => (v > 0.5 ? 1 : 0));
    const cc = components(bin, w, h);
    const big = cc.sizes.slice(1).sort((x, y) => y - x);
    const islands = big.slice(1).filter((x) => x >= 0.003 * w * h).length;
    const area = coverage[i]!;
    qFrames.push({ how: keyFrames.has(i) ? 'key' : (how[i] ?? 'colour'), keptOut: keptOut[i]!, specks: specks[i]!, islands, areaChangePct: i ? Math.round((100 * Math.abs(area - coverage[i - 1]!)) / peak) : 0 });
  }
  const followed = qFrames.filter((q) => q.how !== 'key');
  const quality: MatteQuality = {
    frames: qFrames,
    summary: {
      consensusPct: followed.length ? Math.round((100 * followed.filter((q) => q.how === 'consensus').length) / followed.length) : 100,
      fallbackFrames: followed.filter((q) => q.how === 'best' || q.how === 'prediction').length,
      framesWithNeighboursKeptOut: qFrames.filter((q) => q.keptOut > 0).length,
      specksRemoved: qFrames.reduce((s2, q) => s2 + q.specks, 0),
      framesWithIslands: qFrames.filter((q) => q.islands > 0).length,
      worstAreaChangePct: Math.max(0, ...qFrames.map((q) => q.areaChangePct)),
    },
  };
  {
    // runs of frames carried by motion alone: the segmenter's masks did not fit, so nothing corrected the matte there
    const fb = qFrames.map((q, i) => (q.how === 'best' || q.how === 'prediction' ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < fb.length && flagged.length < 18; ) {
      let e = k;
      while (e + 1 < fb.length && fb[e + 1] === fb[e]! + 1) e++;
      flagged.push({ frame: fb[k]!, ms: ms(fb[k]!), why: `for ${e - k + 1} frame(s) from here none of the segmenter's masks fitted where the object's motion put it, so the matte was carried by motion alone and may drift; look, and mark the object again (studio mask key)` });
      k = e + 1;
    }
  }
  const data: MatteData = {
    v: MATTE_VERSION,
    id,
    key,
    asset: m.asset,
    file: join('.studio', 'cache', 'matte', `${key}.mkv`),
    quality,
    ...(decontaminate ? { fgFile: join('.studio', 'cache', 'matte', `${key}.fg.mkv`) } : {}),
    analysis: { w, h },
    edge: edgeInfo,
    fps,
    w: ow,
    h: oh,
    fromMs: m.from,
    frames: N,
    keys: keys.map((k) => ({ at: k.at, frame: k.frame })),
    cuts: cuts.map((c) => Math.round(m.from + c * step)),
    coverage,
    uncertain: unc.map((v) => Math.round(v * 1000) / 1000),
    flagged,
    drift: drift.map((d) => ({ ...d, iou: Math.round(d.iou * 1000) / 1000 })),
    stats: { ms: Date.now() - t0, keys: keys.length, prior: priors, engine: sam ? 'sam2.1-tiny' : prior.size && modelKey.some(Boolean) ? model! : 'colour', ...(engineNote ? { engineNote } : {}) },
  };
  const metaTmp = `${matteMeta(projectDir, key)}.${process.pid}.tmp`;
  writeFileSync(metaTmp, JSON.stringify(data));
  renameSync(metaTmp, matteMeta(projectDir, key));
  return { data, cached: false };
}

/** Removes the pieces of a matte that are far smaller than its main piece (in place); returns how many pixels went. */
function despeckle(a: Float32Array, w: number, h: number): number {
  const bin = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) bin[i] = a[i]! > 0.5 ? 1 : 0;
  const c = components(bin, w, h);
  if (c.sizes.length <= 2) return 0;
  const biggest = Math.max(...c.sizes.slice(1));
  const keep = Math.max(12, 0.015 * biggest);
  let gone = 0;
  for (let i = 0; i < a.length; i++)
    if (c.id[i] && c.sizes[c.id[i]!]! < keep) {
      a[i] = 0;
      gone++;
    } else if (!c.id[i] && a[i]! > 0 && a[i]! <= 0.5) {
      // the soft fringe of a removed piece goes with it: it has no component of its own, so it is cleared where nothing is next to it
      continue;
    }
  return gone;
}

function mergeQuality(members: MatteData[]): MatteQuality {
  const qs = members.map((d) => d.quality).filter((q): q is MatteQuality => !!q);
  const n = Math.max(...qs.map((q) => q.frames.length));
  const frames: MatteQuality['frames'] = Array.from({ length: n }, (_, i) => {
    const at = qs.map((q) => q.frames[i]).filter((f): f is MatteQuality['frames'][number] => !!f);
    return { how: 'union' as const, keptOut: at.reduce((s, f) => s + f.keptOut, 0), specks: at.reduce((s, f) => s + f.specks, 0), islands: at.reduce((s, f) => s + f.islands, 0), areaChangePct: Math.max(...at.map((f) => f.areaChangePct)) };
  });
  return {
    frames,
    summary: {
      consensusPct: Math.round(qs.reduce((s, q) => s + q.summary.consensusPct, 0) / qs.length),
      fallbackFrames: qs.reduce((s, q) => s + q.summary.fallbackFrames, 0),
      framesWithNeighboursKeptOut: Math.max(...qs.map((q) => q.summary.framesWithNeighboursKeptOut)),
      specksRemoved: qs.reduce((s, q) => s + q.summary.specksRemoved, 0),
      framesWithIslands: Math.max(...qs.map((q) => q.summary.framesWithIslands)),
      worstAreaChangePct: Math.max(...qs.map((q) => q.summary.worstAreaChangePct)),
    },
  };
}

/**
 * A union of mattes: several things kept, each followed on its own (one matte per thing), put together at the finished size: the
 * opacity of the union is the highest of its members' at each pixel, and the object's colour is the one of the member that is
 * most opaque there.
 */
async function buildUnion(o: MatteBuildOptions): Promise<{ data: MatteData; cached: boolean }> {
  const { projectDir, project, id } = o;
  const log = o.log ?? (() => undefined);
  const m = project.mattes![id]!;
  const key = matteKey(project, id);
  if (!o.force) {
    const have = loadMatte(projectDir, project, id);
    if (have) return { data: have, cached: true };
  }
  const t0 = Date.now();
  const members: MatteData[] = [];
  for (const u of m.union!) {
    const mm = project.mattes?.[u];
    if (!mm) throw new EngineError('INVALID_INPUT', `matte ${id}: its member ${u} does not exist`, 'studio matte list');
    if (mm.asset !== m.asset) throw new EngineError('INVALID_INPUT', `matte ${id}: member ${u} was made on ${mm.asset}, not ${m.asset}`);
    log(`union ${id}: member ${u}`);
    members.push((await buildMatte({ ...o, id: u, force: o.force && false })).data);
  }
  const first = members[0]!;
  for (const d of members) if (d.w !== first.w || d.h !== first.h || d.frames !== first.frames || d.fps !== first.fps || d.fromMs !== first.fromMs) throw new EngineError('INVALID_INPUT', `matte ${id}: its members must cover the same range at the same size and rate (${d.id} differs from ${first.id})`, 'make them with the same --from/--to/--fps/--width (studio bg remove does)');
  const { w, h, fps, frames: N } = first;
  const withFg = members.every((d) => d.fgFile);
  mkdirSync(dirOf(projectDir), { recursive: true });
  const video = matteVideo(projectDir, key);
  const tmp = `${video}.${process.pid}.partial.mkv`;
  const fgVideo = video.replace(/\.mkv$/, '.fg.mkv');
  const fgTmp = `${fgVideo}.${process.pid}.partial.mkv`;
  const readers = members.map((d) => readFrames({ file: join(projectDir, d.file), size: { w, h }, channels: 1 })[Symbol.asyncIterator]());
  const fgReaders = withFg ? members.map((d) => readFrames({ file: join(projectDir, d.fgFile!), size: { w, h }, channels: 3 })[Symbol.asyncIterator]()) : [];
  const wr = new VideoWriter(tmp, { w, h, fps });
  const wf = withFg ? new VideoWriter(fgTmp, { w, h, fps, channels: 3, codec: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgr0'] }) : null;
  const coverage: number[] = [];
  for (let i = 0; i < N; i++) {
    const as: Uint8Array[] = [];
    for (const r of readers) as.push(new Uint8Array((await r.next()).value ?? new Uint8Array(w * h)));
    const out = new Uint8Array(w * h);
    const who = new Uint8Array(w * h);
    let sum = 0;
    for (let p = 0; p < w * h; p++) {
      let best = 0;
      for (let k = 0; k < as.length; k++) if (as[k]![p]! > as[best]![p]!) best = k;
      out[p] = as[best]![p]!;
      who[p] = best;
      sum += out[p]!;
    }
    coverage.push(Math.round((sum / 255 / (w * h)) * 10000) / 10000);
    await wr.write(out);
    if (wf) {
      const fgs: Uint8Array[] = [];
      for (const r of fgReaders) fgs.push(new Uint8Array((await r.next()).value ?? new Uint8Array(w * h * 3)));
      const o3 = new Uint8Array(w * h * 3);
      for (let p = 0; p < w * h; p++) {
        const f = fgs[who[p]!]!;
        o3[3 * p] = f[3 * p]!;
        o3[3 * p + 1] = f[3 * p + 1]!;
        o3[3 * p + 2] = f[3 * p + 2]!;
      }
      await wf.write(o3);
    }
  }
  await wr.close();
  if (wf) await wf.close();
  renameSync(tmp, video);
  if (wf) renameSync(fgTmp, fgVideo);
  const flagged: MatteData['flagged'] = [];
  for (const d of members) for (const f of d.flagged) if (flagged.length < 20) flagged.push({ ...f, why: `${d.id}: ${f.why}` });
  const data: MatteData = {
    v: MATTE_VERSION,
    id,
    key,
    asset: m.asset,
    file: join('.studio', 'cache', 'matte', `${key}.mkv`),
    ...(withFg ? { fgFile: join('.studio', 'cache', 'matte', `${key}.fg.mkv`) } : {}),
    ...(first.analysis ? { analysis: first.analysis } : {}),
    ...(first.edge ? { edge: first.edge } : {}),
    fps,
    w,
    h,
    fromMs: first.fromMs,
    frames: N,
    keys: [],
    ...(first.cuts ? { cuts: first.cuts } : {}),
    coverage,
    uncertain: first.uncertain.map((_, i) => Math.max(...members.map((d) => d.uncertain[i] ?? 0))),
    flagged,
    drift: members.flatMap((d) => d.drift),
    stats: { ms: Date.now() - t0, keys: members.reduce((s2, d) => s2 + d.stats.keys, 0), prior: [], engine: first.stats.engine, members: members.map((d) => d.id) },
    ...(members.some((d) => d.quality) ? { quality: mergeQuality(members) } : {}),
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
    for (const f of c.fx ?? []) if ((f.type === 'cutout' || f.type === 'erase' || f.type === 'plugin' || f.type === 'lut') && f.matte && !f.bypass) ids.add(f.matte.id);
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
  // tiles are at most 480 px wide, whatever size the matte is
  const tw = Math.min(data.w, 480);
  const w = tw;
  const h = Math.round((data.h * tw) / data.w);
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


/**
 * The Object Mask Tool, one frame: what the segmenter makes of these prompts, as its three candidates side by side, so the
 * right one can be chosen (`--pick`) or the prompts corrected before anything is built. Nothing is stored in the project.
 */
export async function maskCandidates(o: { projectDir: string; project: Project; asset: string; at: number; seeds: Seeds; width?: number; out: string; log?: (m: string) => void }): Promise<{ file: string; candidates: { index: number; predictedQuality: number; areaPct: number; keepsPointsInside: boolean; keepsPointsOutside: boolean }[]; auto: number; prompts: ReturnType<typeof promptsFromSeeds>; ms: { encode: number; decode: number } }> {
  const a = o.project.assets[o.asset]!;
  const src = join(o.projectDir, a.workingCopy?.path ?? a.path);
  const info = probeVideo(src);
  const size = readSize(info, { width: Math.min(o.width ?? 480, info.w) });
  const { w, h } = size;
  const frame = await grabFrame(src, o.at, info.fps || 30, { w, h });
  if (!frame) throw new EngineError('INVALID_INPUT', `no frame at ${o.at} ms of ${o.asset}`);
  const rgb = new Uint8Array(frame);
  const pr = promptsFromSeeds(w, h, o.seeds);
  if (!pr.points.length && !pr.box) throw new EngineError('INVALID_INPUT', 'give a point on the object (--point), a box or an outline', 'studio mask pick --asset a_x --at MS --point x,y');
  const tag = createHash('sha256').update(JSON.stringify([a.hash, o.at, w, h])).digest('hex').slice(0, 16);
  const sam = await SamServer.start(join(dirOf(o.projectDir), 'sam-pick'));
  try {
    const encode = await sam.embed(`p${tag}`, rgb, w, h);
    const tiles: Uint8Array[] = [rgb.slice()];
    const cands: { index: number; predictedQuality: number; areaPct: number; keepsPointsInside: boolean; keepsPointsOutside: boolean }[] = [];
    let auto = 0;
    let decode = 0;
    for (let k = 0; k < 3; k++) {
      const got = await sam.decode(`p${tag}`, w, h, { ...pr, index: k });
      if (k === 0) auto = (await sam.decode(`p${tag}`, w, h, { ...pr })).picked;
      decode += got.ms;
      const over = rgb.slice();
      let cnt = 0;
      for (let p = 0; p < w * h; p++) {
        const m = got.prob[p]! > 0.5 ? 1 : 0;
        cnt += m;
        for (let c = 0; c < 3; c++) over[3 * p + c] = Math.round(rgb[3 * p + c]! * (1 - 0.55 * m) + [255, 0, 200][c]! * 0.55 * m);
      }
      pr.points.forEach(([x, y], i) => {
        const col: [number, number, number] = pr.labels[i] === 1 ? [0, 255, 70] : [255, 50, 50];
        drawLine(over, w, h, [x - 3, y], [x + 3, y], col, 5);
      });
      if (pr.box) drawPoly(over, w, h, [[pr.box[0], pr.box[1]], [pr.box[2], pr.box[1]], [pr.box[2], pr.box[3]], [pr.box[0], pr.box[3]]], [255, 255, 255], 1);
      tiles.push(over);
      const at = (x: number, y: number) => got.prob[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))]! > 0.5;
      cands.push({
        index: k,
        predictedQuality: got.iou[k] ?? 0,
        areaPct: Math.round((cnt / (w * h)) * 1000) / 10,
        keepsPointsInside: pr.points.every(([x, y], i) => pr.labels[i] !== 1 || at(x, y)),
        keepsPointsOutside: pr.points.every(([x, y], i) => pr.labels[i] !== 0 || !at(x, y)),
      });
    }
    const sheet = tileRgb(tiles, w, h, 2);
    mkdirSync(join(o.out, '..'), { recursive: true });
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheet.w}x${sheet.h}`, '-i', '-', '-frames:v', '1', o.out], { stdio: ['pipe', 'ignore', 'pipe'] });
      p.stdin.on('error', () => undefined);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new EngineError('ENGINE_FAILED', 'ffmpeg could not write the sheet'))));
      p.stdin.end(Buffer.from(sheet.data));
    });
    return { file: o.out, candidates: cands, auto, prompts: pr, ms: { encode, decode } };
  } finally {
    await sam.close();
  }
}

/** Copies the matte video out of the cache (gray, lossless). */
export function exportMatte(projectDir: string, data: MatteData, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(join(projectDir, data.file), to);
}
export type { Matte };
