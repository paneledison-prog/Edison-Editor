/**
 * Animation presets: ready-made keyframes for the common moves (the Animate tab). A preset only produces keyframes; the
 * op that applies it stores them like any others, so they can be edited, retimed, and undone.
 */
import type { Layer } from './schema.js';

export interface KfOut {
  t: number;
  v: number | string;
  ease?: string;
}
export interface PresetArgs {
  /** start time on the scene clock, ms */
  at: number;
  /** length of the move, ms */
  dur: number;
  ease?: string;
  from?: 'left' | 'right' | 'top' | 'bottom';
  distance?: number;
  amount?: number;
  count?: number;
  to?: string;
  /** the scene size, for slides that start off-screen */
  scene: { width: number; height: number };
}
export interface PresetDef {
  id: string;
  summary: string;
  defaults: { dur: number; ease: string };
  /** which layer types it makes sense on (empty = any) */
  types?: string[];
  build(l: Layer, a: PresetArgs): Record<string, KfOut[]>;
}

const k = (t: number, v: number | string, ease?: string): KfOut => ({ t: Math.round(t), v, ...(ease ? { ease } : {}) });
const edge = (l: Layer, from: PresetArgs['from'], a: PresetArgs): { prop: 'x' | 'y'; v: number } => {
  const d = a.distance;
  switch (from ?? 'left') {
    case 'left': return { prop: 'x', v: d === undefined ? -(l.w + l.x) - 20 : l.x - d };
    case 'right': return { prop: 'x', v: d === undefined ? a.scene.width + 20 : l.x + d };
    case 'top': return { prop: 'y', v: d === undefined ? -(l.h + l.y) - 20 : l.y - d };
    case 'bottom': return { prop: 'y', v: d === undefined ? a.scene.height + 20 : l.y + d };
  }
};

export const PRESETS: PresetDef[] = [
  {
    id: 'fade-in', summary: 'Opacity from 0 to its current value.', defaults: { dur: 500, ease: 'quad.out' },
    build: (l, a) => ({ opacity: [k(a.at, 0, a.ease), k(a.at + a.dur, l.opacity ?? 1)] }),
  },
  {
    id: 'fade-out', summary: 'Opacity from its current value to 0.', defaults: { dur: 500, ease: 'quad.in' },
    build: (l, a) => ({ opacity: [k(a.at, l.opacity ?? 1, a.ease), k(a.at + a.dur, 0)] }),
  },
  {
    id: 'slide-in', summary: 'Slide in from an edge (from: left, right, top, bottom; distance in px, default off-screen) while fading in.', defaults: { dur: 600, ease: 'expo.out' },
    build: (l, a) => {
      const e = edge(l, a.from, a);
      return { [e.prop]: [k(a.at, e.v, a.ease), k(a.at + a.dur, l[e.prop])], opacity: [k(a.at, 0, a.ease), k(a.at + a.dur * 0.6, l.opacity ?? 1)] };
    },
  },
  {
    id: 'slide-out', summary: 'Slide out toward an edge while fading out.', defaults: { dur: 500, ease: 'expo.in' },
    build: (l, a) => {
      const e = edge(l, a.from, a);
      return { [e.prop]: [k(a.at, l[e.prop], a.ease), k(a.at + a.dur, e.v)], opacity: [k(a.at + a.dur * 0.4, l.opacity ?? 1, a.ease), k(a.at + a.dur, 0)] };
    },
  },
  {
    id: 'scale-in', summary: 'Grow from nothing with a springy settle.', defaults: { dur: 700, ease: 'spring.out' },
    build: (l, a) => ({ scale: [k(a.at, 0, a.ease), k(a.at + a.dur, l.scale ?? 1)], opacity: [k(a.at, 0, 'linear'), k(a.at + Math.min(150, a.dur), l.opacity ?? 1)] }),
  },
  {
    id: 'pop', summary: 'Pop in: overshoot to 110 percent, then settle.', defaults: { dur: 600, ease: 'quad.out' },
    build: (l, a) => {
      const s = l.scale ?? 1;
      return { scale: [k(a.at, 0, a.ease), k(a.at + a.dur * 0.6, s * 1.1, 'quad.inOut'), k(a.at + a.dur, s)], opacity: [k(a.at, 0), k(a.at + 120, l.opacity ?? 1)] };
    },
  },
  {
    id: 'scale-out', summary: 'Shrink away.', defaults: { dur: 400, ease: 'back.in' },
    build: (l, a) => ({ scale: [k(a.at, l.scale ?? 1, a.ease), k(a.at + a.dur, 0)] }),
  },
  {
    id: 'rotate-in', summary: 'Spin in from -90 degrees while fading in.', defaults: { dur: 700, ease: 'expo.out' },
    build: (l, a) => ({ rotation: [k(a.at, (l.rotation ?? 0) - (a.amount ?? 90), a.ease), k(a.at + a.dur, l.rotation ?? 0)], opacity: [k(a.at, 0), k(a.at + a.dur * 0.5, l.opacity ?? 1)] }),
  },
  {
    id: 'blur-in', summary: 'Come into focus: blur to sharp while fading in.', defaults: { dur: 700, ease: 'quad.out' },
    build: (l, a) => ({ layerBlur: [k(a.at, a.amount ?? 24, a.ease), k(a.at + a.dur, l.layerBlur ?? 0)], opacity: [k(a.at, 0), k(a.at + a.dur * 0.7, l.opacity ?? 1)] }),
  },
  {
    id: 'bounce', summary: 'Hop up and down (count times, amount px high).', defaults: { dur: 900, ease: 'quad.out' },
    build: (l, a) => {
      const n = Math.max(1, Math.min(8, Math.round(a.count ?? 3)));
      const h = a.amount ?? 40;
      const out: KfOut[] = [k(a.at, l.y)];
      for (let i = 0; i < n; i++) {
        const t0 = a.at + (a.dur * i) / n;
        const amp = h * Math.pow(0.55, i);
        out.push(k(t0 + a.dur / n / 2, l.y - amp, 'quad.out'), k(t0 + a.dur / n, l.y, 'quad.in'));
      }
      return { y: out };
    },
  },
  {
    id: 'pulse', summary: 'Breathe: scale up a few percent and back (count times).', defaults: { dur: 1200, ease: 'sine.inOut' },
    build: (l, a) => {
      const n = Math.max(1, Math.min(10, Math.round(a.count ?? 2)));
      const s = l.scale ?? 1;
      const up = s * (1 + (a.amount ?? 0.08));
      const out: KfOut[] = [k(a.at, s, a.ease)];
      for (let i = 0; i < n; i++) out.push(k(a.at + (a.dur * (i + 0.5)) / n, up, a.ease), k(a.at + (a.dur * (i + 1)) / n, s, a.ease));
      return { scale: out };
    },
  },
  {
    id: 'wiggle', summary: 'Shake side to side by a few degrees (count wiggles, amount degrees).', defaults: { dur: 600, ease: 'sine.inOut' },
    build: (l, a) => {
      const n = Math.max(1, Math.min(12, Math.round(a.count ?? 4)));
      const r = l.rotation ?? 0;
      const amp = a.amount ?? 6;
      const out: KfOut[] = [k(a.at, r, a.ease)];
      for (let i = 0; i < n; i++) out.push(k(a.at + (a.dur * (i + 0.5)) / n, r + (i % 2 ? -amp : amp), a.ease));
      out.push(k(a.at + a.dur, r, a.ease));
      return { rotation: out };
    },
  },
  {
    id: 'draw-on', summary: 'A path draws itself (trim from 0 to 1).', types: ['path'], defaults: { dur: 1000, ease: 'quad.inOut' },
    build: (_l, a) => ({ trim: [k(a.at, 0, a.ease), k(a.at + a.dur, 1)] }),
  },
  {
    id: 'typewriter', summary: 'Text types itself out letter by letter.', types: ['text'], defaults: { dur: 1200, ease: 'linear' },
    build: (_l, a) => ({ charProgress: [k(a.at, 0, a.ease), k(a.at + a.dur, 1)] }),
  },
  {
    id: 'color-shift', summary: 'Fade the fill colour to another colour (to: #RRGGBB).', defaults: { dur: 800, ease: 'quad.inOut' },
    build: (l, a) => {
      const from = l.fill?.type === 'solid' ? l.fill.color : '#ffffff';
      return { fill: [k(a.at, from, a.ease), k(a.at + a.dur, a.to ?? '#000000')] };
    },
  },
];
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
