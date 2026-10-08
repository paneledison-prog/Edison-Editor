import { ANIMATABLE, CONTAINERS, MAX_LAYERS, isColorProp, type Design, type Layer } from './schema.js';
import type { Issue } from './util.js';

const NUM_RANGE: Record<string, [number, number]> = {
  opacity: [0, 1],
  scale: [0, 50],
  trim: [0, 1],
  charProgress: [0, 1],
  volume: [0, 2],
  w: [0, 20000],
  h: [0, 20000],
  cornerRadius: [0, 20000],
  strokeWidth: [0, 200],
  shadowBlur: [0, 500],
  layerBlur: [0, 500],
};

/** Everything the zod schema cannot say: the tree, the clock, and which keyframes make sense on which layer. */
export function validateDesign(d: Design): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, path: string) => issues.push({ code, message, path });
  if (d.layers.length > MAX_LAYERS) add('TOO_MANY', `${d.layers.length} layers, max ${MAX_LAYERS}`, 'layers');
  const byId = new Map<string, Layer>();
  for (const l of d.layers) {
    if (byId.has(l.id)) add('DUP_ID', `duplicate layer id ${l.id}`, `layers.${l.id}`);
    byId.set(l.id, l);
  }
  const kfIds = new Set<string>();
  for (const l of d.layers) {
    const at = `layers.${l.id}`;
    if (l.parent !== null) {
      const p = byId.get(l.parent);
      if (!p) add('BAD_PARENT', `${l.id}: parent ${l.parent} does not exist`, at);
      else if (!CONTAINERS.includes(p.type)) add('BAD_PARENT', `${l.id}: parent ${l.parent} is a ${p.type}, not a frame or group`, at);
    }
    // cycle: walking up must end
    let hops = 0;
    for (let p: string | null = l.parent; p; p = byId.get(p)?.parent ?? null)
      if (++hops > d.layers.length) {
        add('CYCLE', `${l.id}: the parent chain loops`, at);
        break;
      }
    if (l.start !== undefined && l.end !== undefined && l.end <= l.start)
      add('TIMING', `${l.id}: end (${l.end}) must be after start (${l.start})`, at);
    if ((l.end ?? 0) > d.meta.duration) add('TIMING', `${l.id}: end ${l.end} is after the scene end (${d.meta.duration})`, at);
    if (l.type === 'audio' && l.parent !== null && byId.get(l.parent)?.type === 'group') {
      /* allowed: audio inside a group still plays */
    }
    for (const [prop, kfs] of Object.entries(l.anim ?? {})) {
      const here = `${at}.anim.${prop}`;
      if (!(ANIMATABLE as readonly string[]).includes(prop))
        add('BAD_PROP', `${l.id}: "${prop}" cannot be animated; animatable: ${ANIMATABLE.join(', ')}`, here);
      if (prop === 'trim' && l.type !== 'path') add('BAD_PROP', `${l.id}: trim animates paths only`, here);
      if (prop === 'charProgress' && l.type !== 'text') add('BAD_PROP', `${l.id}: charProgress animates text only`, here);
      if (prop === 'volume' && l.type !== 'audio') add('BAD_PROP', `${l.id}: volume animates audio only`, here);
      let prev = -1;
      for (const k of kfs) {
        if (kfIds.has(k.id)) add('DUP_ID', `duplicate keyframe id ${k.id}`, here);
        kfIds.add(k.id);
        if (k.t > d.meta.duration) add('KF_BOUNDS', `${l.id} ${prop}: keyframe at ${k.t} ms is after the scene end`, here);
        if (k.t <= prev) add('KF_ORDER', `${l.id} ${prop}: keyframe times must increase (${prev} then ${k.t})`, here);
        prev = k.t;
        if (isColorProp(prop) !== (typeof k.v === 'string'))
          add('KF_TYPE', `${l.id} ${prop}: expected ${isColorProp(prop) ? 'a #RRGGBB colour' : 'a number'}`, here);
        const r = NUM_RANGE[prop];
        if (r && typeof k.v === 'number' && (k.v < r[0] || k.v > r[1]))
          add('KF_RANGE', `${l.id} ${prop}: ${k.v} is outside ${r[0]}..${r[1]}`, here);
      }
    }
    if (isColorProp('fill') && l.anim?.['fill'] && l.fill && l.fill.type !== 'solid')
      add('KF_TYPE', `${l.id}: fill colour keyframes need a solid fill`, `${at}.anim.fill`);
  }
  return issues;
}
