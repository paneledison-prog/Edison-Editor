/**
 * Every change to a design is an op: validated, logged, undoable. An op returns the ops that undo it, so history is
 * exact and `undo` brings the file back byte for byte.
 */
import { z } from 'zod';
import { layerDefaults, displayName, normalize, siblings } from './layers.js';
import { presetById, PRESETS } from './presets.js';
import {
  ANIMATABLE,
  Color,
  Ease,
  KeyframeId,
  Layer,
  LayerId,
  LAYER_TYPES,
  Meta,
  type Design,
  type Keyframe,
  type LayerType,
} from './schema.js';
import { subtree } from './anim.js';
import { validateDesign } from './validate.js';
import { cryptoRng, makeId, OpError, type Rng } from './util.js';

export type Actor = 'agent' | 'ui' | 'cli';
export interface OpSpec {
  type: string;
  args: Record<string, unknown>;
}
export interface Op extends OpSpec {
  id: string;
  actor: Actor;
  ts: number;
  inverse: OpSpec[];
}
export interface Ctx {
  actor: Actor;
  now: () => number;
  rng: Rng;
}
export const defaultCtx = (actor: Actor = 'agent'): Ctx => ({ actor, now: Date.now, rng: cryptoRng() });

interface OpDef<A> {
  args: z.ZodType<A, z.ZodTypeDef, unknown>;
  resolve?: (a: A, d: Design, ctx: Ctx) => A;
  apply: (d: Design, a: A) => OpSpec[];
}
const def = <A>(d: OpDef<A>) => d;
const snap = <T>(v: T): T => structuredClone(v);
const ms = z.number().int().min(0).max(3_600_000);

const layerIds = (d: Design) => new Set(d.layers.map((l) => l.id));
const kfIdSet = (d: Design) => new Set(d.layers.flatMap((l) => Object.values(l.anim ?? {}).flatMap((k) => k.map((x) => x.id))));

function get(d: Design, id: string) {
  const l = d.layers.find((x) => x.id === id);
  if (!l) throw new OpError('NOT_FOUND', `layer ${id} not found`);
  return l;
}
const siblingIndex = (d: Design, l: { id: string; parent: string | null }) => siblings(d, l.parent).findIndex((x) => x.id === l.id);

/** Puts `id` at `index` among its siblings (clamped), keeping everyone else's order. */
function place(d: Design, id: string, index?: number) {
  const l = get(d, id);
  const sibs = siblings(d, l.parent).map((x) => x.id).filter((x) => x !== id);
  const at = index === undefined ? sibs.length : Math.max(0, Math.min(sibs.length, index));
  sibs.splice(at, 0, id);
  d.layers = normalize(d.layers, { parent: l.parent, ids: sibs });
}

const PATCH_BLOCKED = new Set(['id', 'type', 'parent', 'anim']);

function parseLayer(raw: unknown): Layer {
  const r = Layer.safeParse(raw);
  if (!r.success) throw new OpError('INVALID_ARGS', r.error.issues.map((i) => `${i.path.join('.') || 'layer'}: ${i.message}`).join('; '));
  return r.data;
}

const KfSet = z.object({ layer: LayerId, prop: z.string().max(40), t: ms, v: z.union([z.number(), Color]), ease: Ease.optional(), id: KeyframeId.optional() });
type KfSetA = z.infer<typeof KfSet>;

function setKf(d: Design, a: KfSetA & { id: string }): OpSpec {
  const l = get(d, a.layer);
  if (!(ANIMATABLE as readonly string[]).includes(a.prop))
    throw new OpError('INVALID_ARGS', `"${a.prop}" cannot be animated; animatable: ${ANIMATABLE.join(', ')}`);
  const list = (l.anim ??= {});
  const arr = (list[a.prop] ??= []);
  const i = arr.findIndex((k) => k.t === a.t);
  const next: Keyframe = { id: i >= 0 ? arr[i]!.id : a.id, t: a.t, v: a.v, ...(a.ease ? { ease: a.ease } : {}) };
  if (i >= 0) {
    const prev = arr[i]!;
    arr[i] = next;
    return { type: 'kf.set', args: { layer: a.layer, prop: a.prop, t: prev.t, v: prev.v, ...(prev.ease ? { ease: prev.ease } : {}), id: prev.id } };
  }
  arr.push(next);
  arr.sort((x, y) => x.t - y.t);
  return { type: 'kf.delete', args: { layer: a.layer, id: next.id } };
}

export const OPS = {
  'scene.set': def({
    args: z.object({ patch: Meta.partial().strict() }),
    apply(d, a) {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(a.patch) as (keyof Meta)[]) prev[k] = d.meta[k];
      if (!Object.keys(prev).length) throw new OpError('INVALID_ARGS', 'nothing to change: give at least one of name, width, height, fps, duration, background');
      Object.assign(d.meta, a.patch);
      return [{ type: 'scene.set', args: { patch: prev } }];
    },
  }),

  'layer.add': def({
    args: z.object({
      layer: z.record(z.string(), z.unknown()),
      /** position among its siblings, 0 = back; default: front */
      index: z.number().int().min(0).optional(),
    }),
    resolve(a, d, ctx) {
      const layer = { ...a.layer };
      if (typeof layer['type'] !== 'string' || !(LAYER_TYPES as readonly string[]).includes(layer['type']))
        throw new OpError('INVALID_ARGS', `layer.type must be one of ${LAYER_TYPES.join(', ')}`);
      if (layer['id'] === undefined) layer['id'] = makeId('l', layerIds(d), ctx.rng);
      return { ...a, layer };
    },
    apply(d, a) {
      const type = a.layer['type'] as LayerType;
      const merged = { ...layerDefaults(type), name: displayName(type, d), parent: null, ...a.layer };
      const layer = parseLayer(merged);
      if (d.layers.some((l) => l.id === layer.id)) throw new OpError('INVALID_ARGS', `layer id ${layer.id} already exists`);
      d.layers.push(layer);
      place(d, layer.id, a.index);
      return [{ type: 'layer.delete', args: { id: layer.id } }];
    },
  }),

  'layer.set': def({
    args: z.object({ id: LayerId, patch: z.record(z.string(), z.unknown()) }),
    apply(d, a) {
      const l = get(d, a.id);
      const bad = Object.keys(a.patch).filter((k) => PATCH_BLOCKED.has(k));
      if (bad.length) throw new OpError('INVALID_ARGS', `${bad.join(', ')} cannot be set here (use layer.move for parent, kf.* for animation)`);
      if (!Object.keys(a.patch).length) throw new OpError('INVALID_ARGS', 'patch is empty');
      const prev: Record<string, unknown> = {};
      const next: Record<string, unknown> = { ...l };
      for (const [k, v] of Object.entries(a.patch)) {
        prev[k] = (l as Record<string, unknown>)[k] ?? null;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      const parsed = parseLayer(next);
      const i = d.layers.findIndex((x) => x.id === a.id);
      d.layers[i] = parsed;
      return [{ type: 'layer.set', args: { id: a.id, patch: prev } }];
    },
  }),

  'layer.delete': def({
    args: z.object({ id: LayerId }),
    apply(d, a) {
      const l = get(d, a.id);
      const index = siblingIndex(d, l);
      const gone = subtree(d, a.id);
      const ids = new Set(gone.map((x) => x.id));
      d.layers = d.layers.filter((x) => !ids.has(x.id));
      return [{ type: 'layer.restore', args: { parent: l.parent, index, layers: snap(gone) } }];
    },
  }),

  'layer.restore': def({
    args: z.object({ parent: LayerId.nullable(), index: z.number().int().min(0), layers: z.array(z.record(z.string(), z.unknown())).min(1) }),
    apply(d, a) {
      const layers = a.layers.map(parseLayer);
      const root = layers[0]!;
      if (d.layers.some((x) => layers.some((y) => y.id === x.id))) throw new OpError('INVALID_ARGS', 'a restored layer id already exists');
      d.layers.push(...layers);
      place(d, root.id, a.index);
      return [{ type: 'layer.delete', args: { id: root.id } }];
    },
  }),

  'layer.move': def({
    args: z.object({ id: LayerId, parent: LayerId.nullable().optional(), index: z.number().int().min(0).optional() }),
    apply(d, a) {
      const l = get(d, a.id);
      const prev = { id: a.id, parent: l.parent, index: siblingIndex(d, l) };
      if (a.parent !== undefined) {
        if (a.parent !== null) {
          const p = get(d, a.parent);
          if (!['frame', 'group'].includes(p.type)) throw new OpError('INVALID_ARGS', `${a.parent} is a ${p.type}; only frames and groups hold layers`);
          if (subtree(d, a.id).some((x) => x.id === a.parent)) throw new OpError('INVALID_ARGS', 'a layer cannot be moved inside itself');
        }
        l.parent = a.parent;
      }
      place(d, a.id, a.index);
      return [{ type: 'layer.move', args: prev }];
    },
  }),

  'layer.duplicate': def({
    args: z.object({ id: LayerId, ids: z.record(z.string(), z.string()).optional(), dx: z.number().optional(), dy: z.number().optional() }),
    resolve(a, d, ctx) {
      const taken = layerIds(d);
      const ktaken = kfIdSet(d);
      const map: Record<string, string> = a.ids ? { ...a.ids } : {};
      for (const l of subtree(d, a.id)) {
        if (!map[l.id]) map[l.id] = makeId('l', taken, ctx.rng);
        taken.add(map[l.id]!);
        for (const kfs of Object.values(l.anim ?? {})) for (const k of kfs) {
          const key = `kf:${k.id}`;
          if (!map[key]) map[key] = makeId('k', ktaken, ctx.rng);
          ktaken.add(map[key]!);
        }
      }
      return { ...a, ids: map };
    },
    apply(d, a) {
      const src = get(d, a.id);
      const map = a.ids!;
      const index = siblingIndex(d, src) + 1;
      const copies = snap(subtree(d, a.id)).map((l) => {
        const c: Record<string, any> = { ...l, id: map[l.id]! };
        c['parent'] = l.id === a.id ? l.parent : map[l.parent!]!;
        if (l.id === a.id) {
          c['name'] = `${l.name} copy`.slice(0, 80);
          c['x'] = l.x + (a.dx ?? 20);
          c['y'] = l.y + (a.dy ?? 20);
        }
        if (l.anim) c['anim'] = Object.fromEntries(Object.entries(l.anim).map(([p, kfs]) => [p, kfs.map((k) => ({ ...k, id: map[`kf:${k.id}`]! }))]));
        return parseLayer(c);
      });
      d.layers.push(...copies);
      place(d, copies[0]!.id, index);
      return [{ type: 'layer.delete', args: { id: copies[0]!.id } }];
    },
  }),

  'kf.set': def({
    args: KfSet,
    resolve: (a, d, ctx) => ({ ...a, id: a.id ?? makeId('k', kfIdSet(d), ctx.rng) }),
    apply: (d, a) => [setKf(d, a as KfSetA & { id: string })],
  }),

  'kf.delete': def({
    args: z.object({ layer: LayerId, id: KeyframeId }),
    apply(d, a) {
      const l = get(d, a.layer);
      for (const [prop, kfs] of Object.entries(l.anim ?? {})) {
        const i = kfs.findIndex((k) => k.id === a.id);
        if (i < 0) continue;
        const [k] = kfs.splice(i, 1);
        if (!kfs.length) delete l.anim![prop];
        if (l.anim && !Object.keys(l.anim).length) delete l.anim;
        return [{ type: 'kf.set', args: { layer: a.layer, prop, t: k!.t, v: k!.v, ...(k!.ease ? { ease: k!.ease } : {}), id: k!.id } }];
      }
      throw new OpError('NOT_FOUND', `keyframe ${a.id} not found on ${a.layer}`);
    },
  }),

  /** Sets a property's whole keyframe list (empty removes it). The inverse of clearing, and handy for retiming. */
  'anim.put': def({
    args: z.object({ layer: LayerId, prop: z.string().max(40), keyframes: z.array(z.record(z.string(), z.unknown())) }),
    apply(d, a) {
      const l = get(d, a.layer);
      const before = snap(l.anim?.[a.prop] ?? []);
      if (a.keyframes.length) {
        const r = z.array(z.object({ id: KeyframeId, t: ms, v: z.union([z.number(), Color]), ease: Ease.optional() }).strict()).safeParse(a.keyframes);
        if (!r.success) throw new OpError('INVALID_ARGS', r.error.issues.map((i) => i.message).join('; '));
        (l.anim ??= {})[a.prop] = [...r.data].sort((x, y) => x.t - y.t);
      } else if (l.anim) {
        delete l.anim[a.prop];
        if (!Object.keys(l.anim).length) delete l.anim;
      }
      return [{ type: 'anim.put', args: { layer: a.layer, prop: a.prop, keyframes: before } }];
    },
  }),

  'kf.clear': def({
    args: z.object({ layer: LayerId, prop: z.string().max(40).optional() }),
    apply(d, a) {
      const l = get(d, a.layer);
      const props = a.prop ? [a.prop] : Object.keys(l.anim ?? {});
      const inv: OpSpec[] = props.map((p) => ({ type: 'anim.put', args: { layer: a.layer, prop: p, keyframes: snap(l.anim?.[p] ?? []) } }));
      for (const p of props) if (l.anim) delete l.anim[p];
      if (l.anim && !Object.keys(l.anim).length) delete l.anim;
      return inv;
    },
  }),

  'anim.preset': def({
    args: z.object({
      layer: LayerId,
      preset: z.string().max(40),
      at: ms.optional(),
      dur: z.number().int().min(50).max(60_000).optional(),
      ease: Ease.optional(),
      from: z.enum(['left', 'right', 'top', 'bottom']).optional(),
      distance: z.number().min(0).max(20000).optional(),
      amount: z.number().min(0).max(1000).optional(),
      count: z.number().int().min(1).max(20).optional(),
      to: Color.optional(),
      /** filled in at resolve time so replays use the same keyframe ids */
      ids: z.array(KeyframeId).optional(),
    }),
    resolve(a, d, ctx) {
      const p = presetById(a.preset);
      if (!p) throw new OpError('INVALID_ARGS', `unknown preset "${a.preset}"; available: ${PRESETS.map((x) => x.id).join(', ')}`);
      if (a.ids) return a;
      const l = get(d, a.layer);
      const built = p.build(l, { at: a.at ?? 0, dur: a.dur ?? p.defaults.dur, scene: d.meta, ...(a.ease ? { ease: a.ease } : { ease: p.defaults.ease }) });
      const n = Object.values(built).reduce((s, v) => s + v.length, 0);
      const taken = kfIdSet(d);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = makeId('k', taken, ctx.rng);
        taken.add(id);
        ids.push(id);
      }
      return { ...a, ids };
    },
    apply(d, a) {
      const p = presetById(a.preset)!;
      const l = get(d, a.layer);
      if (p.types?.length && !p.types.includes(l.type)) throw new OpError('INVALID_ARGS', `preset ${p.id} is for ${p.types.join(', ')} layers, not ${l.type}`);
      const built = p.build(l, {
        at: a.at ?? 0,
        dur: a.dur ?? p.defaults.dur,
        ease: a.ease ?? p.defaults.ease,
        scene: d.meta,
        ...(a.from ? { from: a.from } : {}),
        ...(a.distance !== undefined ? { distance: a.distance } : {}),
        ...(a.amount !== undefined ? { amount: a.amount } : {}),
        ...(a.count !== undefined ? { count: a.count } : {}),
        ...(a.to ? { to: a.to } : {}),
      });
      const inverse: OpSpec[] = [];
      let n = 0;
      for (const [prop, kfs] of Object.entries(built)) {
        inverse.push({ type: 'anim.put', args: { layer: a.layer, prop, keyframes: snap(l.anim?.[prop] ?? []) } });
        // a preset owns the property over its own time window: keyframes of the property inside it are replaced
        const lo = Math.min(...kfs.map((x) => x.t));
        const hi = Math.max(...kfs.map((x) => x.t));
        const keep = (l.anim?.[prop] ?? []).filter((x) => x.t < lo || x.t > hi);
        (l.anim ??= {})[prop] = [
          ...keep,
          ...kfs.map((x) => ({ id: a.ids![n++]!, t: Math.min(x.t, d.meta.duration), v: x.v, ...(x.ease ? { ease: x.ease } : {}) })),
        ].sort((x, y) => x.t - y.t);
      }
      return inverse.reverse();
    },
  }),
} satisfies Record<string, OpDef<any>>;

export type OpType = keyof typeof OPS;
export const OP_TYPES = Object.keys(OPS) as OpType[];

export interface BatchResult {
  design: Design;
  ops: Op[];
}

/** Atomic: applies every spec to a copy, validates the result, returns it; on any error the input is untouched. */
export function applyBatch(design: Design, specs: OpSpec[], ctx: Ctx = defaultCtx()): BatchResult {
  const draft = structuredClone(design);
  const ops: Op[] = [];
  const opIds = new Set<string>();
  specs.forEach((spec, i) => {
    const d = (OPS as Record<string, OpDef<any>>)[spec.type];
    if (!d) throw new OpError('UNKNOWN_OP', `op ${i}: unknown type "${spec.type}"; known: ${OP_TYPES.join(', ')}`);
    const parsed = d.args.safeParse(spec.args);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((x) => `${x.path.join('.') || '(args)'}: ${x.message}`).join('; ');
      throw new OpError('INVALID_ARGS', `op ${i} ${spec.type}: ${msg}`);
    }
    let args = parsed.data;
    try {
      if (d.resolve) args = d.resolve(args, draft, ctx);
      const inverse = d.apply(draft, args);
      const id = makeId('op', opIds, ctx.rng, 6);
      opIds.add(id);
      ops.push({ id, type: spec.type, args, actor: ctx.actor, ts: ctx.now(), inverse });
    } catch (e) {
      if (e instanceof OpError) throw new OpError(e.code, `op ${i} ${spec.type}: ${e.message}`, e.issues);
      if (e instanceof z.ZodError) throw new OpError('INVALID_ARGS', `op ${i} ${spec.type}: ${e.issues.map((x) => x.message).join('; ')}`);
      throw e;
    }
  });
  draft.layers = normalize(draft.layers);
  const issues = validateDesign(draft);
  if (issues.length)
    throw new OpError('VALIDATION', `validation failed: ${issues[0]!.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`, issues);
  return { design: draft, ops };
}

export const inverseSpecs = (ops: Op[]): OpSpec[] => [...ops].reverse().flatMap((o) => o.inverse);
export const makeTxId = (taken: ReadonlySet<string>, ctx: Ctx) => makeId('tx', taken, ctx.rng, 6);
