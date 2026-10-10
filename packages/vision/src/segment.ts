/**
 * Cut-outs without a green screen: separating a person or object from the background in a frame from a few marks, and then
 * following it through the shot.
 *
 * Nothing here learns anything. A frame is split by colour: the pixels near the marks give a picture of what "inside" and
 * "outside" look like (colour histograms), every pixel gets a likelihood, and an edge-aware smoothing (a screened Poisson
 * problem, solved by conjugate gradients) decides the rest so that the boundary falls on image edges, not through flat areas.
 * Following the object through time warps the last frame's matte by dense optical flow, keeps the confident inside and
 * outside, and decides only a band around the boundary again, from the colours learned so far and the edges of the new frame.
 *
 * A model's opinion (a saliency map from a pretrained network, for instance) can be passed as a prior: it only adds to the
 * likelihood, it never overrides a mark.
 */
import { denseFlow } from './flow.js';
import type { Gray } from './image.js';

export interface Shape {
  /** points in fractions of the frame; one point is a dot, several are a stroke, a closed shape is filled */
  p: [number, number][];
  /** stroke radius as a fraction of the frame width (default 0.006) */
  r?: number;
  closed?: boolean;
}
export interface Seeds {
  /** the object is inside this box (x, y, w, h, fractions of the frame); everything outside it is background */
  box?: [number, number, number, number];
  fg?: Shape[];
  bg?: Shape[];
  /**
   * A rough outline of the object, as a closed polygon: its inside (shrunk by `band`) is the object, its outside (grown by
   * `band`) is not, and only the ring between is decided from colours and edges. `band` is a fraction of the frame width
   * (default 0.025), as far off as the outline may be.
   */
  outline?: { p: [number, number][]; band?: number };
}

export const LABEL_FG = 1;
export const LABEL_BG = 2;

function disc(m: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, v: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.25) m[y * w + x] = v;
}

function fillPolygon(m: Uint8Array, w: number, h: number, pts: [number, number][], v: number): void {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if ((a[1] <= y + 0.5 && b[1] > y + 0.5) || (b[1] <= y + 0.5 && a[1] > y + 0.5)) xs.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k]!)); x <= Math.min(w - 1, Math.round(xs[k + 1]!)); x++) m[y * w + x] = v;
  }
}

/** The marks as a label image (0 unknown, 1 inside, 2 outside) at the analysis size; strokes of the foreground win over the box. */
export function rasterSeeds(w: number, h: number, s: Seeds): { labels: Uint8Array; box?: Uint8Array; marks: Uint8Array; strokes: Uint8Array } {
  const labels = new Uint8Array(w * h);
  let box: Uint8Array | undefined;
  if (s.box) {
    box = new Uint8Array(w * h);
    const [bx, by, bw, bh] = s.box;
    for (let y = Math.max(0, Math.floor(by * h)); y < Math.min(h, Math.ceil((by + bh) * h)); y++) for (let x = Math.max(0, Math.floor(bx * w)); x < Math.min(w, Math.ceil((bx + bw) * w)); x++) box[y * w + x] = 1;
    for (let i = 0; i < w * h; i++) if (!box[i]) labels[i] = LABEL_BG;
  }
  const draw = (target: Uint8Array, shapes: Shape[] | undefined, v: number) => {
    for (const sh of shapes ?? []) {
      const pts = sh.p.map(([x, y]) => [x * w, y * h] as [number, number]);
      const r = Math.max(0.7, (sh.r ?? 0.006) * w);
      if (sh.closed && pts.length >= 3) fillPolygon(target, w, h, pts, v);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[Math.min(i + 1, pts.length - 1)]!;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, r * 0.7)));
        for (let k = 0; k <= n; k++) disc(target, w, h, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, r, v);
      }
    }
  };
  if (s.outline && s.outline.p.length >= 3) {
    const filled = new Uint8Array(w * h);
    fillPolygon(filled, w, h, s.outline.p.map(([x, y]) => [x * w, y * h] as [number, number]), 1);
    const r = Math.max(1, Math.round((s.outline.band ?? 0.025) * w));
    const inner = morph(filled, w, h, r, false);
    const outer = morph(filled, w, h, r, true);
    for (let i = 0; i < w * h; i++) {
      if (inner[i]) labels[i] = LABEL_FG;
      else if (!outer[i]) labels[i] = LABEL_BG;
    }
  }
  const before = labels.slice();
  draw(labels, s.bg, LABEL_BG);
  draw(labels, s.fg, LABEL_FG);
  // every stroke and dot as drawn, wherever it lies (also inside an outline, where the label was already 'inside')
  const strokes = new Uint8Array(w * h);
  draw(strokes, s.bg, LABEL_BG);
  draw(strokes, s.fg, LABEL_FG);
  // the pixels the strokes and dots themselves set (not the box or the outline's rings): what was said outright
  const marks = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (labels[i] && labels[i] !== before[i]) marks[i] = labels[i]!;
  return { labels, box, marks, strokes };
}

// ----- colour models ------------------------------------------------------------------------------------------------------------------

const BINS = 16;
export class ColorModel {
  h = new Float32Array(BINS * BINS * BINS);
  n = 0;
  private smoothed: Float32Array | null = null;
  add(r: number, g: number, b: number, wt = 1): void {
    this.h[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]! += wt;
    this.n += wt;
    this.smoothed = null;
    this.sum = -1;
  }
  /** keeps a fraction of what was learned (for models that follow the object through time) */
  decay(k: number): void {
    for (let i = 0; i < this.h.length; i++) this.h[i] = this.h[i]! * k;
    this.n *= k;
    this.smoothed = null;
    this.sum = -1;
  }
  private prep(): Float32Array {
    if (this.smoothed) return this.smoothed;
    const s = new Float32Array(this.h.length);
    for (let r = 0; r < BINS; r++)
      for (let g = 0; g < BINS; g++)
        for (let b = 0; b < BINS; b++) {
          let acc = 0;
          let cnt = 0;
          for (let dr = -1; dr <= 1; dr++)
            for (let dg = -1; dg <= 1; dg++)
              for (let db = -1; db <= 1; db++) {
                const rr = r + dr;
                const gg = g + dg;
                const bb = b + db;
                if (rr < 0 || gg < 0 || bb < 0 || rr >= BINS || gg >= BINS || bb >= BINS) continue;
                const wgt = dr || dg || db ? 0.35 : 1;
                acc += wgt * this.h[(rr << 8) | (gg << 4) | bb]!;
                cnt += wgt;
              }
          s[(r << 8) | (g << 4) | b] = acc / cnt;
        }
    this.smoothed = s;
    return s;
  }
  /** probability of a colour under the model (2% of a uniform floor, so unseen colours are rare but not impossible) */
  p(r: number, g: number, b: number): number {
    const s = this.prep();
    if (this.n <= 0) return 1 / (BINS * BINS * BINS);
    if (this.sum < 0) {
      let t = 0;
      for (let i = 0; i < s.length; i++) t += s[i]!;
      this.sum = t;
    }
    const a = 0.02;
    return (s[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]! + (a * this.sum) / s.length) / (this.sum * (1 + a));
  }
  private sum = -1;
}

// ----- edge weights and the smoothing solver ---------------------------------------------------------------------------------------------

export interface Edges {
  /** weight between a pixel and the one to its right / below */
  wx: Float32Array;
  wy: Float32Array;
}
/** Contrast-sensitive weights: strong where the picture is flat, weak across an edge, so the matte settles on edges. */
export function edgeWeights(rgb: Uint8Array, w: number, h: number, gamma = 4): Edges {
  const wx = new Float32Array(w * h);
  const wy = new Float32Array(w * h);
  const d2 = (i: number, j: number) => {
    const a = rgb[3 * i]! - rgb[3 * j]!;
    const b = rgb[3 * i + 1]! - rgb[3 * j + 1]!;
    const c = rgb[3 * i + 2]! - rgb[3 * j + 2]!;
    return (a * a + b * b + c * c) / (255 * 255);
  };
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) (sum += d2(i, i + 1), n++);
      if (y + 1 < h) (sum += d2(i, i + w), n++);
    }
  const beta = 1 / (2 * Math.max(1e-4, sum / Math.max(1, n)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) wx[i] = gamma * Math.exp(-beta * d2(i, i + 1)) + 0.02;
      if (y + 1 < h) wy[i] = gamma * Math.exp(-beta * d2(i, i + w)) + 0.02;
    }
  return { wx, wy };
}

/**
 * Solves for the unknown pixels `active` (nonzero): at each, the weighted average of its neighbours and its own target `u`
 * (pulled by `lam`). Pixels not active keep `fixed` and act as boundary values. Conjugate gradients, Jacobi preconditioner.
 */
export function solveField(
  w: number,
  h: number,
  active: Uint8Array,
  fixed: Float32Array,
  e: Edges,
  u: Float32Array,
  lam: number,
  o: { iters?: number; tol?: number } = {},
): Float32Array {
  const n = w * h;
  const x = new Float64Array(n);
  const b = new Float64Array(n);
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = active[i] ? u[i]! : fixed[i]!;
  for (let y = 0; y < h; y++)
    for (let xx = 0; xx < w; xx++) {
      const i = y * w + xx;
      if (!active[i]) continue;
      let d = lam;
      let rhs = lam * u[i]!;
      const nb = (j: number, wt: number) => {
        d += wt;
        if (!active[j]) rhs += wt * fixed[j]!;
      };
      if (xx + 1 < w) nb(i + 1, e.wx[i]!);
      if (xx > 0) nb(i - 1, e.wx[i - 1]!);
      if (y + 1 < h) nb(i + w, e.wy[i]!);
      if (y > 0) nb(i - w, e.wy[i - w]!);
      diag[i] = d;
      b[i] = rhs;
    }
  const Ap = (v: Float64Array, out: Float64Array) => {
    for (let y = 0; y < h; y++)
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        if (!active[i]) {
          out[i] = 0;
          continue;
        }
        let s = diag[i]! * v[i]!;
        if (xx + 1 < w && active[i + 1]) s -= e.wx[i]! * v[i + 1]!;
        if (xx > 0 && active[i - 1]) s -= e.wx[i - 1]! * v[i - 1]!;
        if (y + 1 < h && active[i + w]) s -= e.wy[i]! * v[i + w]!;
        if (y > 0 && active[i - w]) s -= e.wy[i - w]! * v[i - w]!;
        out[i] = s;
      }
  };
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  Ap(x, q);
  let rz = 0;
  let bn = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    r[i] = b[i]! - q[i]!;
    z[i] = r[i]! / diag[i]!;
    p[i] = z[i]!;
    rz += r[i]! * z[i]!;
    bn += b[i]! * b[i]!;
  }
  const tol = (o.tol ?? 1e-4) ** 2 * Math.max(bn, 1e-12);
  for (let it = 0; it < (o.iters ?? 250) && rz > tol; it++) {
    Ap(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) if (active[i]) pq += p[i]! * q[i]!;
    if (pq <= 1e-30) break;
    const a = rz / pq;
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      x[i] = x[i]! + a * p[i]!;
      r[i] = r[i]! - a * q[i]!;
      z[i] = r[i]! / diag[i]!;
      rz2 += r[i]! * z[i]!;
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) if (active[i]) p[i] = z[i]! + beta * p[i]!;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, x[i]!));
  return out;
}

// ----- morphology on masks ----------------------------------------------------------------------------------------------------------------

/** Grows (`grow` = true) or shrinks a binary mask by r pixels (square window, separable). */
export function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // running count of "on" pixels in the window
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, r - 1); x++) cnt += m[y * w + x]!;
    for (let x = 0; x < w; x++) {
      if (x + r < w) cnt += m[y * w + x + r]!;
      if (x - r - 1 >= 0) cnt -= m[y * w + x - r - 1]!;
      const lo = Math.max(0, x - r);
      const hi = Math.min(w - 1, x + r);
      tmp[y * w + x] = grow ? (cnt > 0 ? 1 : 0) : cnt === hi - lo + 1 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, r - 1); y++) cnt += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      if (y + r < h) cnt += tmp[(y + r) * w + x]!;
      if (y - r - 1 >= 0) cnt -= tmp[(y - r - 1) * w + x]!;
      const lo = Math.max(0, y - r);
      const hi = Math.min(h - 1, y + r);
      out[y * w + x] = grow ? (cnt > 0 ? 1 : 0) : cnt === hi - lo + 1 ? 1 : 0;
    }
  }
  return out;
}

// ----- a frame from marks ------------------------------------------------------------------------------------------------------------------

export interface SegmentOptions {
  /** a model's idea of the foreground, 0..1 per pixel (only adds to the colour evidence) */
  prior?: Float32Array;
  iterations?: number;
  /** how strongly neighbouring pixels are tied together relative to their own colour evidence (default 4) */
  smoothness?: number;
}
export interface Segmented {
  alpha: Float32Array;
  fg: ColorModel;
  bg: ColorModel;
  /** parts the person marked that a model's mask would leave out (a thin antenna, a held object): kept and carried along by flow */
  extra?: Float32Array;
}

function modelsFrom(rgb: Uint8Array, labelsFg: Uint8Array, labelsBg: Uint8Array, wFg: number, wBg: number): { fg: ColorModel; bg: ColorModel } {
  const fg = new ColorModel();
  const bg = new ColorModel();
  for (let i = 0; i < labelsFg.length; i++) {
    if (labelsFg[i]) fg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, wFg);
    if (labelsBg[i]) bg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, wBg);
  }
  return { fg, bg };
}

/** Likelihood of "inside" per pixel from two colour models, 0..1. */
export function colorEvidence(rgb: Uint8Array, n: number, fg: ColorModel, bg: ColorModel): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = fg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!);
    const b = bg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!);
    out[i] = a / (a + b);
  }
  return out;
}

/** Cuts the object out of one frame from the marks (GrabCut-style: models, decide, learn from the decision, repeat). */
export function segmentFrame(rgb: Uint8Array, w: number, h: number, seeds: Seeds, o: SegmentOptions = {}): Segmented {
  const n = w * h;
  const { labels, box, marks } = rasterSeeds(w, h, seeds);
  const hasFg = labels.some((v) => v === LABEL_FG);
  const prior = o.prior;
  if (!hasFg && !box && !prior) throw new Error('give a box, foreground marks, or a prior: nothing says what to cut out');
  // starting evidence: marks first; else the inside of the box against the outside; a prior adds to either
  const fgInit = new Uint8Array(n);
  const bgInit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === LABEL_FG) fgInit[i] = 1;
    else if (labels[i] === LABEL_BG) bgInit[i] = 1;
    if (prior) {
      if (prior[i]! > 0.9) fgInit[i] = 1;
      else if (prior[i]! < 0.1 && !fgInit[i]) bgInit[i] = 1;
    }
  }
  const boxInside = box ?? new Uint8Array(n).fill(1);
  if (!hasFg && box) for (let i = 0; i < n; i++) if (boxInside[i] && !bgInit[i]) fgInit[i] = 1; // the whole box, as a first guess
  // A stroke is a decision, not a sample of a density: a thin stroke on a bar in front of the object must count for as much
  // as the (much larger) area the box rules out, or the colours it names are drowned by it. So marked pixels weigh enough
  // to make up about a quarter of their class.
  let nMarkFg = 0;
  let nMarkBg = 0;
  let nBg = 0;
  let nFg = 0;
  for (let i = 0; i < n; i++) {
    if (marks[i] === LABEL_FG) nMarkFg++;
    else if (marks[i] === LABEL_BG) nMarkBg++;
    if (bgInit[i]) nBg++;
    if (fgInit[i]) nFg++;
  }
  const markWeight = (mark: number, all: number) => (mark ? Math.min(300, Math.max(1, (0.25 * (all - mark)) / mark)) : 1);
  const wMarkFg = markWeight(nMarkFg, nFg);
  const wMarkBg = markWeight(nMarkBg, nBg);
  let { fg, bg } = (() => {
    const m = modelsFrom(rgb, fgInit, bgInit, hasFg || prior ? 1 : 0.5, 1);
    for (let i = 0; i < n; i++) {
      if (marks[i] === LABEL_FG && wMarkFg > 1) m.fg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, wMarkFg - 1);
      if (marks[i] === LABEL_BG && wMarkBg > 1) m.bg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, wMarkBg - 1);
    }
    return m;
  })();
  const edges = edgeWeights(rgb, w, h, o.smoothness ?? 4);
  const active = new Uint8Array(n).fill(1);
  const fixed = new Float32Array(n);
  for (let i = 0; i < n; i++)
    if (labels[i] === LABEL_FG) (active[i] = 0, (fixed[i] = 1));
    else if (labels[i] === LABEL_BG) (active[i] = 0, (fixed[i] = 0));
  let alpha: Float32Array = new Float32Array(n);
  for (let it = 0; it < (o.iterations ?? 4); it++) {
    const ev = colorEvidence(rgb, n, fg, bg);
    const u = new Float32Array(n);
    for (let i = 0; i < n; i++) u[i] = prior ? 0.65 * ev[i]! + 0.35 * prior[i]! : ev[i]!;
    if (it > 0) {
      // A colour the object (as now understood) hardly ever has is probably not the object: where the colour models cannot
      // tell (it is rare in both), lean to "not" instead of a coin flip, so a bar passing in front is not taken as part of it.
      const ps: number[] = [];
      for (let i = 0; i < n; i += 3) if (alpha[i]! > 0.92) ps.push(fg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!));
      ps.sort((a, b) => a - b);
      const floor = ps.length > 50 ? 0.25 * ps[Math.floor(ps.length * 0.03)]! : 0;
      for (let i = 0; i < n; i++) if (active[i] && fg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!) < floor) u[i] = Math.min(u[i]!, 0.2);
    }
    alpha = solveField(w, h, active, fixed, edges, u, 0.5, { iters: 200 });
    // sharpen a little: the smoothing leaves a soft ramp across the edge that is wider than the real one
    for (let i = 0; i < n; i++) alpha[i] = Math.min(1, Math.max(0, (alpha[i]! - 0.5) * 2.2 + 0.5));
    // learn from what is now sure
    const sureFg = new Uint8Array(n);
    const sureBg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (alpha[i]! > 0.92) sureFg[i] = 1;
      else if (alpha[i]! < 0.08) sureBg[i] = 1;
    }
    const m = modelsFrom(rgb, sureFg, sureBg, 1, 1);
    // the marks keep a say: they were certain
    for (let i = 0; i < n; i++) {
      if (marks[i] === LABEL_FG) m.fg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, Math.max(2, wMarkFg));
      if (marks[i] === LABEL_BG) m.bg.add(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!, Math.max(2, wMarkBg));
    }
    fg = m.fg;
    bg = m.bg;
  }
  return { alpha, fg, bg };
}

// ----- a model's mask: choosing the subject and snapping it to the picture ----------------------------------------------------------------------

/** Connected parts (4-neighbour) of a binary mask: a label per pixel (0 = none) and each part's size. */
export function components(mask: Uint8Array, w: number, h: number): { id: Int32Array; sizes: number[] } {
  const id = new Int32Array(w * h);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || id[s]) continue;
    const c = sizes.length;
    let size = 0;
    id[s] = c;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !id[p - 1]) ((id[p - 1] = c), stack.push(p - 1));
      if (x < w - 1 && mask[p + 1] && !id[p + 1]) ((id[p + 1] = c), stack.push(p + 1));
      if (y > 0 && mask[p - w] && !id[p - w]) ((id[p - w] = c), stack.push(p - w));
      if (y < h - 1 && mask[p + w] && !id[p + w]) ((id[p + w] = c), stack.push(p + w));
    }
    sizes.push(size);
  }
  return { id, sizes };
}

/**
 * The parts of a model's mask that are the subject: those that mostly lie on the reference (the marked or the carried-over
 * matte). Other salient things in the picture are left out. The soft fringe of the chosen parts is kept.
 */
export function selectSubject(prior: Float32Array, ref: Float32Array, w: number, h: number, o: { minOverlap?: number; reach?: number } = {}): Float32Array {
  const n = w * h;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prior[i]! > 0.5 ? 1 : 0;
  const { id, sizes } = components(bin, w, h);
  const ov = new Array<number>(sizes.length).fill(0);
  let region = ref;
  if (o.reach) {
    const rb = new Uint8Array(n);
    for (let i = 0; i < n; i++) rb[i] = ref[i]! > 0.5 ? 1 : 0;
    const grown = morph(rb, w, h, o.reach, true);
    region = Float32Array.from(grown, (v) => v);
  }
  for (let i = 0; i < n; i++) if (id[i] && ref[i]! > 0.5) ov[id[i]!]!++;
  const keep = new Uint8Array(n);
  const minSize = Math.max(8, Math.round(0.0015 * n));
  const chosen = sizes.map((sz, c) => c > 0 && sz >= minSize && ov[c]! / sz >= (o.minOverlap ?? 0.3));
  for (let i = 0; i < n; i++) if (id[i] && chosen[id[i]!] && region[i]! > 0.5) keep[i] = 1;
  const d = morph(keep, w, h, 3, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (d[i]) out[i] = keep[i] ? Math.max(prior[i]!, 0.5) : prior[i]! > 0.5 ? 0 : prior[i]!;
  return out;
}

/** A matte from a target (a model's subject mask): sure inside kept, a thin band at the boundary decided with the picture's edges. */
function refineToTarget(rgb: Uint8Array, w: number, h: number, target: Float32Array, colour: Float32Array | null, band = 3): { alpha: Float32Array; unsure: number } {
  const n = w * h;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = target[i]! > 0.5 ? 1 : 0;
  const sure = morph(inside, w, h, band, false);
  const near = morph(inside, w, h, band, true);
  const active = new Uint8Array(n);
  const fixed = new Float32Array(n);
  const ev = new Float32Array(n);
  let nActive = 0;
  for (let i = 0; i < n; i++) {
    if (sure[i]) fixed[i] = 1;
    else if (near[i]) {
      active[i] = 1;
      ev[i] = colour ? 0.7 * target[i]! + 0.3 * colour[i]! : target[i]!;
      nActive++;
    }
  }
  const solved = nActive ? solveField(w, h, active, fixed, edgeWeights(rgb, w, h, 4), ev, 0.5, { iters: 120 }) : fixed;
  const alpha = new Float32Array(n);
  let unsure = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) alpha[i] = fixed[i]!;
    else {
      alpha[i] = Math.min(1, Math.max(0, (solved[i]! - 0.5) * 2.2 + 0.5));
      if (alpha[i]! > 0.2 && alpha[i]! < 0.8) unsure++;
    }
  }
  return { alpha, unsure: nActive ? unsure / nActive : 0 };
}

export interface ModelKey {
  seg: Segmented;
  /** the model's mask agrees with what was marked (so it is the right guide for this object) */
  ok: boolean;
  why: string;
}

/**
 * A marked frame, with a model's mask as the guide: the subject is the part(s) of the mask on the marked object; the marks
 * still decide (a foreground mark is inside, a background mark is outside). `ok` says whether the model found the marked
 * object at all; if not, `seg` is the colour result unchanged.
 */
export function segmentWithModel(rgb: Uint8Array, w: number, h: number, seeds: Seeds, seg: Segmented, prior: Float32Array): ModelKey {
  const n = w * h;
  const { strokes: marks, box } = rasterSeeds(w, h, seeds); // the strokes themselves (an outline's inside is only a hint)
  // the marked region only guides which parts are the subject: the model may reach a little past a rough outline (hair, a hand),
  // but never past a box (the box says what is outside)
  const sel = selectSubject(prior, seg.alpha, w, h, { reach: Math.max(4, Math.round(0.04 * w)) });
  if (box) for (let i = 0; i < n; i++) if (!box[i]) sel[i] = 0;
  let area = 0;
  let onRef = 0;
  let inBox = 0;
  for (let i = 0; i < n; i++)
    if (sel[i]! > 0.5) {
      area++;
      if (seg.alpha[i]! > 0.5) onRef++;
      if (!box || box[i]) inBox++;
    }
  if (area < 0.003 * n) return { seg, ok: false, why: 'the model found nothing on the marked object' };
  if (onRef / area < 0.4) return { seg, ok: false, why: 'the model\'s subject lies mostly off the marked object' };
  if (box && inBox / area < 0.6) return { seg, ok: false, why: 'the model\'s subject reaches well outside the marked box' };
  const colour = colorEvidence(rgb, n, seg.fg, seg.bg);
  // something marked as not the object (a bar passing in front) that the model joined to the subject: taken out near the strokes
  const bgStroke = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (marks[i] === LABEL_BG) bgStroke[i] = 1;
  const bgNear = morph(bgStroke, w, h, Math.max(4, Math.round(0.05 * w)), true);
  for (let i = 0; i < n; i++) if (bgNear[i] && (colour[i]! < 0.6 || seg.alpha[i]! < 0.5)) sel[i] = 0;
  const { alpha } = refineToTarget(rgb, w, h, sel, colour);
  // what the person marked as the object but the model left out: the marked stroke and what the colours join to it nearby
  const markMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (marks[i] === LABEL_FG && sel[i]! <= 0.5) markMask[i] = 1;
  const near = morph(markMask, w, h, Math.max(3, Math.round(0.025 * w)), true);
  const extra = new Float32Array(n);
  for (let i = 0; i < n; i++)
    if (near[i] && alpha[i]! < 0.5 && (seg.alpha[i]! > 0.5 || colour[i]! > 0.5)) {
      extra[i] = 1;
      alpha[i] = 1;
    }
  for (let i = 0; i < n; i++) {
    if (marks[i] === LABEL_FG) alpha[i] = 1;
    else if (marks[i] === LABEL_BG) alpha[i] = 0;
  }
  for (let i = 0; i < n; i++) if (marks[i] === LABEL_FG && sel[i]! <= 0.5) extra[i] = 1;
  // the colour models are learnt again from the model-guided matte, so that following has the object's real palette
  const sureFg = new Uint8Array(n);
  const sureBg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i]! > 0.92) sureFg[i] = 1;
    else if (alpha[i]! < 0.08) sureBg[i] = 1;
  }
  const m = modelsFrom(rgb, morph(sureFg, w, h, 2, false), morph(sureBg, w, h, 2, false), 1, 1);
  return { seg: { alpha, fg: m.fg, bg: m.bg, extra }, ok: true, why: '' };
}

// ----- promptable model: prompts from marks and from a matte, and a frame from its mask ------------------------------------------------------

export interface ModelPrompts {
  points: [number, number][];
  /** 1 inside the object, 0 outside */
  labels: number[];
  box?: [number, number, number, number];
}

/** A few evenly spread pixels of each connected part of a mask. */
function samplePixels(mask: Uint8Array, w: number, h: number, perPart: number, minSize = 1): [number, number][] {
  const { id, sizes } = components(mask, w, h);
  const lists: number[][] = sizes.map(() => []);
  for (let i = 0; i < mask.length; i++) if (id[i]) lists[id[i]!]!.push(i);
  const out: [number, number][] = [];
  for (let c = 1; c < lists.length; c++) {
    const l = lists[c]!;
    if (l.length < minSize) continue;
    const k = Math.min(perPart, l.length);
    for (let j = 0; j < k; j++) {
      const i = l[Math.floor(((j + 0.5) * l.length) / k)]!;
      out.push([i % w, Math.floor(i / w)]);
    }
  }
  return out;
}

/** What the marks say, as a promptable model wants it: points on the object, points off it, and a box. */
export function promptsFromSeeds(w: number, h: number, seeds: Seeds): ModelPrompts {
  const { labels, box, strokes } = rasterSeeds(w, h, seeds);
  const fg = new Uint8Array(w * h);
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (strokes[i] === LABEL_FG) fg[i] = 1;
    else if (strokes[i] === LABEL_BG) bg[i] = 1;
  }
  const points: [number, number][] = [];
  const lab: number[] = [];
  for (const p of samplePixels(fg, w, h, 3)) (points.push(p), lab.push(1));
  for (const p of samplePixels(bg, w, h, 3)) (points.push(p), lab.push(0));
  let bx: [number, number, number, number] | undefined;
  if (seeds.box) {
    const [x, y, bw, bh] = seeds.box;
    bx = [Math.max(0, x * w), Math.max(0, y * h), Math.min(w - 1, (x + bw) * w), Math.min(h - 1, (y + bh) * h)];
  }
  if (!lab.includes(1) && !bx) {
    // an outline only: its inside gives a box and a point
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0, cnt = 0;
    for (let i = 0; i < w * h; i++)
      if (labels[i] === LABEL_FG) {
        const x = i % w, y = Math.floor(i / w);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); sx += x; sy += y; cnt++;
      }
    if (cnt) {
      bx = [x0, y0, x1, y1];
      const cx = sx / cnt, cy = sy / cnt;
      let best = -1, bd = 1e18;
      for (let i = 0; i < w * h; i++)
        if (labels[i] === LABEL_FG) {
          const d = (i % w - cx) ** 2 + (Math.floor(i / w) - cy) ** 2;
          if (d < bd) (bd = d, best = i);
        }
      if (best >= 0) (points.push([best % w, Math.floor(best / w)]), lab.push(1));
    }
  }
  return { points, labels: lab, ...(bx ? { box: bx } : {}) };
}

/** Prompts for the next frame from the matte carried over to it: points deep inside, points around it, a box. */
export function promptsFromMask(alpha: Float32Array, w: number, h: number): ModelPrompts | null {
  const n = w * h;
  const m = new Uint8Array(n);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0;
  for (let i = 0; i < n; i++)
    if (alpha[i]! > 0.5) {
      m[i] = 1;
      const x = i % w, y = Math.floor(i / w);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cnt++;
    }
  if (cnt < 0.002 * n) return null;
  let inner = morph(m, w, h, Math.max(2, Math.round(0.012 * w)), false);
  if (!inner.some((v) => v)) inner = m;
  const points: [number, number][] = [];
  const labels: number[] = [];
  // 3 x 3 cells over the box: in each, the inner pixel nearest the mean of the inner pixels of that cell
  const cw = (x1 - x0 + 1) / 3, ch = (y1 - y0 + 1) / 3;
  for (let cy = 0; cy < 3; cy++)
    for (let cx = 0; cx < 3; cx++) {
      const px: number[] = [];
      for (let y = Math.floor(y0 + cy * ch); y < Math.floor(y0 + (cy + 1) * ch); y++)
        for (let x = Math.floor(x0 + cx * cw); x < Math.floor(x0 + (cx + 1) * cw); x++) if (inner[y * w + x]) px.push(y * w + x);
      if (px.length < 12) continue;
      let mx = 0, my = 0;
      for (const i of px) (mx += i % w, my += Math.floor(i / w));
      mx /= px.length; my /= px.length;
      let best = px[0]!, bd = 1e18;
      for (const i of px) {
        const d = (i % w - mx) ** 2 + (Math.floor(i / w) - my) ** 2;
        if (d < bd) (bd = d, best = i);
      }
      points.push([best % w, Math.floor(best / w)]);
      labels.push(1);
    }
  // outside: pixels in a ring a little way from the matte, one per direction around its centre
  const near = morph(m, w, h, Math.max(3, Math.round(0.03 * w)), true);
  const far = morph(m, w, h, Math.max(8, Math.round(0.12 * w)), true);
  const ccx = (x0 + x1) / 2, ccy = (y0 + y1) / 2;
  const sectors: number[][] = Array.from({ length: 8 }, () => []);
  for (let i = 0; i < n; i++)
    if (far[i] && !near[i]) {
      const a = Math.atan2(Math.floor(i / w) - ccy, (i % w) - ccx);
      sectors[Math.min(7, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 8))]!.push(i);
    }
  for (const l of sectors) {
    if (l.length < 20) continue;
    let mx = 0, my = 0;
    for (const i of l) (mx += i % w, my += Math.floor(i / w));
    mx /= l.length; my /= l.length;
    let best = l[0]!, bd = 1e18;
    for (const i of l) {
      const d = (i % w - mx) ** 2 + (Math.floor(i / w) - my) ** 2;
      if (d < bd) (bd = d, best = i);
    }
    points.push([best % w, Math.floor(best / w)]);
    labels.push(0);
  }
  const pad = Math.round(0.03 * Math.max(w, h));
  return { points, labels, box: [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w - 1, x1 + pad), Math.min(h - 1, y1 + pad)] };
}

/**
 * A marked frame from a promptable model's mask: the mask is the object (the marks decided which one), its boundary is snapped
 * to the picture's edges in a thin band, strokes still win, and the colour models are learnt for following.
 */
export function segmentFromPrompted(rgb: Uint8Array, w: number, h: number, seeds: Seeds, prior: Float32Array): Segmented {
  const n = w * h;
  const { strokes } = rasterSeeds(w, h, seeds);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prior[i]! > 0.5 ? 1 : 0;
  // specks the model left away from the object are not the object, unless a stroke says so
  // small holes inside the object are model noise (the mask is predicted at a quarter of the resolution): filled
  const notIn = new Uint8Array(n);
  for (let i = 0; i < n; i++) notIn[i] = bin[i] ? 0 : 1;
  const holes = components(notIn, w, h);
  const touches = new Uint8Array(holes.sizes.length);
  for (let x = 0; x < w; x++) (touches[holes.id[x]!] = 1, (touches[holes.id[(h - 1) * w + x]!] = 1));
  for (let y = 0; y < h; y++) (touches[holes.id[y * w]!] = 1, (touches[holes.id[y * w + w - 1]!] = 1));
  for (let i = 0; i < n; i++) if (holes.id[i] && !touches[holes.id[i]!] && holes.sizes[holes.id[i]!]! < 0.004 * n && strokes[i] !== LABEL_BG) { bin[i] = 1; prior[i] = 1; }
  const { id, sizes } = components(bin, w, h);
  const hasStroke = new Uint8Array(sizes.length);
  for (let i = 0; i < n; i++) if (id[i] && strokes[i] === LABEL_FG) hasStroke[id[i]!] = 1;
  const target = new Float32Array(n);
  const minSize = Math.max(6, Math.round(0.0008 * n));
  for (let i = 0; i < n; i++) if (id[i] && (sizes[id[i]!]! >= minSize || hasStroke[id[i]!])) target[i] = Math.max(prior[i]!, 0.5);
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = target[i]! > 0.5 ? 1 : 0;
  const sureFg = morph(inside, w, h, 2, false);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = inside[i] ? 0 : 1;
  const sureBg = morph(outside, w, h, 2, false);
  const m = modelsFrom(rgb, sureFg, sureBg, 1, 1);
  const colour = colorEvidence(rgb, n, m.fg, m.bg);
  const { alpha } = refineToTarget(rgb, w, h, target, colour);
  for (let i = 0; i < n; i++) {
    if (strokes[i] === LABEL_FG) alpha[i] = 1;
    else if (strokes[i] === LABEL_BG) alpha[i] = 0;
  }
  return { alpha, fg: m.fg, bg: m.bg };
}

// ----- following it through time -------------------------------------------------------------------------------------------------------------

/** Samples `src` at the positions given by a flow field (backward warp): out(p) = src(p + flow(p)). */
export function warpByFlow(src: Float32Array, w: number, h: number, u: Float32Array, v: Float32Array): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const sx = Math.min(w - 1, Math.max(0, x + u[i]!));
      const sy = Math.min(h - 1, Math.max(0, y + v[i]!));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      out[i] = (src[y0 * w + x0]! * (1 - fx) + src[y0 * w + x1]! * fx) * (1 - fy) + (src[y1 * w + x0]! * (1 - fx) + src[y1 * w + x1]! * fx) * fy;
    }
  return out;
}

export const grayOf = (rgb: Uint8Array, w: number, h: number): Gray => {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = (0.299 * rgb[3 * i]! + 0.587 * rgb[3 * i + 1]! + 0.114 * rgb[3 * i + 2]!) / 255;
  return { w, h, d };
};

export interface FollowState {
  w: number;
  h: number;
  rgb: Uint8Array;
  gray: Gray;
  alpha: Float32Array;
  /** what the object and the background looked like at the keyframe (never forgotten) and recently (fades) */
  refFg: ColorModel;
  refBg: ColorModel;
  runFg: ColorModel;
  runBg: ColorModel;
  /** a colour that the object's own palette gives less probability than this is not the object's (something else in front) */
  fgFloor: number;
  /** marked parts that a model's mask leaves out, carried along (see Segmented.extra) */
  extra?: Float32Array;
}

/** Starts following from a segmented keyframe. */
export function startFollowing(rgb: Uint8Array, w: number, h: number, seg: Segmented): FollowState {
  const ps: number[] = [];
  for (let i = 0; i < w * h; i += 3) if (seg.alpha[i]! > 0.9) ps.push(seg.fg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!));
  ps.sort((a, b) => a - b);
  const fgFloor = ps.length ? 0.25 * ps[Math.floor(ps.length * 0.03)]! : 0;
  const st: FollowState = { w, h, rgb, gray: grayOf(rgb, w, h), alpha: seg.alpha, refFg: seg.fg, refBg: seg.bg, runFg: new ColorModel(), runBg: new ColorModel(), fgFloor, ...(seg.extra ? { extra: seg.extra } : {}) };
  learn(st, rgb, seg.alpha);
  return st;
}
function learn(st: FollowState, rgb: Uint8Array, alpha: Float32Array): void {
  const { w, h } = st;
  const sure = (inside: boolean) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = inside ? (alpha[i]! > 0.5 ? 1 : 0) : alpha[i]! < 0.5 ? 1 : 0;
    return morph(m, w, h, 3, false);
  };
  const fg = sure(true);
  const bg = sure(false);
  st.runFg.decay(0.85);
  st.runBg.decay(0.85);
  for (let i = 0; i < w * h; i++) {
    if (!fg[i] && !bg[i]) continue;
    const r = rgb[3 * i]!;
    const g = rgb[3 * i + 1]!;
    const b = rgb[3 * i + 2]!;
    // what was learnt at the keyframe vets what is learnt later: a mistake (the matte slipping onto the background, or the
    // object's colours labelled background while something passes in front) must not teach the models the wrong colours
    const a = st.refFg.p(r, g, b);
    const c = a / (a + st.refBg.p(r, g, b));
    if (fg[i] && c > 0.35) st.runFg.add(r, g, b, 1);
    if (bg[i] && c < 0.65) st.runBg.add(r, g, b, 1);
  }
}

export interface FollowStep {
  alpha: Float32Array;
  /** the band that was decided again (px) and how much of it stayed uncertain */
  band: number;
  uncertain: number;
  /** how much the matte's pixels look like the marked object (colour evidence from the marked frame, 0..1; 1 when the matte is empty) */
  confidence: number;
  /** the matte did not look like the object (something else, or the object is hidden or out of the picture): nothing is shown, and the state is kept for when it is back */
  hidden?: boolean;
}

/** Per pixel: how much the colour looks like what was marked as the object at the keyframe, against what was marked as its surroundings (0..1). */
export function colourEvidence(st: FollowState, rgb: Uint8Array): Float32Array {
  const n = st.w * st.h;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[3 * i]!;
    const g = rgb[3 * i + 1]!;
    const b = rgb[3 * i + 2]!;
    const a = st.refFg.p(r, g, b);
    e[i] = a / (a + st.refBg.p(r, g, b) + 1e-9);
  }
  return e;
}

/** Per pixel: 1 where the colour is one the object's palette at the keyframe gives (almost) no probability to: something the object never looked like. */
export function neverSeen(st: FollowState, rgb: Uint8Array): Uint8Array {
  const n = st.w * st.h;
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (st.refFg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!) < st.fgFloor) o[i] = 1;
  return o;
}

/** Mean colour evidence of the pixels a matte covers: do they look like what was marked at the keyframe, and not like its surroundings? */
function lookLike(st: FollowState, rgb: Uint8Array, alpha: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < alpha.length; i += 2) {
    if (alpha[i]! <= 0.5) continue;
    const r = rgb[3 * i]!;
    const g = rgb[3 * i + 1]!;
    const b = rgb[3 * i + 2]!;
    const a = st.refFg.p(r, g, b);
    s += a / (a + st.refBg.p(r, g, b) + 1e-9);
    n++;
  }
  return n < 12 ? 1 : s / n;
}


/**
 * Ends a step: does the matte look like the marked object? If not (a neighbour, the background, the object gone), nothing is shown
 * for this frame and what was learnt before is kept, so that the object can be found again when it is back.
 */
function finishStep(st: FollowState, rgb: Uint8Array, gray: Gray, alpha: Float32Array, band: number, uncertain: number, minConfidence?: number): FollowStep {
  const confidence = lookLike(st, rgb, alpha);
  if (minConfidence !== undefined && confidence < minConfidence) {
    st.rgb = rgb;
    st.gray = gray;
    return { alpha: new Float32Array(alpha.length), band, uncertain: 1, confidence, hidden: true };
  }
  learn(st, rgb, alpha);
  st.rgb = rgb;
  st.gray = gray;
  st.alpha = alpha;
  return { alpha, band, uncertain, confidence };
}

/**
 * The matte of the next frame: the last one carried over by optical flow, its confident inside and outside kept, and a band
 * around the boundary decided again from colours and edges.
 */
export interface FollowPrep {
  gray: Gray;
  flow: ReturnType<typeof denseFlow>;
  /** the last matte carried to this frame by optical flow */
  warped: Float32Array;
}
/** The first half of a step: the motion to the new frame and the matte carried over. A promptable model can be asked about `warped`. */
export function followPrepare(st: FollowState, rgb: Uint8Array): FollowPrep {
  const { w, h } = st;
  const gray = grayOf(rgb, w, h);
  const flow = denseFlow(gray, st.gray, { levels: 4, iters: 3, radius: 5 });
  return { gray, flow, warped: warpByFlow(st.alpha, w, h, flow.u, flow.v) };
}

export function followStep(st: FollowState, rgb: Uint8Array, o: { band?: number; prior?: Float32Array; pre?: FollowPrep; minConfidence?: number } = {}): FollowStep {
  const { w, h } = st;
  const n = w * h;
  const { gray, flow, warped } = o.pre ?? followPrepare(st, rgb);
  // how far the boundary moved decides how wide the band must be
  let mv = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++)
    if (warped[i]! > 0.2 && warped[i]! < 0.8) {
      mv += Math.hypot(flow.u[i]!, flow.v[i]!);
      cnt++;
    }
  const band = o.band ?? Math.max(4, Math.min(Math.round(0.05 * w), Math.round(0.012 * w + 0.8 * (cnt ? mv / cnt : 0))));
  if (o.prior) {
    // A model's mask guides: its parts that lie on the carried-over matte are the subject, and the boundary is snapped to the
    // picture. If it lost the subject (much less than the carried-over matte), flow and colours decide, as without a model.
    // (the carried-over matte and the previous one together: where the object was and where the motion says it went)
    const ref = new Float32Array(n);
    let before = 0;
    for (let i = 0; i < n; i++) {
      ref[i] = Math.max(warped[i]!, st.alpha[i]!);
      if (ref[i]! > 0.5) before++;
    }
    const sel = selectSubject(o.prior, ref, w, h, { reach: Math.max(10, Math.round(0.06 * w)) });
    // The model does not know about something passing in front of the object (a bar, a hand of someone else): it joins the
    // subject's mask. A sizeable piece of picture in colours the object never had is taken out again (small ones, such as
    // the inside of a mouth, are the object's own).
    const foreign = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      if (sel[i]! > 0.5) {
        const r = rgb[3 * i]!;
        const g = rgb[3 * i + 1]!;
        const b = rgb[3 * i + 2]!;
        if (st.refFg.p(r, g, b) < st.fgFloor && st.runFg.p(r, g, b) < st.fgFloor) foreign[i] = 1;
      }
    const fc = components(foreign, w, h);
    const bigOnly = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (fc.id[i] && fc.sizes[fc.id[i]!]! >= 0.008 * n) bigOnly[i] = 1;
    const carve = morph(bigOnly, w, h, 1, true);
    for (let i = 0; i < n; i++) if (carve[i]) sel[i] = 0;
    let after = 0;
    let both = 0;
    for (let i = 0; i < n; i++)
      if (sel[i]! > 0.5) {
        after++;
        if (ref[i]! > 0.5) both++;
      }
    // the model is trusted only while it agrees with where the motion says the object went (IoU of the two)
    const agree = before + after - both > 0 ? both / (before + after - both) : 0;
    if (before > 0 && agree < 0.6 && after > 0) {
      // The model found something else than where the motion says the object went (a neighbour of the same colours, or the object
      // is hidden behind it). Colours cannot be trusted to grow the matte here (they would take the neighbour in): it is carried by
      // the motion alone, and the visibility check below may hide it.
      return finishStep(st, rgb, gray, warped.slice(), band, 1, o.minConfidence);
    }
    if (before > 0 && agree >= 0.6) {
      const colour = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = st.refFg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!);
        colour[i] = a / (a + st.refBg.p(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!));
      }
      // the parts the person marked that the model leaves out go along with the motion, as long as they keep the object's colours
      if (st.extra) {
        const ex = warpByFlow(st.extra, w, h, flow.u, flow.v);
        const kept = new Float32Array(n);
        for (let i = 0; i < n; i++) if (ex[i]! > 0.5 && colour[i]! > 0.5 && sel[i]! <= 0.5) ((kept[i] = 1), (sel[i] = 1));
        st.extra = kept;
      }
      const r = refineToTarget(rgb, w, h, sel, colour);
      return finishStep(st, rgb, gray, r.alpha, 3, r.unsure, o.minConfidence);
    }
  }
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = warped[i]! > 0.5 ? 1 : 0;
  const sureFg = morph(inside, w, h, band, false);
  const reach = morph(inside, w, h, band * 3, true); // how far from the old matte the object may turn up
  const near = morph(inside, w, h, band, true);
  const active = new Uint8Array(n);
  const fixed = new Float32Array(n);
  const ev = new Float32Array(n);
  let nActive = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[3 * i]!;
    const g = rgb[3 * i + 1]!;
    const b = rgb[3 * i + 2]!;
    const fgA = st.refFg.p(r, g, b);
    const fgP = 0.65 * fgA + 0.35 * st.runFg.p(r, g, b);
    const bgP = 0.65 * st.refBg.p(r, g, b) + 0.35 * st.runBg.p(r, g, b);
    const c = fgP / (fgP + bgP);
    // a colour the object never had (something passing in front of it) is not the object, wherever the old matte had it
    const foreign = fgA < st.fgFloor && st.runFg.p(r, g, b) < st.fgFloor;
    const inner = sureFg[i] === 1;
    const ring = !inner && near[i] === 1;
    const far = !near[i] && reach[i] === 1; // outside the band: the object may only come back here on strong evidence
    if (foreign && (inner || ring)) {
      active[i] = 1;
      ev[i] = 0.05;
    } else if (inner) fixed[i] = 1;
    else if (ring) {
      active[i] = 1;
      ev[i] = 0.6 * c + 0.4 * warped[i]!;
    } else if (far && c > 0.93 && !foreign) {
      active[i] = 1;
      ev[i] = c;
    }
    if (active[i]) nActive++;
  }
  const edges = edgeWeights(rgb, w, h, 4);
  const solved: Float32Array = nActive ? solveField(w, h, active, fixed, edges, ev, 0.5, { iters: 120 }) : fixed;
  const alpha = new Float32Array(n);
  let unsure = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) alpha[i] = fixed[i]!;
    else {
      alpha[i] = Math.min(1, Math.max(0, (solved[i]! - 0.5) * 2.2 + 0.5));
      if (alpha[i]! > 0.2 && alpha[i]! < 0.8) unsure++;
    }
  }
  return finishStep(st, rgb, gray, alpha, band, nActive ? unsure / nActive : 0, o.minConfidence);
}
