/**
 * The edge engine: what turns a rough mask into a matte, and keeps a matte steady over time.
 *
 *  - `refineEdge`: the mask (made at a low resolution) is brought to the picture's own resolution; in a thin band around its
 *    boundary the opacity is decided again from the picture with a colour guided filter, so the boundary follows real image
 *    edges at full resolution, and thin structures (hair, fabric edges) get fractional opacity instead of a staircase.
 *  - `estimateForeground`: the colour of the object with the old background taken out of the edge pixels (blur fusion,
 *    Forte and Pitie 2021), so a cut-out does not carry a halo of its old surroundings.
 *  - `smoothMattes`: flicker control. Each frame is compared with its neighbours carried onto it by optical flow; a pixel that
 *    differs from both neighbours while they agree with each other is a glitch of one frame and is replaced, and the rest of
 *    the boundary is averaged with the carried neighbours where they agree. Honest about its limits: it removes jitter and
 *    one-frame glitches, not a boundary that is wrong for many frames in a row.
 *  - `flickerOf`: the measure of it, so "steady" is a number.
 */
import { denseFlow, type Flow } from './flow.js';
import type { Gray } from './image.js';
import { morph, warpByFlow } from './segment.js';

// ----- box filters --------------------------------------------------------------------------------------------------------------------------

/** Mean over a (2r+1)^2 window with the edge replicated (separable running sums). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/** Bilinear resize of a plane. */
export function resizePlane(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src.slice();
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = sy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = sx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      out[y * dw + x] = (src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx) * (1 - ty) + (src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx) * ty;
    }
  }
  return out;
}

/** Splits interleaved RGB bytes into three planes in 0..1. */
export function planesOf(rgb: Uint8Array, n: number): [Float32Array, Float32Array, Float32Array] {
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgb[3 * i]! / 255;
    g[i] = rgb[3 * i + 1]! / 255;
    b[i] = rgb[3 * i + 2]! / 255;
  }
  return [r, g, b];
}

// ----- the colour guided filter -------------------------------------------------------------------------------------------------------------

/**
 * Guided filter (He, Sun and Tang) with a colour guide: the output is locally a linear function of the guide's colour, so it
 * has the guide's edges and the input's values. `eps` is the regularisation on the guide's variance (colour in 0..1).
 */
export function guidedFilterRGB(p: Float32Array, guide: [Float32Array, Float32Array, Float32Array], w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const [I1, I2, I3] = guide;
  const mI1 = boxMean(I1, w, h, r);
  const mI2 = boxMean(I2, w, h, r);
  const mI3 = boxMean(I3, w, h, r);
  const mp = boxMean(p, w, h, r);
  const prod = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = a[i]! * b[i]!;
    return boxMean(o, w, h, r);
  };
  const m11 = prod(I1, I1), m12 = prod(I1, I2), m13 = prod(I1, I3), m22 = prod(I2, I2), m23 = prod(I2, I3), m33 = prod(I3, I3);
  const mp1 = prod(I1, p), mp2 = prod(I2, p), mp3 = prod(I3, p);
  const a1 = new Float32Array(n), a2 = new Float32Array(n), a3 = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s11 = m11[i]! - mI1[i]! * mI1[i]! + eps;
    const s12 = m12[i]! - mI1[i]! * mI2[i]!;
    const s13 = m13[i]! - mI1[i]! * mI3[i]!;
    const s22 = m22[i]! - mI2[i]! * mI2[i]! + eps;
    const s23 = m23[i]! - mI2[i]! * mI3[i]!;
    const s33 = m33[i]! - mI3[i]! * mI3[i]! + eps;
    const c1 = mp1[i]! - mI1[i]! * mp[i]!;
    const c2 = mp2[i]! - mI2[i]! * mp[i]!;
    const c3 = mp3[i]! - mI3[i]! * mp[i]!;
    // solve the symmetric 3x3 system S a = c by its cofactors
    const k11 = s22 * s33 - s23 * s23;
    const k12 = s13 * s23 - s12 * s33;
    const k13 = s12 * s23 - s13 * s22;
    const k22 = s11 * s33 - s13 * s13;
    const k23 = s12 * s13 - s11 * s23;
    const k33 = s11 * s22 - s12 * s12;
    const det = s11 * k11 + s12 * k12 + s13 * k13 || 1e-9;
    a1[i] = (k11 * c1 + k12 * c2 + k13 * c3) / det;
    a2[i] = (k12 * c1 + k22 * c2 + k23 * c3) / det;
    a3[i] = (k13 * c1 + k23 * c2 + k33 * c3) / det;
    b[i] = mp[i]! - a1[i]! * mI1[i]! - a2[i]! * mI2[i]! - a3[i]! * mI3[i]!;
  }
  const ma1 = boxMean(a1, w, h, r), ma2 = boxMean(a2, w, h, r), ma3 = boxMean(a3, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma1[i]! * I1[i]! + ma2[i]! * I2[i]! + ma3[i]! * I3[i]! + mb[i]!;
  return q;
}

// ----- the edge ------------------------------------------------------------------------------------------------------------------------------

export interface EdgeOptions {
  /** half-width of the band around the boundary that is decided again, in px of the output (default 1.2% of the width) */
  band?: number;
  /** window of the guided filter, px (default 0.4% of the width) */
  radius?: number;
  /** how closely the boundary follows image edges (smaller = closer; colour variance, 0..1 scale; default 2e-3) */
  eps?: number;
  /** a wider band where the picture has fine detail around the boundary, for hair (default off) */
  hair?: boolean;
}

/**
 * The matte for a picture, from a mask made at another resolution. `alphaLow` is 0..1 at `lw x lh`; `rgb` is the picture
 * (`w x h`). Outside the band the opacity is the mask's (0 or 1); inside it, the guided filter's.
 */
export function refineEdge(rgb: Uint8Array, w: number, h: number, alphaLow: Float32Array, lw: number, lh: number, o: EdgeOptions = {}): Float32Array {
  const n = w * h;
  const up = resizePlane(alphaLow, lw, lh, w, h);
  const bandPx = Math.max(2, Math.round(o.band ?? 0.012 * w));
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = up[i]! > 0.5 ? 1 : 0;
  const sure = morph(inside, w, h, bandPx, false);
  const reach = morph(inside, w, h, bandPx, true);
  const guide = planesOf(rgb, n);
  const q = guidedFilterRGB(up, guide, w, h, Math.max(2, Math.round(o.radius ?? 0.004 * w)), o.eps ?? 2e-3);
  let wide: Uint8Array | null = null;
  if (o.hair) wide = morph(inside, w, h, bandPx * 3, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (sure[i]) out[i] = 1;
    else if (!reach[i] && !(wide && wide[i] && q[i]! > 0.08)) out[i] = 0;
    else {
      // a little contrast so the ramp across the edge is as narrow as the picture's
      const v = Math.min(1, Math.max(0, (q[i]! - 0.5) * 1.25 + 0.5));
      out[i] = v < 0.02 ? 0 : v > 0.98 ? 1 : v;
    }
  }
  return out;
}

// ----- the colour of the object --------------------------------------------------------------------------------------------------------------

/**
 * The colour of the object where the matte is partly transparent, with the background taken out (blur fusion). Returns RGB
 * bytes of the same picture where `alpha` is 1 and corrected values where it is fractional. `strength` 0..1 mixes the
 * corrected colour with the original at the edge.
 */
export function estimateForeground(rgb: Uint8Array, alpha: Float32Array, w: number, h: number, strength = 1): Uint8Array {
  const n = w * h;
  const I = planesOf(rgb, n);
  const r1 = Math.max(2, Math.round(0.02 * w));
  const r2 = Math.max(1, Math.round(0.002 * w));
  const out = new Uint8Array(n * 3);
  const F: Float32Array[] = [I[0].slice(), I[1].slice(), I[2].slice()];
  const B: Float32Array[] = [I[0].slice(), I[1].slice(), I[2].slice()];
  const fuse = (r: number) => {
    const ba = boxMean(alpha, w, h, r);
    const inv = new Float32Array(n);
    for (let i = 0; i < n; i++) inv[i] = 1 - alpha[i]!;
    const bia = boxMean(inv, w, h, r);
    for (let c = 0; c < 3; c++) {
      const fa = new Float32Array(n);
      const b1a = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        fa[i] = F[c]![i]! * alpha[i]!;
        b1a[i] = B[c]![i]! * inv[i]!;
      }
      const bf = boxMean(fa, w, h, r);
      const bb = boxMean(b1a, w, h, r);
      const nf = new Float32Array(n);
      const nb = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f = bf[i]! / (ba[i]! + 1e-5);
        const b = bb[i]! / (bia[i]! + 1e-5);
        nf[i] = Math.min(1, Math.max(0, f + alpha[i]! * (I[c]![i]! - alpha[i]! * f - inv[i]! * b)));
        nb[i] = b;
      }
      F[c] = nf;
      B[c] = nb;
    }
  };
  fuse(r1);
  fuse(r2);
  for (let i = 0; i < n; i++) {
    const a = alpha[i]!;
    // fully opaque or fully clear pixels keep the picture's colour; only the partly transparent ones are corrected
    const k = a >= 0.995 || a <= 0.005 ? 0 : strength;
    for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(255 * (I[c]![i]! * (1 - k) + F[c]![i]! * k));
  }
  return out;
}

// ----- keeping it steady over time -----------------------------------------------------------------------------------------------------------

const grayOfBytes = (rgb: Uint8Array, w: number, h: number): Gray => {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = (0.299 * rgb[3 * i]! + 0.587 * rgb[3 * i + 1]! + 0.114 * rgb[3 * i + 2]!) / 255;
  return { w, h, d };
};

export interface Steadiness {
  /** mean change of the opacity in the boundary band from one frame to the next, after carrying the last onto the next by optical flow (0..1) */
  flicker: number;
  /** mean difference of the opacity from the mean of both neighbours carried onto it: jitter (0..1) */
  jitter: number;
  /** frames compared */
  pairs: number;
}

function bandOf(a: Float32Array, w: number, h: number, r: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = a[i]! > 0.5 ? 1 : 0;
  const g = morph(m, w, h, r, true);
  const e = morph(m, w, h, r, false);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = g[i]! && !e[i]! ? 1 : 0;
  return out;
}

/** Flows needed to compare neighbours: for each frame, where its pixels are in the frame before and the frame after. */
export function flowsOf(frames: Uint8Array[], w: number, h: number, cutAt: Set<number>): { prev: (Flow | null)[]; next: (Flow | null)[] } {
  const grays = frames.map((f) => grayOfBytes(f, w, h));
  const prev: (Flow | null)[] = new Array(frames.length).fill(null);
  const next: (Flow | null)[] = new Array(frames.length).fill(null);
  for (let t = 0; t < frames.length; t++) {
    if (t > 0 && !cutAt.has(t)) prev[t] = denseFlow(grays[t]!, grays[t - 1]!, { levels: 4, iters: 3, radius: 5 });
    if (t + 1 < frames.length && !cutAt.has(t + 1)) next[t] = denseFlow(grays[t]!, grays[t + 1]!, { levels: 4, iters: 3, radius: 5 });
  }
  return { prev, next };
}


/** One frame steadied against its neighbours carried onto it (either may be null): glitches replaced, the rest averaged where they agree. */
function steadyFrame(cur: Float32Array, wp: Float32Array | null, wn: Float32Array | null, strength: number, out: Float32Array): void {
  const n = cur.length;
  for (let i = 0; i < n; i++) {
    const c = cur[i]!;
    if (wp && wn) {
      const p = wp[i]!;
      const q = wn[i]!;
      // a pixel unlike both neighbours while they agree with each other: a glitch of this frame alone
      if (Math.abs(p - q) < 0.25 && Math.abs(c - p) > 0.4 && Math.abs(c - q) > 0.4) out[i] = 0.5 * (p + q);
      else {
        const m = 0.5 * (p + q);
        const k = strength * (1 - Math.min(1, Math.abs(c - m) / 0.5)); // trust the neighbours where they and this frame are close
        out[i] = c + k * (m - c);
      }
    } else if (wp || wn) {
      const m = (wp ?? wn)![i]!;
      const k = 0.5 * strength * (1 - Math.min(1, Math.abs(c - m) / 0.5));
      out[i] = c + k * (m - c);
    }
  }
}

/** A flow field at another size: the same motion, in the pixels of the new size. */
export function scaleFlow(f: Flow, w: number, h: number): Flow {
  if (f.w === w && f.h === h) return f;
  const k = w / f.w;
  const u = resizePlane(f.u, f.w, f.h, w, h);
  const v = resizePlane(f.v, f.w, f.h, w, h);
  for (let i = 0; i < u.length; i++) (u[i] = u[i]! * k, (v[i] = v[i]! * (h / f.h)));
  return { w, h, u, v };
}

/**
 * Flicker control for mattes held as bytes at the picture's size (the finished matte, where the hair model's opacity flickers
 * from frame to frame). The motion comes from the analysis-size pictures. `fixed` frames are not changed.
 */
export function smoothMattesBytes(alphas: Uint8Array[], w: number, h: number, flows: { prev: (Flow | null)[]; next: (Flow | null)[] }, o: { fixed?: Set<number>; strength?: number } = {}): Uint8Array[] {
  const strength = Math.min(1, Math.max(0, o.strength ?? 0.7));
  const n = w * h;
  const toF = (a: Uint8Array) => Float32Array.from(a, (v) => v / 255);
  const out: Uint8Array[] = alphas.map((a) => a.slice());
  for (let t = 0; t < alphas.length; t++) {
    if (o.fixed?.has(t)) continue;
    const pf = flows.prev[t];
    const nf = flows.next[t];
    if (!pf && !nf) continue;
    const pa = pf ? scaleFlow(pf, w, h) : null;
    const na = nf ? scaleFlow(nf, w, h) : null;
    const wp = pa ? warpByFlow(toF(alphas[t - 1]!), w, h, pa.u, pa.v) : null;
    const wn = na ? warpByFlow(toF(alphas[t + 1]!), w, h, na.u, na.v) : null;
    const res = new Float32Array(n);
    steadyFrame(toF(alphas[t]!), wp, wn, strength, res);
    // only where the frame changed does the steadied value replace the original byte, so untouched pixels stay exact
    const cur = alphas[t]!;
    const dst = out[t]!;
    for (let i = 0; i < n; i++) {
      const v = Math.round(res[i]! * 255);
      if (Math.abs(v - cur[i]!) > 0) dst[i] = Math.min(255, Math.max(0, v));
    }
  }
  return out;
}

/** How steady a sequence of mattes is (lower is steadier). `frames` are the pictures at the matte's size. */
export function flickerOf(alphas: Float32Array[], frames: Uint8Array[], w: number, h: number, cuts: number[] = [], flows?: ReturnType<typeof flowsOf>): Steadiness {
  const cutAt = new Set(cuts);
  const fl = flows ?? flowsOf(frames, w, h, cutAt);
  let fs = 0, fn = 0, js = 0, jn = 0, pairs = 0;
  for (let t = 1; t < alphas.length; t++) {
    const pf = fl.prev[t];
    if (!pf) continue;
    const band = bandOf(alphas[t]!, w, h, 3);
    const wp = warpByFlow(alphas[t - 1]!, w, h, pf.u, pf.v);
    for (let i = 0; i < band.length; i++)
      if (band[i]) {
        fs += Math.abs(alphas[t]![i]! - wp[i]!);
        fn++;
      }
    pairs++;
    const nf = t + 1 < alphas.length ? fl.next[t] : null;
    if (nf) {
      const wn = warpByFlow(alphas[t + 1]!, w, h, nf.u, nf.v);
      for (let i = 0; i < band.length; i++)
        if (band[i]) {
          js += Math.abs(alphas[t]![i]! - 0.5 * (wp[i]! + wn[i]!));
          jn++;
        }
    }
  }
  return { flicker: fn ? fs / fn : 0, jitter: jn ? js / jn : 0, pairs };
}

/**
 * Steadies a sequence of mattes (0..1 planes at the pictures' size). `fixed` frames (marked by a person) are not changed.
 * `strength` 0..1 is how much of the neighbours is taken where they agree.
 */
export function smoothMattes(alphas: Float32Array[], frames: Uint8Array[], w: number, h: number, o: { cuts?: number[]; fixed?: Set<number>; strength?: number } = {}): { alphas: Float32Array[]; before: Steadiness; after: Steadiness } {
  const strength = Math.min(1, Math.max(0, o.strength ?? 0.7));
  const cutAt = new Set(o.cuts ?? []);
  const fixed = o.fixed ?? new Set<number>();
  const flows = flowsOf(frames, w, h, cutAt);
  const before = flickerOf(alphas, frames, w, h, o.cuts, flows);
  const n = w * h;
  const out: Float32Array[] = alphas.map((a) => a.slice());
  for (let t = 0; t < alphas.length; t++) {
    if (fixed.has(t)) continue;
    const pf = flows.prev[t];
    const nf = flows.next[t];
    if (!pf && !nf) continue;
    const cur = alphas[t]!;
    const wp = pf ? warpByFlow(alphas[t - 1]!, w, h, pf.u, pf.v) : null;
    const wn = nf ? warpByFlow(alphas[t + 1]!, w, h, nf.u, nf.v) : null;
    steadyFrame(cur, wp, wn, strength, out[t]!);
  }
  const after = flickerOf(out, frames, w, h, o.cuts, flows);
  return { alphas: out, before, after };
}
