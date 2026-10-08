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
