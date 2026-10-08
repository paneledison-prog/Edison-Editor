import { compileExpr, ExprError, EXPR_FUNCTIONS, type OpSpec } from '@studio/core';
import { easeFn } from '@studio/motion/ease';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num, parseJson, runSpecs, store, str } from './shared.js';

const FAMILIES = ['quad', 'cubic', 'quart', 'quint', 'sine', 'expo', 'circ', 'back', 'elastic', 'bounce'];
/** `expo_out(x)`, `cubic_inOut(x)`, ... : every named easing as a function of progress 0..1 */
export function easeFns(): Record<string, (x: number) => number> {
  const out: Record<string, (x: number) => number> = {};
  for (const f of FAMILIES)
    for (const d of ['in', 'out', 'inOut']) {
      const fn = easeFn(`${f}.${d}`);
      out[`${f}_${d}`] = (x) => fn(Math.min(1, Math.max(0, x)));
    }
  return out;
}

function compile(src: string) {
  try {
    return compileExpr(src, easeFns() as never);
  } catch (e) {
    if (e instanceof ExprError) throw new CliError('INVALID_ARGS', `expression: ${e.message}`, 2, 'studio expr eval --expr "..." tests a formula');
    throw e;
  }
}

/** Evaluates a formula at one or more times, so it can be checked before it is baked into keyframes. */
export const evaluate: Handler = async (inv) => {
  const src = str(inv, 'expr');
  if (!src) throw new CliError('INVALID_ARGS', '--expr is required', 2);
  const f = compile(src);
  const times = String(inv.flags['at'] ?? '0')
    .split(',')
    .map(Number);
  if (times.some((t) => !Number.isFinite(t))) throw new CliError('INVALID_ARGS', '--at must be seconds, e.g. 0,0.5,1', 2);
  const extra = inv.flags['vars'] ? parseJson('--vars', String(inv.flags['vars'])) : {};
  const dur = num(inv, 'dur') ?? 1;
  try {
    const values = times.map((t) => ({ t, v: Math.round(f({ t, f: t * 30, dur, p: dur ? t / dur : 0, ...extra }) * 1e5) / 1e5 }));
    return { data: { expr: src, values, functions: EXPR_FUNCTIONS, vars: ['t', 'f', 'dur', 'p', 'pi', 'tau', 'e'] } };
  } catch (e) {
    throw new CliError('INVALID_ARGS', `expression: ${(e as Error).message}`, 2);
  }
};

const BAKEABLE = ['scale', 'x', 'y'];
/** Samples a formula across a span of a clip and writes the samples as keyframes, in one undoable step. */
export const bake: Handler = async (inv) => {
  const clipId = str(inv, 'clip');
  const prop = str(inv, 'prop');
  const src = str(inv, 'expr');
  if (!clipId || !prop || !src) throw new CliError('INVALID_ARGS', '--clip, --prop and --expr are required', 2);
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${clipId}`, 2, 'studio project show');
  const from = num(inv, 'from') ?? 0;
  const to = num(inv, 'to') ?? clip.dur;
  const step = num(inv, 'step') ?? 100;
  if (!(from >= 0 && to <= clip.dur && to > from))
    throw new CliError('INVALID_ARGS', `--from/--to must satisfy 0 <= from < to <= clip duration (${clip.dur} ms)`, 2);
  if (step < 40) throw new CliError('INVALID_ARGS', '--step must be at least 40 ms (about one frame at 24 fps)', 2);
  const count = Math.floor((to - from) / step) + 1 + ((to - from) % step ? 1 : 0);
  if (count > 240) throw new CliError('INVALID_ARGS', `${count} keyframes is too many (max 240); raise --step`, 2);
  const f = compile(src);
  const specs: OpSpec[] = [];
  const samples: { t: number; v: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(to, from + i * step);
    let v: number;
    try {
      v = f({ t: t / 1000, f: (t / 1000) * project.meta.fps, dur: clip.dur / 1000, p: (t - from) / (to - from) });
    } catch (e) {
      throw new CliError('INVALID_ARGS', `expression at t=${t} ms: ${(e as Error).message}`, 2);
    }
    v = Math.round(v * 1e4) / 1e4;
    const [lo, hi] = prop === 'scale' ? [1, 8] : [0, 1];
    if (BAKEABLE.includes(prop) && (v < lo || v > hi))
      throw new CliError(
        'INVALID_ARGS',
        `expression gives ${v} at ${t} ms; ${prop} must stay within ${lo}..${hi} (wrap it in clamp(..., ${lo}, ${hi}) or max/min)`,
        2,
      );
    samples.push({ t, v });
    specs.push({ type: 'kf.set', args: { clip: clipId, prop, t, v, ease: str(inv, 'ease') ?? 'linear' } });
  }
  const res = runSpecs(inv, specs, `bake ${prop}`);
  const warnings = BAKEABLE.includes(prop)
    ? []
    : [`"${prop}" keyframes are stored but the renderer only animates ${BAKEABLE.join(', ')} on media clips`];
  return { ...res, data: { ...(res.data as Record<string, unknown>), baked: { prop, keyframes: samples.length, first: samples[0], last: samples[samples.length - 1] } }, warnings };
};
