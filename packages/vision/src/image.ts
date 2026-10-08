/** Float images and the few operations the trackers need: blur, pyramids, gradients, bilinear sampling, warping. Values are 0..1. */

export interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}
export const newGray = (w: number, h: number): Gray => ({ w, h, d: new Float32Array(w * h) });

/** 8-bit gray (1 channel) or rgb24 (3 channels) bytes to a float image in 0..1 (luma for colour). */
export function fromBytes(buf: Uint8Array, w: number, h: number, channels: 1 | 3 = 1): Gray {
  const g = newGray(w, h);
  if (channels === 1) for (let i = 0; i < w * h; i++) g.d[i] = buf[i]! / 255;
  else for (let i = 0; i < w * h; i++) g.d[i] = (0.299 * buf[3 * i]! + 0.587 * buf[3 * i + 1]! + 0.114 * buf[3 * i + 2]!) / 255;
  return g;
}

/** A separable convolution with edge clamping. */
function conv(src: Float32Array, w: number, h: number, k: Float32Array): Float32Array {
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        s += src[row + xx]! * k[i + r]!;
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        s += tmp[yy * w + x]! * k[i + r]!;
      }
      out[y * w + x] = s;
    }
  return out;
}
export function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    s += k[i + r]!;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / s;
  return k;
}
export function blur(g: Gray, sigma: number): Gray {
  return { w: g.w, h: g.h, d: conv(g.d, g.w, g.h, gaussKernel(sigma)) };
}

const K5 = Float32Array.from([1, 4, 6, 4, 1].map((v) => v / 16));
/** Half-size copy, low-passed first so detail does not alias. */
export function downsample(g: Gray): Gray {
  const sm = conv(g.d, g.w, g.h, K5);
  const w = Math.max(1, g.w >> 1);
  const h = Math.max(1, g.h >> 1);
  const o = newGray(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.d[y * w + x] = sm[Math.min(g.h - 1, 2 * y) * g.w + Math.min(g.w - 1, 2 * x)]!;
  return o;
}
export function pyramid(g: Gray, levels: number): Gray[] {
  const out = [g];
  for (let i = 1; i < levels; i++) {
    const last = out[i - 1]!;
    if (last.w < 24 || last.h < 24) break;
    out.push(downsample(last));
  }
  return out;
}

/** Scharr gradients (central, 3-10-3 weighting): per-pixel derivative in x and y. */
export function gradients(g: Gray): { gx: Float32Array; gy: Float32Array } {
  const { w, h, d } = g;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      const a = d[y0 * w + x0]!, b = d[y0 * w + x]!, c = d[y0 * w + x1]!;
      const e = d[y * w + x0]!, f = d[y * w + x1]!;
      const gg = d[y1 * w + x0]!, hh = d[y1 * w + x]!, ii = d[y1 * w + x1]!;
      const dx = x1 - x0 || 1;
      const dy = y1 - y0 || 1;
      gx[y * w + x] = (3 * (c - a) + 10 * (f - e) + 3 * (ii - gg)) / (16 * dx);
      gy[y * w + x] = (3 * (gg - a) + 10 * (hh - b) + 3 * (ii - c)) / (16 * dy);
    }
  }
  return { gx, gy };
}

/** Bilinear sample with clamped borders. */
export function bilinear(d: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const j = y1 * w + x0;
  return (d[i]! * (1 - fx) + d[i + (x1 - x0)]! * fx) * (1 - fy) + (d[j]! * (1 - fx) + d[j + (x1 - x0)]! * fx) * fy;
}

/** Sliding-window sum over a (2r+1)^2 box, edges clamped. */
export function boxSum(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/** Resamples to a new size with bilinear interpolation (area-averaging first when shrinking a lot). */
export function resize(g: Gray, w: number, h: number): Gray {
  let src = g;
  while (src.w >= 2 * w && src.h >= 2 * h) src = downsample(src);
  const o = newGray(w, h);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.d[y * w + x] = bilinear(src.d, src.w, src.h, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
  return o;
}

/** out(x, y) = src(H (x, y)): samples the source through a homography (for tests and for warping masks). */
export function warpHomography(src: Gray, H: ArrayLike<number>, w = src.w, h = src.h): Gray {
  const o = newGray(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ww = H[6]! * x + H[7]! * y + H[8]!;
      const sx = (H[0]! * x + H[1]! * y + H[2]!) / ww;
      const sy = (H[3]! * x + H[4]! * y + H[5]!) / ww;
      o.d[y * w + x] = bilinear(src.d, src.w, src.h, sx, sy);
    }
  return o;
}
