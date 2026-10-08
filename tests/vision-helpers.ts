import { newGray, rng, type Gray } from '../packages/vision/src/index.js';

/** A smooth random texture with detail at several scales: what a tracker sees on a real surface. Values 0..1. */
export function texture(w: number, h: number, seed = 1): Gray {
  const R = rng(seed);
  const g = newGray(w, h);
  let amp = 1;
  let tot = 0;
  for (const cell of [48, 24, 12, 6, 3]) {
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const grid = new Float32Array(gw * gh).map(() => R());
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const fx = x / cell;
        const fy = y / cell;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = grid[y0 * gw + x0]!;
        const b = grid[y0 * gw + x0 + 1]!;
        const c = grid[(y0 + 1) * gw + x0]!;
        const d = grid[(y0 + 1) * gw + x0 + 1]!;
        g.d[y * w + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      }
    tot += amp;
    amp *= 0.7;
  }
  for (let i = 0; i < g.d.length; i++) g.d[i] = g.d[i]! / tot;
  return g;
}

/** Adds Gaussian noise (Box-Muller), clamped to 0..1. */
export function noisy(g: Gray, sigma: number, seed = 7): Gray {
  const R = rng(seed);
  const o = newGray(g.w, g.h);
  for (let i = 0; i < g.d.length; i++) {
    const n = Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());
    o.d[i] = Math.min(1, Math.max(0, g.d[i]! + sigma * n));
  }
  return o;
}
