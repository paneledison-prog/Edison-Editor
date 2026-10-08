/** Optical flow: sparse pyramidal Lucas-Kanade for tracking points, and a dense coarse-to-fine version for moving masks. */
import { bilinear, boxSum, gradients, newGray, pyramid, type Gray } from './image.js';
import type { Pt } from './geom.js';

export interface Pyr {
  levels: Gray[];
  gx: Float32Array[];
  gy: Float32Array[];
}
/** The image pyramid with gradients for each level (gradients are only needed for the image points are tracked FROM). */
export function buildPyr(g: Gray, levels = 4, withGrad = true): Pyr {
  const ls = pyramid(g, levels);
  const gx: Float32Array[] = [];
  const gy: Float32Array[] = [];
  if (withGrad)
    for (const l of ls) {
      const gr = gradients(l);
      gx.push(gr.gx);
      gy.push(gr.gy);
    }
  return { levels: ls, gx, gy };
}

export interface Track {
  x: number;
  y: number;
  ok: boolean;
  /** mean absolute intensity difference over the window at the end (0..1) */
  err: number;
}

/**
 * Follows points from `a` to `b` (both pyramids; `a` needs gradients). Bouguet's pyramidal Lucas-Kanade: at each level a
 * (2r+1)^2 window is matched by Gauss-Newton iterations, starting from the motion found one level up. `guess` can seed it with
 * a predicted position per point (for a fast, steady camera). A point fails when its window leaves the image, when the patch
 * has no texture, or when the iterations do not settle.
 */
export function trackPoints(a: Pyr, b: Pyr, pts: Pt[], o: { radius?: number; iters?: number; eps?: number; guess?: Pt[]; minEig?: number } = {}): Track[] {
  const r = o.radius ?? 7;
  const maxIter = o.iters ?? 24;
  const eps = o.eps ?? 0.01;
  const minEig = o.minEig ?? 1e-4;
  const L = Math.min(a.levels.length, b.levels.length);
  const win = (2 * r + 1) * (2 * r + 1);
  const I = new Float32Array(win);
  const Ix = new Float32Array(win);
  const Iy = new Float32Array(win);
  const out: Track[] = [];
  for (let k = 0; k < pts.length; k++) {
    const [x0, y0] = pts[k]!;
    const gu = o.guess?.[k];
    // the running guess is in the units of the level being solved, so a given full-size guess starts scaled down
    let gx = gu ? (gu[0] - x0) / (1 << (L - 1)) : 0;
    let gy = gu ? (gu[1] - y0) / (1 << (L - 1)) : 0;
    let ok = true;
    let err = 0;
    for (let lv = L - 1; lv >= 0 && ok; lv--) {
      const s = 1 << lv;
      const A = a.levels[lv]!;
      const B = b.levels[lv]!;
      const px = x0 / s;
      const py = y0 / s;
      // the window in the first image must be inside it
      if (px - r < 0 || py - r < 0 || px + r > A.w - 1 || py + r > A.h - 1) {
        if (lv === 0) ok = false;
        gx *= 2;
        gy *= 2;
        continue;
      }
      let g11 = 0, g12 = 0, g22 = 0;
      let n = 0;
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          const v = bilinear(A.d, A.w, A.h, px + i, py + j);
          const dx = bilinear(a.gx[lv]!, A.w, A.h, px + i, py + j);
          const dy = bilinear(a.gy[lv]!, A.w, A.h, px + i, py + j);
          I[n] = v;
          Ix[n] = dx;
          Iy[n] = dy;
          g11 += dx * dx;
          g12 += dx * dy;
          g22 += dy * dy;
          n++;
        }
      const det = g11 * g22 - g12 * g12;
      const eig = (g11 + g22) / 2 - Math.sqrt(Math.max(0, ((g11 - g22) / 2) ** 2 + g12 * g12));
      if (det < 1e-12 || eig / win < minEig * 0.01) {
        if (lv === 0) ok = false;
        gx *= 2;
        gy *= 2;
        continue;
      }
      let vx = gx; // motion in this level's pixels
      let vy = gy;
      let conv = false;
      for (let it = 0; it < maxIter; it++) {
        let b1 = 0, b2 = 0, sad = 0;
        n = 0;
        for (let j = -r; j <= r; j++)
          for (let i = -r; i <= r; i++) {
            const J = bilinear(B.d, B.w, B.h, px + i + vx, py + j + vy);
            const d = I[n]! - J;
            b1 += d * Ix[n]!;
            b2 += d * Iy[n]!;
            sad += Math.abs(d);
            n++;
          }
        const dx = (g22 * b1 - g12 * b2) / det;
        const dy = (g11 * b2 - g12 * b1) / det;
        vx += dx;
        vy += dy;
        err = sad / win;
        if (px + vx < -r || py + vy < -r || px + vx > B.w + r || py + vy > B.h + r) {
          ok = false;
          break;
        }
        if (Math.abs(dx) < eps && Math.abs(dy) < eps) {
          conv = true;
          break;
        }
      }
      if (lv === 0 && !conv && ok) ok = Math.hypot(vx - gx, vy - gy) < 40; // still moving: only trust a modest correction
      gx = lv === 0 ? vx : vx * 2;
      gy = lv === 0 ? vy : vy * 2;
    }
    const fx = x0 + gx;
    const fy = y0 + gy;
    const B0 = b.levels[0]!;
    if (fx < 0 || fy < 0 || fx > B0.w - 1 || fy > B0.h - 1) ok = false;
    out.push({ x: fx, y: fy, ok, err });
  }
  return out;
}

/**
 * Tracks forward, then back again from where each point landed; points that do not return within `fbThresh` pixels (and
 * those with a poor match) are dropped. This is the cheap test that catches occlusions and drifting.
 */
export function trackChecked(a: Pyr, b: Pyr, pts: Pt[], o: { fbThresh?: number; maxErr?: number; radius?: number; guess?: Pt[] } = {}): Track[] {
  const fw = trackPoints(a, b, pts, { radius: o.radius, guess: o.guess });
  const ok = fw.map((t) => t.ok);
  const idx = fw.map((_, i) => i).filter((i) => ok[i]);
  if (!idx.length) return fw;
  // back-tracking needs gradients of b
  const bw = trackPoints(b.gx.length ? b : { ...b, ...gradPyr(b) }, a, idx.map((i) => [fw[i]!.x, fw[i]!.y] as Pt), { radius: o.radius });
  const th = o.fbThresh ?? 1;
  const maxErr = o.maxErr ?? 0.12;
  idx.forEach((i, k) => {
    const back = bw[k]!;
    const d = Math.hypot(back.x - pts[i]![0], back.y - pts[i]![1]);
    fw[i]!.ok = back.ok && d <= th && fw[i]!.err <= maxErr;
  });
  return fw;
}
function gradPyr(p: Pyr): { gx: Float32Array[]; gy: Float32Array[] } {
  const gx: Float32Array[] = [];
  const gy: Float32Array[] = [];
  for (const l of p.levels) {
    const g = gradients(l);
    gx.push(g.gx);
    gy.push(g.gy);
  }
  return { gx, gy };
}

// ---------------------------------------------------------------------------------------------------------------
// dense flow

export interface Flow {
  w: number;
  h: number;
  u: Float32Array;
  v: Float32Array;
}

/**
 * A flow field from a to b: for every pixel, where it went. Coarse to fine; at each level the second image is warped by the
 * current estimate and the remaining motion solved from windowed sums of the gradient products (Lucas-Kanade per pixel),
 * with a light smoothing so flat areas follow their neighbours. Fine for the tens of pixels a mask moves between frames;
 * it does not do large motion of thin structure.
 */
export function denseFlow(a: Gray, b: Gray, o: { levels?: number; iters?: number; radius?: number } = {}): Flow {
  const levels = o.levels ?? 4;
  const iters = o.iters ?? 3;
  const r = o.radius ?? 5;
  const A = pyramid(a, levels);
  const B = pyramid(b, levels);
  const L = Math.min(A.length, B.length);
  let u = new Float32Array(A[L - 1]!.w * A[L - 1]!.h);
  let v = new Float32Array(u.length);
  for (let lv = L - 1; lv >= 0; lv--) {
    const IA = A[lv]!;
    const IB = B[lv]!;
    const { w, h } = IA;
    if (u.length !== w * h) {
      // up-sample the coarser flow (x2)
      const pw = A[lv + 1]!.w;
      const ph = A[lv + 1]!.h;
      const nu = new Float32Array(w * h);
      const nv = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          nu[y * w + x] = 2 * bilinear(u, pw, ph, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5);
          nv[y * w + x] = 2 * bilinear(v, pw, ph, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5);
        }
      u = nu;
      v = nv;
    }
    const g0 = gradients(IA);
    for (let it = 0; it < iters; it++) {
      const wd = newGray(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) wd.d[y * w + x] = bilinear(IB.d, w, h, x + u[y * w + x]!, y + v[y * w + x]!);
      const g1 = gradients(wd);
      const sxx = new Float32Array(w * h);
      const sxy = new Float32Array(w * h);
      const syy = new Float32Array(w * h);
      const sxt = new Float32Array(w * h);
      const syt = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const ix = (g0.gx[i]! + g1.gx[i]!) / 2;
        const iy = (g0.gy[i]! + g1.gy[i]!) / 2;
        const it_ = wd.d[i]! - IA.d[i]!;
        sxx[i] = ix * ix;
        sxy[i] = ix * iy;
        syy[i] = iy * iy;
        sxt[i] = ix * it_;
        syt[i] = iy * it_;
      }
      const Sxx = boxSum(sxx, w, h, r);
      const Sxy = boxSum(sxy, w, h, r);
      const Syy = boxSum(syy, w, h, r);
      const Sxt = boxSum(sxt, w, h, r);
      const Syt = boxSum(syt, w, h, r);
      const lam = 1e-3 * (2 * r + 1) ** 2 * 0.01;
      const du = new Float32Array(w * h);
      const dv = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const a11 = Sxx[i]! + lam;
        const a22 = Syy[i]! + lam;
        const a12 = Sxy[i]!;
        const det = a11 * a22 - a12 * a12;
        if (det < 1e-9) continue;
        du[i] = Math.max(-2, Math.min(2, (-a22 * Sxt[i]! + a12 * Syt[i]!) / det));
        dv[i] = Math.max(-2, Math.min(2, (a12 * Sxt[i]! - a11 * Syt[i]!) / det));
      }
      for (let i = 0; i < w * h; i++) {
        u[i] = u[i]! + du[i]!;
        v[i] = v[i]! + dv[i]!;
      }
      // light smoothing: average with the 4-neighbourhood
      const su = new Float32Array(w * h);
      const sv = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const l = x > 0 ? i - 1 : i;
          const rr = x < w - 1 ? i + 1 : i;
          const up = y > 0 ? i - w : i;
          const dn = y < h - 1 ? i + w : i;
          su[i] = (u[i]! * 2 + u[l]! + u[rr]! + u[up]! + u[dn]!) / 6;
          sv[i] = (v[i]! * 2 + v[l]! + v[rr]! + v[up]! + v[dn]!) / 6;
        }
      u = su;
      v = sv;
    }
  }
  return { w: A[0]!.w, h: A[0]!.h, u, v };
}
