/** Corner detection (Shi-Tomasi: the smaller eigenvalue of the local gradient tensor) with even coverage. */
import { blur, gradients, type Gray } from './image.js';
import type { Pt } from './geom.js';

export interface Corner {
  /** sub-pixel position */
  x: number;
  y: number;
  score: number;
}

/**
 * Corners of a gray image, best first. `minDist` keeps them apart; `mask` (same size, nonzero = allowed) restricts where they
 * may be; `border` keeps them off the edge so a tracking window fits. The best corner in each cell of a grid is taken first,
 * so features cover the picture instead of piling up on its most textured patch.
 */
export function detectCorners(
  g: Gray,
  o: { max?: number; quality?: number; minDist?: number; border?: number; mask?: Uint8Array; win?: number } = {},
): Corner[] {
  const { w, h } = g;
  const max = o.max ?? 300;
  const border = o.border ?? 8;
  const minDist = o.minDist ?? 8;
  const { gx, gy } = gradients(g);
  const A = new Float32Array(w * h);
  const B = new Float32Array(w * h);
  const C = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    A[i] = gx[i]! * gx[i]!;
    B[i] = gx[i]! * gy[i]!;
    C[i] = gy[i]! * gy[i]!;
  }
  // a Gaussian window, so a corner has one peak (a flat window gives a plateau whose position is arbitrary)
  const sg = o.win ?? 1.5;
  const a = blur({ w, h, d: A }, sg).d;
  const b = blur({ w, h, d: B }, sg).d;
  const c = blur({ w, h, d: C }, sg).d;
  const score = new Float32Array(w * h);
  let top = 0;
  for (let y = border; y < h - border; y++)
    for (let x = border; x < w - border; x++) {
      const i = y * w + x;
      if (o.mask && !o.mask[i]) continue;
      const tr = (a[i]! + c[i]!) / 2;
      const det = Math.sqrt(Math.max(0, ((a[i]! - c[i]!) / 2) ** 2 + b[i]! * b[i]!));
      const s = tr - det;
      score[i] = s;
      if (s > top) top = s;
    }
  if (top <= 0) return [];
  const thresh = top * (o.quality ?? 0.02);
  // local maxima
  const cand: Corner[] = [];
  for (let y = border; y < h - border; y++)
    for (let x = border; x < w - border; x++) {
      const s = score[y * w + x]!;
      if (s < thresh) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++)
        for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && score[(y + dy) * w + x + dx]! > s) isMax = false;
      if (!isMax) continue;
      // parabola through the neighbours: where the peak really is, to a fraction of a pixel
      const sl = score[y * w + x - 1]!, sr = score[y * w + x + 1]!, su = score[(y - 1) * w + x]!, sd = score[(y + 1) * w + x]!;
      const fx = sl - 2 * s + sr;
      const fy = su - 2 * s + sd;
      const dx = fx < -1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (sl - sr)) / fx)) : 0;
      const dy = fy < -1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (su - sd)) / fy)) : 0;
      cand.push({ x: x + dx, y: y + dy, score: s });
    }
  cand.sort((p, q) => q.score - p.score);
  // grid first: the best of every cell, then the rest by score
  const cells = Math.max(1, Math.round(Math.sqrt(max)));
  const cw = (w - 2 * border) / cells;
  const ch = (h - 2 * border) / cells;
  const taken = new Uint8Array(w * h);
  const pts = new Map<number, Corner>();
  const out: Corner[] = [];
  const free = (p: Corner) => {
    const m = Math.ceil(minDist);
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    for (let dy = -m; dy <= m; dy++)
      for (let dx = -m; dx <= m; dx++) {
        const xx = px + dx;
        const yy = py + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && taken[yy * w + xx]) {
          const q = pts.get(yy * w + xx)!;
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minDist * minDist) return false;
        }
      }
    return true;
  };
  const take = (p: Corner) => {
    out.push(p);
    taken[Math.round(p.y) * w + Math.round(p.x)] = 1;
    pts.set(Math.round(p.y) * w + Math.round(p.x), p);
  };
  const best = new Map<number, Corner>();
  for (const p of cand) {
    const key = Math.floor((p.y - border) / ch) * cells + Math.floor((p.x - border) / cw);
    if (!best.has(key)) best.set(key, p);
  }
  for (const p of [...best.values()].sort((p, q) => q.score - p.score)) if (out.length < max && free(p)) take(p);
  for (const p of cand) if (out.length < max && free(p)) take(p);
  return out;
}
export const cornerPoints = (cs: Corner[]): Pt[] => cs.map((c) => [c.x, c.y]);
