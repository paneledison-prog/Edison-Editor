/** Small drawing helpers for checking a result by eye: lines and quads on RGB buffers, tiles into a sheet. */
import type { Pt } from './geom.js';

export type Rgb = [number, number, number];

/** A line of the given thickness (in px) on an RGB buffer, clipped to the image. */
export function drawLine(buf: Uint8Array, w: number, h: number, a: Pt, b: Pt, color: Rgb, thick = 2): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const r = Math.max(0, (thick - 1) / 2);
  for (let i = 0; i <= steps; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / steps;
    const y = a[1] + ((b[1] - a[1]) * i) / steps;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 3;
        buf[o] = color[0];
        buf[o + 1] = color[1];
        buf[o + 2] = color[2];
      }
  }
}

/** The outline of a polygon. */
export function drawPoly(buf: Uint8Array, w: number, h: number, pts: Pt[], color: Rgb, thick = 2): void {
  pts.forEach((p, i) => drawLine(buf, w, h, p, pts[(i + 1) % pts.length]!, color, thick));
}

/** A small cross, for points. */
export function drawCross(buf: Uint8Array, w: number, h: number, p: Pt, color: Rgb, size = 4): void {
  drawLine(buf, w, h, [p[0] - size, p[1]], [p[0] + size, p[1]], color, 1);
  drawLine(buf, w, h, [p[0], p[1] - size], [p[0], p[1] + size], color, 1);
}

/** Tiles equally sized RGB frames into a grid with `cols` columns (a 2 px gap). */
export function tileRgb(frames: Uint8Array[], w: number, h: number, cols: number): { data: Uint8Array; w: number; h: number } {
  const gap = 2;
  const rows = Math.ceil(frames.length / cols);
  const W = cols * w + (cols - 1) * gap;
  const H = rows * h + (rows - 1) * gap;
  const out = new Uint8Array(W * H * 3).fill(24);
  frames.forEach((f, i) => {
    const ox = (i % cols) * (w + gap);
    const oy = Math.floor(i / cols) * (h + gap);
    for (let y = 0; y < h; y++) out.set(f.subarray(y * w * 3, (y + 1) * w * 3), ((oy + y) * W + ox) * 3);
  });
  return { data: out, w: W, h: H };
}
