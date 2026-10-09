import { rng } from '../packages/vision/src/index.js';
import { texture } from './vision-helpers.js';

export interface Composite {
  w: number;
  h: number;
  /** the picture, RGB bytes */
  image: Uint8Array;
  /** the true opacity, 0..1 */
  alpha: Float32Array;
  /** the true colour of the object (RGB, 0..1 planes) */
  fg: Float32Array[];
}

/** An object with a soft edge and thin hair-like strands, over a different background, composited with known opacity. */
export function hairComposite(w: number, h: number, seed = 3): Composite {
  const S = 4; // supersampling for exact edge coverage
  const R = rng(seed);
  const cx = w * 0.5;
  const cy = h * 0.58;
  const rx = w * 0.2;
  const ry = h * 0.3;
  // strands: thin lines from the top of the head outwards
  const strands: { x0: number; y0: number; x1: number; y1: number; wd: number }[] = [];
  for (let i = 0; i < 70; i++) {
    const a = (-0.15 - 0.7 * R()) * Math.PI + (R() - 0.5) * 0.3;
    const x0 = cx + Math.cos(a) * rx * 0.85;
    const y0 = cy + Math.sin(a) * ry * 0.85;
    const len = (0.05 + 0.08 * R()) * h;
    strands.push({ x0, y0, x1: x0 + Math.cos(a + (R() - 0.5) * 0.6) * len, y1: y0 + Math.sin(a + (R() - 0.5) * 0.6) * len, wd: 0.6 + 0.8 * R() });
  }
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let cov = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          let inside = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
          if (!inside)
            for (const s of strands) {
              const dx = s.x1 - s.x0;
              const dy = s.y1 - s.y0;
              const t = Math.min(1, Math.max(0, ((px - s.x0) * dx + (py - s.y0) * dy) / (dx * dx + dy * dy)));
              if (Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy)) <= s.wd / 2) {
                inside = true;
                break;
              }
            }
          if (inside) cov++;
        }
      alpha[y * w + x] = cov / (S * S);
    }
  const tf = texture(w, h, seed + 1);
  const tb = texture(w, h, seed + 2);
  const fg = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const image = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    // an object in warm dark browns, a background in light blue-greys: they differ in colour, not much in brightness
    const f = [0.28 + 0.25 * tf.d[i]!, 0.18 + 0.2 * tf.d[i]!, 0.1 + 0.15 * tf.d[i]!];
    const b = [0.55 + 0.2 * tb.d[i]!, 0.62 + 0.2 * tb.d[i]!, 0.7 + 0.2 * tb.d[i]!];
    for (let c = 0; c < 3; c++) {
      fg[c]![i] = f[c]!;
      image[3 * i + c] = Math.round(255 * (alpha[i]! * f[c]! + (1 - alpha[i]!) * b[c]!));
    }
  }
  return { w, h, image, alpha, fg };
}

/** What a mask made at half the resolution looks like: the true opacity, thresholded, with a ragged edge, brought back by bilinear. */
export function roughMask(c: Composite, seed = 5): { low: Float32Array; lw: number; lh: number } {
  const R = rng(seed);
  const lw = c.w >> 1;
  const lh = c.h >> 1;
  const low = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++)
    for (let x = 0; x < lw; x++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += c.alpha[(2 * y + dy) * c.w + 2 * x + dx]!;
      // thin strands average away at half resolution; the ragged edge is a random shift of the threshold
      low[y * lw + x] = s / 4 > 0.45 + 0.2 * (R() - 0.5) ? 1 : 0;
    }
  return { low, lw, lh };
}
