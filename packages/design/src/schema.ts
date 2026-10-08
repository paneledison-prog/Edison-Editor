/**
 * The design document: one scene (an artboard with a duration), a tree of layers, and keyframes per layer.
 * It is deliberately not the media project: separate file, separate ops, separate editor. See docs/design.md.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const MAX_LAYERS = 2000;
export const MAX_KEYFRAMES_PER_PROP = 400;

// ids use the same alphabet as the rest of Studio (no i, l, o, u)
const ID_BODY = '[0-9a-hjkmnp-tv-z]{4,}';
export const LayerId = z.string().regex(new RegExp(`^l_${ID_BODY}$`), 'expected an id like l_k3f9');
export const KeyframeId = z.string().regex(new RegExp(`^k_${ID_BODY}$`), 'expected an id like k_k3f9');

const FAMILIES = 'quad|cubic|quart|quint|sine|expo|circ|back|elastic|bounce|spring';
const NUM = '-?\\d*\\.?\\d+';
export const EASE_RE = new RegExp(
  `^(linear|hold|(${FAMILIES})\\.(in|out|inOut)|bezier\\(\\s*${NUM}\\s*(,\\s*${NUM}\\s*){3}\\))$`,
);
export const Ease = z.string().regex(EASE_RE, 'unknown easing name');

export const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'expected #RRGGBB or #RRGGBBAA');
const ms = z.number().int().min(0).max(3_600_000);
const num = (lo: number, hi: number) => z.number().min(lo).max(hi);

/** Where a file may come from: inside the design project's assets folder, or a small embedded image. */
const AssetPath = z
  .string()
  .max(200)
  .regex(/^(?!.*\.\.)assets\/[A-Za-z0-9_][A-Za-z0-9_./ -]*$/, 'a path under assets/');
const ImageSrc = z.union([AssetPath, z.string().max(1_500_000).regex(/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/)]);

const Stop = z.object({ at: num(0, 1), color: Color }).strict();
export const Fill = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: Color }).strict(),
  z.object({ type: z.literal('linear'), angle: num(-360, 360), stops: z.array(Stop).min(2).max(8) }).strict(),
  z.object({ type: z.literal('radial'), stops: z.array(Stop).min(2).max(8) }).strict(),
]);
export type Fill = z.infer<typeof Fill>;

export const Stroke = z
  .object({ color: Color, width: num(0, 200), align: z.enum(['inside', 'center', 'outside']).optional() })
  .strict();
export const Shadow = z
  .object({ x: num(-500, 500), y: num(-500, 500), blur: num(0, 500), color: Color })
  .strict();

export const BLEND = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'difference'] as const;

/** The properties a keyframe can animate. Colours animate as colours, the rest as numbers. */
export const NUMERIC_PROPS = [
  'x', 'y', 'w', 'h', 'rotation', 'opacity', 'scale', 'cornerRadius', 'strokeWidth',
  'shadowX', 'shadowY', 'shadowBlur', 'layerBlur', 'trim', 'charProgress', 'volume',
] as const;
export const COLOR_PROPS = ['fill', 'stroke'] as const;
export const ANIMATABLE = [...NUMERIC_PROPS, ...COLOR_PROPS] as const;
export type AnimProp = (typeof ANIMATABLE)[number];
export const isColorProp = (p: string): p is (typeof COLOR_PROPS)[number] => (COLOR_PROPS as readonly string[]).includes(p);

export const Keyframe = z
  .object({ id: KeyframeId, t: ms, v: z.union([z.number(), Color]), ease: Ease.optional() })
  .strict();
export type Keyframe = z.infer<typeof Keyframe>;

const Base = {
  id: LayerId,
  name: z.string().min(1).max(80),
  parent: LayerId.nullable(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  x: num(-20000, 20000),
  y: num(-20000, 20000),
  w: num(0, 20000),
  h: num(0, 20000),
  /** degrees, clockwise, about the centre */
  rotation: num(-3600, 3600).optional(),
  opacity: num(0, 1).optional(),
  /** uniform scale about the centre */
  scale: num(0, 50).optional(),
  /** the layer exists from `start` to `end` (ms on the scene clock); default: the whole scene */
  start: ms.optional(),
  end: ms.optional(),
  fill: Fill.optional(),
  stroke: Stroke.optional(),
  cornerRadius: num(0, 20000).optional(),
  shadow: Shadow.optional(),
  layerBlur: num(0, 500).optional(),
  bgBlur: num(0, 500).optional(),
  /** frosted glass: a background blur with a light tint and a hairline edge */
  glass: z.boolean().optional(),
  blend: z.enum(BLEND).optional(),
  anim: z.record(z.string(), z.array(Keyframe).max(MAX_KEYFRAMES_PER_PROP)).optional(),
};

const Frame = z.object({ ...Base, type: z.literal('frame'), clip: z.boolean().optional() }).strict();
const Group = z.object({ ...Base, type: z.literal('group') }).strict();
const Rect = z.object({ ...Base, type: z.literal('rect') }).strict();
const Ellipse = z.object({ ...Base, type: z.literal('ellipse') }).strict();
const Star = z.object({ ...Base, type: z.literal('star'), points: z.number().int().min(3).max(32), innerRatio: num(0.05, 0.98) }).strict();
const Path = z
  .object({
    ...Base,
    type: z.literal('path'),
    /** SVG path data in the layer's own w x h box */
    d: z.string().max(20_000).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/, 'SVG path commands and numbers only'),
    /** how much of the outline is drawn, 0..1 (animatable: a line that draws itself) */
    trim: num(0, 1).optional(),
    cap: z.enum(['butt', 'round', 'square']).optional(),
  })
  .strict();
const Text = z
  .object({
    ...Base,
    type: z.literal('text'),
    text: z.string().max(2000),
    fontFamily: z.string().max(60).optional(),
    fontSize: num(1, 2000),
    fontWeight: z.number().int().min(100).max(900).optional(),
    lineHeight: num(0.5, 4).optional(),
    letterSpacing: num(-50, 200).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    /** how much of the text is shown, 0..1 (animatable: typewriter) */
    charProgress: num(0, 1).optional(),
  })
  .strict();
const Image = z
  .object({ ...Base, type: z.literal('image'), src: ImageSrc, fit: z.enum(['cover', 'contain', 'fill']).optional() })
  .strict();
const Audio = z
  .object({ ...Base, type: z.literal('audio'), src: AssetPath, volume: num(0, 2).optional(), trimIn: ms.optional() })
  .strict();

export const Layer = z.discriminatedUnion('type', [Frame, Group, Rect, Ellipse, Star, Path, Text, Image, Audio]);
export type Layer = z.infer<typeof Layer>;
export type LayerType = Layer['type'];
export const LAYER_TYPES = ['frame', 'group', 'rect', 'ellipse', 'star', 'path', 'text', 'image', 'audio'] as const;
/** the types that can hold children */
export const CONTAINERS: readonly string[] = ['frame', 'group'];

export const Meta = z
  .object({
    name: z.string().min(1).max(80),
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    fps: z.number().int().min(1).max(120),
    /** scene length in ms */
    duration: z.number().int().min(100).max(600_000),
    background: z.union([Color, z.literal('transparent')]),
  })
  .strict();
export type Meta = z.infer<typeof Meta>;

export const DesignSchema = z
  .object({ schema: z.literal(SCHEMA_VERSION), meta: Meta, layers: z.array(Layer).max(MAX_LAYERS) })
  .strict();
export type Design = z.infer<typeof DesignSchema>;

export function emptyDesign(meta: Partial<Meta> & { name: string }): Design {
  return {
    schema: SCHEMA_VERSION,
    meta: { width: 1280, height: 720, fps: 30, duration: 5000, background: '#f7f7f8', ...meta },
    layers: [],
  };
}
