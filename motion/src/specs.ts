/**
 * Template catalogue: the props each template accepts, with defaults. Pure data plus validation, so the CLI,
 * the renderer, and the page all agree. A render with an unknown or ill-typed prop fails instead of ignoring it.
 */
import { EASE_RE } from '@studio/core';

export type PropType =
  'string' | 'number' | 'color' | 'ease' | 'boolean' | 'enum' | 'box' | 'cues' | 'list';
export interface PropSpec {
  type: PropType;
  default?: unknown;
  desc: string;
  min?: number;
  max?: number;
  maxLen?: number;
  values?: string[];
  optional?: boolean;
}
export interface TemplateSpec {
  id: string;
  summary: string;
  /** 'overlay' renders on transparent; 'full' covers the frame (intro, outro) unless `background` is transparent */
  kind: 'overlay' | 'full';
  defaultDurMs: number;
  props: Record<string, PropSpec>;
}

const ease = (d: string, desc: string): PropSpec => ({ type: 'ease', default: d, desc });
const colorProp = (d: string, desc: string): PropSpec => ({ type: 'color', default: d, desc });
const str = (desc: string, maxLen = 80, optional = false, d?: string): PropSpec => ({
  type: 'string',
  desc,
  maxLen,
  optional,
  ...(d !== undefined ? { default: d } : {}),
});

const COMMON = {
  ease: ease('expo.out', 'entrance easing (300-500 ms, expo.out or cubic.out)'),
  exitEase: ease('cubic.in', 'exit easing (200-300 ms)'),
  entranceMs: {
    type: 'number',
    default: 400,
    min: 0,
    max: 2000,
    desc: 'entrance duration in ms',
  } as PropSpec,
  exitMs: {
    type: 'number',
    default: 250,
    min: 0,
    max: 2000,
    desc: 'exit duration in ms',
  } as PropSpec,
};

export const TEMPLATES: Record<string, TemplateSpec> = {
  'lower-third': {
    id: 'lower-third',
    summary: 'Name and role bar in the bottom third, inside the title-safe area.',
    kind: 'overlay',
    defaultDurMs: 4000,
    props: {
      title: str('main line (a name)', 60, false, 'Name Surname'),
      subtitle: str('second line (a role)', 80, true, 'Role or title'),
      accent: colorProp('token:accent', 'accent bar color'),
      background: colorProp('token:panel', 'panel color'),
      color: colorProp('token:fg', 'title text color'),
      subtitleColor: colorProp('token:muted', 'subtitle text color'),
      align: {
        type: 'enum',
        values: ['left', 'right'],
        default: 'left',
        desc: 'which side the bar sits on',
      },
      ...COMMON,
    },
  },
  title: {
    id: 'title',
    summary: 'Centered title card text with a staggered word reveal; transparent background.',
    kind: 'overlay',
    defaultDurMs: 3500,
    props: {
      title: str('title text', 120, false, 'Title'),
      subtitle: str('subtitle text', 160, true),
      color: colorProp('token:fg', 'title color'),
      subtitleColor: colorProp('token:muted', 'subtitle color'),
      accent: colorProp('token:accent', 'underline accent'),
      align: {
        type: 'enum',
        values: ['center', 'left'],
        default: 'center',
        desc: 'text alignment',
      },
      staggerMs: {
        type: 'number',
        default: 60,
        min: 0,
        max: 200,
        desc: 'delay between words (40-80 ms)',
      },
      ...COMMON,
    },
  },
  callout: {
    id: 'callout',
    summary: 'Box drawn around a region, with an arrow and a label.',
    kind: 'overlay',
    defaultDurMs: 3500,
    props: {
      box: {
        type: 'box',
        default: { x: 0.35, y: 0.3, w: 0.3, h: 0.25 },
        desc: 'highlighted region as fractions of the frame {x,y,w,h}',
      },
      label: str('label text', 60, false, 'Look here'),
      labelPos: {
        type: 'enum',
        values: ['above', 'below'],
        default: 'below',
        desc: 'where the label sits',
      },
      color: colorProp('token:accent', 'box and arrow color'),
      labelColor: colorProp('token:onAccent', 'label text color'),
      layout: {
        type: 'enum',
        values: ['horizontal', 'vertical'],
        default: 'horizontal',
        desc: 'vertical enlarges the label for phone-sized canvases',
      },
      strokePx: {
        type: 'number',
        default: 6,
        min: 2,
        max: 24,
        desc: 'stroke width at 1080 px (scales with the frame)',
      },
      ...COMMON,
    },
  },
  'kinetic-text': {
    id: 'kinetic-text',
    summary: 'Large words that pop in one after another; transparent background.',
    kind: 'overlay',
    defaultDurMs: 3000,
    props: {
      text: str('words to animate', 140, false, 'Make every word count'),
      color: colorProp('token:fg', 'text color'),
      highlight: colorProp('token:accent', 'color of the last word'),
      staggerMs: { type: 'number', default: 70, min: 20, max: 400, desc: 'delay between words' },
      sizePct: {
        type: 'number',
        default: 11,
        min: 3,
        max: 30,
        desc: 'font size as % of the short side',
      },
      ...COMMON,
    },
  },
  intro: {
    id: 'intro',
    summary: 'Opening card: accent wipe, title, subtitle.',
    kind: 'full',
    defaultDurMs: 3000,
    props: {
      title: str('title', 80, false, 'Episode title'),
      subtitle: str('subtitle', 120, true),
      logo: str('logo image path (PNG), relative to the project', 4_000_000, true),
      background: colorProp('token:bg', 'background color, or "transparent"'),
      color: colorProp('token:fg', 'title color'),
      subtitleColor: colorProp('token:muted', 'subtitle color'),
      accent: colorProp('token:accent', 'wipe color'),
      ...COMMON,
    },
  },
  outro: {
    id: 'outro',
    summary: 'Closing card: message and call to action.',
    kind: 'full',
    defaultDurMs: 3500,
    props: {
      title: str('message', 80, false, 'Thanks for watching'),
      cta: str('call to action', 80, true),
      logo: str('logo image path (PNG), relative to the project', 4_000_000, true),
      background: colorProp('token:bg', 'background color, or "transparent"'),
      color: colorProp('token:fg', 'message color'),
      accent: colorProp('token:accent', 'call-to-action color'),
      ...COMMON,
    },
  },
  'cursor-highlight': {
    id: 'cursor-highlight',
    summary:
      'Expanding click rings at given moments and positions (positions are fractions of the canvas).',
    kind: 'overlay',
    defaultDurMs: 5000,
    props: {
      clicks: { type: 'list', desc: 'list of {t (ms from clip start), x, y (0..1 of the canvas)}' },
      ringMs: { type: 'number', default: 600, min: 200, max: 2000, desc: 'ring duration in ms' },
      sizePct: {
        type: 'number',
        default: 5,
        min: 1,
        max: 15,
        desc: 'final ring diameter as % of the short side',
      },
      color: colorProp('token:accent', 'ring color'),
      ease: ease('cubic.out', 'ring growth easing'),
    },
  },
  'speed-badge': {
    id: 'speed-badge',
    summary:
      'Small pill (for example "6x") that marks a sped-up section, top right inside the safe area.',
    kind: 'overlay',
    defaultDurMs: 2000,
    props: {
      label: str('badge text', 12, false, '4x'),
      color: colorProp('token:onAccent', 'text color'),
      background: colorProp('token:accent', 'pill color'),
      ...COMMON,
    },
  },
  captions: {
    id: 'captions',
    summary:
      'Burned-in captions from a cue list, with optional word highlight. Used by caption clips.',
    kind: 'overlay',
    defaultDurMs: 5000,
    props: {
      cues: { type: 'cues', desc: 'cues relative to the clip start, from `studio captions build`' },
      style: {
        type: 'enum',
        values: ['clean', 'social', 'karaoke'],
        default: 'clean',
        desc: 'clean = box, social = bold outline, karaoke = box + word highlight',
      },
      position: {
        type: 'enum',
        values: ['bottom', 'center', 'top'],
        default: 'bottom',
        desc: 'vertical placement inside the safe zone',
      },
      sizePct: {
        type: 'number',
        default: 0,
        min: 0,
        max: 12,
        desc: 'font size as % of frame height; 0 = by aspect (4% horizontal, 4.5% vertical)',
      },
      color: colorProp('token:captionText', 'text color'),
      highlight: colorProp('token:captionHighlight', 'active word color (karaoke)'),
      box: colorProp('token:captionBox', 'box color'),
      outline: colorProp('token:captionOutline', 'outline color'),
    },
  },
};

export interface Palette {
  colors: Record<string, string>;
  fonts: Record<string, { family: string; files: Record<string, string> }>;
}

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export function resolveColor(v: string, pal: Palette, where: string): string {
  if (v === 'transparent') return v;
  if (v.startsWith('token:')) {
    const c = pal.colors[v.slice(6)];
    if (!c)
      throw new Error(
        `${where}: unknown color token "${v}"; known: ${Object.keys(pal.colors).join(', ')}`,
      );
    return c;
  }
  if (!HEX.test(v))
    throw new Error(
      `${where}: "${v}" is not a #RRGGBB(AA) color, "transparent", or a token:<name>`,
    );
  return v;
}

/** Fills defaults, checks every prop, resolves colors. Throws one error listing every problem. */
export function resolveProps(
  comp: string,
  given: Record<string, unknown> | undefined,
  pal: Palette,
): Record<string, unknown> {
  const spec = TEMPLATES[comp];
  if (!spec)
    throw new Error(`unknown template "${comp}"; available: ${Object.keys(TEMPLATES).join(', ')}`);
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  const g = given ?? {};
  for (const k of Object.keys(g)) if (!(k in spec.props)) problems.push(`unknown prop "${k}"`);
  for (const [k, s] of Object.entries(spec.props)) {
    const v = g[k] !== undefined ? g[k] : s.default;
    if (v === undefined) {
      if (!s.optional && s.type !== 'string') problems.push(`missing prop "${k}" (${s.desc})`);
      else if (!s.optional) problems.push(`missing prop "${k}" (${s.desc})`);
      continue;
    }
    const bad = (m: string) => problems.push(`prop "${k}": ${m}`);
    switch (s.type) {
      case 'string':
        if (typeof v !== 'string') bad('expected a string');
        else if (s.maxLen && [...v].length > s.maxLen)
          bad(`${[...v].length} characters, max ${s.maxLen}`);
        else out[k] = v;
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) bad('expected a number');
        else if ((s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max))
          bad(`${v} is outside ${s.min}..${s.max}`);
        else out[k] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') bad('expected true or false');
        else out[k] = v;
        break;
      case 'enum':
        if (typeof v !== 'string' || !s.values!.includes(v))
          bad(`expected one of ${s.values!.join(', ')}`);
        else out[k] = v;
        break;
      case 'ease':
        if (typeof v !== 'string' || !EASE_RE.test(v)) bad(`"${String(v)}" is not an easing name`);
        else out[k] = v;
        break;
      case 'color':
        try {
          out[k] = resolveColor(String(v), pal, `prop "${k}"`);
        } catch (e) {
          problems.push((e as Error).message);
        }
        break;
      case 'box': {
        const b = v as Record<string, unknown>;
        const ok =
          b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((n) => typeof b[n] === 'number');
        if (!ok) bad('expected {x,y,w,h} as fractions of the frame');
        else if (
          (b['x']! as number) < 0 ||
          (b['y']! as number) < 0 ||
          (b['x'] as number) + (b['w'] as number) > 1 ||
          (b['y'] as number) + (b['h'] as number) > 1 ||
          (b['w'] as number) <= 0 ||
          (b['h'] as number) <= 0
        )
          bad('box must lie inside the frame (0..1)');
        else out[k] = { x: b['x'], y: b['y'], w: b['w'], h: b['h'] };
        break;
      }
      case 'cues':
        if (!Array.isArray(v) || !v.length) bad('expected a non-empty cue list');
        else out[k] = v;
        break;
      case 'list':
        if (!Array.isArray(v) || !v.length) bad('expected a non-empty list');
        else out[k] = v;
        break;
    }
  }
  if (problems.length) throw new Error(`${comp}: ${problems.join('; ')}`);
  return out;
}

/** Shortest duration that lets the entrance finish, the text be read (0.3 s/word, min 1.2 s), and the exit run. */
export function minDurMs(comp: string, props: Record<string, unknown>): number {
  const words = (s: unknown) =>
    typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean).length : 0;
  const n =
    words(props['title']) +
    words(props['subtitle']) +
    words(props['label']) +
    words(props['text']) +
    words(props['cta']);
  const read = Math.max(1200, n * 300);
  const inMs = Number(props['entranceMs'] ?? 400);
  const outMs = Number(props['exitMs'] ?? 250);
  return comp === 'captions' ? 1000 : Math.round(inMs + read + outMs);
}
