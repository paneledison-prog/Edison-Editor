/**
 * Finding the things in a picture that can be kept or taken out (people, objects, a table): from the segmenter's masks, each
 * asked about one point of a grid over the frame, no two the same, the whole of a thing told from its parts. Pure functions on
 * masks; the segmenter and the picture are the engine's business (packages/engines/src/subjects.ts).
 */
import { fitFlowAffine } from './consensus.js';
import { drawLine, type Rgb } from './draw.js';

export interface Candidate {
  /** binary mask, w x h */
  mask: Uint8Array;
  /** the segmenter's estimate of its quality (0..1) */
  quality: number;
  /** which prompt and candidate made it (to ask for the same again) */
  prompt: number;
  candidate: number;
  /** found where something moves against the background: may be much smaller than the rest (a person far away) */
  small?: boolean;
}

export interface RankedSubject extends Candidate {
  area: number;
  /** another subject that this one lies inside of (a part of it), or -1 for a thing in its own right */
  parent: number;
}

const area = (m: Uint8Array): number => {
  let c = 0;
  for (let i = 0; i < m.length; i++) c += m[i]!;
  return c;
};

/**
 * One list of subjects from many candidates: weak and tiny and huge masks go, duplicates go (the better of two masks that overlap
 * by more than `dup` stays), and each of those left is marked as a thing of its own or a part of a larger one.
 */
export function rankSubjects(cands: Candidate[], w: number, h: number, o: { minArea?: number; maxArea?: number; minQuality?: number; dup?: number; inside?: number } = {}): RankedSubject[] {
  const n = w * h;
  const minA = (o.minArea ?? 0.004) * n;
  const minSmall = 0.0008 * n;
  const maxA = (o.maxArea ?? 0.85) * n;
  const dup = o.dup ?? 0.85;
  const inside = o.inside ?? 0.9;
  const pool = cands
    .map((c) => ({ ...c, area: area(c.mask) }))
    .filter((c) => c.area >= (c.small ? minSmall : minA) && c.area <= maxA && c.quality >= (o.minQuality ?? 0.7))
    .sort((a, b) => b.quality - a.quality || b.area - a.area);
  const kept: (Candidate & { area: number })[] = [];
  for (const c of pool) {
    let same = false;
    for (const k of kept) {
      let inter = 0;
      for (let i = 0; i < n; i++) if (c.mask[i] && k.mask[i]) inter++;
      if (inter / (c.area + k.area - inter) >= dup) {
        same = true;
        break;
      }
    }
    if (!same) kept.push(c);
  }
  // largest first, so that a thing's parent comes before it
  kept.sort((a, b) => b.area - a.area);
  const out: RankedSubject[] = kept.map((k) => ({ ...k, parent: -1 }));
  for (let i = 0; i < out.length; i++) {
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < i; j++) {
      const big = out[j]!;
      if (big.area < out[i]!.area * 1.25) continue;
      let inter = 0;
      for (let p = 0; p < n; p++) if (out[i]!.mask[p] && big.mask[p]) inter++;
      // the part lies inside the whole; the nearest whole (the smallest that holds it) is its parent
      if (inter / out[i]!.area >= inside && big.area < bestArea) {
        best = j;
        bestArea = big.area;
      }
    }
    out[i]!.parent = best;
  }
  return out;
}

const NAMES: { n: string; c: Rgb }[] = [
  { n: 'black', c: [20, 20, 22] },
  { n: 'dark gray', c: [75, 75, 80] },
  { n: 'gray', c: [135, 135, 140] },
  { n: 'light gray', c: [190, 190, 195] },
  { n: 'white', c: [240, 240, 240] },
  { n: 'red', c: [200, 40, 40] },
  { n: 'orange', c: [230, 130, 30] },
  { n: 'yellow', c: [235, 215, 50] },
  { n: 'lime', c: [170, 220, 40] },
  { n: 'green', c: [50, 150, 70] },
  { n: 'teal', c: [40, 150, 150] },
  { n: 'blue', c: [50, 90, 200] },
  { n: 'navy', c: [25, 40, 100] },
  { n: 'purple', c: [120, 60, 170] },
  { n: 'pink', c: [225, 90, 160] },
  { n: 'skin', c: [215, 165, 135] },
  { n: 'brown', c: [110, 70, 40] },
  { n: 'tan', c: [195, 160, 110] },
];
/** The name of the nearest of a few colours: enough to tell "the navy jacket" from "the pink dress". */
export function colourName(r: number, g: number, b: number): string {
  let best = NAMES[0]!.n;
  let bd = Infinity;
  for (const c of NAMES) {
    const d = (c.c[0] - r) ** 2 + (c.c[1] - g) ** 2 + (c.c[2] - b) ** 2;
    if (d < bd) (bd = d, (best = c.n));
  }
  return best;
}

// ----- numbers on a sheet: a 3 x 5 pixel font ---------------------------------------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  s: '011100010001110',
  p: '110101110100100',
};

/** Draws a short text of digits (and s, p) with its top-left corner at x, y; a dark outline keeps it readable on any picture. */
export function drawText(buf: Uint8Array, w: number, h: number, x: number, y: number, text: string, color: Rgb, scale = 3): { w: number; h: number } {
  const put = (px: number, py: number, c: Rgb) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const o = (py * w + px) * 3;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
  };
  const adv = 4 * scale;
  for (let pass = 0; pass < 2; pass++)
    for (let k = 0; k < text.length; k++) {
      const g = GLYPHS[text[k]!];
      if (!g) continue;
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++)
          if (g[gy * 3 + gx] === '1')
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++) {
                const px = x + k * adv + gx * scale + dx;
                const py = y + gy * scale + dy;
                if (pass === 0) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) put(px + ox, py + oy, [0, 0, 0]);
                else put(px, py, color);
              }
    }
  return { w: text.length * adv - scale, h: 5 * scale };
}

/** The outline pixels of a mask, drawn in a colour. */
export function drawMaskOutline(buf: Uint8Array, w: number, h: number, mask: Uint8Array, color: Rgb): void {
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (mask[p] && (!mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w])) {
        buf[3 * p] = color[0];
        buf[3 * p + 1] = color[1];
        buf[3 * p + 2] = color[2];
      }
    }
}

export const SUBJECT_COLOURS: Rgb[] = [
  [255, 60, 60],
  [60, 140, 255],
  [255, 200, 40],
  [80, 220, 120],
  [220, 80, 255],
  [40, 220, 220],
  [255, 130, 40],
  [180, 180, 255],
];
void drawLine;

/**
 * Where something moves against the background: points to ask the segmenter about (one per moving blob, with the blob's box).
 * `flow` is from this frame to the next; the background's motion is taken to be the median of the whole frame.
 */
export function movingBlobs(flow: { u: Float32Array; v: Float32Array }, w: number, h: number, o: { minPx?: number; max?: number } = {}): { point: [number, number]; box: [number, number, number, number]; size: number }[] {
  const n = w * h;
  // the background's own motion (the camera's, shake and slow drift): a robust affine fit of the flow over the whole frame, which
  // the things that move on their own (few, and unlike it) hardly disturb
  const pix: number[] = [];
  for (let i = 0; i < n; i += 5) pix.push(i);
  const cx = w / 2;
  const cy = h / 2;
  const bgm = fitFlowAffine(pix, w, flow, cx, cy);
  const resid = new Float32Array(n);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % w) - cx;
    const y = Math.floor(i / w) - cy;
    const pu = bgm ? bgm.a[0]! + bgm.a[1]! * x + bgm.a[2]! * y : 0;
    const pv = bgm ? bgm.b[0]! + bgm.b[1]! * x + bgm.b[2]! * y : 0;
    resid[i] = Math.hypot(flow.u[i]! - pu, flow.v[i]! - pv);
    if (i % 5 === 0) vals.push(resid[i]!);
  }
  vals.sort((a, b) => a - b);
  // movers stand out from the background's own residual (its noise level): well above it, and not less than a pixel
  const thr = Math.max(o.minPx ?? 1.0, 4 * vals[Math.floor(vals.length * 0.6)]!);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (resid[i]! > thr) bin[i] = 1;
  // close small gaps so that one mover is one blob
  const closed = morphClose(bin, w, h, 2);
  const seen = new Uint8Array(n);
  const blobs: { point: [number, number]; box: [number, number, number, number]; size: number; score: number }[] = [];
  const stack = new Int32Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (!closed[s0] || seen[s0]) continue;
    let sp = 0;
    let cnt = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0, sm = 0;
    stack[sp++] = s0;
    seen[s0] = 1;
    const pix: number[] = [];
    while (sp) {
      const p = stack[--sp]!;
      const x = p % w, y = (p / w) | 0;
      cnt++;
      pix.push(p);
      sx += x; sy += y;
      sm += resid[p]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && closed[p - 1] && !seen[p - 1]) (seen[p - 1] = 1, (stack[sp++] = p - 1));
      if (x < w - 1 && closed[p + 1] && !seen[p + 1]) (seen[p + 1] = 1, (stack[sp++] = p + 1));
      if (y > 0 && closed[p - w] && !seen[p - w]) (seen[p - w] = 1, (stack[sp++] = p - w));
      if (y < h - 1 && closed[p + w] && !seen[p + w]) (seen[p + w] = 1, (stack[sp++] = p + w));
    }
    if (cnt < 18 || cnt > 0.4 * n) continue;
    // the pixel of the blob nearest its centre (the centre itself may be outside it)
    const cx = sx / cnt, cy = sy / cnt;
    let best = pix[0]!, bd = Infinity;
    for (const p of pix) {
      const d = ((p % w) - cx) ** 2 + (((p / w) | 0) - cy) ** 2;
      if (d < bd) (bd = d, (best = p));
    }
    blobs.push({ point: [best % w, (best / w) | 0], box: [x0, y0, x1, y1], size: cnt, score: cnt * (sm / cnt) });
  }
  blobs.sort((a, b) => b.score - a.score);
  return blobs.slice(0, o.max ?? 8).map((b) => ({ point: b.point, box: b.box, size: b.size }));
}

function morphClose(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const grow = (src: Uint8Array, rad: number, on: number): Uint8Array => {
    const out = new Uint8Array(src.length);
    const tmp = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let hit = on ? 0 : 1;
        for (let k = -rad; k <= rad; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          if (on ? src[y * w + xx] : !src[y * w + xx]) { hit = on ? 1 : 0; break; }
        }
        tmp[y * w + x] = hit;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let hit = on ? 0 : 1;
        for (let k = -rad; k <= rad; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          if (on ? tmp[yy * w + x] : !tmp[yy * w + x]) { hit = on ? 1 : 0; break; }
        }
        out[y * w + x] = hit;
      }
    return out;
  };
  return grow(grow(m, r, 1), r, 0);
}
