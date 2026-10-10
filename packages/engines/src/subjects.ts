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
import { colourName, denseFlow, drawMaskOutline, drawText, grayOf, maskToRle, probeVideo, proposalPrompts, rankSubjects, readSize, SUBJECT_COLOURS, tileRgb, type Candidate } from '@studio/vision';
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
  const times = (o.at?.length ? o.at : to > from + 400 ? [from, Math.round((from + to) / 2), Math.max(from, to - 150)] : [from]).map((t) => Math.round(t));
  const run = 'sub_' + createHash('sha256').update(JSON.stringify([a.hash, times, w, o.maxThings ?? 10, o.maxParts ?? 6])).digest('hex').slice(0, 4);
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
      const nx = await grabFrame(src, t + dtMs, fps, { w, h });
      const id = `u${createHash('sha256').update(JSON.stringify([a.hash, t, w, h])).digest('hex').slice(0, 14)}`;
      log(`looking at ${t} ms`);
      await sam.embed(id, rgb, w, h);
      // a grid of questions "what is here?", one point each
      const GX = 9;
      const GY = 6;
      const prompts: { points: [number, number][]; labels: number[] }[] = [];
      for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) prompts.push({ points: [[((gx + 0.5) / GX) * w, ((gy + 0.5) / GY) * h]], labels: [1] });
      const props = await sam.proposals(id, w, h, prompts);
      const cands: (Candidate & { index: number })[] = props.map((p) => {
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < mask.length; i++) mask[i] = p.prob[i]! > 0.5 ? 1 : 0;
        return { mask, quality: p.iou, prompt: p.prompt, candidate: p.candidate, index: p.candidate };
      });
      const ranked = rankSubjects(cands, w, h);
      const things = ranked.map((r, i) => ({ r, i })).filter(({ r }) => r.parent < 0).slice(0, o.maxThings ?? 10);
      const keepIdx = new Set(things.map((x) => x.i));
      const parts = ranked.map((r, i) => ({ r, i })).filter(({ r }) => r.parent >= 0 && keepIdx.has(r.parent)).slice(0, o.maxParts ?? 6);
      for (const p of parts) keepIdx.add(p.i);
      const listed = ranked.map((r, i) => ({ r, i })).filter(({ i }) => keepIdx.has(i));
      // saliency and motion
      const sal = await salienceOf(rgb, w, h);
      let flow: { u: Float32Array; v: Float32Array } | null = null;
      if (nx) flow = denseFlow(grayOf(rgb, w, h), grayOf(new Uint8Array(nx), w, h), { levels: 4, iters: 3, radius: 5 });
      // the motion of what is not a subject: the background's own (the camera's)
      const inThing = new Uint8Array(w * h);
      for (const { r } of things) for (let i = 0; i < inThing.length; i++) if (r.mask[i]) inThing[i] = 1;
      const bgU: number[] = [];
      const bgV: number[] = [];
      if (flow) {
        for (let i = 0; i < w * h; i += 7)
          if (!inThing[i]) {
            bgU.push(flow.u[i]!);
            bgV.push(flow.v[i]!);
          }
        if (bgU.length < 0.05 * ((w * h) / 7)) {
          bgU.length = 0;
          bgV.length = 0;
          for (let i = 0; i < w * h; i += 7) (bgU.push(flow.u[i]!), bgV.push(flow.v[i]!));
        }
      }
      const bgFlow: [number, number] = [median(bgU), median(bgV)];
      // numbered left to right: things first, then their parts
      const order = listed.slice().sort((x, y) => (x.r.parent < 0 ? 0 : 1) - (y.r.parent < 0 ? 0 : 1) || centroidX(x.r.mask, w, h) - centroidX(y.r.mask, w, h));
      const idOf = new Map<number, string>();
      for (const { i } of order) idOf.set(i, `s${subjects.length + idOf.size + 1}`);
      const tint = rgb.slice();
      const colourOf = new Map<number, number>();
      let ci = 0;
      for (const { r, i } of order) {
        const top = r.parent < 0;
        // a point inside, away from the edge: the pixel with the most room around it (cheap: the one closest to the centroid among the eroded)
        const pt = innerPoint(r.mask, w, h);
        let sx = 0;
        let sy = 0;
        let cnt = 0;
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        let rr = 0, gg = 0, bb = 0;
        const fu: number[] = [];
        const fv: number[] = [];
        let sIn = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (!r.mask[p]) continue;
            cnt++;
            sx += x; sy += y;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            if ((x + y) % 3 === 0) {
              rr += rgb[3 * p]!; gg += rgb[3 * p + 1]!; bb += rgb[3 * p + 2]!;
              if (flow) (fu.push(flow.u[p]!), fv.push(flow.v[p]!));
              if (sal) sIn += sal[p]!;
            }
          }
        const nS = Math.max(1, Math.floor(cnt / 3));
        const bw = (x1 - x0 + 1) / w;
        const bh = (y1 - y0 + 1) / h;
        const dx = median(fu) - bgFlow[0];
        const dy = median(fv) - bgFlow[1];
        const speed = flow ? (Math.hypot(dx, dy) / (dtMs / 1000) / w) * 100 : 0;
        const touches: string[] = [];
        if (x0 <= 1) touches.push('left');
        if (x1 >= w - 2) touches.push('right');
        if (y0 <= 1) touches.push('top');
        if (y1 >= h - 2) touches.push('bottom');
        const s: Subject = {
          id: idOf.get(i)!,
          n: subjects.length + 1,
          at: t,
          top,
          ...(top ? {} : { partOf: idOf.get(r.parent) ?? '' }),
          areaPct: Math.round((1000 * cnt) / (w * h)) / 10,
          bbox: [round3(x0 / w), round3(y0 / h), round3(bw), round3(bh)],
          point: [round3(pt[0] / w), round3(pt[1] / h)],
          quality: Math.round(r.quality * 100) / 100,
          salience: sal ? Math.round((100 * sIn) / nS) / 100 : 0,
          speedPctPerSec: Math.round(speed * 10) / 10,
          moving: speed >= 6,
          colour: colourName(rr / nS, gg / nS, bb / nS),
          shape: bh > 1.3 * bw ? 'tall' : bw > 1.3 * bh ? 'wide' : 'compact',
          touches,
          prompt: { points: [[round3(pt[0] / w), round3(pt[1] / h)]], box: [round3(x0 / w), round3(y0 / h), round3(bw), round3(bh)] },
          mask: maskToRle(r.mask, w, h),
        };
        void sx; void sy;
        subjects.push(s);
        // points spread over the whole of it (not the grid point that found it): with its box they ask for the same mask again
        const spread = proposalPrompts(Float32Array.from(r.mask), w, h, 6).filter((q) => q.points?.length === 1).map((q) => [round3(q.points![0]![0] / w), round3(q.points![0]![1] / h)] as [number, number]);
        if (spread.length) s.prompt.points = spread;
        // drawing
        const col = SUBJECT_COLOURS[(top ? ci++ : (colourOf.get(r.parent) ?? 0)) % SUBJECT_COLOURS.length]!;
        if (top) colourOf.set(i, ci - 1);
        if (top) for (let p = 0; p < w * h; p++) if (r.mask[p]) for (let c = 0; c < 3; c++) tint[3 * p + c] = Math.round(rgb[3 * p + c]! * 0.62 + col[c]! * 0.38);
      }
      // outlines and numbers on top of all tints
      ci = 0;
      for (const { r, i } of order) {
        const top = r.parent < 0;
        const col = SUBJECT_COLOURS[(top ? ci++ : (colourOf.get(r.parent) ?? 0)) % SUBJECT_COLOURS.length]!;
        drawMaskOutline(tint, w, h, r.mask, top ? col : [255, 255, 255]);
        const s = subjects.find((q) => q.id === idOf.get(i))!;
        drawText(tint, w, h, Math.max(2, Math.min(w - 40, Math.round(s.point[0] * w) - 8)), Math.max(2, Math.min(h - 20, Math.round(s.point[1] * h) - 8)), s.id, top ? [255, 255, 255] : [255, 255, 0], top ? 3 : 2);
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
  const out: SubjectsRun = { run, asset: o.asset, width: w, height: h, times, subjects, sheet: sheetFile, ...(eachFile ? { each: eachFile } : {}), ms: Date.now() - t0 };
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
