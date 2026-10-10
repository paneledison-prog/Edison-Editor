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
    // The frames to look at: the shot's frames, nearest in time first. Each pixel of the hole takes its colour from the nearest
    // frame that saw it: what was behind the object then is most like what is behind it now (people sway, light changes), and
    // neighbouring pixels mostly come from the same frame, so the fill is one picture, not a patchwork of many.
    const cands: number[] = [];
    for (let d = 1; d < N; d++) for (const s of [t - d, t + d]) if (s >= 0 && s < N && shotOf[s] === shotOf[t] && HH[s]) cands.push(s);
    const srcs = cands.slice(0, Math.max(maxSrc, 1) * 3);
    const o2 = out[t]!;
    const known = new Uint8Array(w * h);
    const fromFrame = new Int32Array(w * h).fill(-1);
    let nFilled = 0;
    const sample = (s: number, M: Mat3, p: number, dst: Uint8Array, at: number): boolean => {
      const x = (p % w) + 0.5;
      const y = Math.floor(p / w) + 0.5;
      const z = M[6]! * x + M[7]! * y + M[8]!;
      const qx = (M[0]! * x + M[1]! * y + M[2]!) / z - 0.5;
      const qy = (M[3]! * x + M[4]! * y + M[5]!) / z - 0.5;
      if (!(qx >= 0 && qy >= 0 && qx < w - 1 && qy < h - 1)) return false;
      const bs = bad[s]!;
      // the sample and its bilinear neighbours must not be hole there
      if (bs[(qy | 0) * w + (qx | 0)] || bs[(qy | 0) * w + (qx | 0) + 1] || bs[((qy | 0) + 1) * w + (qx | 0)] || bs[((qy | 0) + 1) * w + (qx | 0) + 1]) return false;
      const fs = frames[s]!;
      dst[at] = Math.round(bil(fs, qx, qy, 0));
      dst[at + 1] = Math.round(bil(fs, qx, qy, 1));
      dst[at + 2] = Math.round(bil(fs, qx, qy, 2));
      return true;
    };
    if (Hti) {
      const Ms = srcs.map((s) => mul3(HH[s]!, Hti)); // t -> s
      let left = px.slice();
      for (let k = 0; k < srcs.length && left.length; k++) {
        const s = srcs[k]!;
        const next: number[] = [];
        for (const p of left) {
          if (sample(s, Ms[k]!, p, o2, 3 * p)) {
            known[p] = 1;
            fromFrame[p] = s;
            nFilled++;
          } else next.push(p);
        }
        left = next;
      }
      // Seams: the fill is taken from other moments, a little brighter or darker or displaced; the difference to the picture
      // around the hole (measured on a ring just outside it, where both are known) is spread smoothly over the hole and added,
      // so the fill meets its surroundings without a visible edge.
      const ring = morph(hole, w, h, 2, true);
      const offR = new Float32Array(w * h);
      const offG = new Float32Array(w * h);
      const offB = new Float32Array(w * h);
      const wt = new Float32Array(w * h);
      const tmp = new Uint8Array(3);
      for (let p = 0; p < w * h; p++) {
        if (!ring[p] || hole[p]) continue;
        // what the same source would have given here: the source of the nearest hole pixel
        const x = p % w;
        const y = (p / w) | 0;
        let s = -1;
        for (let r = 1; r <= 3 && s < 0; r++)
          for (let dy = -r; dy <= r && s < 0; dy++)
            for (let dx = -r; dx <= r && s < 0; dx++) {
              const q = (y + dy) * w + (x + dx);
              if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h && hole[q] && fromFrame[q]! >= 0) s = fromFrame[q]!;
            }
        if (s < 0) continue;
        const ki = srcs.indexOf(s);
        if (ki < 0 || !sample(s, Ms[ki]!, p, tmp, 0)) continue;
        const cur = frames[t]!;
        offR[p] = cur[3 * p]! - tmp[0]!;
        offG[p] = cur[3 * p + 1]! - tmp[1]!;
        offB[p] = cur[3 * p + 2]! - tmp[2]!;
        wt[p] = 1;
      }
      const smooth = membrane([offR, offG, offB], wt, w, h);
      for (const p of px)
        if (known[p]) {
          o2[3 * p] = Math.max(0, Math.min(255, Math.round(o2[3 * p]! + smooth[0]![p]!)));
          o2[3 * p + 1] = Math.max(0, Math.min(255, Math.round(o2[3 * p + 1]! + smooth[1]![p]!)));
          o2[3 * p + 2] = Math.max(0, Math.min(255, Math.round(o2[3 * p + 2]! + smooth[2]![p]!)));
        }
    }
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

/**
 * A smooth surface through scattered values (weight 1 where known, 0 elsewhere), by push-pull over a pyramid: averages are
 * pulled down to coarser levels until every cell has something, then pushed back up to fill what was unknown. Several
 * channels share the weights.
 */
export function membrane(ch: Float32Array[], wt: Float32Array, w: number, h: number): Float32Array[] {
  if (w <= 1 && h <= 1) return ch.map((c) => c.slice());
  const w2 = Math.max(1, (w + 1) >> 1);
  const h2 = Math.max(1, (h + 1) >> 1);
  const cw = new Float32Array(w2 * h2);
  const cc = ch.map(() => new Float32Array(w2 * h2));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const q = (y >> 1) * w2 + (x >> 1);
      const a = wt[p]!;
      if (!a) continue;
      cw[q] = cw[q]! + a;
      for (let k = 0; k < ch.length; k++) cc[k]![q] = cc[k]![q]! + ch[k]![p]! * a;
    }
  let any = false;
  for (let q = 0; q < cw.length; q++)
    if (cw[q]) {
      any = true;
      for (let k = 0; k < ch.length; k++) cc[k]![q] = cc[k]![q]! / cw[q]!;
      cw[q] = Math.min(1, cw[q]!);
    }
  if (!any) return ch.map(() => new Float32Array(w * h));
  const coarse = w2 === w && h2 === h ? cc : membrane(cc, cw, w2, h2);
  const out = ch.map((c) => c.slice());
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = Math.min(1, wt[p]!);
      if (a >= 1) continue;
      // bilinear from the coarser level (its cell centres sit at 2i + 0.5)
      const fx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2));
      const fy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(w2 - 1, x0 + 1);
      const y1 = Math.min(h2 - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let k = 0; k < ch.length; k++) {
        const C = coarse[k]!;
        const v = (C[y0 * w2 + x0]! * (1 - ax) + C[y0 * w2 + x1]! * ax) * (1 - ay) + (C[y1 * w2 + x0]! * (1 - ax) + C[y1 * w2 + x1]! * ax) * ay;
        out[k]![p] = a * ch[k]![p]! + (1 - a) * v;
      }
    }
  return out;
}
