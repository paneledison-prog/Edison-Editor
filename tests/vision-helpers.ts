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

import { apply, inv3, mul3, warpHomography, type Mat3, type Pt, type Quad } from '../packages/vision/src/index.js';

/** A camera path over a flat world: the homography taking the world texture to frame i, as a smooth hand-held-ish move. */
export function cameraPath(frames: number, w: number, h: number, o: { amp?: number; rot?: number; zoom?: number; persp?: number; jitter?: number; seed?: number } = {}): Mat3[] {
  const R = rng(o.seed ?? 3);
  const amp = o.amp ?? 30;
  const out: Mat3[] = [];
  let jx = 0;
  let jy = 0;
  let jr = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / Math.max(1, frames - 1);
    jx = jx * 0.5 + ((R() - 0.5) * (o.jitter ?? 0));
    jy = jy * 0.5 + ((R() - 0.5) * (o.jitter ?? 0));
    jr = jr * 0.5 + ((R() - 0.5) * (o.jitter ?? 0) * 0.002);
    const tx = amp * Math.sin(2 * Math.PI * t * 0.8) + jx;
    const ty = amp * 0.5 * Math.sin(2 * Math.PI * t * 1.3 + 1) + jy;
    const a = ((o.rot ?? 3) * Math.PI) / 180 * Math.sin(2 * Math.PI * t * 0.6 + 0.5) + jr;
    const s = 1 + (o.zoom ?? 0.04) * Math.sin(2 * Math.PI * t * 0.5);
    const c = Math.cos(a) * s;
    const sn = Math.sin(a) * s;
    const p = (o.persp ?? 0) * Math.sin(2 * Math.PI * t * 0.7);
    const cx = w / 2;
    const cy = h / 2;
    // rotate/scale about the centre, then translate, then a touch of perspective
    const Hs: Mat3 = [c, -sn, cx - c * cx + sn * cy + tx, sn, c, cy - sn * cx - c * cy + ty, p / w, p / (2 * h), 1];
    out.push(Hs);
  }
  return out;
}

/** The frames of a camera over a textured plane: frame i(p) = world(H_i^-1 p). */
export function renderPlane(world: Gray, path: Mat3[], w: number, h: number, o: { occluder?: boolean; gain?: (i: number) => number; noise?: number } = {}): Gray[] {
  return path.map((H, i) => {
    const f = warpHomography(world, inv3(H)!, w, h);
    if (o.occluder) {
      // a dark block that crosses the picture
      const t = i / Math.max(1, path.length - 1);
      const x0 = Math.round(-60 + t * (w + 120));
      for (let y = Math.round(h * 0.3); y < Math.round(h * 0.7); y++)
        for (let x = x0; x < x0 + 60; x++) if (x >= 0 && x < w) f.d[y * w + x] = 0.05 + 0.1 * ((x + y) % 3) / 3;
    }
    if (o.gain) for (let k = 0; k < f.d.length; k++) f.d[k] = Math.min(1, f.d[k]! * o.gain(i));
    return o.noise ? noisy(f, o.noise, 100 + i) : f;
  });
}
import { rng } from '../packages/vision/src/index.js';
export const toBytes = (g: Gray): Uint8Array => Uint8Array.from(g.d, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
export type { Mat3, Pt, Quad };
export { apply, mul3, inv3 };
