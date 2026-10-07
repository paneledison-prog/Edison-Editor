import { z } from 'zod';

export const SCHEMA_VERSION = 1;

const ms = z.number().int().min(0);
const idRe = (p: string) => new RegExp(`^${p}_[0-9a-z]{2,16}$`);
const idOf = (p: string) => z.string().regex(idRe(p), `expected an id like ${p}_xxxx`);
export const AssetId = idOf('a');
export const TrackId = idOf('t');
export const ClipId = idOf('c');
export const KeyframeId = idOf('k');
export const MarkerId = idOf('m');

const FAMILIES = 'quad|cubic|quart|quint|sine|expo|circ|back|elastic|bounce';
const NUM = '-?\\d*\\.?\\d+';
export const EASE_RE = new RegExp(
  `^(linear|hold|(${FAMILIES})\\.(in|out|inOut)|bezier\\(\\s*${NUM}\\s*(,\\s*${NUM}\\s*){3}\\))$`,
);
export const Ease = z.string().regex(EASE_RE, 'unknown easing name');

export const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const Probe = z
  .object({
    durMs: ms.optional(),
    fps: z.number().positive().optional(),
    rFps: z.number().positive().optional(),
    vfr: z.boolean().optional(),
    w: z.number().int().positive().optional(),
    h: z.number().int().positive().optional(),
    rotation: z.number().optional(),
    codec: z.string().optional(),
    pixFmt: z.string().optional(),
    colorRange: z.string().optional(),
    colorPrimaries: z.string().optional(),
    colorTransfer: z.string().optional(),
    colorSpace: z.string().optional(),
    hdr: z.boolean().optional(),
    audio: z
      .object({ sr: z.number().int().positive(), ch: z.number().int().positive() })
      .nullable()
      .optional(),
  })
  .strict();

const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'path must be relative and stay inside the project',
  });

export const Asset = z
  .object({
    path: relPath,
    kind: z.enum(['video', 'audio', 'image']),
    hash: z.string().regex(/^(sha256|fast-hash):[0-9a-f]{16,64}$/),
    probe: Probe,
    synthetic: z.boolean().optional(),
    /** CFR / normalized working copy used instead of the original for editing and render. */
    workingCopy: z.object({ path: relPath, reason: z.string() }).strict().optional(),
  })
  .strict();

export const TrackType = z.enum(['video', 'audio', 'graphics', 'captions']);
export const Track = z
  .object({
    id: TrackId,
    type: TrackType,
    name: z.string().min(1),
    role: z.string().optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .strict();

export const Transform = z
  .object({
    x: z.number(),
    y: z.number(),
    scale: z.number(),
    rot: z.number(),
    opacity: z.number().min(0).max(1),
  })
  .partial()
  .strict();

export const Keyframe = z
  .object({ id: KeyframeId, t: ms, v: z.number(), ease: Ease.optional() })
  .strict();

export const PropName = z.string().regex(/^[a-zA-Z][\w.]*$/);

const num = (lo: number, hi: number) => z.number().min(lo).max(hi);
/**
 * Typed per-clip effects. Audio effects run in array order, then the join fades. An unknown type fails
 * validation instead of being ignored: a render must never silently skip an effect.
 */
export const Fx = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speed'), factor: num(0.1, 16) }).strict(),
  z.object({ type: z.literal('gain'), db: num(-60, 40) }).strict(),
  z.object({ type: z.literal('highpass'), hz: num(20, 500) }).strict(),
  z
    .object({
      type: z.literal('denoise'),
      method: z.enum(['afftdn', 'arnndn']),
      nr: num(0, 40).optional(),
      nf: num(-80, -20).optional(),
      model: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('eq'),
      bands: z
        .array(
          z.object({ hz: num(20, 20000), gain: num(-24, 24), q: num(0.1, 10).optional() }).strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  z
    .object({
      type: z.literal('compress'),
      thresholdDb: num(-60, 0),
      ratio: num(1, 20),
      attackMs: num(0.01, 2000),
      releaseMs: num(0.01, 9000),
      makeupDb: num(0, 36).optional(),
    })
    .strict(),
  z.object({ type: z.literal('limit'), ceilingDb: num(-20, 0) }).strict(),
  z
    .object({
      type: z.literal('loudnorm'),
      I: num(-40, -5),
      TP: num(-9, 0),
      LRA: num(1, 20).optional(),
      measured: z
        .object({
          I: z.number(),
          TP: z.number(),
          LRA: z.number(),
          thresh: z.number(),
          offset: z.number(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('duck'),
      by: TrackId,
      thresholdDb: num(-60, 0),
      ratio: num(1, 20),
      attackMs: num(0.01, 2000),
      releaseMs: num(0.01, 9000),
      makeupDb: num(0, 36).optional(),
    })
    .strict(),
]);
export type Fx = z.infer<typeof Fx>;

export const Clip = z
  .object({
    id: ClipId,
    track: TrackId,
    asset: AssetId.optional(),
    comp: z.string().min(1).optional(),
    props: z.record(z.unknown()).optional(),
    start: ms,
    dur: z.number().int().positive(),
    srcIn: ms.optional(),
    transform: Transform.optional(),
    keyframes: z.record(PropName, z.array(Keyframe)).optional(),
    fx: z.array(Fx).optional(),
    link: z.string().optional(),
    label: z.string().optional(),
  })
  .strict()
  .refine((c) => (c.asset === undefined) !== (c.comp === undefined), {
    message: 'clip needs exactly one of asset or comp',
  });

export const Marker = z.object({ id: MarkerId, t: ms, label: z.string() }).strict();

export const Export = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    preset: z.string().min(1),
    reframe: z.string().optional(),
    range: z.tuple([ms, ms]).optional(),
  })
  .strict();

export const Meta = z
  .object({
    name: z.string().min(1),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: Color,
  })
  .strict();

export const ProjectSchema = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    meta: Meta,
    assets: z.record(AssetId, Asset),
    tracks: z.array(Track),
    clips: z.array(Clip),
    markers: z.array(Marker),
    exports: z.array(Export),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Asset = z.infer<typeof Asset>;
export type Track = z.infer<typeof Track>;
export type Clip = z.infer<typeof Clip>;
export type Keyframe = z.infer<typeof Keyframe>;
export type Marker = z.infer<typeof Marker>;
export type ExportSpec = z.infer<typeof Export>;
export type Meta = z.infer<typeof Meta>;

export function emptyProject(meta: Partial<Meta> & { name: string }): Project {
  return {
    schema: SCHEMA_VERSION,
    meta: { fps: 30, width: 1920, height: 1080, background: '#000000', ...meta },
    assets: {},
    tracks: [],
    clips: [],
    markers: [],
    exports: [],
  };
}

/** Migration registry: version N -> N+1. Empty at schema 1; a schema change must add an entry and a fixture. */
export const migrations: Record<number, (raw: any) => any> = {};

export function migrateToCurrent(raw: any): any {
  let v = raw?.schema;
  if (typeof v !== 'number') throw new Error('project file has no numeric "schema" field');
  if (v > SCHEMA_VERSION)
    throw new Error(`project schema ${v} is newer than supported ${SCHEMA_VERSION}`);
  while (v < SCHEMA_VERSION) {
    const m = migrations[v];
    if (!m) throw new Error(`no migration from schema ${v}`);
    raw = m(raw);
    v = raw.schema;
  }
  return raw;
}

/** Width and height as displayed after the rotation metadata is applied (coded w/h are stored as-is). */
export function displaySize(p: { w?: number; h?: number; rotation?: number }): {
  w?: number;
  h?: number;
} {
  return p.rotation === 90 || p.rotation === 270 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** Playback speed of a clip (1 when it has no speed effect). `dur` is timeline time; source time used is dur * speed. */
export function speedOf(c: { fx?: { type: string; factor?: number }[] }): number {
  return c.fx?.find((f) => f.type === 'speed')?.factor ?? 1;
}
