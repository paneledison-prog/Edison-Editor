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

export interface Pt {
  t: number;
  v: number;
}

/** Points (seconds, clip-local) of one property: keyframes, else the constant transform value, else the default. */
export function propPoints(
  c: Clip,
  prop: 'scale' | 'x' | 'y' | 'rot' | 'opacity',
  dflt: number,
): Pt[] {
  return pointsOf(c.keyframes?.[prop], (c.transform as Record<string, number | undefined> | undefined)?.[prop] ?? dflt);
}

/** The same for any keyframe list (an effect parameter, a mix): eased segments are sampled into linear pieces. */
export function pointsOf(kfs: Clip['keyframes'] extends Record<string, infer K> | undefined ? K | undefined : never, base: number): Pt[] {
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

/** Keyframes on effect parameters (`fx.<node>.<name>`) belong to the effect stack, not to the clip's own motion. */
export const isFxProp = (p: string) => p.startsWith('fx.');

export function hasMotion(c: Clip): boolean {
  return (
    Object.keys(c.keyframes ?? {}).some((p) => !isFxProp(p)) ||
    !!(c.transform && Object.keys(c.transform).length)
  );
}

export const MAX_SCALE = 8;

const identity = (c: Clip, prop: 'rot' | 'opacity', v: number) =>
  !c.keyframes?.[prop]?.length && ((c.transform as Record<string, number> | undefined)?.[prop] ?? v) === v;

/**
 * The filters for a clip's keyframed motion, as a comma chain with a trailing comma, or '' when it has none.
 * Zoom and pan (`scale`, `x`, `y`) are a `scale` + `crop`; `rot` (degrees, clockwise) is a `rotate` that leaves the
 * uncovered corners transparent; `opacity` (0..1) multiplies the alpha plane. Output size stays width x height.
 */
export function zoomFilter(c: Clip, width: number, height: number): string {
  if (!hasMotion(c)) return '';
  const known = new Set(['scale', 'x', 'y', 'rot', 'opacity']);
  for (const p of Object.keys(c.keyframes ?? {}))
    if (!known.has(p) && !isFxProp(p))
      throw new EngineError(
        'ENGINE_MISSING',
        `${c.id}: keyframes on "${p}" are not implemented for media clips; supported: scale, x, y, rot, opacity`,
        'remove it, or use one of the supported properties',
      );
  const geom = ['scale', 'x', 'y'].some(
    (p) => c.keyframes?.[p]?.length || (c.transform as Record<string, number> | undefined)?.[p] !== undefined,
  );
  let out = '';
  if (geom) {
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
    out +=
      `scale=w='${sw}':h='${sh}':eval=frame:flags=lanczos,` +
      `crop=${width}:${height}:x='min(max((${cx})*${sw}-${width / 2},0),${sw}-${width})':y='min(max((${cy})*${sh}-${height / 2},0),${sh}-${height})',`;
  }
  if (!identity(c, 'rot', 0)) {
    const pts = propPoints(c, 'rot', 0);
    for (const p of pts)
      if (Math.abs(p.v) > 3600)
        throw new EngineError('INVALID_INPUT', `${c.id}: rot ${p.v} is outside -3600..3600 degrees`);
    out += `format=yuva420p,rotate=a='(${expr(pts)})*PI/180':ow=iw:oh=ih:c=black@0,`;
  }
  if (!identity(c, 'opacity', 1)) {
    const pts = propPoints(c, 'opacity', 1);
    for (const p of pts)
      if (p.v < 0 || p.v > 1)
        throw new EngineError('INVALID_INPUT', `${c.id}: opacity ${p.v} is outside 0..1`);
    // geq names the time `T`; only the alpha plane is rewritten, the picture planes are passed through
    const e = expr(pts).replace(/\bt\b/g, 'T');
    out += `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${e})',`;
  }
  return out;
}

/**
 * `blur-region`: blurs a rectangle for the whole clip, inside the fitted canvas frame. Written as a comma chain that
 * ends with a trailing comma, like zoomFilter. The region is in fractions of the canvas, which equals the clip frame
 * for a clip that fills the canvas; for letterboxed clips it is a canvas fraction.
 */
export function blurRegionFilter(c: Clip, width: number, height: number, n: number): string {
  const fx = (c.fx ?? []).filter((f) => f.type === 'blur-region');
  if (!fx.length) return '';
  let out = '';
  fx.forEach((f, i) => {
    if (f.type !== 'blur-region') return;
    const x = 2 * Math.floor((f.x * width) / 2);
    const y = 2 * Math.floor((f.y * height) / 2);
    const w = Math.max(2, 2 * Math.ceil((f.w * width) / 2));
    const h = Math.max(2, 2 * Math.ceil((f.h * height) / 2));
    const k = `br${n}_${i}`;
    // boxblur radii may not exceed a quarter of the region's shorter side (the chroma planes are half size)
    const r = Math.max(
      1,
      Math.min(Math.round(f.strength ?? 24), Math.floor(Math.min(w, h) / 4) - 1),
    );
    out += `split=2[${k}a][${k}b];[${k}b]crop=${w}:${h}:${x}:${y},boxblur=${r}:3[${k}c];[${k}a][${k}c]overlay=${x}:${y},`;
  });
  return out;
}
