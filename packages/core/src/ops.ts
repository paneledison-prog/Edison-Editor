import { z } from 'zod';
import { cryptoRng, makeId, type Rng } from './ids.js';
import {
  Asset,
  Clip,
  ClipId,
  Ease,
  Export,
  Fx,
  Meta,
  speedOf,
  KeyframeId,
  MarkerId,
  AssetId,
  Matte,
  MatteId,
  Tracker,
  TrackerId,
  TrackId,
  TrackType,
  PropName,
  Transform,
  type Project,
} from './schema.js';
import { validateProject, type Issue } from './validate.js';

export type Actor = 'agent' | 'ui' | 'cli';

export interface OpSpec {
  type: string;
  args: Record<string, unknown>;
}
export interface Op extends OpSpec {
  id: string;
  actor: Actor;
  ts: number;
  /** Specs that, applied in order, undo this op. */
  inverse: OpSpec[];
}

export interface Ctx {
  actor: Actor;
  now: () => number;
  rng: Rng;
}
export const defaultCtx = (actor: Actor = 'agent'): Ctx => ({
  actor,
  now: Date.now,
  rng: cryptoRng(),
});

export type OpErrorCode = 'NOT_FOUND' | 'INVALID_ARGS' | 'VALIDATION' | 'UNKNOWN_OP';
export class OpError extends Error {
  constructor(
    public code: OpErrorCode,
    message: string,
    public issues: Issue[] = [],
  ) {
    super(message);
  }
}

interface OpDef<A> {
  args: z.ZodType<A, z.ZodTypeDef, unknown>;
  /** Fills generated ids so the logged args replay deterministically. */
  resolve?: (a: A, p: Project, ctx: Ctx) => A;
  /** Mutates the draft, returns inverse specs. */
  apply: (p: Project, a: A) => OpSpec[];
}
const def = <A>(d: OpDef<A>) => d;

const clipIds = (p: Project) => new Set(p.clips.map((c) => c.id));
const kfIdSet = (p: Project) =>
  new Set(
    p.clips.flatMap((c) => Object.values(c.keyframes ?? {}).flatMap((k) => k.map((x) => x.id))),
  );

function getClip(p: Project, id: string): Clip {
  const c = p.clips.find((x) => x.id === id);
  if (!c) throw new OpError('NOT_FOUND', `clip ${id} not found`);
  return c;
}
const snap = <T>(v: T): T => structuredClone(v);
const putSpec = (c: Clip): OpSpec => ({ type: 'clip.put', args: { clip: snap(c) } });
const ms = z.number().int().min(0);

const ClipInput = z.object({ clip: Clip });

export const OPS = {
  'asset.add': def({
    args: z.object({ id: AssetId.optional(), asset: Asset }),
    resolve: (a, p, ctx) => ({
      ...a,
      id: a.id ?? makeId('a', new Set(Object.keys(p.assets)), ctx.rng),
    }),
    apply(p, a) {
      if (p.assets[a.id!]) throw new OpError('INVALID_ARGS', `asset ${a.id} already exists`);
      p.assets[a.id!] = a.asset;
      return [{ type: 'asset.remove', args: { id: a.id } }];
    },
  }),
  'asset.remove': def({
    args: z.object({ id: AssetId }),
    apply(p, a) {
      const prev = p.assets[a.id];
      if (!prev) throw new OpError('NOT_FOUND', `asset ${a.id} not found`);
      delete p.assets[a.id];
      return [{ type: 'asset.add', args: { id: a.id, asset: snap(prev) } }];
    },
  }),

  'tracker.add': def({
    args: z.object({ id: TrackerId.optional(), tracker: Tracker }),
    resolve: (a, p, ctx) => ({ ...a, id: a.id ?? makeId('tk', new Set(Object.keys(p.trackers ?? {})), ctx.rng) }),
    apply(p, a) {
      if (p.trackers?.[a.id!]) throw new OpError('INVALID_ARGS', `tracker ${a.id} already exists`);
      (p.trackers ??= {})[a.id!] = a.tracker;
      return [{ type: 'tracker.remove', args: { id: a.id } }];
    },
  }),
  'tracker.set': def({
    args: z.object({ id: TrackerId, patch: z.record(z.unknown()) }),
    apply(p, a) {
      const prev = p.trackers?.[a.id];
      if (!prev) throw new OpError('NOT_FOUND', `tracker ${a.id} not found`);
      const next: Record<string, unknown> = { ...prev };
      const was: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.patch)) {
        was[k] = (prev as Record<string, unknown>)[k] ?? null;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      const parsed = Tracker.safeParse(next);
      if (!parsed.success) throw new OpError('INVALID_ARGS', `tracker ${a.id}: ${parsed.error.issues[0]!.path.join('.')} ${parsed.error.issues[0]!.message}`);
      p.trackers![a.id] = parsed.data;
      return [{ type: 'tracker.set', args: { id: a.id, patch: was } }];
    },
  }),
  'tracker.remove': def({
    args: z.object({ id: TrackerId }),
    apply(p, a) {
      const prev = p.trackers?.[a.id];
      if (!prev) throw new OpError('NOT_FOUND', `tracker ${a.id} not found`);
      delete p.trackers![a.id];
      if (!Object.keys(p.trackers!).length) delete p.trackers;
      return [{ type: 'tracker.add', args: { id: a.id, tracker: snap(prev) } }];
    },
  }),

  'matte.add': def({
    args: z.object({ id: MatteId.optional(), matte: Matte }),
    resolve: (a, p, ctx) => ({ ...a, id: a.id ?? makeId('mt', new Set(Object.keys(p.mattes ?? {})), ctx.rng) }),
    apply(p, a) {
      if (p.mattes?.[a.id!]) throw new OpError('INVALID_ARGS', `matte ${a.id} already exists`);
      (p.mattes ??= {})[a.id!] = a.matte;
      return [{ type: 'matte.remove', args: { id: a.id } }];
    },
  }),
  'matte.set': def({
    args: z.object({ id: MatteId, patch: z.record(z.unknown()) }),
    apply(p, a) {
      const prev = p.mattes?.[a.id];
      if (!prev) throw new OpError('NOT_FOUND', `matte ${a.id} not found`);
      const next: Record<string, unknown> = { ...prev };
      const was: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.patch)) {
        was[k] = (prev as Record<string, unknown>)[k] ?? null;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      const parsed = Matte.safeParse(next);
      if (!parsed.success) throw new OpError('INVALID_ARGS', `matte ${a.id}: ${parsed.error.issues[0]!.path.join('.')} ${parsed.error.issues[0]!.message}`);
      p.mattes![a.id] = parsed.data;
      return [{ type: 'matte.set', args: { id: a.id, patch: was } }];
    },
  }),
  'matte.remove': def({
    args: z.object({ id: MatteId }),
    apply(p, a) {
      const prev = p.mattes?.[a.id];
      if (!prev) throw new OpError('NOT_FOUND', `matte ${a.id} not found`);
      delete p.mattes![a.id];
      if (!Object.keys(p.mattes!).length) delete p.mattes;
      return [{ type: 'matte.add', args: { id: a.id, matte: snap(prev) } }];
    },
  }),

  'track.add': def({
    args: z.object({
      id: z.string().optional(),
      type: TrackType,
      name: z.string().min(1),
      role: z.string().optional(),
      index: z.number().int().min(0).optional(),
    }),
    resolve: (a, p, ctx) => ({
      ...a,
      id: a.id ?? makeId('t', new Set(p.tracks.map((t) => t.id)), ctx.rng),
    }),
    apply(p, a) {
      const id = TrackId.parse(a.id);
      if (p.tracks.some((t) => t.id === id))
        throw new OpError('INVALID_ARGS', `track ${id} already exists`);
      const t = { id, type: a.type, name: a.name, ...(a.role ? { role: a.role } : {}) };
      p.tracks.splice(a.index ?? p.tracks.length, 0, t);
      return [{ type: 'track.remove', args: { id } }];
    },
  }),
  'track.set': def({
    args: z.object({
      id: TrackId,
      patch: z
        .object({
          name: z.string().min(1),
          role: z.string(),
          muted: z.boolean(),
          hidden: z.boolean(),
          locked: z.boolean(),
        })
        .partial()
        .strict(),
    }),
    apply(p, a) {
      const t = p.tracks.find((x) => x.id === a.id);
      if (!t) throw new OpError('NOT_FOUND', `track ${a.id} not found`);
      const prevPatch: Record<string, unknown> = {};
      for (const k of Object.keys(a.patch) as (keyof typeof a.patch)[]) prevPatch[k] = t[k] ?? null;
      Object.assign(t, a.patch);
      return [{ type: 'track.set-raw', args: { id: a.id, patch: prevPatch } }];
    },
  }),
  /** Restores prior track fields; null deletes the field. Used as the inverse of track.set. */
  'track.set-raw': def({
    args: z.object({ id: TrackId, patch: z.record(z.unknown()) }),
    apply(p, a) {
      const t = p.tracks.find((x) => x.id === a.id) as Record<string, unknown> | undefined;
      if (!t) throw new OpError('NOT_FOUND', `track ${a.id} not found`);
      const prevPatch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.patch)) {
        prevPatch[k] = t[k] ?? null;
        if (v === null) delete t[k];
        else t[k] = v;
      }
      return [{ type: 'track.set-raw', args: { id: a.id, patch: prevPatch } }];
    },
  }),
  'track.remove': def({
    args: z.object({ id: TrackId }),
    apply(p, a) {
      const i = p.tracks.findIndex((x) => x.id === a.id);
      if (i < 0) throw new OpError('NOT_FOUND', `track ${a.id} not found`);
      if (p.clips.some((c) => c.track === a.id))
        throw new OpError('INVALID_ARGS', `track ${a.id} still has clips`);
      const [t] = p.tracks.splice(i, 1);
      return [{ type: 'track.add', args: { ...t, index: i } }];
    },
  }),

  'clip.add': def({
    args: z.object({ clip: Clip.innerType().extend({ id: ClipId.optional() }).strict() }),
    resolve: (a, p, ctx) => ({
      clip: { ...a.clip, id: a.clip.id ?? makeId('c', clipIds(p), ctx.rng) },
    }),
    apply(p, a) {
      const clip = Clip.parse(a.clip);
      if (p.clips.some((c) => c.id === clip.id))
        throw new OpError('INVALID_ARGS', `clip ${clip.id} already exists`);
      p.clips.push(clip);
      return [{ type: 'clip.delete', args: { id: clip.id } }];
    },
  }),
  /** Upsert of a whole clip. Inverse of most clip ops; also usable directly. */
  'clip.put': def({
    args: ClipInput,
    apply(p, a) {
      const clip = Clip.parse(a.clip);
      const i = p.clips.findIndex((c) => c.id === clip.id);
      if (i < 0) {
        p.clips.push(clip);
        return [{ type: 'clip.delete', args: { id: clip.id } }];
      }
      const prev = p.clips[i]!;
      p.clips[i] = clip;
      return [putSpec(prev)];
    },
  }),
  'clip.delete': def({
    args: z.object({ id: ClipId }),
    apply(p, a) {
      const c = getClip(p, a.id);
      p.clips.splice(p.clips.indexOf(c), 1);
      return [putSpec(c)];
    },
  }),
  'clip.move': def({
    args: z.object({ id: ClipId, start: ms, track: TrackId.optional() }),
    apply(p, a) {
      const c = getClip(p, a.id);
      const prev = snap(c);
      c.start = a.start;
      if (a.track) c.track = a.track;
      return [putSpec(prev)];
    },
  }),
  /** Absolute values, not deltas. srcIn changes the source in-point. */
  'clip.trim': def({
    args: z.object({
      id: ClipId,
      start: ms.optional(),
      dur: z.number().int().positive().optional(),
      srcIn: ms.optional(),
    }),
    apply(p, a) {
      const c = getClip(p, a.id);
      const prev = snap(c);
      if (a.start !== undefined) c.start = a.start;
      if (a.dur !== undefined) c.dur = a.dur;
      if (a.srcIn !== undefined) c.srcIn = a.srcIn;
      return [putSpec(prev)];
    },
  }),
  /**
   * Splits at timeline time `at` (strictly inside the clip). Keyframes before the cut stay left,
   * the rest move right, shifted. No boundary keyframe is synthesized, so an in-flight ease restarts
   * from the first right keyframe. Speed fx is not accounted for yet.
   */
  'clip.split': def({
    args: z.object({
      id: ClipId,
      at: ms,
      newId: ClipId.optional(),
      kfIds: z.array(KeyframeId).optional(),
    }),
    resolve(a, p, ctx) {
      const c = getClip(p, a.id);
      const moving = Object.values(c.keyframes ?? {})
        .flat()
        .filter((k) => k.t >= a.at - c.start).length;
      const taken = kfIdSet(p);
      const kfIds =
        a.kfIds ??
        Array.from({ length: moving }, () => {
          const id = makeId('k', taken, ctx.rng);
          taken.add(id);
          return id;
        });
      return { ...a, newId: a.newId ?? makeId('c', clipIds(p), ctx.rng), kfIds };
    },
    apply(p, a) {
      const c = getClip(p, a.id);
      if (!(a.at > c.start && a.at < c.start + c.dur)) {
        throw new OpError(
          'INVALID_ARGS',
          `split time ${a.at} ms is not inside clip ${c.id} (${c.start}–${c.start + c.dur} ms)`,
        );
      }
      const prev = snap(c);
      const leftDur = a.at - c.start;
      const right: Clip = snap(c);
      right.id = a.newId!;
      right.start = a.at;
      right.dur = c.dur - leftDur;
      if (c.srcIn !== undefined || c.asset)
        right.srcIn = (c.srcIn ?? 0) + Math.round(leftDur * speedOf(c));
      if (c.keyframes) {
        const ids = [...(a.kfIds ?? [])];
        const lk: NonNullable<Clip['keyframes']> = {};
        const rk: NonNullable<Clip['keyframes']> = {};
        for (const [prop, kfs] of Object.entries(c.keyframes)) {
          const l = kfs.filter((k) => k.t < leftDur);
          const r = kfs
            .filter((k) => k.t >= leftDur)
            .map((k) => ({ ...k, id: ids.shift()!, t: k.t - leftDur }));
          if (l.length) lk[prop] = l;
          if (r.length) rk[prop] = r;
        }
        c.keyframes = Object.keys(lk).length ? lk : undefined;
        right.keyframes = Object.keys(rk).length ? rk : undefined;
        if (!c.keyframes) delete c.keyframes;
        if (!right.keyframes) delete right.keyframes;
      }
      c.dur = leftDur;
      p.clips.push(right);
      return [{ type: 'clip.delete', args: { id: right.id } }, putSpec(prev)];
    },
  }),
  /**
   * Removes a clip and closes the gap. scope "track" shifts later clips on the same track;
   * "all" shifts later clips on every track and fails if a clip on another track straddles the gap.
   */
  'clip.ripple-delete': def({
    args: z.object({ id: ClipId, scope: z.enum(['track', 'all']).default('track') }),
    apply(p, a) {
      const c = getClip(p, a.id);
      const inverse: OpSpec[] = [];
      const end = c.start + c.dur;
      p.clips.splice(p.clips.indexOf(c), 1);
      inverse.push(putSpec(c));
      for (const o of p.clips) {
        if (a.scope === 'track' && o.track !== c.track) continue;
        if (o.start >= end) {
          inverse.push(putSpec(o));
          o.start -= c.dur;
        } else if (o.start + o.dur > c.start && o.start < end) {
          throw new OpError(
            'INVALID_ARGS',
            `clip ${o.id} straddles the ripple gap (${c.start}–${end} ms); trim or split it first`,
          );
        }
      }
      return inverse.reverse();
    },
  }),
  /**
   * Change playback speed (factor > 1 is faster). The clip's timeline duration becomes source-span / factor.
   * With ripple, later clips on the same track shift by the change in duration. Factor 1 removes the effect.
   */
  'clip.speed': def({
    args: z.object({
      id: ClipId,
      factor: z.number().min(0.1).max(16),
      ripple: z.boolean().optional(),
    }),
    apply(p, a) {
      const c = getClip(p, a.id);
      const inverse: OpSpec[] = [putSpec(c)];
      const oldEnd = c.start + c.dur;
      const srcSpan = c.dur * speedOf(c);
      const newDur = Math.max(1, Math.round(srcSpan / a.factor));
      const fx: Fx[] = (c.fx ?? []).filter((f) => f.type !== 'speed');
      if (a.factor !== 1) fx.unshift({ type: 'speed', factor: a.factor });
      if (fx.length) c.fx = fx;
      else delete c.fx;
      const delta = newDur - c.dur;
      c.dur = newDur;
      if (a.ripple && delta !== 0) {
        for (const o of p.clips) {
          if (o !== c && o.track === c.track && o.start >= oldEnd) {
            inverse.push(putSpec(o));
            o.start += delta;
          }
        }
      }
      return inverse.reverse();
    },
  }),
  /** Shallow patch of transform, fx, props, link, label. null removes the field. */
  'clip.set': def({
    args: z.object({
      id: ClipId,
      patch: z
        .object({
          transform: Transform.nullable(),
          fx: z.array(z.record(z.unknown())).nullable(),
          props: z.record(z.unknown()).nullable(),
          link: z.string().nullable(),
          label: z.string().nullable(),
        })
        .partial()
        .strict(),
    }),
    apply(p, a) {
      const c = getClip(p, a.id) as Record<string, unknown>;
      const prev = snap(c) as unknown as Clip;
      for (const [k, v] of Object.entries(a.patch)) {
        if (v === null) delete c[k];
        else c[k] = v;
      }
      return [putSpec(prev)];
    },
  }),

  'kf.set': def({
    args: z.object({
      clip: ClipId,
      prop: PropName,
      t: ms,
      v: z.number(),
      ease: Ease.optional(),
      id: KeyframeId.optional(),
    }),
    resolve(a, p, ctx) {
      const existing = getClip(p, a.clip).keyframes?.[a.prop]?.find((k) => k.t === a.t);
      return { ...a, id: a.id ?? existing?.id ?? makeId('k', kfIdSet(p), ctx.rng) };
    },
    apply(p, a) {
      const c = getClip(p, a.clip);
      const prev = snap(c);
      const kfs = ((c.keyframes ??= {})[a.prop] ??= []);
      const i = kfs.findIndex((k) => k.t === a.t);
      const k = { id: a.id!, t: a.t, v: a.v, ...(a.ease ? { ease: a.ease } : {}) };
      if (i >= 0) kfs[i] = k;
      else kfs.push(k);
      kfs.sort((x, y) => x.t - y.t);
      return [putSpec(prev)];
    },
  }),
  'kf.delete': def({
    args: z.object({ clip: ClipId, id: KeyframeId }),
    apply(p, a) {
      const c = getClip(p, a.clip);
      const prev = snap(c);
      let found = false;
      for (const [prop, kfs] of Object.entries(c.keyframes ?? {})) {
        const i = kfs.findIndex((k) => k.id === a.id);
        if (i >= 0) {
          kfs.splice(i, 1);
          if (!kfs.length) delete c.keyframes![prop];
          found = true;
        }
      }
      if (!found) throw new OpError('NOT_FOUND', `keyframe ${a.id} not found on clip ${a.clip}`);
      if (c.keyframes && !Object.keys(c.keyframes).length) delete c.keyframes;
      return [putSpec(prev)];
    },
  }),

  /** Canvas, frame rate, name, background. Validated like the schema; the inverse restores the previous values. */
  'project.set': def({
    args: z.object({ patch: Meta.partial().strict() }),
    apply(p, a) {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(a.patch) as (keyof typeof a.patch)[]) prev[k] = p.meta[k];
      if (!Object.keys(prev).length)
        throw new OpError(
          'INVALID_ARGS',
          'nothing to change: give at least one of name, fps, width, height, background',
        );
      Object.assign(p.meta, a.patch);
      return [{ type: 'project.set', args: { patch: prev } }];
    },
  }),

  'marker.add': def({
    args: z.object({ id: MarkerId.optional(), t: ms, label: z.string() }),
    resolve: (a, p, ctx) => ({
      ...a,
      id: a.id ?? makeId('m', new Set(p.markers.map((m) => m.id)), ctx.rng),
    }),
    apply(p, a) {
      if (p.markers.some((m) => m.id === a.id))
        throw new OpError('INVALID_ARGS', `marker ${a.id} already exists`);
      p.markers.push({ id: a.id!, t: a.t, label: a.label });
      return [{ type: 'marker.remove', args: { id: a.id } }];
    },
  }),
  'marker.remove': def({
    args: z.object({ id: MarkerId }),
    apply(p, a) {
      const i = p.markers.findIndex((m) => m.id === a.id);
      if (i < 0) throw new OpError('NOT_FOUND', `marker ${a.id} not found`);
      const [m] = p.markers.splice(i, 1);
      return [{ type: 'marker.add', args: { ...m } }];
    },
  }),

  /** Upsert by id. */
  'export.set': def({
    args: Export,
    apply(p, a) {
      const i = p.exports.findIndex((e) => e.id === a.id);
      if (i >= 0) {
        const prev = p.exports[i]!;
        p.exports[i] = a;
        return [{ type: 'export.set', args: { ...prev } }];
      }
      p.exports.push(a);
      return [{ type: 'export.remove', args: { id: a.id } }];
    },
  }),
  'export.remove': def({
    args: z.object({ id: z.string() }),
    apply(p, a) {
      const i = p.exports.findIndex((e) => e.id === a.id);
      if (i < 0) throw new OpError('NOT_FOUND', `export ${a.id} not found`);
      const [e] = p.exports.splice(i, 1);
      return [{ type: 'export.set', args: { ...e } }];
    },
  }),
} satisfies Record<string, OpDef<any>>;

export type OpType = keyof typeof OPS;
export const OP_TYPES = Object.keys(OPS) as OpType[];

export interface BatchResult {
  project: Project;
  ops: Op[];
}

/**
 * Atomic: applies every spec to a copy, validates the result, and returns it, or throws and
 * the input is untouched. Args are normalized (ids filled in) so the returned ops replay exactly.
 */
export function applyBatch(
  project: Project,
  specs: OpSpec[],
  ctx: Ctx = defaultCtx(),
): BatchResult {
  const draft = structuredClone(project);
  const ops: Op[] = [];
  const opIds = new Set<string>();
  specs.forEach((spec, i) => {
    const d = (OPS as Record<string, OpDef<any>>)[spec.type];
    if (!d) throw new OpError('UNKNOWN_OP', `op ${i}: unknown type "${spec.type}"`);
    const parsed = d.args.safeParse(spec.args);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((x) => `${x.path.join('.') || '(args)'}: ${x.message}`)
        .join('; ');
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
      if (e instanceof OpError)
        throw new OpError(e.code, `op ${i} ${spec.type}: ${e.message}`, e.issues);
      if (e instanceof z.ZodError)
        throw new OpError(
          'INVALID_ARGS',
          `op ${i} ${spec.type}: ${e.issues.map((x) => x.message).join('; ')}`,
        );
      throw e;
    }
  });
  const issues = validateProject(draft);
  if (issues.length) {
    throw new OpError(
      'VALIDATION',
      `validation failed: ${issues[0]!.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
      issues,
    );
  }
  return { project: draft, ops };
}

/** Specs that undo `ops` (last op first). */
export const inverseSpecs = (ops: Op[]): OpSpec[] => [...ops].reverse().flatMap((o) => o.inverse);

export function makeTxId(taken: ReadonlySet<string>, ctx: Ctx): string {
  return makeId('tx', taken, ctx.rng, 6);
}
