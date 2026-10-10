/**
 * `studio layer ...`: clips as layers. A layer is a video clip on its own track; its picture can be placed over what is below
 * it (moved, sized, turned about an anchor, faded), statically or with keyframes. `studio bg layers` makes them from a shot:
 * one element per kept thing, cut out, and the background with those things erased.
 * Every change is an op (validated, logged, undoable); nothing is rendered until asked.
 */
import { cryptoRng, displaySize, makeId, type Clip, type Fx, type Project } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { fxSpecs, named } from './fx.js';
import { num, runSpecs, store, str } from './shared.js';

const PROPS = ['dx', 'dy', 'size', 'rot', 'opacity', 'ax', 'ay'] as const;
type Prop = (typeof PROPS)[number];
const RANGE: Record<Prop, [number, number]> = { dx: [-20000, 20000], dy: [-20000, 20000], size: [0.02, 8], rot: [-3600, 3600], opacity: [0, 1], ax: [-2, 3], ay: [-2, 3] };

function clipFor(inv: Invocation): { project: Project; clip: Clip } {
  const id = str(inv, 'clip') ?? inv.positionals[0];
  if (!id) throw new CliError('INVALID_ARGS', '--clip is required', 2, 'studio layer list');
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === id);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${id}`, 2, 'studio layer list');
  if (clip.comp) throw new CliError('INVALID_ARGS', `${id} is a composition clip: it moves through its props, not as a layer`, 2);
  return { project, clip };
}

const kindOf = (c: Clip): 'element' | 'background' | 'clip' =>
  (c.fx ?? []).some((f) => f.type === 'cutout' && !('bypass' in f && f.bypass)) ? 'element' : (c.fx ?? []).some((f) => f.type === 'erase') ? 'background' : 'clip';

/** `studio layer list`: the video layers, top first, grouped by link (the layers of one shot). */
export const list: Handler = async (inv) => {
  const { project } = store(inv).load();
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  const vids = project.clips
    .filter((c) => {
      const t = project.tracks.find((x) => x.id === c.track);
      return !!c.asset && (t?.type === 'video' || t?.type === 'graphics') && project.assets[c.asset]?.kind !== 'audio';
    })
    .sort((a, b) => order.get(b.track)! - order.get(a.track)! || a.start - b.start);
  const rows = vids.map((c) => {
    const t = project.tracks.find((x) => x.id === c.track)!;
    const cut = (c.fx ?? []).find((f) => f.type === 'cutout');
    const er = (c.fx ?? []).find((f) => f.type === 'erase');
    const cr = (c.fx ?? []).find((f) => f.type === 'crop' && !f.bypass) as { left?: number; top?: number; right?: number; bottom?: number; feather?: number } | undefined;
    const animated = Object.keys(c.keyframes ?? {}).filter((p) => (PROPS as readonly string[]).includes(p));
    return {
      clip: c.id,
      track: t.id,
      trackName: t.name,
      ...(t.hidden ? { hidden: true } : {}),
      kind: kindOf(c),
      ...(c.label ? { label: c.label } : {}),
      timeMs: [c.start, c.start + c.dur],
      ...(cut && cut.type === 'cutout' ? { matte: cut.matte.id } : {}),
      ...(er && er.type === 'erase' ? { erased: er.matte.id } : {}),
      ...(cr ? { crop: { left: cr.left ?? 0, top: cr.top ?? 0, right: cr.right ?? 0, bottom: cr.bottom ?? 0, ...(cr.feather ? { feather: cr.feather } : {}) } } : {}),
      ...(c.transform && Object.keys(c.transform).length ? { transform: c.transform } : {}),
      ...(animated.length ? { animated } : {}),
      ...(c.link ? { link: c.link } : {}),
    };
  });
  const links = [...new Set(rows.map((r) => r.link).filter(Boolean))] as string[];
  return {
    data: {
      layers: rows,
      ...(links.length ? { groups: Object.fromEntries(links.map((l) => [l, rows.filter((r) => r.link === l).map((r) => r.clip)])) } : {}),
      key: 'top first. kind: element (cut out by a matte), background (things erased from it), clip. A link groups the layers of one shot: they move and trim together in time.',
    },
  };
};

/**
 * `studio layer move`: place a layer. Without --t the values are the layer's (constant over the clip); with --t they are
 * keyframes at that time (ms from the clip's start), so two calls make a move from one place to another.
 */
export const move: Handler = async (inv) => {
  const { project, clip } = clipFor(inv);
  const given = PROPS.filter((p) => num(inv, p) !== undefined);
  if (!given.length) throw new CliError('INVALID_ARGS', `give at least one of ${PROPS.map((p) => `--${p}`).join(' ')}`, 2);
  for (const p of given) {
    const v = num(inv, p)!;
    const [lo, hi] = RANGE[p];
    if (!(v >= lo && v <= hi)) throw new CliError('INVALID_ARGS', `--${p} ${v} is outside ${lo}..${hi}`, 2);
  }
  const t = num(inv, 't');
  const ease = str(inv, 'ease');
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  if (t === undefined) {
    const kf = given.filter((p) => clip.keyframes?.[p]?.length);
    if (kf.length) throw new CliError('INVALID_ARGS', `${kf.join(', ')} ${kf.length > 1 ? 'are' : 'is'} animated on ${clip.id} (keyframes win over a constant value)`, 2, `give --t MS to set a keyframe, or remove the keyframes: studio layer reset --clip ${clip.id} --prop ${kf[0]}`);
    const transform = { ...(clip.transform ?? {}) } as Record<string, number>;
    for (const p of given) transform[p] = num(inv, p)!;
    specs.push({ type: 'clip.set', args: { id: clip.id, patch: { transform } } });
  } else {
    if (t < 0 || t > clip.dur) throw new CliError('INVALID_ARGS', `--t ${t} is outside the clip (0..${clip.dur} ms from its start)`, 2);
    for (const p of given) specs.push({ type: 'kf.set', args: { clip: clip.id, prop: p, t: Math.round(t), v: num(inv, p)!, ...(ease ? { ease } : {}) } });
    const single = given.filter((p) => (clip.keyframes?.[p]?.length ?? 0) === 0);
    if (single.length) warnings.push(`${single.join(', ')}: one keyframe holds that value over the whole clip; set another (--t) to move from one value to the other`);
  }
  const r = runSpecs(inv, specs, `layer move ${clip.id}`);
  const after = store(inv).load().project.clips.find((c) => c.id === clip.id) ?? clip;
  void project;
  return {
    ...r,
    data: {
      ...(r.data as object),
      clip: clip.id,
      transform: after.transform ?? {},
      keyframes: Object.fromEntries(Object.entries(after.keyframes ?? {}).filter(([p]) => (PROPS as readonly string[]).includes(p)).map(([p, ks]) => [p, ks.map((k) => ({ t: k.t, v: k.v, ...(k.ease ? { ease: k.ease } : {}) }))])),
      meaning: 'dx, dy: project pixels to the right and down; size: about the anchor (1 = as it is); rot: degrees clockwise about the anchor; ax, ay: the anchor, fractions of the canvas; opacity 0..1',
      next: [`studio render --still MS --out check   (look at it)`],
    },
    ...(warnings.length ? { warnings } : {}),
  };
};

/** `studio layer reset`: back to where the layer was (its layer placement, or just the properties named, and their keyframes). */
export const reset: Handler = async (inv) => {
  const { clip } = clipFor(inv);
  const which = str(inv, 'prop') ? (str(inv, 'prop')!.split(',').map((x) => x.trim()) as Prop[]) : ([...PROPS].filter((p) => p !== 'ax' && p !== 'ay') as Prop[]);
  for (const p of which) if (!(PROPS as readonly string[]).includes(p)) throw new CliError('INVALID_ARGS', `unknown property ${p}; one of ${PROPS.join(', ')}`, 2);
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  const transform = { ...(clip.transform ?? {}) } as Record<string, number>;
  for (const p of which) delete transform[p];
  specs.push({ type: 'clip.set', args: { id: clip.id, patch: { transform: Object.keys(transform).length ? transform : null } } });
  for (const p of which) for (const k of clip.keyframes?.[p] ?? []) specs.push({ type: 'kf.delete', args: { clip: clip.id, id: k.id } });
  return runSpecs(inv, specs, `layer reset ${clip.id}`);
};

function setHidden(hidden: boolean): Handler {
  return async (inv) => {
    const { project, clip } = clipFor(inv);
    const t = project.tracks.find((x) => x.id === clip.track)!;
    const others = project.clips.filter((c) => c.track === t.id && c.id !== clip.id).map((c) => c.id);
    const r = runSpecs(inv, [{ type: 'track.set', args: { id: t.id, patch: { hidden } } }], `layer ${hidden ? 'hide' : 'show'} ${clip.id}`);
    return { ...r, data: { ...(r.data as object), clip: clip.id, track: t.id, hidden }, ...(others.length ? { warnings: [`track ${t.id} also holds ${others.join(', ')}: ${hidden ? 'hidden' : 'shown'} with it`] } : {}) };
  };
}
export const hide = setHidden(true);
export const show = setHidden(false);

/** `studio layer front|back`: put the layer on a new track at the top or the bottom of the stack. */
function restack(where: 'front' | 'back'): Handler {
  return async (inv) => {
    const { project, clip } = clipFor(inv);
    const tid = makeId('t', new Set(project.tracks.map((t) => t.id)), cryptoRng());
    const old = project.tracks.find((t) => t.id === clip.track)!;
    const specs: { type: string; args: Record<string, unknown> }[] = [
      { type: 'track.add', args: { id: tid, type: old.type, name: old.name, index: where === 'front' ? project.tracks.length : 0 } },
      { type: 'clip.move', args: { id: clip.id, start: clip.start, track: tid } },
    ];
    // the track it leaves is removed when nothing else is on it
    if (!project.clips.some((c) => c.track === old.id && c.id !== clip.id)) specs.push({ type: 'track.remove', args: { id: old.id } });
    const r = runSpecs(inv, specs, `layer ${where} ${clip.id}`);
    return { ...r, data: { ...(r.data as object), clip: clip.id, track: tid } };
  };
}
export const front = restack('front');
export const back = restack('back');

const EDGES = ['left', 'top', 'right', 'bottom'] as const;
type Edge = (typeof EDGES)[number];
type Crop = Extract<Fx, { type: 'crop' }>;

/**
 * `studio layer crop`: cut a layer's edges away. Each side is the part of the clip's picture cut from it (a fraction, or pixels of
 * the picture with --px); what is cut is transparent and shows the tracks below. Without --t the values hold for the whole clip;
 * with --t they are keyframes (two calls: from, to). --feather softens the cut edges inward. --reset removes the crop.
 */
export const crop: Handler = async (inv) => {
  const { project, clip } = clipFor(inv);
  const t = project.tracks.find((x) => x.id === clip.track);
  if (t?.type !== 'video' && t?.type !== 'graphics') throw new CliError('INVALID_ARGS', `${clip.id} is not on a video track`, 2);
  const list = named(project, clip);
  const idx = list.findIndex((f) => f.type === 'crop');
  const cur = idx >= 0 ? (list[idx] as Crop) : undefined;
  if (inv.flags['reset']) {
    if (!cur) throw new CliError('NOT_FOUND', `${clip.id} has no crop`, 2);
    const r = runSpecs(inv, fxSpecs(clip, list.filter((_, i) => i !== idx), cur.node ? [cur.node] : []), `layer crop ${clip.id} reset`);
    return { ...r, data: { ...(r.data as object), clip: clip.id, crop: null } };
  }
  const a = clip.asset ? project.assets[clip.asset] : undefined;
  const ds = a ? displaySize(a.probe) : undefined;
  const size = { w: ds?.w ?? 0, h: ds?.h ?? 0 };
  const px = !!inv.flags['px'];
  if (px && !(size.w && size.h)) throw new CliError('INVALID_ARGS', `the size of ${clip.asset} is not known; give fractions instead of --px`, 2);
  const given = EDGES.filter((e) => num(inv, e) !== undefined);
  const feather = num(inv, 'feather');
  if (!given.length && feather === undefined)
    throw new CliError('INVALID_ARGS', 'give at least one of --left --top --right --bottom (the part cut from that side: a fraction of the picture, or pixels with --px), or --feather', 2, `studio layer crop --clip ${clip.id} --left 0.1 --right 0.1`);
  const val: Partial<Record<Edge, number>> = {};
  for (const e of given) {
    const raw = num(inv, e)!;
    const v = px ? raw / (e === 'left' || e === 'right' ? size.w : size.h) : raw;
    if (!(v >= 0 && v <= 0.99)) throw new CliError('INVALID_ARGS', `--${e} ${raw}${px ? ' px' : ''} is outside the picture (0..0.99 of it${px ? `, 0..${Math.floor(0.99 * (e === 'left' || e === 'right' ? size.w : size.h))} px` : ''})`, 2);
    val[e] = Math.round(v * 10000) / 10000;
  }
  if (feather !== undefined && !(feather >= 0 && feather <= 200)) throw new CliError('INVALID_ARGS', '--feather is 0..200 px', 2);
  const node = cur?.node ?? makeId('f', new Set(project.clips.flatMap((c) => (c.fx ?? []).map((f) => (f as { node?: string }).node).filter(Boolean) as string[])), cryptoRng());
  const next: Crop = { ...(cur ?? { type: 'crop' }), node } as Crop;
  if (feather !== undefined) {
    if (feather) next.feather = feather;
    else delete next.feather;
  }
  const at = num(inv, 't');
  const ease = str(inv, 'ease');
  const animated = (e: Edge) => (clip.keyframes?.[`fx.${node}.${e}`]?.length ?? 0) > 0;
  const warnings: string[] = [];
  if (at === undefined) {
    const kf = given.filter(animated);
    if (kf.length) throw new CliError('INVALID_ARGS', `${kf.join(', ')} ${kf.length > 1 ? 'are' : 'is'} animated on ${clip.id} (keyframes win over a constant value)`, 2, `give --t MS to set a keyframe, or studio layer crop --clip ${clip.id} --reset`);
    for (const e of given) {
      if (val[e]) next[e] = val[e];
      else delete next[e];
    }
  } else if (at < 0 || at > clip.dur) throw new CliError('INVALID_ARGS', `--t ${at} is outside the clip (0..${clip.dur} ms from its start)`, 2);
  // what the picture keeps: checked on the values that hold (keyframed ones at this keyframe)
  const v = (e: Edge) => (at !== undefined && val[e] !== undefined ? val[e]! : (next[e] ?? 0));
  if (v('left') + v('right') > 0.99 || v('top') + v('bottom') > 0.99) throw new CliError('INVALID_ARGS', `the crop would leave nothing of the picture (left ${v('left')} + right ${v('right')}, top ${v('top')} + bottom ${v('bottom')}; each pair must stay under 0.99)`, 2);
  const fx = idx >= 0 ? list.map((f, i) => (i === idx ? next : f)) : [...list, next];
  const specs: { type: string; args: Record<string, unknown> }[] = fxSpecs(clip, fx);
  if (at !== undefined) {
    for (const e of given) specs.push({ type: 'kf.set', args: { clip: clip.id, prop: `fx.${node}.${e}`, t: Math.round(at), v: val[e]!, ...(ease ? { ease } : {}) } });
    const single = given.filter((e) => !animated(e));
    if (single.length) warnings.push(`${single.join(', ')}: one keyframe holds that value over the whole clip; set another (--t) to move from one value to the other`);
  }
  const r = runSpecs(inv, specs, `layer crop ${clip.id}`);
  const after = store(inv).load().project.clips.find((c) => c.id === clip.id) ?? clip;
  const c2 = (after.fx ?? []).find((f) => f.type === 'crop') as Crop | undefined;
  const keyframes = Object.fromEntries(EDGES.filter((e) => after.keyframes?.[`fx.${node}.${e}`]?.length).map((e) => [e, after.keyframes![`fx.${node}.${e}`]!.map((k) => ({ t: k.t, v: k.v, ...(k.ease ? { ease: k.ease } : {}) }))]));
  return {
    ...r,
    data: {
      ...(r.data as object),
      clip: clip.id,
      node,
      crop: { ...Object.fromEntries(EDGES.map((e) => [e, c2?.[e] ?? 0])), feather: c2?.feather ?? 0 },
      ...(size.w ? { pictureKeeps: { w: Math.round(size.w * (1 - (c2?.left ?? 0) - (c2?.right ?? 0))), h: Math.round(size.h * (1 - (c2?.top ?? 0) - (c2?.bottom ?? 0))), of: `${size.w}x${size.h}` } } : {}),
      ...(Object.keys(keyframes).length ? { keyframes } : {}),
      meaning: 'left/top/right/bottom: the part of the clip’s picture cut from that side (0.1 = a tenth of its width or height); cut parts are transparent and show the tracks below; feather softens the cut edges inward (px)',
      next: [`studio render --still MS --out check   (look at it)`, `studio fx bypass --clip ${clip.id} --node ${node}   (compare without it)`],
    },
    ...(warnings.length ? { warnings } : {}),
  };
};
