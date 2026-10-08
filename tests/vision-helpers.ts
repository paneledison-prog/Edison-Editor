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

// ----- a 3D scene of textured planes ----------------------------------------------------------------------------------------------
import { len3, sub3, scale3, rot, type Pose, type Vec3 } from '../packages/vision/src/index.js';

export interface ScenePlane {
  /** corner, and the two edge vectors: X(s, t) = O + s U + t V for s, t in 0..1 */
  O: Vec3;
  U: Vec3;
  V: Vec3;
  tex: Gray;
}
const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

/** A camera at `C` looking at `target` with the given roll (radians); x right, y down, z forward. */
export function lookAt(C: Vec3, target: Vec3, roll = 0): Pose {
  const z = scale3(sub3(target, C), 1 / len3(sub3(target, C)));
  let x = cross([0, 1, 0], z);
  x = scale3(x, 1 / len3(x));
  let y = cross(z, x);
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const x2: Vec3 = [c * x[0] + s * y[0], c * x[1] + s * y[1], c * x[2] + s * y[2]];
    const y2: Vec3 = [-s * x[0] + c * y[0], -s * x[1] + c * y[1], -s * x[2] + c * y[2]];
    x = x2;
    y = y2;
  }
  const R: Mat3 = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
  return { R, t: scale3(rot(R, C), -1) };
}

/** The picture a pinhole camera (focal length f px, principal point at the centre) sees of the planes, painted far to near. */
export function renderScene(planes: ScenePlane[], f: number, poses: Pose[], w: number, h: number, o: { noise?: number; background?: number } = {}): Gray[] {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  return poses.map((pose, fi) => {
    const img = newGray(w, h);
    img.d.fill(o.background ?? 0.5);
    const order = planes
      .map((p) => {
        const mid: Vec3 = [p.O[0] + (p.U[0] + p.V[0]) / 2, p.O[1] + (p.U[1] + p.V[1]) / 2, p.O[2] + (p.U[2] + p.V[2]) / 2];
        return { p, depth: rot(pose.R, mid)[2] + pose.t[2] };
      })
      .sort((a, b) => b.depth - a.depth);
    for (const { p } of order) {
      const tw = p.tex.w;
      const th = p.tex.h;
      const c1 = scale3(rot(pose.R, p.U), 1 / tw);
      const c2 = scale3(rot(pose.R, p.V), 1 / th);
      const RO = rot(pose.R, p.O);
      const c3: Vec3 = [RO[0] + pose.t[0], RO[1] + pose.t[1], RO[2] + pose.t[2]];
      const Hf: Mat3 = [f * c1[0] + cx * c1[2], f * c2[0] + cx * c2[2], f * c3[0] + cx * c3[2], f * c1[1] + cy * c1[2], f * c2[1] + cy * c2[2], f * c3[1] + cy * c3[2], c1[2], c2[2], c3[2]];
      const Hi = inv3(Hf);
      if (!Hi) continue;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const ww = Hi[6]! * x + Hi[7]! * y + Hi[8]!;
          if (ww <= 0) continue;
          const a = (Hi[0]! * x + Hi[1]! * y + Hi[2]!) / ww;
          const b = (Hi[3]! * x + Hi[4]! * y + Hi[5]!) / ww;
          if (a < 0 || b < 0 || a > tw - 1 || b > th - 1) continue;
          img.d[y * w + x] = bilinearAt(p.tex, a, b);
        }
    }
    return o.noise ? noisy(img, o.noise, 500 + fi) : img;
  });
}
import { bilinear as bilinearRaw } from '../packages/vision/src/index.js';
const bilinearAt = (g: Gray, x: number, y: number) => bilinearRaw(g.d, g.w, g.h, x, y);
