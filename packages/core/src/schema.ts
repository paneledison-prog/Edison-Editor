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

/** A tracked region of an asset: where a flat patch of one frame goes in every other frame. The data is derived and cached. */
export const TrackerId = z.string().regex(/^tk_[0-9a-hjkmnp-tv-z]{4,10}$/, 'a tracker id such as tk_k3f9');
const Pt01 = z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)]);
export const Tracker = z
  .object({
    asset: AssetId,
    /** the source range that was analysed, in ms of the asset */
    from: z.number().int().min(0),
    to: z.number().int().min(1),
    /** the reference frame, in ms of the asset: the picture the region is drawn on */
    at: z.number().int().min(0),
    /** the region at the reference frame, four corners clockwise from the top left, as fractions of the displayed frame */
    quad: z.tuple([Pt01, Pt01, Pt01, Pt01]),
    /** plane3d solves the camera in 3D and follows the plane through it (needs a camera that moves through space) */
    model: z.enum(['translation', 'similarity', 'affine', 'homography', 'plane3d']),
    /** plane3d: the camera's horizontal field of view in degrees, as the starting value of the solve (default 58) */
    focal: z.number().min(10).max(150).optional(),
    /** plane3d: keep `focal` as given instead of refining it */
    fixFocal: z.boolean().optional(),
    /** align the reference picture to every frame after the point fit (removes drift; needs a region that stays visible) */
    refine: z.boolean().optional(),
    /** analysis frame rate and width (defaults: the source rate up to 30, 480 px) */
    fps: z.number().min(1).max(60).optional(),
    width: z.number().int().min(160).max(1280).optional(),
    label: z.string().max(80).optional(),
  })
  .strict();

/** A cut-out of an object in a video, made from marks the agent gives on some frames and followed through the rest. */
export const MatteId = z.string().regex(/^mt_[0-9a-hjkmnp-tv-z]{4,10}$/, 'a matte id such as mt_k3f9');
const Pt2 = z.tuple([z.number().min(-0.5).max(1.5), z.number().min(-0.5).max(1.5)]);
const MarkShape = z
  .object({
    /** points in fractions of the frame: one is a dot, several a stroke, a closed shape is filled */
    p: z.array(Pt2).min(1).max(400),
    /** stroke radius as a fraction of the frame width (default 0.006) */
    r: z.number().min(0.0005).max(0.2).optional(),
    closed: z.boolean().optional(),
  })
  .strict();
export const MatteSeeds = z
  .object({
    /** the object lies inside this box (x, y, w, h, fractions of the frame); outside it is background */
    box: z.tuple([z.number().min(-0.5).max(1.5), z.number().min(-0.5).max(1.5), z.number().min(0.001).max(2), z.number().min(0.001).max(2)]).optional(),
    fg: z.array(MarkShape).max(60).optional(),
    bg: z.array(MarkShape).max(60).optional(),
    /** a rough closed outline of the object: only the ring `band` wide around it is decided from the picture */
    outline: z.object({ p: z.array(Pt2).min(3).max(400), band: z.number().min(0.002).max(0.2).optional() }).strict().optional(),
    /** the object's exact mask, run-length coded (alternating runs over the rows, starting with zeros): what `bg subjects` found */
    mask: z.object({ w: z.number().int().min(16).max(1280), h: z.number().int().min(16).max(1280), rle: z.array(z.number().int().min(0)).min(1).max(40000) }).strict().optional(),
  })
  .strict();
export const Matte = z
  .object({
    asset: AssetId,
    /** the source range cut out, in ms of the asset */
    from: z.number().int().min(0),
    to: z.number().int().min(1),
    /** frames where the object was marked, in ms of the asset; the matte is followed from each to the next */
    keys: z
      .array(z.object({ at: z.number().int().min(0), seeds: MatteSeeds, prior: z.enum(['u2net', 'u2netp']).optional(), pick: z.enum(['auto', 'whole', 'smallest', 'best', 'first']).optional(), /** one of the segmenter's three candidates by number, instead of pick (what `bg subjects` lists) */ index: z.number().int().min(0).max(2).optional(), /** the object is not in the picture here (hidden, or out of frame): the matte is empty at this frame */ absent: z.boolean().optional() }).strict())
      .max(80),
    /** a matte that is the union of other mattes made on the same asset (several things kept, each followed on its own); it has no marked frames of its own */
    union: z.array(MatteId).min(2).max(12).optional(),
    fps: z.number().min(1).max(60).optional(),
    width: z.number().int().min(160).max(1280).optional(),
    /** what decides the boundary: a saliency model guided by the marks (auto: u2net when it can run), or the marks and colours alone */
    engine: z.enum(['auto', 'colour', 'u2net', 'u2netp', 'sam']).optional(),
    /** the edge: refined at the picture's own resolution, steadied over time, object colour cleaned of the old background */
    edge: z
      .object({
        /** output width of the matte in px (default the source's, up to 960) */
        width: z.number().int().min(160).max(3840).optional(),
        /** decide a band around the boundary again from the full-resolution picture (default on) */
        refine: z.boolean().optional(),
        /** a wider band where there is fine detail: hair (default off) */
        hair: z.boolean().optional(),
        /** flicker control, 0 (off) to 1 (default 0.7) */
        smooth: z.number().min(0).max(1).optional(),
        /** a trained matting model decides the opacity in the edge band: hair, fur, fine detail (slower: about 0.5 to 2 s a frame) */
        model: z.enum(['vitmatte']).optional(),
        /** take the old background out of the edge pixels' colour (default on) */
        decontaminate: z.boolean().optional(),
      })
      .strict()
      .optional(),
    label: z.string().max(80).optional(),
  })
  .strict()
  .refine((m) => (m.union ? m.keys.length === 0 : m.keys.length >= 1), { message: 'a matte has marked frames, or is the union of other mattes (and then has none of its own)' });
/** Where a matte is used on a clip: inside it (or outside, inverted), with a soft edge and a grow or shrink. */
export const MatteUse = z
  .object({
    id: MatteId,
    invert: z.boolean().optional(),
    /** edge softness in pixels of the output (0..40) */
    feather: z.number().min(0).max(40).optional(),
    /** shrinks the matte by this many pixels (negative grows it) */
    choke: z.number().min(-20).max(20).optional(),
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
 * Names one video effect on a clip (`f_xxxx`), so it can be changed, moved, keyframed or removed by name however the stack
 * is reordered. Optional: effects added before ids existed keep working and are addressed by position until they get one.
 */
export const NodeId = z.string().regex(/^f_[0-9a-hjkmnp-tv-z]{4,10}$/, 'an effect node id such as f_k3f9');
/**
 * Typed per-clip effects. Audio effects run in array order, then the join fades. An unknown type fails
 * validation instead of being ignored: a render must never silently skip an effect.
 */
export const Fx = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speed'), factor: num(0.1, 16) }).strict(),
  // Blurs a rectangle (fractions of the clip's frame) for the whole clip: a privacy fix for a visible secret.
  z
    .object({
      type: z.literal('blur-region'),
      x: num(0, 1),
      y: num(0, 1),
      w: num(0.005, 1),
      h: num(0.005, 1),
      strength: num(2, 80).optional(),
      node: NodeId.optional(),
    })
    .strict(),
  // A 3D LUT (.cube or .3dl) from inside the project folder, applied to the picture after the clip's own scale and zoom.
  z
    .object({
      type: z.literal('lut'),
      file: z
        .string()
        .max(200)
        .regex(/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./ -]*\.(cube|3dl)$/i, 'a .cube or .3dl path inside the project'),
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
      /** how much of the effect shows, 0..1 (default 1): the picture before it and after it, mixed */
      mix: num(0, 1).optional(),
      /** the effect applies only inside this matte */
      matte: MatteUse.optional(),
    })
    .strict(),
  // A plugin's video effect; the id and parameters are checked against the plugin's manifest at render time.
  z
    .object({
      type: z.literal('plugin'),
      id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
      params: z.record(z.string().max(24), z.union([z.number(), z.string().max(120), z.boolean()])).optional(),
      /** a node switched off: kept in the stack, skipped by the render */
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
      /** how much of the effect shows, 0..1 (default 1) */
      mix: num(0, 1).optional(),
      /** the effect applies only inside this matte */
      matte: MatteUse.optional(),
    })
    .strict(),
  // Removes everything outside a matte: the clip's picture becomes transparent there, so the tracks below show through.
  z
    .object({
      type: z.literal('cutout'),
      matte: MatteUse,
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
    })
    .strict(),
  // Erases an object: inside the matte the picture is replaced by the background as it was seen in other frames of the shot
  // (a clean plate made from the frames, never invented). `pad` grows the removed area by this many px of the picture's width / 1000.
  z
    .object({
      type: z.literal('erase'),
      matte: MatteUse,
      /** how far past the matte the removed area reaches, in thousandths of the picture's width (default 8) */
      pad: num(0, 60).optional(),
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
    })
    .strict(),
  // Steadies the picture: the camera path of a tracker, smoothed, undone frame by frame, with a crop that hides the borders.
  z
    .object({
      type: z.literal('stabilize'),
      tracker: TrackerId,
      /** seconds of camera motion that are kept (the path is smoothed over about this long); default 0.6 */
      smooth: num(0.05, 30).optional(),
      /** hold the frame completely still on the reference instead of smoothing */
      lock: z.boolean().optional(),
      /** the most the picture may be enlarged to hide the borders (1 = none); default 1.25 */
      maxZoom: num(1, 2).optional(),
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
    })
    .strict(),
  // Fixes an image or video onto a tracked plane: it follows the plane's corners through every frame.
  z
    .object({
      type: z.literal('pin'),
      tracker: TrackerId,
      asset: AssetId,
      /** where on the plane, at the tracker's reference frame (default: the tracked region itself) */
      quad: z.tuple([Pt01, Pt01, Pt01, Pt01]).optional(),
      opacity: num(0, 1).optional(),
      bypass: z.boolean().optional(),
      node: NodeId.optional(),
    })
    .strict(),
  z.object({ type: z.literal('gain'), db: num(-60, 40), node: NodeId.optional() }).strict(),
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
    trackers: z.record(TrackerId, Tracker).optional(),
    mattes: z.record(MatteId, Matte).optional(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Tracker = z.infer<typeof Tracker>;
export type Matte = z.infer<typeof Matte>;
export type MatteSeeds = z.infer<typeof MatteSeeds>;
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
