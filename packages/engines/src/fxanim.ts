/**
 * Which effect parameters can be keyframed, and with what range. The keyframe name is `fx.<node>.<name>`:
 * a number parameter of a plugin effect, `mix` (how much of the effect shows, 0..1), or the `db` of a `gain`.
 */
import { EngineError } from './run.js';
import { pluginEffectDecl } from './plugins.js';

export interface Animatable {
  min: number;
  max: number;
  default: number;
  integer?: boolean;
}

/** The numeric parameters of an effect that a keyframe may drive, with ranges. Empty for an effect with none. */
export function animatableParams(fx: { type: string; id?: string }): Record<string, Animatable> {
  if (fx.type === 'gain') return { db: { min: -60, max: 40, default: 0 } };
  if (fx.type === 'plugin' || fx.type === 'lut') {
    const out: Record<string, Animatable> = { mix: { min: 0, max: 1, default: 1 } };
    if (fx.type === 'plugin') {
      const decl = pluginEffectDecl(fx.id!);
      for (const [k, p] of Object.entries(decl?.params ?? {}))
        if (p.type === 'number') out[k] = { min: p.min!, max: p.max!, default: Number(p.default), ...(p.integer ? { integer: true } : {}) };
    }
    return out;
  }
  return {};
}

/** Throws with the allowed names and range when `param` cannot be keyframed on this effect or `v` is outside it. */
export function checkEffectKeyframe(fx: { type: string; id?: string }, param: string, v: number): void {
  const ok = animatableParams(fx);
  const a = ok[param];
  const what = fx.type === 'plugin' ? `effect ${fx.id}` : fx.type;
  if (!a)
    throw new EngineError(
      'INVALID_INPUT',
      `${what} has no keyframeable parameter "${param}"; it has: ${Object.keys(ok).join(', ') || 'none'}`,
      'only number parameters (and mix) can change over time; colours, choices and switches cannot',
    );
  if (!Number.isFinite(v) || v < a.min || v > a.max)
    throw new EngineError('INVALID_INPUT', `${what} ${param} = ${v} is outside ${a.min}..${a.max}`);
}

// ---------------------------------------------------------------------------------------------------------------
// animated effects

import type { Clip, Fx } from '@studio/core';
import { easeFn } from '@studio/motion/ease';
import { effectLines, pluginEffectDecl as declOf, type FxContext } from './plugins.js';
import { expr, pointsOf } from './zoom.js';

type KfList = NonNullable<Clip['keyframes']>[string];
type Node = Extract<Fx, { type: 'plugin' | 'lut' }>;

/** The eased value of a keyframe list at clip-local time `tMs`: holds before the first and after the last. */
export function sampleCurve(kfs: KfList, tMs: number): number {
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (tMs <= k[0]!.t) return k[0]!.v;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1]!;
    const b = k[i]!;
    if (tMs < b.t) {
      const e = a.ease ?? 'linear';
      if (e === 'hold') return a.v;
      const u = (tMs - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * (e === 'linear' ? u : easeFn(e)(u));
    }
  }
  return k[k.length - 1]!.v;
}

const propOf = (node: string, name: string) => `fx.${node}.${name}`;
const nodeOf = (f: Fx): string | undefined => (f as { node?: string }).node;
const sec = (n: number) => (Math.round(n * 1e4) / 1e4).toString();

/** The parameters of a node that have keyframes. */
export function animatedParams(c: Clip, f: Fx): string[] {
  const node = nodeOf(f);
  if (!node) return [];
  const pre = `fx.${node}.`;
  return Object.keys(c.keyframes ?? {})
    .filter((p) => p.startsWith(pre))
    .map((p) => p.slice(pre.length));
}

/** Checks every effect keyframe of a clip against the effect it names; throws with the allowed names and range. */
export function checkClipKeyframes(c: Clip): void {
  for (const [prop, kfs] of Object.entries(c.keyframes ?? {})) {
    const m = /^fx\.(f_[^.]+)\.(\w+)$/.exec(prop);
    if (!m) continue;
    const fx = (c.fx ?? []).find((f) => nodeOf(f) === m[1]);
    if (!fx) throw new EngineError('INVALID_INPUT', `${c.id}: keyframes on ${prop} but the clip has no effect ${m[1]}`, 'studio fx list shows the effects and their ids');
    for (const k of kfs) checkEffectKeyframe(fx.type === 'plugin' ? { type: 'plugin', id: fx.id } : { type: fx.type }, m[2]!, k.v);
  }
}

export interface AnimCtx {
  fps: number;
  /** where the clip starts on the timeline, in seconds: the stream's timestamps carry this offset */
  atSec: number;
  /** the LUT filter lines of a `lut` node (reads `from`, writes `to`) */
  lut?: (from: string, to: string, uid: string) => string[];
}

/**
 * Sample spacing and cap for animated parameters (STUDIO_ANIM_STEP / STUDIO_ANIM_MAX override them, for tuning and tests).
 * Fewer samples render faster and follow the curve less closely; measured on lumetri exposure 0 to 1.5: 0.5 s apart is
 * about 1 level off, 1 s apart about 2 on a 3 s clip.
 */
const STEP_SEC = Number(process.env['STUDIO_ANIM_STEP']) > 0 ? Number(process.env['STUDIO_ANIM_STEP']) : 0.35;
const MAX_SAMPLES = Number(process.env['STUDIO_ANIM_MAX']) > 1 ? Number(process.env['STUDIO_ANIM_MAX']) : 14;

/**
 * The FFmpeg lines for one effect node that may be partly off (`mix`) or animated (keyframes on its number parameters).
 *
 * `mix` m shows (1-m) of the picture before the effect and m of the picture after it. A keyframed parameter is rendered
 * as the effect at two neighbouring sample values over a slice of the clip, blended with a weight that moves linearly
 * between them; the samples sit on every keyframe and at most 0.25 s apart, and the values at the samples follow the
 * keyframes' easing, so the curve is exact at the keyframes and follows its shape between them. That works for every
 * effect and every number parameter. Each sample is rendered once and shared by the two pieces next to it, so every
 * frame is rendered twice and the graph holds one effect per sample. Measured on 3 and 10 s clips: 3 to 4 times the cost
 * of the same effect fixed, within about 1 level (of 255) of the effect at the exact value. An effect whose filters carry
 * state over time (temporal denoise, frame blending) starts over at each sample.
 */
export function nodeLines(c: Clip, f: Node, from: string, to: string, uid: string, ctx: FxContext, a: AnimCtx): string[] {
  const node = nodeOf(f);
  const mixKfs = node ? c.keyframes?.[propOf(node, 'mix')] : undefined;
  const staticMix = f.mix ?? 1;
  const params = animatedParams(c, f).filter((p) => p !== 'mix');
  const core = (i: string, o: string, u: string, p: Record<string, unknown> | undefined): string[] =>
    f.type === 'plugin' ? effectLines({ id: f.id, ...(p ? { params: p } : {}) }, i, o, u, ctx) : a.lut!(i, o, u);

  let inner: (i: string, o: string, u: string) => string[];
  if (!params.length) inner = (i, o, u) => core(i, o, u, f.type === 'plugin' ? f.params : undefined);
  else if (f.type !== 'plugin') inner = (i, o, u) => core(i, o, u, undefined);
  else {
    const decl = declOf(f.id);
    if (decl?.stage === 'source')
      throw new EngineError('ENGINE_MISSING', `${c.id}: effect ${f.id} works on the source frames and cannot be keyframed`, 'keyframe its mix, or choose another effect');
    inner = (i, o, u) => sliced(c, f, params, i, o, u, a, (inp, out, uu, p) => core(inp, out, uu, p));
  }
  if (!mixKfs && staticMix >= 1) return inner(from, to, uid);
  if (!mixKfs && staticMix <= 0) return [`[${from}]null[${to}]`];
  const w = mixKfs ? expr(pointsOf(mixKfs, staticMix).map((p) => ({ t: p.t + a.atSec, v: p.v }))).replace(/\bt\b/g, 'T') : sec(staticMix);
  return [
    `[${from}]split=2[${uid}mo][${uid}mi]`,
    ...inner(`${uid}mi`, `${uid}me`, `${uid}m`),
    `[${uid}mo][${uid}me]blend=all_expr='A*(1-(${w}))+B*(${w})'[${to}]`,
  ];
}

function sliced(
  c: Clip,
  f: Extract<Node, { type: 'plugin' }>,
  names: string[],
  from: string,
  to: string,
  uid: string,
  a: AnimCtx,
  core: (i: string, o: string, u: string, p: Record<string, unknown>) => string[],
): string[] {
  const node = nodeOf(f)!;
  const decl = declOf(f.id);
  const curves = Object.fromEntries(names.map((n) => [n, c.keyframes![propOf(node, n)]!]));
  const times = new Set<number>();
  for (const k of Object.values(curves)) for (const x of k) times.add(x.t);
  const keys = [...times].sort((x, y) => x - y);
  const t0 = keys[0]!;
  const tN = keys[keys.length - 1]!;
  // sample times: every keyframe, and enough between to keep the blend short
  const samples = new Set<number>(keys);
  const span = (tN - t0) / 1000;
  const extra = Math.min(MAX_SAMPLES - keys.length, Math.max(0, Math.ceil(span / STEP_SEC) - (keys.length - 1)));
  if (extra > 0) {
    const gaps = keys.slice(1).map((t, i) => ({ a: keys[i]!, b: t }));
    const per = Math.ceil(extra / Math.max(1, gaps.length));
    for (const g of gaps) {
      const n = Math.min(per, Math.max(0, Math.ceil((g.b - g.a) / 1000 / STEP_SEC) - 1));
      for (let j = 1; j <= n; j++) samples.add(Math.round(g.a + ((g.b - g.a) * j) / (n + 1)));
    }
  }
  const S = [...samples].sort((x, y) => x - y);
  const total = Math.max(1, Math.round((c.dur / 1000) * a.fps));
  // sample frames on the clip's own frame grid; a sample on the same frame as the one before it adds nothing
  const idx: { t: number; n: number }[] = [];
  for (const t of S) {
    const n = Math.round((t / 1000) * a.fps);
    if (!idx.length || n > idx[idx.length - 1]!.n) idx.push({ t, n });
  }
  const valuesAt = (tMs: number) => {
    const p: Record<string, unknown> = { ...(f.params ?? {}) };
    for (const [n, k] of Object.entries(curves)) {
      const v = sampleCurve(k, tMs);
      p[n] = decl?.params[n]?.integer ? Math.round(v) : v;
    }
    return p;
  };
  // The pieces of the clip, in order: before the first sample (held), between each pair of samples (blended), after the last
  // (held). A render window can cut the clip, so pieces are clamped to the frames that exist and empty ones dropped; the
  // blend weight stays anchored to the real sample frames. Each sample is rendered ONCE over the frames of the (up to two)
  // pieces that touch it, and shared: that is what keeps a long animation from costing two renders per piece.
  interface Piece { a: number; b: number; kind: 'hold' | 'blend'; i: number; off: number; span: number }
  const first = idx[0]!;
  const last = idx[idx.length - 1]!;
  const pieces: Piece[] = [];
  if (first.n > 0 && Math.min(first.n, total) > 0) pieces.push({ a: 0, b: Math.min(first.n, total), kind: 'hold', i: 0, off: 0, span: 0 });
  for (let i = 0; i + 1 < idx.length; i++) {
    const A = idx[i]!;
    const B = idx[i + 1]!;
    const lo = Math.max(A.n, 0);
    const hi = Math.min(B.n, total);
    if (hi > lo) pieces.push({ a: lo, b: hi, kind: 'blend', i, off: lo - A.n, span: B.n - A.n });
  }
  if (last.n < total) pieces.push({ a: Math.max(last.n, 0), b: total, kind: 'hold', i: idx.length - 1, off: 0, span: 0 });
  // which pieces read which sample
  const uses = new Map<number, { p: number; a: number; b: number }[]>();
  const use = (j: number, p: number, a: number, b: number) => (uses.get(j) ?? uses.set(j, []).get(j)!).push({ p, a, b });
  pieces.forEach((pc, p) => {
    if (pc.kind === 'hold') use(pc.i, p, pc.a, pc.b);
    else {
      use(pc.i, p, pc.a, pc.b);
      use(pc.i + 1, p, pc.a, pc.b);
    }
  });
  const used = [...uses.keys()].sort((x, y) => x - y);
  const lines: string[] = [];
  lines.push(`[${from}]split=${used.length}${used.map((j) => `[${uid}s${j}]`).join('')}`);
  // out[p] collects the streams a piece needs: [hold] or [A, B]
  const feed = new Map<string, string>();
  for (const j of used) {
    const u = uses.get(j)!;
    const base = Math.min(...u.map((x) => x.a));
    const end = Math.max(...u.map((x) => x.b));
    const whole = end >= total ? `start_frame=${base}` : `start_frame=${base}:end_frame=${end}`;
    lines.push(`[${uid}s${j}]trim=${whole}[${uid}t${j}]`);
    lines.push(...core(`${uid}t${j}`, `${uid}e${j}`, `${uid}h${j}`, valuesAt(idx[j]!.t)));
    const outs = u.map((_, k) => `${uid}e${j}u${k}`);
    if (u.length > 1) lines.push(`[${uid}e${j}]split=${u.length}${outs.map((o) => `[${o}]`).join('')}`);
    u.forEach((x, k) => {
      const src = u.length > 1 ? outs[k]! : `${uid}e${j}`;
      const rel = `start_frame=${x.a - base}:end_frame=${x.b - base}`;
      const label = `${uid}u${j}p${x.p}`;
      lines.push(`[${src}]trim=${rel}[${label}]`);
      feed.set(`${j}:${x.p}`, label);
    });
  }
  const parts: string[] = [];
  pieces.forEach((pc, p) => {
    if (pc.kind === 'hold') parts.push(feed.get(`${pc.i}:${p}`)!);
    else {
      const w = pc.off ? `(N+${pc.off})/${pc.span}` : `N/${pc.span}`;
      lines.push(`[${feed.get(`${pc.i}:${p}`)}][${feed.get(`${pc.i + 1}:${p}`)}]blend=all_expr='A*(1-${w})+B*${w}'[${uid}bl${p}]`);
      parts.push(`${uid}bl${p}`);
    }
  });
  // every slice restarts at 0 for the join; the clip's own offset on the timeline is put back after it
  const reset = parts.map((l, j) => `[${l}]setpts=PTS-STARTPTS[${uid}z${j}]`);
  lines.push(...reset);
  lines.push(`${parts.map((_, j) => `[${uid}z${j}]`).join('')}concat=n=${parts.length}:v=1:a=0[${uid}cc]`);
  lines.push(`[${uid}cc]setpts=PTS+${sec(a.atSec)}/TB[${to}]`);
  return lines;
}
