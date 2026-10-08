import { CONTAINERS, type Design, type Layer, type LayerType } from './schema.js';

const NAMES: Record<LayerType, string> = {
  frame: 'Frame', group: 'Group', rect: 'Rectangle', ellipse: 'Ellipse', star: 'Star',
  path: 'Path', text: 'Text', image: 'Image', audio: 'Audio',
};

/** Starting values for a new layer of a type. `id` and `parent` are filled by the op. */
export function layerDefaults(type: LayerType): Record<string, unknown> {
  const base = { type, x: 0, y: 0, w: 200, h: 120 };
  switch (type) {
    case 'frame':
      return { ...base, w: 400, h: 300, clip: true, fill: { type: 'solid', color: '#ffffff' } };
    case 'group':
      return { ...base, w: 100, h: 100 };
    case 'rect':
      return { ...base, fill: { type: 'solid', color: '#9b6bff' } };
    case 'ellipse':
      return { ...base, w: 160, h: 160, fill: { type: 'solid', color: '#9b6bff' } };
    case 'star':
      return { ...base, w: 160, h: 160, points: 5, innerRatio: 0.5, fill: { type: 'solid', color: '#ffd426' } };
    case 'path':
      return { ...base, w: 200, h: 100, d: 'M0 100 C60 0 140 0 200 100', stroke: { color: '#111111', width: 6 }, cap: 'round' };
    case 'text':
      return { ...base, w: 320, h: 64, text: 'Text', fontSize: 48, fontWeight: 600, fill: { type: 'solid', color: '#111111' } };
    case 'image':
      return { ...base, w: 240, h: 240, fit: 'cover' };
    case 'audio':
      return { ...base, w: 0, h: 0, volume: 1 };
  }
}

export const displayName = (type: LayerType, d: Design) =>
  `${NAMES[type]} ${d.layers.filter((l) => l.type === type).length + 1}`;

/** Sibling order is array order within one parent. The array is always kept in depth-first order so equal trees are equal bytes. */
export function normalize(layers: Layer[], reorder?: { parent: string | null; ids: string[] }): Layer[] {
  const kids = new Map<string | null, Layer[]>();
  for (const l of layers) {
    const k = kids.get(l.parent) ?? [];
    k.push(l);
    kids.set(l.parent, k);
  }
  if (reorder) {
    const cur = kids.get(reorder.parent) ?? [];
    const byId = new Map(cur.map((l) => [l.id, l]));
    kids.set(reorder.parent, reorder.ids.map((id) => byId.get(id)!).filter(Boolean));
  }
  const out: Layer[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null) => {
    for (const l of kids.get(p) ?? []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
      walk(l.id);
    }
  };
  walk(null);
  // anything unreachable (a broken parent pointer) is kept, in its old order, so validation can report it
  for (const l of layers) if (!seen.has(l.id)) out.push(l);
  return out;
}

export const siblings = (d: Design, parent: string | null) => d.layers.filter((l) => l.parent === parent);
export const canHold = (l: Layer) => CONTAINERS.includes(l.type);

/** Starting colours for new design content. They are the document's data (a new shape's fill), not the editor's own chrome. */
export const DEFAULT_COLORS = {
  fill: '#9b6bff',
  white: '#ffffff',
  black: '#000000',
  ink: '#111111',
  shadow: '#00000055',
  background: '#f7f7f8',
  shift: '#ff3b30',
} as const;
