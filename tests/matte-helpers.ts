import { texture } from './vision-helpers.js';
import { bilinear, rng } from '../packages/vision/src/index.js';

/** A textured object (a wobbly blob, turning, changing size, deforming) in front of a textured background that pans. */
export interface ObjectShot {
  w: number;
  h: number;
  /** RGB frames */
  frames: Uint8Array[];
  /** the true opacity of the object in each frame (0..1) */
  gt: Float32Array[];
  /** where the object is in each frame: centre x, y and mean radius in pixels */
  where: { x: number; y: number; r: number }[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type C3 = [number, number, number];
const ramp = (c1: C3, c2: C3, t: number): C3 => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

export function renderObjectShot(
  N: number,
  w: number,
  h: number,
  o: { seed?: number; occluder?: boolean; similar?: boolean; noise?: number; speed?: number; /** the background alone: what is behind the object */ noObject?: boolean } = {},
): ObjectShot {
  const bgTex = texture(w + 120, h + 80, 71 + (o.seed ?? 0));
  const fgTex = texture(256, 256, 91 + (o.seed ?? 0));
  const bgA: C3 = [30, 60, 100];
  const bgB: C3 = [140, 180, 225];
  const fgA: C3 = [110, 30, 25];
  const fgB: C3 = [250, 190, 110];
  const R = rng(5 + (o.seed ?? 0));
  const frames: Uint8Array[] = [];
  const gt: Float32Array[] = [];
  const where: ObjectShot['where'] = [];
  const sp = o.speed ?? 1;
  for (let i = 0; i < N; i++) {
    const t = (i / Math.max(1, N - 1)) * sp;
    const ox = 14 * Math.sin(2 * Math.PI * t * 0.7);
    const oy = 6 * Math.sin(2 * Math.PI * t * 1.1);
    const cx = w / 2 + 0.2 * w * Math.sin(2 * Math.PI * t * 0.6);
    const cy = h / 2 + 0.1 * h * Math.sin(2 * Math.PI * t * 0.9 + 1);
    const th = 0.35 * Math.sin(2 * Math.PI * t * 0.5);
    const s = 1 + 0.12 * Math.sin(2 * Math.PI * t * 0.8);
    const phi = 2 * Math.PI * t * 0.9;
    const R0 = 0.27 * h * s;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const img = new Uint8Array(w * h * 3);
    const a = new Float32Array(w * h);
    const occX = o.occluder ? Math.round(-50 + (i / Math.max(1, N - 1)) * (w + 100)) : -1000;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bg = ramp(bgA, bgB, bilinear(bgTex.d, bgTex.w, bgTex.h, x + 60 + ox, y + 40 + oy));
        // opacity by 3x3 supersampling of the shape
        let cov = 0;
        for (let sy = 0; sy < 3; sy++)
          for (let sx = 0; sx < 3; sx++) {
            const dx = x + (sx + 0.5) / 3 - 0.5 - cx;
            const dy = y + (sy + 0.5) / 3 - 0.5 - cy;
            const px = (ct * dx + st * dy) / R0;
            const py = (-st * dx + ct * dy) / R0;
            const ang = Math.atan2(py, px);
            const rr = 1 + 0.18 * Math.sin(3 * ang + phi) + 0.1 * Math.sin(5 * ang);
            if (Math.hypot(px, py) < rr) cov++;
          }
        cov /= 9;
        if (o.noObject) cov = 0;
        let col = bg;
        if (cov > 0) {
          const dx = x - cx;
          const dy = y - cy;
          const px = (ct * dx + st * dy) / R0;
          const py = (-st * dx + ct * dy) / R0;
          const g = bilinear(fgTex.d, fgTex.w, fgTex.h, (px + 1.4) * 90, (py + 1.4) * 90);
          // `similar`: the lower part of the object wears the background's colours, so colour alone cannot tell them apart
          const fgc = o.similar && py > 0.1 ? ramp(bgA, bgB, g) : ramp(fgA, fgB, g);
          col = ramp(bg, fgc, cov);
        }
        let alpha = cov;
        if (x >= occX && x < occX + 36 && y > h * 0.15 && y < h * 0.9) {
          col = [90 + 20 * ((x + y) % 3), 95 + 15 * ((x >> 2) % 2), 90]; // a dull bar in front of everything
          alpha = 0;
        }
        const k = y * w + x;
        a[k] = alpha;
        const n = o.noise ? o.noise * 255 : 0;
        for (let c = 0; c < 3; c++) {
          const nz = n ? Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R()) * n : 0;
          img[3 * k + c] = Math.max(0, Math.min(255, Math.round(col[c]! + nz)));
        }
      }
    frames.push(img);
    gt.push(a);
    where.push({ x: cx, y: cy, r: R0 });
  }
  return { w, h, frames, gt, where };
}

/** Intersection over union of a soft matte (taken at 0.5) with the truth (taken at 0.5). */
export function iou(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k]! > 0.5;
    const y = b[k]! > 0.5;
    if (x && y) i++;
    if (x || y) u++;
  }
  return u ? i / u : 1;
}
/** Mean absolute difference of two mattes. */
export const mae = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += Math.abs(a[k]! - b[k]!);
  return s / a.length;
};
