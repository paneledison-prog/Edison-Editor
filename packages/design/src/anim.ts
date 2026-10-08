/**
 * Animation sampling: what a layer looks like at time t. Pure and deterministic; the editor canvas and the video export
 * both call it, so what you scrub is what you render.
 */
import { easeFn as baseEase, type EaseFn } from '@studio/motion/ease';
import { isColorProp, type Design, type Keyframe, type Layer } from './schema.js';

/** `spring.out` and friends: a damped overshoot that settles exactly at 1. */
const springOut: EaseFn = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : 1 - Math.exp(-7 * t) * Math.cos(11 * t));
export function easing(name: string): EaseFn {
  const m = /^spring\.(in|out|inOut)$/.exec(name);
  if (!m) return baseEase(name);
  if (m[1] === 'out') return springOut;
  if (m[1] === 'in') return (t) => 1 - springOut(1 - t);
  return (t) => (t < 0.5 ? (1 - springOut(1 - 2 * t)) / 2 : (1 + springOut(2 * t - 1)) / 2);
}

const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
export function parseColor(c: string): [number, number, number, number] {
  const n = parseInt(c.slice(1, 7), 16);
  const a = c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}
export function mixColor(a: string, b: string, u: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  const m = (i: number) => x[i]! + (y[i]! - x[i]!) * u;
  const alpha = x[3]! + (y[3]! - x[3]!) * u;
  return `#${hex(m(0))}${hex(m(1))}${hex(m(2))}${alpha < 0.9995 ? hex(alpha * 255) : ''}`;
}

/** The keyframed value of `prop` at `t` ms, or undefined when the layer has no keyframes for it. */
export function sample(kfs: readonly Keyframe[] | undefined, prop: string, t: number): number | string | undefined {
  if (!kfs?.length) return undefined;
  const sorted = kfs.length > 1 && kfs.some((k, i) => i && k.t < kfs[i - 1]!.t) ? [...kfs].sort((a, b) => a.t - b.t) : kfs;
  const first = sorted[0]!;
  if (t <= first.t) return first.v;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.t) return last.v;
  let i = 1;
  while (sorted[i]!.t < t) i++;
  const a = sorted[i - 1]!;
  const b = sorted[i]!;
  const u = easing(a.ease ?? 'linear')((t - a.t) / (b.t - a.t));
  if (isColorProp(prop)) return mixColor(String(a.v), String(b.v), u);
  return (a.v as number) + ((b.v as number) - (a.v as number)) * u;
}

/** A layer with every keyframed property replaced by its value at `t`. */
export interface Resolved {
  layer: Layer;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  scale: number;
  cornerRadius: number;
  strokeWidth: number;
  shadow: { x: number; y: number; blur: number; color: string } | null;
  layerBlur: number;
  trim: number;
  charProgress: number;
  volume: number;
  fillColor: string | null;
  strokeColor: string | null;
  /** inside its start..end window (and visible) */
  alive: boolean;
}

export function resolve(layer: Layer, t: number, sceneMs: number): Resolved {
  const a = layer.anim;
  const n = (prop: string, base: number): number => {
    const v = sample(a?.[prop], prop, t);
    return typeof v === 'number' ? v : base;
  };
  const c = (prop: string, base: string | null): string | null => {
    const v = sample(a?.[prop], prop, t);
    return typeof v === 'string' ? v : base;
  };
  const sh = layer.shadow;
  const shadow =
    sh || a?.['shadowBlur'] || a?.['shadowX'] || a?.['shadowY']
      ? { x: n('shadowX', sh?.x ?? 0), y: n('shadowY', sh?.y ?? 0), blur: n('shadowBlur', sh?.blur ?? 0), color: sh?.color ?? '#00000066' }
      : null;
  const solid = layer.fill?.type === 'solid' ? layer.fill.color : null;
  const stroke = layer.stroke;
  return {
    layer,
    x: n('x', layer.x),
    y: n('y', layer.y),
    w: n('w', layer.w),
    h: n('h', layer.h),
    rotation: n('rotation', layer.rotation ?? 0),
    opacity: n('opacity', layer.opacity ?? 1),
    scale: n('scale', layer.scale ?? 1),
    cornerRadius: n('cornerRadius', layer.cornerRadius ?? 0),
    strokeWidth: n('strokeWidth', stroke?.width ?? 0),
    shadow,
    layerBlur: n('layerBlur', layer.layerBlur ?? 0),
    trim: n('trim', layer.type === 'path' ? (layer.trim ?? 1) : 1),
    charProgress: n('charProgress', layer.type === 'text' ? (layer.charProgress ?? 1) : 1),
    volume: n('volume', layer.type === 'audio' ? (layer.volume ?? 1) : 1),
    fillColor: c('fill', solid),
    strokeColor: c('stroke', stroke?.color ?? null),
    alive: layer.visible !== false && t >= (layer.start ?? 0) && t < (layer.end ?? sceneMs + 1),
  };
}

/** Children of `parent` (null = the scene) in paint order, back to front. */
export function childrenOf(d: Design, parent: string | null): Layer[] {
  return d.layers.filter((l) => l.parent === parent);
}

/** The layer and all its descendants, in document order. */
export function subtree(d: Design, id: string): Layer[] {
  const out: Layer[] = [];
  const walk = (pid: string) => {
    const l = d.layers.find((x) => x.id === pid);
    if (!l) return;
    out.push(l);
    for (const ch of d.layers) if (ch.parent === pid) walk(ch.id);
  };
  walk(id);
  return out;
}
