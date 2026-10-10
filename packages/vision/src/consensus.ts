/**
 * Following an object by consensus of the segmenter's proposals.
 *
 * Asking the segmenter for "the object" with a box and some points on a frame where the object touches or passes in front of
 * something similar (another person, a bar, its own reflection) returns the two joined. The motion does not know the edges; the
 * segmenter does not know which of the things is the one being followed. Here each knows its part:
 *   - the segmenter is asked many small questions on the frame (one point each, three candidate masks per point);
 *   - the matte carried over from the previous frame by the object's motion says where the object should be (the prediction);
 *   - a proposal is the object's when it lies almost entirely on the prediction (plus a margin for what the motion got wrong):
 *     those are united, and their edges are the segmenter's edges. A proposal that mostly lies outside the prediction is another
 *     thing (a neighbour, or the neighbour joined to the object) and is not used; the confident ones among them are taken out of
 *     the prediction too, so that the object cannot grow into what is plainly something else.
 */
import { bilinear, type Gray } from './image.js';
import { components, morph } from './segment.js';

export interface Proposal {
  /** 0..1 per pixel */
  prob: Float32Array;
  /** the segmenter's own estimate of how good the mask is */
  iou: number;
}

export interface ConsensusOptions {
  /** how far (px) the object may be from where the motion put it; default 3.5% of the width */
  margin?: number;
  /** share of a proposal that must lie on the prediction (with margin) for it to be the object's (default 0.93) */
  precision?: number;
  /** proposals smaller than this share of the prediction are ignored (default 0.004) */
  minShare?: number;
  /** the flow from this frame to the previous one (as `denseFlow(this, previous)`): the object moves differently from the background, and a proposal that moves with the background is not the object */
  flow?: { u: Float32Array; v: Float32Array };
  /** the previous and this frame (gray): with the object's and the background's motion they show which of the two explains each pixel */
  frames?: { prev: Gray; cur: Gray };
  /** per pixel, how much the colour looks like the marked object (0..1): a proposal in colours the object never had is not the object */
  evidence?: Float32Array;
  /** per pixel, 1 where the colour is one the object never had (its palette gives it next to no probability) */
  never?: Uint8Array;
}

export interface Consensus {
  alpha: Float32Array;
  /** share of the prediction that the accepted proposals cover (0..1) */
  coverage: number;
  accepted: number;
  /** foreign proposals: other things on the frame that were kept out */
  foreign: number;
  /** how the matte was made: from proposals, from the single best-matching proposal, or no proposal fitted and the prediction stands */
  how: 'consensus' | 'best' | 'prediction' | 'hidden';
  /** the object's motion against the background's (px per frame), when the flow was given: below about 1.2 the motion tells nothing and was not used */
  motionSeparation?: number;
  /** what was decided about each proposal (for looking into a result) */
  trace?: { cx: number; cy: number; share: number; precision: number; looks: number; moves: string; verdict: string; motion?: number[] }[];
}

export interface Affine {
  a: number[];
  b: number[];
}
/** Robust affine fit of a flow field over some pixels: u = a0 + a1 x + a2 y, v = b0 + b1 x + b2 y (x, y centred on cx, cy). */
export function fitFlowAffine(pix: number[], w: number, flow: { u: Float32Array; v: Float32Array }, cx: number, cy: number): Affine | null {
  if (pix.length < 30) return null;
  let use = pix;
  let fit: Affine = { a: [0, 0, 0], b: [0, 0, 0] };
  for (let it = 0; it < 3; it++) {
    const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const ru = [0, 0, 0];
    const rv = [0, 0, 0];
    for (const i of use) {
      const x = (i % w) - cx;
      const y = Math.floor(i / w) - cy;
      const f = [1, x / 100, y / 100];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) M[3 * r + c]! += f[r]! * f[c]!;
        ru[r]! += f[r]! * flow.u[i]!;
        rv[r]! += f[r]! * flow.v[i]!;
      }
    }
    const solve = (rhs: number[]): number[] | null => {
      const A = [M.slice(0, 3).concat(rhs[0]!), M.slice(3, 6).concat(rhs[1]!), M.slice(6, 9).concat(rhs[2]!)];
      for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
        if (Math.abs(A[p]![c]!) < 1e-9) return null;
        [A[c], A[p]] = [A[p]!, A[c]!];
        for (let r = 0; r < 3; r++) {
          if (r === c) continue;
          const k = A[r]![c]! / A[c]![c]!;
          for (let cc = c; cc < 4; cc++) A[r]![cc]! -= k * A[c]![cc]!;
        }
      }
      return [A[0]![3]! / A[0]![0]!, A[1]![3]! / A[1]![1]!, A[2]![3]! / A[2]![2]!];
    };
    const sa = solve(ru);
    const sb = solve(rv);
    if (!sa || !sb) return it ? fit : null;
    fit = { a: [sa[0]!, sa[1]! / 100, sa[2]! / 100], b: [sb[0]!, sb[1]! / 100, sb[2]! / 100] };
    const res = use.map((i) => {
      const x = (i % w) - cx;
      const y = Math.floor(i / w) - cy;
      return { i, r: Math.hypot(flow.u[i]! - (fit.a[0]! + fit.a[1]! * x + fit.a[2]! * y), flow.v[i]! - (fit.b[0]! + fit.b[1]! * x + fit.b[2]! * y)) };
    });
    res.sort((p, q) => p.r - q.r);
    use = res.slice(0, Math.max(30, Math.round(res.length * 0.7))).map((q) => q.i);
  }
  return fit;
}

const area = (m: Uint8Array): number => {
  let c = 0;
  for (let i = 0; i < m.length; i++) c += m[i]!;
  return c;
};

/**
 * Layered motion labels: for every pixel, which motion explains it better: the object's (+1) or the background's (-1), 0 where
 * both do (flat colour, or the two motions are alike there). The previous frame is sampled where each motion says the pixel came
 * from, and the difference to this frame is averaged over a small window.
 */
function motionLabels(mA: Affine, mB: Affine, cx: number, cy: number, f: { prev: Gray; cur: Gray }, w: number, h: number): { lab: Float32Array; rA: Float32Array; rB: Float32Array } {
  const n = w * h;
  const rA = new Float32Array(n);
  const rB = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - cx;
      const dy = y - cy;
      const c = f.cur.d[i]!;
      rA[i] = Math.abs(c - bilinear(f.prev.d, w, h, x + mA.a[0]! + mA.a[1]! * dx + mA.a[2]! * dy, y + mA.b[0]! + mA.b[1]! * dx + mA.b[2]! * dy));
      rB[i] = Math.abs(c - bilinear(f.prev.d, w, h, x + mB.a[0]! + mB.a[1]! * dx + mB.a[2]! * dy, y + mB.b[0]! + mB.b[1]! * dx + mB.b[2]! * dy));
    }
  const r = 3;
  const box = (src: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    const tmp = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]!;
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc;
        acc += src[y * w + Math.min(w - 1, x + r + 1)]! - src[y * w + Math.max(0, x - r)]!;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / ((2 * r + 1) ** 2);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
      }
    }
    return out;
  };
  const a = box(rA);
  const b = box(rB);
  const lab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = b[i]! - a[i]!; // > 0: the object's motion explains the pixel better
    const scale = Math.max(a[i]!, b[i]!);
    lab[i] = Math.abs(d) < Math.max(2, 0.2 * scale) ? 0 : d > 0 ? 1 : -1;
  }
  return { lab, rA, rB };
}

/**
 * @param predicted the previous matte carried to this frame by the object's motion (0..1)
 * @param props the segmenter's proposals on this frame
 */
export function consensusMask(predicted: Float32Array, props: Proposal[], w: number, h: number, o: ConsensusOptions = {}): Consensus {
  const n = w * h;
  const P = new Uint8Array(n);
  for (let i = 0; i < n; i++) P[i] = predicted[i]! > 0.5 ? 1 : 0;
  const pArea = area(P);
  const margin = Math.max(3, Math.round(o.margin ?? 0.035 * w));
  const Pd = morph(P, w, h, margin, true);
  const Pc = morph(P, w, h, Math.max(2, Math.round(margin * 0.6)), false);
  const prec = o.precision ?? 0.93;
  const minArea = Math.max(20, (o.minShare ?? 0.004) * pArea);
  // The object's motion and the background's, as affine fits of the flow: on the middle of the prediction, and on a ring far from it.
  let mA: Affine | null = null;
  let mB: Affine | null = null;
  let separation: number | undefined;
  let mcx = 0;
  let mcy = 0;
  if (o.flow) {
    const far = morph(P, w, h, margin * 4, true);
    const near = morph(P, w, h, margin * 2, true);
    const inner: number[] = [];
    const ring: number[] = [];
    let cx = 0, cy = 0, cc = 0;
    const smallObj = area(Pc) < 40;
    for (let i = 0; i < n; i += smallObj ? 1 : 2) {
      if (smallObj ? P[i] : Pc[i]) (inner.push(i), (cx += i % w), (cy += Math.floor(i / w)), cc++);
      else if (far[i] && !near[i]) ring.push(i);
    }
    if (cc) {
      cx /= cc; cy /= cc;
      mcx = cx; mcy = cy;
      mA = fitFlowAffine(inner, w, o.flow, cx, cy);
      if (!mA) {
        // a small object has no middle to speak of: its whole prediction, and a plain shift if that is too little for more
        const all: number[] = [];
        for (let i = 0; i < n; i++) if (P[i]) all.push(i);
        mA = fitFlowAffine(all, w, o.flow, cx, cy);
        if (!mA && all.length >= 6) {
          const us = all.map((i) => o.flow!.u[i]!).sort((x, y) => x - y);
          const vs = all.map((i) => o.flow!.v[i]!).sort((x, y) => x - y);
          mA = { a: [us[Math.floor(us.length / 2)]!, 0, 0], b: [vs[Math.floor(vs.length / 2)]!, 0, 0] };
        }
      }
      mB = fitFlowAffine(ring, w, o.flow, cx, cy);
      if (mA && mB) {
        let sep = 0;
        for (const i of inner) {
          const x = (i % w) - cx, y = Math.floor(i / w) - cy;
          sep += Math.hypot(mA.a[0]! + mA.a[1]! * x + mA.a[2]! * y - (mB.a[0]! + mB.a[1]! * x + mB.a[2]! * y), mA.b[0]! + mA.b[1]! * x + mA.b[2]! * y - (mB.b[0]! + mB.b[1]! * x + mB.b[2]! * y));
        }
        separation = sep / inner.length;
        if (separation < 1.2) (mA = null, (mB = null));
      }
    }
  }
  const ml = mA && mB && o.frames ? motionLabels(mA, mB, mcx, mcy, o.frames, w, h) : null;
  const labels = ml ? ml.lab : null;
  let lastMotion: number[] | undefined;
  const moves = (C: Uint8Array): 'object' | 'background' | 'unknown' => {
    lastMotion = undefined;
    if (ml) {
      // the proposal's inside (away from its edge, where the other layer shows through): which motion explains it better, summed over
      // all its pixels, so that a few textured places (eyes, hair, a seam) decide where the rest is flat
      const inner = morph(C, w, h, 3, false);
      let sA = 0, sB = 0, k = 0;
      for (let i = 0; i < n; i += 2)
        if (inner[i]) {
          k++;
          sA += ml.rA[i]!;
          sB += ml.rB[i]!;
        }
      lastMotion = [k, Math.round((100 * sA) / Math.max(1, k)) / 100, Math.round((100 * sB) / Math.max(1, k)) / 100];
      if (k >= 40 && sA + sB >= 0.05 * k) return sB < 0.6 * sA ? 'background' : sA < 0.6 * sB ? 'object' : 'unknown';
    }
    if (!mA || !mB || !o.flow) return 'unknown';
    let rA = 0, rB = 0, k = 0;
    for (let i = 0; i < n; i += 2)
      if (C[i]) {
        const x = (i % w) - mcx, y = Math.floor(i / w) - mcy;
        const u = o.flow.u[i]!, v = o.flow.v[i]!;
        rA += Math.hypot(u - (mA.a[0]! + mA.a[1]! * x + mA.a[2]! * y), v - (mA.b[0]! + mA.b[1]! * x + mA.b[2]! * y));
        rB += Math.hypot(u - (mB.a[0]! + mB.a[1]! * x + mB.a[2]! * y), v - (mB.b[0]! + mB.b[1]! * x + mB.b[2]! * y));
        k++;
      }
    if (k < 15) return 'unknown';
    rA /= k; rB /= k;
    return rB < 0.55 * rA && rB < 1.2 ? 'background' : rA < 0.55 * rB ? 'object' : 'unknown';
  };
  const accepted: Uint8Array[] = [];
  const trace: NonNullable<Consensus['trace']> = [];
  const foreign = new Uint8Array(n);
  let nForeign = 0;
  let best: { m: Uint8Array; iou: number } | null = null;
  for (const pr of props) {
    const C = new Uint8Array(n);
    let a = 0;
    let inD = 0;
    let inP = 0;
    let ev = 0;
    for (let i = 0; i < n; i++)
      if (pr.prob[i]! > 0.5) {
        C[i] = 1;
        a++;
        if (Pd[i]) inD++;
        if (P[i]) inP++;
        if (o.evidence) ev += o.evidence[i]!;
      }
    if (a < minArea) continue;
    const uni = a + pArea - inP;
    const iou = uni ? inP / uni : 0;
    const mv = moves(C);
    const looks = o.evidence ? ev / a : 1;
    // something that moves with the background, or is in colours the object never had, is another thing
    const notObject = mv === 'background' || looks < 0.3;
    {
      let sx = 0, sy = 0;
      for (let i = 0; i < n; i += 4) if (C[i]) (sx += i % w, (sy += Math.floor(i / w)));
      const q = Math.max(1, area(C) / 4);
      trace.push({ cx: Math.round(sx / q), cy: Math.round(sy / q), share: Math.round((100 * a) / Math.max(1, pArea)) / 100, precision: Math.round((100 * inD) / a) / 100, looks: Math.round(looks * 100) / 100, moves: mv, verdict: notObject ? 'foreign' : inD / a >= prec ? 'accepted' : 'too far outside', ...(lastMotion ? { motion: lastMotion } : {}) });
    }
    if (!notObject && (!best || iou > best.iou)) best = { m: C, iou };
    if (!notObject && inD / a >= prec) accepted.push(C);
    else if (notObject && a > 0.004 * n * 0.3) {
      for (let i = 0; i < n; i++) if (C[i]) foreign[i] = 1;
      nForeign++;
    }
  }
  const union = new Uint8Array(n);
  for (const C of accepted) for (let i = 0; i < n; i++) if (C[i]) union[i] = 1;
  let cov = 0;
  for (let i = 0; i < n; i++) if (union[i] && P[i]) cov++;
  const coverage = pArea ? cov / pArea : 0;
  const out = new Float32Array(n);
  // The object's motion is known and differs from the background's, and every thing found where the object should be moves with the
  // background (a coat it went behind, the ground it is not on): the object is not in the picture here.
  if (mA && mB && accepted.length === 0 && trace.some((t) => t.moves === 'background' && t.verdict === 'foreign')) {
    return { alpha: new Float32Array(n), coverage: 0, accepted: 0, foreign: nForeign, how: 'hidden', trace, ...(separation !== undefined ? { motionSeparation: separation } : {}) };
  }
  if (accepted.length && coverage >= 0.5) {
    // the object: the accepted proposals, and the middle of the prediction where they left a hole, except what is another thing
    for (let i = 0; i < n; i++) out[i] = union[i] || (Pc[i] && !foreign[i]) ? 1 : 0;
    // Things that stick out of the object and are plainly something else, in colours the object never had or moving with the
    // background, are taken out, also where a big proposal carried them in (an object and the thing it touches, as one mask).
    // What is enclosed by the object (the inside of a mouth, a dark button) is its own and stays.
    {
      const fp = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (out[i] && ((o.never && o.never[i]) || (o.evidence && o.evidence[i]! < 0.2) || (labels && labels[i]! < 0))) fp[i] = 1;
      const fc = components(fp, w, h);
      let rArea = 0;
      for (let i = 0; i < n; i++) rArea += out[i]! > 0.5 ? 1 : 0;
      const minBlob = Math.max(25, 0.003 * rArea);
      const sticks = new Uint8Array(fc.sizes.length);
      for (let i = 0; i < n; i++)
        if (fc.id[i]) {
          const x = i % w, y = Math.floor(i / w);
          if ((x > 0 && !out[i - 1]) || (x < w - 1 && !out[i + 1]) || (y > 0 && !out[i - w]) || (y < h - 1 && !out[i + w])) sticks[fc.id[i]!] = 1;
        }
      const drop = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (fc.id[i] && sticks[fc.id[i]!] && fc.sizes[fc.id[i]!]! >= minBlob) drop[i] = 1;
      const dropG = morph(drop, w, h, 2, true);
      for (let i = 0; i < n; i++) if (dropG[i]) out[i] = 0;
    }
    // thin leftovers of the union that are not connected to the main body are dropped (a sliver of wall between two proposals)
    const c = components(Uint8Array.from(out, (v) => (v > 0.5 ? 1 : 0)), w, h);
    if (c.sizes.length > 2) {
      let big = 1;
      for (let k = 1; k < c.sizes.length; k++) if (c.sizes[k]! > c.sizes[big]!) big = k;
      for (let i = 0; i < n; i++) if (out[i] && c.id[i] !== big && c.sizes[c.id[i]!]! < 0.15 * c.sizes[big]!) out[i] = 0;
    }
    return { alpha: out, coverage, accepted: accepted.length, foreign: nForeign, how: 'consensus', trace, ...(separation !== undefined ? { motionSeparation: separation } : {}) };
  }
  if (best && best.iou >= 0.5) {
    for (let i = 0; i < n; i++) out[i] = best.m[i]!;
    return { alpha: out, coverage, accepted: accepted.length, foreign: nForeign, how: 'best', trace, ...(separation !== undefined ? { motionSeparation: separation } : {}) };
  }
  out.set(predicted);
  return { alpha: out, coverage, accepted: accepted.length, foreign: nForeign, how: 'prediction', trace, ...(separation !== undefined ? { motionSeparation: separation } : {}) };
}

/** Prompts for the proposals on a frame: points spread over the prediction (each a question "what is here?"), and the whole of it as a box. */
export function proposalPrompts(predicted: Float32Array, w: number, h: number, count = 14): { points?: [number, number][]; labels?: number[]; box?: [number, number, number, number] }[] {
  const n = w * h;
  const m = new Uint8Array(n);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0;
  for (let i = 0; i < n; i++)
    if (predicted[i]! > 0.5) {
      m[i] = 1;
      const x = i % w, y = Math.floor(i / w);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cnt++;
    }
  if (cnt < 0.002 * n) return [];
  let inner = morph(m, w, h, Math.max(2, Math.round(0.008 * w)), false);
  if (!area(inner)) inner = m;
  // farthest-point sampling over the inner pixels (every 3rd pixel is enough): spreads the points over every part of the object
  const cand: number[] = [];
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) if (inner[y * w + x]) cand.push(y * w + x);
  if (!cand.length) return [];
  const chosen: number[] = [];
  let mx = 0, my = 0;
  for (const i of cand) (mx += i % w, my += Math.floor(i / w));
  mx /= cand.length; my /= cand.length;
  let first = cand[0]!, bd = 1e18;
  for (const i of cand) {
    const d = (i % w - mx) ** 2 + (Math.floor(i / w) - my) ** 2;
    if (d < bd) (bd = d, first = i);
  }
  chosen.push(first);
  const dist = new Float64Array(cand.length).fill(1e18);
  while (chosen.length < count) {
    const last = chosen[chosen.length - 1]!;
    let far = -1, fd = -1;
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k]!;
      const d = (i % w - (last % w)) ** 2 + (Math.floor(i / w) - Math.floor(last / w)) ** 2;
      if (d < dist[k]!) dist[k] = d;
      if (dist[k]! > fd) (fd = dist[k]!, far = k);
    }
    if (far < 0 || fd < (0.03 * w) ** 2) break;
    chosen.push(cand[far]!);
  }
  const out: { points?: [number, number][]; labels?: number[]; box?: [number, number, number, number] }[] = chosen.map((i) => ({ points: [[i % w, Math.floor(i / w)]], labels: [1] }));
  out.push({ box: [x0, y0, x1, y1] });
  return out;
}
