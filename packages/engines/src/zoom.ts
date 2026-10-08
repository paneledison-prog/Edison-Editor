import type { Clip } from '@studio/core';
import { easeFn } from '@studio/motion/ease';
import { EngineError } from './run.js';

/**
 * Per-clip scale and pan from keyframes and `transform`, as FFmpeg expressions of the clip-local time `t`.
 * Meaning on media clips: `scale` >= 1 is the zoom factor; `x`, `y` are the focus point as fractions of the frame
 * (0..1, default 0.5), clamped so the crop stays inside the frame. Eased segments are sampled into SUB linear pieces.
 */
const SUB = 12;
const f = (n: number) => (Math.round(n * 1e5) / 1e5).toString();

interface Pt {
  t: number;
  v: number;
}

/** Points (seconds, clip-local) of one property: keyframes, else the constant transform value, else the default. */
export function propPoints(c: Clip, prop: 'scale' | 'x' | 'y', dflt: number): Pt[] {
  const kfs = c.keyframes?.[prop];
  const base = (c.transform as Record<string, number | undefined> | undefined)?.[prop] ?? dflt;
  if (!kfs?.length) return [{ t: 0, v: base }];
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  const out: Pt[] = [];
  sorted.forEach((k, i) => {
    out.push({ t: k.t / 1000, v: k.v });
    const nx = sorted[i + 1];
    if (!nx) return;
    // The easing on a keyframe shapes the segment that follows it.
    const e = k.ease ?? 'linear';
    if (e === 'hold') {
      out.push({ t: nx.t / 1000 - 1e-4, v: k.v });
      return;
    }
    if (e === 'linear') return;
    const fn = easeFn(e);
    for (let s = 1; s < SUB; s++) {
      const u = s / SUB;
      out.push({ t: (k.t + (nx.t - k.t) * u) / 1000, v: k.v + (nx.v - k.v) * fn(u) });
    }
  });
  return out;
}

/** Value at clip-local time `tSec`, for tests and for the sharpness check. */
export function valueAt(pts: Pt[], tSec: number): number {
  if (tSec <= pts[0]!.t) return pts[0]!.v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (tSec < b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (tSec - a.t)) / (b.t - a.t);
  }
  return pts[pts.length - 1]!.v;
}

/** Piecewise-linear expression as a sum of windowed terms (no deep nesting). */
export function expr(pts: Pt[]): string {
  if (pts.length === 1) return f(pts[0]!.v);
  const terms = [`${f(pts[0]!.v)}*lt(t,${f(pts[0]!.t)})`];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (b.t <= a.t) continue;
    const slope = (b.v - a.v) / (b.t - a.t);
    terms.push(`gte(t,${f(a.t)})*lt(t,${f(b.t)})*(${f(a.v)}+${f(slope)}*(t-${f(a.t)}))`);
  }
  const last = pts[pts.length - 1]!;
  terms.push(`${f(last.v)}*gte(t,${f(last.t)})`);
  return terms.join('+');
}

export function hasMotion(c: Clip): boolean {
  return (
    !!(c.keyframes && Object.keys(c.keyframes).length) ||
    !!(c.transform && Object.keys(c.transform).length)
  );
}

export const MAX_SCALE = 8;

/** `scale=...,crop=...,` (trailing comma) for a clip, or '' when it has no motion. Output size stays width x height. */
export function zoomFilter(c: Clip, width: number, height: number): string {
  if (!hasMotion(c)) return '';
  const unsupported = [
    ...(c.keyframes && (c.keyframes['rot'] || c.keyframes['opacity'])
      ? ['keyframes on rot/opacity']
      : []),
    ...(c.transform && (c.transform.rot !== undefined || c.transform.opacity !== undefined)
      ? ['transform rot/opacity']
      : []),
  ];
  const known = new Set(['scale', 'x', 'y']);
  for (const p of Object.keys(c.keyframes ?? {}))
    if (!known.has(p) && !unsupported.length) unsupported.push(`keyframes on "${p}"`);
  if (unsupported.length)
    throw new EngineError(
      'ENGINE_MISSING',
      `${c.id}: ${unsupported.join(', ')} is not implemented for media clips; supported: scale, x, y`,
      'remove it, or use scale/x/y (zoom and pan)',
    );
  const sc = propPoints(c, 'scale', 1);
  for (const p of sc)
    if (p.v < 1 || p.v > MAX_SCALE)
      throw new EngineError(
        'INVALID_INPUT',
        `${c.id}: scale ${p.v} is outside 1..${MAX_SCALE} (zooming out below 1 would show empty canvas)`,
      );
  const cx = expr(propPoints(c, 'x', 0.5));
  const cy = expr(propPoints(c, 'y', 0.5));
  const s = expr(sc);
  // crop's iw/ih are the size configured at start, not the per-frame scaled size, so the scaled size is spelled out.
  const sw = `(2*trunc(${width}*(${s})/2))`;
  const sh = `(2*trunc(${height}*(${s})/2))`;
  return (
    `scale=w='${sw}':h='${sh}':eval=frame:flags=lanczos,` +
    `crop=${width}:${height}:x='min(max((${cx})*${sw}-${width / 2},0),${sw}-${width})':y='min(max((${cy})*${sh}-${height / 2},0),${sh}-${height})',`
  );
}
