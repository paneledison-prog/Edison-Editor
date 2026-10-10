/**
 * Clean plate: what was behind an object, rebuilt from the frames where it was not in the way. Not generative: every pixel
 * of the fill is a pixel that exists in another frame of the shot, carried over by the camera's motion (a homography fitted to
 * the background); the little that is never visible anywhere is spread in from its surroundings and counted as unfilled.
 */
import { trackPlane } from './planar.js';
import { frameQuad } from './geom.js';
import { inv3, mul3, type Mat3, I3 } from './linalg.js';
import type { Gray } from './image.js';
import { morph } from './segment.js';

export interface Registration {
  /** maps the reference frame's pixels to each frame's (the pixel size of the grays given), null where the camera could not be followed */
  H: (Mat3 | null)[];
  ref: number;
  /** frames where the fit was not trusted */
  lost: number[];
  /** mean of the feature matches the fits agreed with, and the worst rms (px) */
  meanInliers: number;
  maxRms: number;
}

/**
 * The camera's motion over a shot as one homography per frame, fitted to the background: the object (`holes`) is left out
 * of the region that is followed, and the fit is robust to what still gets in.
 */
export async function registerBackground(grays: Gray[], holes: Uint8Array[], o: { ref?: number } = {}): Promise<Registration> {
  const n = grays.length;
  const ref = Math.min(n - 1, Math.max(0, o.ref ?? Math.floor(n / 2)));
  const { w, h } = grays[ref]!;
  const H: (Mat3 | null)[] = new Array(n).fill(null);
  H[ref] = I3;
  const lost: number[] = [];
  let inl = 0;
  let cnt = 0;
  let maxRms = 0;
  const inset = 0.04;
  const quad = frameQuad(w, h).map(([x, y], i) => [x + (i === 0 || i === 3 ? 1 : -1) * inset * w, y + (i < 2 ? 1 : -1) * inset * h]) as ReturnType<typeof frameQuad>;
  for (const dir of [1, -1] as const) {
    const order: number[] = [];
    for (let i = ref + dir; i >= 0 && i < n; i += dir) order.push(i);
    if (!order.length) continue;
    let k = 0;
    for await (const r of trackPlane(grays[ref]!, quad, order.map((i) => grays[i]!), {
      model: 'homography',
      refine: true,
      exclude: (j) => (j < 0 ? holes[ref] : holes[order[j]!]),
    })) {
      const i = order[k++]!;
      H[i] = r.ok ? r.H : null;
      if (!r.ok) lost.push(i);
      else {
        inl += r.inliers;
        cnt++;
        maxRms = Math.max(maxRms, r.rms);
      }
    }
  }
  // a frame that could not be followed takes the motion of the nearest one that could
  for (let i = 0; i < n; i++) {
    if (H[i]) continue;
    for (let d = 1; d < n && !H[i]; d++) H[i] = H[i - d] ?? H[i + d] ?? null;
  }
  return { H, ref, lost: lost.sort((a, b) => a - b), meanInliers: cnt ? inl / cnt : 0, maxRms };
}

export interface PlateResult {
  /** the frames with the holes filled (RGB bytes), the rest untouched */
  frames: Uint8Array[];
  /** per frame: the share of hole pixels filled from other frames, and the share that had to be spread in from the surroundings */
  filled: number[];
  spread: number[];
}

const scaleH = (H: Mat3, k: number): Mat3 => mul3(mul3([k, 0, 0, 0, k, 0, 0, 0, 1], H), [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1]);

/**
 * Fills `holes[t]` (1 = remove) of every frame from the other frames. `H` maps a reference frame to each frame at the pixel size
 * `hk` times that of `frames` (so the registration can be made at a smaller size than the fill). `cuts` are frame indices that
 * start a new shot: nothing is taken across them.
 */
export function cleanPlate(frames: Uint8Array[], holes: Uint8Array[], w: number, h: number, H: (Mat3 | null)[], o: { scale?: number; cuts?: number[]; sources?: number } = {}): PlateResult {
  const N = frames.length;
  const k = o.scale ?? 1;
  const HH = H.map((m) => (m ? scaleH(m, k) : null));
  const cutAt = [0, ...(o.cuts ?? []), N];
  const shotOf = new Int32Array(N);
  for (let s = 0; s + 1 < cutAt.length; s++) for (let i = cutAt[s]!; i < cutAt[s + 1]!; i++) shotOf[i] = s;
  const out: Uint8Array[] = frames.map((f) => f.slice());
  const filled: number[] = [];
  const spread: number[] = [];
  const maxSrc = o.sources ?? 24;
  // a margin of the holes themselves is not trusted as a source either (the matte's soft edge)
  const bad = holes.map((m) => morph(m, w, h, 2, true));
  const bil = (img: Uint8Array, x: number, y: number, c: number): number => {
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 3 + c;
    return (img[i00]! * (1 - fx) + img[i00 + 3]! * fx) * (1 - fy) + (img[i00 + 3 * w]! * (1 - fx) + img[i00 + 3 * w + 3]! * fx) * fy;
  };
  for (let t = 0; t < N; t++) {
    const hole = holes[t]!;
    const px: number[] = [];
    for (let i = 0; i < hole.length; i++) if (hole[i]) px.push(i);
    if (!px.length) {
      filled.push(1);
      spread.push(0);
      continue;
    }
    const Ht = HH[t];
    const Hti = Ht ? inv3(Ht) : null;
    // the frames to look at: the shot's frames, nearest first, spread out so that a long shot is sampled evenly
    const cands: number[] = [];
    for (let d = 1; d < N; d++) for (const s of [t - d, t + d]) if (s >= 0 && s < N && shotOf[s] === shotOf[t] && HH[s]) cands.push(s);
    const step = Math.max(1, Math.ceil(cands.length / maxSrc));
    const srcs = cands.filter((_, i) => i % step === 0).slice(0, maxSrc);
    const vals: number[][] = px.map(() => []); // per hole pixel: r,g,b triples of the candidates
    if (Hti)
      for (const s of srcs) {
        const M = mul3(HH[s]!, Hti); // t -> s
        const bs = bad[s]!;
        const fs = frames[s]!;
        for (let j = 0; j < px.length; j++) {
          const p = px[j]!;
          const x = (p % w) + 0.5;
          const y = Math.floor(p / w) + 0.5;
          const z = M[6]! * x + M[7]! * y + M[8]!;
          const qx = (M[0]! * x + M[1]! * y + M[2]!) / z - 0.5;
          const qy = (M[3]! * x + M[4]! * y + M[5]!) / z - 0.5;
          if (!(qx >= 0 && qy >= 0 && qx < w - 1 && qy < h - 1)) continue;
          if (bs[Math.round(qy) * w + Math.round(qx)]) continue;
          // the neighbours of the sample must not be hole either (bilinear)
          if (bs[(qy | 0) * w + (qx | 0)] || bs[(qy | 0) * w + (qx | 0) + 1] || bs[((qy | 0) + 1) * w + (qx | 0)] || bs[((qy | 0) + 1) * w + (qx | 0) + 1]) continue;
          vals[j]!.push(bil(fs, qx, qy, 0), bil(fs, qx, qy, 1), bil(fs, qx, qy, 2));
        }
      }
    // the candidate nearest to all the others (a medoid): the fill is a real colour seen somewhere, not a mixture
    const known = new Uint8Array(w * h);
    const o2 = out[t]!;
    let nFilled = 0;
    px.forEach((p, j) => {
      const v = vals[j]!;
      const m = v.length / 3;
      if (!m) return;
      let best = 0;
      if (m > 2) {
        let bd = Infinity;
        for (let a = 0; a < m; a++) {
          let d = 0;
          for (let b = 0; b < m; b++) d += Math.hypot(v[3 * a]! - v[3 * b]!, v[3 * a + 1]! - v[3 * b + 1]!, v[3 * a + 2]! - v[3 * b + 2]!);
          if (d < bd) (bd = d, (best = a));
        }
      }
      o2[3 * p] = Math.round(v[3 * best]!);
      o2[3 * p + 1] = Math.round(v[3 * best + 1]!);
      o2[3 * p + 2] = Math.round(v[3 * best + 2]!);
      known[p] = 1;
      nFilled++;
    });
    // what no frame shows: spread in from the pixels around it (nearest known neighbours, repeated)
    let remaining = px.length - nFilled;
    const nSpread = remaining;
    if (remaining > 0) {
      const isKnown = new Uint8Array(w * h);
      for (let i = 0; i < isKnown.length; i++) isKnown[i] = hole[i] ? known[i]! : 1;
      for (let it = 0; it < 400 && remaining > 0; it++) {
        const next = isKnown.slice();
        for (const p of px) {
          if (isKnown[p]) continue;
          const x = p % w;
          const y = (p - x) / w;
          let r = 0, g = 0, b = 0, c = 0;
          for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
            if (q >= 0 && isKnown[q]) (r += o2[3 * q]!, (g += o2[3 * q + 1]!), (b += o2[3 * q + 2]!), c++);
          if (c) {
            o2[3 * p] = Math.round(r / c);
            o2[3 * p + 1] = Math.round(g / c);
            o2[3 * p + 2] = Math.round(b / c);
            next[p] = 1;
            remaining--;
          }
        }
        isKnown.set(next);
      }
    }
    filled.push(nFilled / px.length);
    spread.push(nSpread / px.length);
  }
  return { frames: out, filled, spread };
}
