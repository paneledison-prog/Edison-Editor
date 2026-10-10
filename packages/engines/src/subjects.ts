/**
 * Subjects: what is in a shot, found automatically, so that the agent can say what to keep and what to take out by number.
 *
 * At a few moments of the shot the segmenter is asked about a grid of points; its masks are cleaned into a list of things (a
 * person, a table, a bottle) and parts of things. Each comes with what the agent needs to decide: where, how big, what colour,
 * how salient to a saliency model, whether it moves against the background and how fast, whether it touches the frame's edge.
 * A sheet shows them numbered. A subject also stores the prompt that found it, so that the same mask is asked for again when the
 * subject is kept (`studio bg remove`); nothing here is stored in the project.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@studio/core';
import { colourName, denseFlow, detectCuts, readFrames, drawMaskOutline, drawText, grayOf, maskToRle, movingBlobs, probeVideo, proposalPrompts, rankSubjects, readSize, SUBJECT_COLOURS, tileRgb, type Candidate } from '@studio/vision';
import { removeBackground } from './bgremove.js';
import { grabFrame } from './grab.js';
import { SamServer } from './sam.js';
import { EngineError } from './run.js';

export interface Subject {
  /** `s3`: what to give `studio bg remove --keep 3` */
  id: string;
  n: number;
  /** the moment (ms of the asset) this subject was found at */
  at: number;
  /** a thing in its own right, or a part of another (`partOf`): a person, or that person's face */
  top: boolean;
  partOf?: string;
  areaPct: number;
  /** x, y, w, h as fractions of the frame */
  bbox: [number, number, number, number];
  /** a point inside the subject (fractions of the frame) */
  point: [number, number];
  /** what the segmenter thinks of its own mask (0..1) */
  quality: number;
  /** how much a saliency model thinks it is the picture's subject (0..1) */
  salience: number;
  /** how fast it moves against the background, as % of the frame's width per second (0 = still against it) */
  speedPctPerSec: number;
  moving: boolean;
  colour: string;
  shape: 'tall' | 'wide' | 'compact';
  touches: string[];
  /** how to ask the segmenter for this mask again: its box and points spread over it (fractions of the frame) */
  prompt: { points: [number, number][]; box: [number, number, number, number] };
  /** its exact mask at the size the subjects were found at (run-length coded): what `studio bg remove` marks the frame with */
  mask: { w: number; h: number; rle: number[] };
}

export interface SubjectsRun {
  run: string;
  asset: string;
  /** the size the subjects were found at */
  width: number;
  height: number;
  times: number[];
  /** where the shot changes (ms of the asset): a thing must be chosen in every shot it should be kept in */
  cuts: number[];
  subjects: Subject[];
  /** the numbered picture(s) and the one with each subject cut out */
  sheet: string;
  each?: string;
  ms: number;
}

const dirOf = (projectDir: string) => join(projectDir, '.studio', 'cache', 'subjects');
export const subjectsFile = (projectDir: string, run: string) => join(dirOf(projectDir), `${run}.json`);

export function loadSubjects(projectDir: string, run: string): SubjectsRun {
  const f = subjectsFile(projectDir, run);
  if (!existsSync(f)) throw new EngineError('INVALID_INPUT', `no subjects run ${run}`, 'studio bg subjects --asset a_xx   (lists them, numbered)');
  return JSON.parse(readFileSync(f, 'utf8')) as SubjectsRun;
}

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

async function writePng(rgb: Uint8Array, w: number, h: number, out: string): Promise<void> {
  const sharp = (await import('sharp')).default;
  mkdirSync(join(out, '..'), { recursive: true });
  await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toFile(out);
}

/** A saliency model's mask for one frame (0..1), or null when the model cannot run: the analysis then goes on without it. */
async function salienceOf(rgb: Uint8Array, w: number, h: number): Promise<Float32Array | null> {
  const sharp = (await import('sharp')).default;
  const tmp = mkdtempSync(join(tmpdir(), 'studio-sal-'));
  try {
    const png = join(tmp, 'f.png');
    await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toFile(png);
    const out = join(tmp, 'c.png');
    await removeBackground(png, out, { model: 'u2net', preview: false });
    const raw = await sharp(out).ensureAlpha().raw().toBuffer();
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = raw[4 * i + 3]! / 255;
    return a;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface SubjectsOptions {
  projectDir: string;
  project: Project;
  asset: string;
  /** moments to look at (ms of the asset); default: three spread over the shot */
  at?: number[];
  from?: number;
  to?: number;
  width?: number;
  /** how many things and parts to list at most (per moment) */
  maxThings?: number;
  maxParts?: number;
  log?: (m: string) => void;
}

export async function findSubjects(o: SubjectsOptions): Promise<SubjectsRun> {
  const t0 = Date.now();
  const log = o.log ?? (() => undefined);
  const a = o.project.assets[o.asset];
  if (!a || a.kind !== 'video') throw new EngineError('INVALID_INPUT', `${o.asset} is not a video asset`, 'studio project show lists assets');
  const src = join(o.projectDir, a.workingCopy?.path ?? a.path);
  const info = probeVideo(src);
  const size = readSize(info, { width: Math.min(o.width ?? 480, info.w) });
  const { w, h } = size;
  const dur = a.probe.durMs ?? Math.round(info.durMs ?? 0);
  const from = Math.max(0, o.from ?? 0);
  const to = Math.min(dur || Infinity, o.to ?? dur);
  // where to look: given, or one moment in each shot (a cut changes everything), or the start, middle and end of a single shot
  let shots: number[] = [];
  if (!o.at?.length && to > from + 400) {
    const lf: Uint8Array[] = [];
    const sw = 160;
    const sh = Math.max(2, Math.round((sw * h) / w / 2) * 2);
    const lfps = 10;
    for await (const b of readFrames({ file: src, startMs: from, durMs: to - from, fps: lfps, size: { w: sw, h: sh }, channels: 3 })) lf.push(new Uint8Array(b));
    shots = lf.length > 2 ? detectCuts(lf, sw, sh).map((c) => Math.round(from + (c * 1000) / lfps)) : [];
  }
  const shotStarts = [from, ...shots];
  const times = (
    o.at?.length
      ? o.at
      : shots.length
        ? shotStarts.slice(0, 6).map((s0, k) => Math.round((s0 + (shotStarts[k + 1] ?? to)) / 2))
        : to > from + 400
          ? [from, Math.round((from + to) / 2), Math.max(from, to - 150)]
          : [from]
  ).map((t) => Math.round(t));
  const run = 'sub_' + createHash('sha256').update(JSON.stringify([a.hash, times, w, o.maxThings ?? 12, o.maxParts ?? 6])).digest('hex').slice(0, 4);
  const sam = await SamServer.start(join(o.projectDir, '.studio', 'cache', 'matte', 'sam-subjects'));
  const subjects: Subject[] = [];
  const tiles: Uint8Array[] = [];
  const eachTiles: Uint8Array[] = [];
  const fps = info.fps || 30;
  const dtMs = Math.max(100, Math.round((4 * 1000) / fps));
  try {
    for (const [ti, t] of times.entries()) {
      const fr = await grabFrame(src, t, fps, { w, h });
      if (!fr) throw new EngineError('INVALID_INPUT', `no frame at ${t} ms of ${o.asset}`);
      const rgb = new Uint8Array(fr);
      const id = `u${createHash('sha256').update(JSON.stringify([a.hash, t, w, h])).digest('hex').slice(0, 14)}`;
      log(`looking at ${t} ms`);
      await sam.embed(id, rgb, w, h);
      // a grid of questions "what is here?", one point each
      const GX = 9;
      const GY = 6;
      const prompts: { points?: [number, number][]; labels?: number[]; box?: [number, number, number, number] }[] = [];
      for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) prompts.push({ points: [[((gx + 0.5) / GX) * w, ((gy + 0.5) / GY) * h]], labels: [1] });
      // what moves against the background is asked about too, however small (a person far away): a point and a box for each mover
      let moverFrom = prompts.length;
      let flowEarly: { u: Float32Array; v: Float32Array } | null = null;
      const nxt = await grabFrame(src, t + dtMs, fps, { w, h });
      if (nxt) {
        flowEarly = denseFlow(grayOf(rgb, w, h), grayOf(new Uint8Array(nxt), w, h), { levels: 4, iters: 3, radius: 5 });
        const blobs = movingBlobs(flowEarly, w, h);
        log(`${t} ms: ${blobs.length} moving blob(s)${blobs.length ? ': ' + blobs.map((b) => `${Math.round(b.size)} px at ${Math.round((100 * b.point[0]) / w)}%,${Math.round((100 * b.point[1]) / h)}%`).join('; ') : ''}`);
        for (const b of blobs) {
          prompts.push({ points: [b.point], labels: [1], box: [Math.max(0, b.box[0] - 3), Math.max(0, b.box[1] - 3), Math.min(w - 1, b.box[2] + 3), Math.min(h - 1, b.box[3] + 3)] });
        }
      } else moverFrom = prompts.length;
      const props = await sam.proposals(id, w, h, prompts);
      const cands: (Candidate & { index: number })[] = props.map((p) => {
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < mask.length; i++) mask[i] = p.prob[i]! > 0.5 ? 1 : 0;
        return { mask, quality: p.iou, prompt: p.prompt, candidate: p.candidate, index: p.candidate, ...(p.prompt >= moverFrom ? { small: true } : {}) };
      });
      const ranked = rankSubjects(cands, w, h);
      // saliency, and the motion of everything against the background's own (the median of the whole frame: it is mostly background)
      const sal = await salienceOf(rgb, w, h);
      const flow = flowEarly;
      const bgFlow: [number, number] = flow ? [median(Array.from(flow.u).filter((_, i) => i % 7 === 0)), median(Array.from(flow.v).filter((_, i) => i % 7 === 0))] : [0, 0];
      const facts = (r: (typeof ranked)[number]) => {
        const pt = innerPoint(r.mask, w, h);
        let cnt = 0;
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        let rr = 0, gg = 0, bb = 0, sIn = 0, taken = 0;
        const fu: number[] = [];
        const fv: number[] = [];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (!r.mask[p]) continue;
            cnt++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            if ((x + y) % 3 === 0) {
              taken++;
              rr += rgb[3 * p]!; gg += rgb[3 * p + 1]!; bb += rgb[3 * p + 2]!;
              if (flow) (fu.push(flow.u[p]!), fv.push(flow.v[p]!));
              if (sal) sIn += sal[p]!;
            }
          }
        const nS = Math.max(1, taken);
        const bw = (x1 - x0 + 1) / w;
        const bh = (y1 - y0 + 1) / h;
        const speed = flow ? (Math.hypot(median(fu) - bgFlow[0], median(fv) - bgFlow[1]) / (dtMs / 1000) / w) * 100 : 0;
        const touches: string[] = [];
        if (x0 <= 1) touches.push('left');
        if (x1 >= w - 2) touches.push('right');
        if (y0 <= 1) touches.push('top');
        if (y1 >= h - 2) touches.push('bottom');
        const salience = sal ? sIn / nS : 0;
        return {
          area: cnt, pt, x0, y0, bw, bh, speed, touches, salience,
          colour: colourName(rr / nS, gg / nS, bb / nS),
          moving: speed >= 6,
          interest: (speed >= 6 ? 0.5 : 0) + 0.35 * salience + 0.15 * Math.sqrt(cnt / (w * h)),
        };
      };
      const tops = ranked.map((r, i) => ({ r, i, f: facts(r) })).filter(({ r }) => r.parent < 0).slice(0, 40);
      // what is worth listing: what moves, what a saliency model likes, what is big; the rest is "everything else"
      const things = tops.slice().sort((x, y) => y.f.interest - x.f.interest).slice(0, o.maxThings ?? 12);
      const keepIdx = new Set(things.map((x) => x.i));
      const parts = ranked.map((r, i) => ({ r, i })).filter(({ r, i }) => r.parent >= 0 && keepIdx.has(r.parent) && i >= 0).slice(0, o.maxParts ?? 6).map(({ r, i }) => ({ r, i, f: facts(r) }));
      const listed = [...things, ...parts];
      // numbered left to right: things first, then their parts
      const order = listed.slice().sort((x, y) => (x.r.parent < 0 ? 0 : 1) - (y.r.parent < 0 ? 0 : 1) || centroidX(x.r.mask, w, h) - centroidX(y.r.mask, w, h));
      const idOf = new Map<number, string>();
      for (const { i } of order) idOf.set(i, `s${subjects.length + idOf.size + 1}`);
      const tint = rgb.slice();
      const colourOf = new Map<number, number>();
      let ci = 0;
      for (const { r, i, f } of order) {
        const top = r.parent < 0;
        const s: Subject = {
          id: idOf.get(i)!,
          n: subjects.length + 1,
          at: t,
          top,
          ...(top ? {} : { partOf: idOf.get(r.parent) ?? '' }),
          areaPct: Math.round((1000 * f.area) / (w * h)) / 10,
          bbox: [round3(f.x0 / w), round3(f.y0 / h), round3(f.bw), round3(f.bh)],
          point: [round3(f.pt[0] / w), round3(f.pt[1] / h)],
          quality: Math.round(r.quality * 100) / 100,
          salience: Math.round(f.salience * 100) / 100,
          speedPctPerSec: Math.round(f.speed * 10) / 10,
          moving: f.moving,
          colour: f.colour,
          shape: f.bh > 1.3 * f.bw ? 'tall' : f.bw > 1.3 * f.bh ? 'wide' : 'compact',
          touches: f.touches,
          prompt: { points: [[round3(f.pt[0] / w), round3(f.pt[1] / h)]], box: [round3(f.x0 / w), round3(f.y0 / h), round3(f.bw), round3(f.bh)] },
          mask: maskToRle(r.mask, w, h),
        };
        subjects.push(s);
        // points spread over the whole of it (not the grid point that found it): they and its box describe it
        const spread = proposalPrompts(Float32Array.from(r.mask), w, h, 6).filter((q) => q.points?.length === 1).map((q) => [round3(q.points![0]![0] / w), round3(q.points![0]![1] / h)] as [number, number]);
        if (spread.length) s.prompt.points = spread;
        const col = SUBJECT_COLOURS[(top ? ci++ : (colourOf.get(r.parent) ?? 0)) % SUBJECT_COLOURS.length]!;
        if (top) colourOf.set(i, ci - 1);
        if (top) for (let p = 0; p < w * h; p++) if (r.mask[p]) for (let c = 0; c < 3; c++) tint[3 * p + c] = Math.round(rgb[3 * p + c]! * 0.62 + col[c]! * 0.38);
      }
      // outlines (of things; parts only get their number) and numbers on top of all tints, each number where it covers no other
      ci = 0;
      const placed: [number, number, number, number][] = [];
      for (const { r, i } of order) {
        const top = r.parent < 0;
        const col = SUBJECT_COLOURS[(top ? ci++ : (colourOf.get(r.parent) ?? 0)) % SUBJECT_COLOURS.length]!;
        if (top) drawMaskOutline(tint, w, h, r.mask, col);
        const s = subjects.find((q) => q.id === idOf.get(i))!;
        const scale = top ? 3 : 2;
        const tw = s.id.length * 4 * scale;
        const th = 5 * scale;
        const spots = [s.point, ...s.prompt.points].map((q) => [Math.max(2, Math.min(w - tw - 2, Math.round(q[0] * w - tw / 2))), Math.max(2, Math.min(h - th - 2, Math.round(q[1] * h - th / 2)))] as [number, number]);
        const free = (x: number, y: number) => placed.every(([a, b, c, d]) => x + tw + 2 < a || x > a + c + 2 || y + th + 2 < b || y > b + d + 2);
        let at2 = spots.find(([x, y]) => free(x, y));
        if (!at2) {
          // nowhere free on the thing: step down from its point until free
          const [x, y0] = spots[0]!;
          let y = y0;
          while (y < h - th - 2 && !free(x, y)) y += th + 2;
          at2 = [x, Math.min(y, h - th - 2)];
        }
        placed.push([at2[0], at2[1], tw, th]);
        drawText(tint, w, h, at2[0], at2[1], s.id, top ? [255, 255, 255] : [255, 255, 0], scale);
      }
      drawText(tint, w, h, 4, 4, `${t}`, [255, 255, 255], 2);
      tiles.push(tint);
      // each top-level subject cut out on a checkerboard
      for (const { r, i } of order.filter(({ r: q }) => q.parent < 0).slice(0, 12)) {
        const cut = new Uint8Array(w * h * 3);
        for (let p = 0; p < w * h; p++) {
          const chk = ((p % w >> 3) + (Math.floor(p / w) >> 3)) & 1 ? 170 : 110;
          for (let c = 0; c < 3; c++) cut[3 * p + c] = r.mask[p] ? rgb[3 * p + c]! : chk;
        }
        const s = subjects.find((q) => q.id === idOf.get(i))!;
        drawText(cut, w, h, 4, 4, s.id, [255, 255, 255], 4);
        eachTiles.push(cut);
      }
      void ti;
    }
  } finally {
    await sam.close();
  }
  mkdirSync(dirOf(o.projectDir), { recursive: true });
  const sheetFile = join('renders', `subjects-${run}.png`);
  const sheet = tileRgb(tiles, w, h, Math.min(2, tiles.length));
  await writePng(sheet.data, sheet.w, sheet.h, join(o.projectDir, sheetFile));
  let eachFile: string | undefined;
  if (eachTiles.length) {
    // smaller tiles: up to 12 on one sheet
    const sharp = (await import('sharp')).default;
    const tw = Math.round(w / 2);
    const th = Math.round(h / 2);
    const small: Uint8Array[] = [];
    for (const t of eachTiles) small.push(new Uint8Array(await sharp(Buffer.from(t), { raw: { width: w, height: h, channels: 3 } }).resize(tw, th).raw().toBuffer()));
    const es = tileRgb(small, tw, th, 4);
    eachFile = join('renders', `subjects-${run}-each.png`);
    await writePng(es.data, es.w, es.h, join(o.projectDir, eachFile));
  }
  const out: SubjectsRun = { run, asset: o.asset, width: w, height: h, times, cuts: shots, subjects, sheet: sheetFile, ...(eachFile ? { each: eachFile } : {}), ms: Date.now() - t0 };
  writeFileSync(subjectsFile(o.projectDir, run), JSON.stringify(out));
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
function centroidX(m: Uint8Array, w: number, h: number): number {
  let s = 0;
  let c = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (m[y * w + x]) (s += x, c++);
  return c ? s / c : 0;
}
/** A point well inside a mask: of the pixels that survive a shrink, the one nearest their centre. */
function innerPoint(m: Uint8Array, w: number, h: number): [number, number] {
  // the distance to the edge, by a few shrinking steps along rows and columns (cheap, good enough to stay off the boundary)
  let best = -1;
  let bd = -1;
  let cx = 0;
  let cy = 0;
  let cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) (cx += x, (cy += y), cnt++);
  if (!cnt) return [0, 0];
  cx /= cnt;
  cy /= cnt;
  for (let y = 1; y < h - 1; y += 2)
    for (let x = 1; x < w - 1; x += 2) {
      const p = y * w + x;
      if (!m[p]) continue;
      let room = 0;
      for (let r = 1; r <= 12; r++) {
        if (m[p - r] && m[p + r] && m[p - r * w] && m[p + r * w] && x - r > 0 && x + r < w && y - r > 0 && y + r < h) room = r;
        else break;
      }
      const d = room * 1000 - Math.hypot(x - cx, y - cy);
      if (d > bd) (bd = d, (best = p));
    }
  return best < 0 ? [Math.round(cx), Math.round(cy)] : [best % w, Math.floor(best / w)];
}

export { maskToRle } from '@studio/vision';
