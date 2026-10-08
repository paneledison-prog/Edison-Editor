/**
 * `studio design ...`: the design and animation editor's command line. A design is its own file in its own folder
 * (design.studio.json); nothing here touches project.studio.json. Every change is an op: validated, logged, undoable.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  CONTAINERS, LAYER_TYPES, cryptoRng, makeId, NUMERIC_PROPS, PRESETS, subtree, type Design, type Layer, type OpSpec,
} from '@studio/design';
import { DesignStore, DESIGN_FILE } from '@studio/design/store';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, parseJson, str } from './shared.js';

const store = (inv: Invocation) => new DesignStore(inv.dir);
const need = (inv: Invocation, k: string): string => {
  const v = str(inv, k);
  if (v === undefined) throw new CliError('INVALID_ARGS', `--${k} is required`, 2);
  return v;
};
const opErr = (e: unknown): never => {
  const err = e as { code?: string; message: string };
  const code = err.code;
  if (code === 'NOT_FOUND') throw new CliError('NOT_FOUND', err.message, 2);
  if (code === 'VALIDATION') throw new CliError('VALIDATION', err.message, 4, 'studio design show --full');
  if (code === 'INVALID_ARGS' || code === 'UNKNOWN_OP') throw new CliError('INVALID_ARGS', err.message, 2);
  throw e;
};

function apply(inv: Invocation, specs: OpSpec[], label: string) {
  try {
    const step = store(inv).apply(specs, { actor: inv.actor, label, dryRun: inv.dryRun });
    const e = step.entry;
    return {
      data: {
        txn: e.id,
        dryRun: inv.dryRun || undefined,
        ops: e.kind === 'apply' ? e.ops.map((o) => ({ id: o.id, type: o.type, ...((o.args as any)?.layer?.id ?? (o.args as any)?.id ? { target: (o.args as any)?.layer?.id ?? (o.args as any)?.id } : {}) })) : [],
        layers: step.design.layers.length,
        before: e.before,
        after: e.after,
      },
      artifacts: inv.dryRun ? [] : [{ kind: 'design', path: DESIGN_FILE }],
    };
  } catch (e) {
    return opErr(e);
  }
}

function describe(d: Design) {
  const kids = (p: string | null): Layer[] => d.layers.filter((l) => l.parent === p);
  const walk = (p: string | null, depth: number): unknown[] =>
    kids(p).flatMap((l) => [
      {
        id: l.id, depth, type: l.type, name: l.name, x: l.x, y: l.y, w: l.w, h: l.h,
        ...(l.rotation ? { rotation: l.rotation } : {}),
        ...(l.start !== undefined || l.end !== undefined ? { start: l.start ?? 0, end: l.end ?? d.meta.duration } : {}),
        ...(l.anim ? { animated: Object.fromEntries(Object.entries(l.anim).map(([k, v]) => [k, v.length])) } : {}),
        ...(l.type === 'text' ? { text: l.text.slice(0, 60) } : {}),
      },
      ...walk(l.id, depth + 1),
    ]);
  return walk(null, 0);
}

export const create: Handler = async (inv) => {
  const name = inv.positionals[0];
  if (!name) throw new CliError('INVALID_ARGS', 'give the design a name: studio design new "Launch teaser"', 2);
  try {
    DesignStore.init(inv.dir, {
      name,
      ...(num(inv, 'width') ? { width: num(inv, 'width')! } : {}),
      ...(num(inv, 'height') ? { height: num(inv, 'height')! } : {}),
      ...(num(inv, 'fps') ? { fps: num(inv, 'fps')! } : {}),
      ...(num(inv, 'duration') ? { duration: num(inv, 'duration')! } : {}),
      ...(str(inv, 'background') ? { background: str(inv, 'background') as any } : {}),
    }, inv.force);
  } catch (e) {
    return opErr(e);
  }
  const { design } = store(inv).load();
  return { data: { dir: inv.dir, meta: design.meta, next: 'studio design add rect --props \'{"x":100,"y":100}\'' }, artifacts: [{ kind: 'design', path: DESIGN_FILE }] };
};

export const show: Handler = async (inv) => {
  let loaded;
  try {
    loaded = store(inv).load();
  } catch (e) {
    return opErr(e);
  }
  const { design, log, driftedFromLog } = loaded;
  const st = store(inv).stacks();
  return {
    data: {
      meta: design.meta,
      layers: design.layers.length,
      tree: describe(design),
      undoDepth: st.undo.length,
      redoDepth: st.redo.length,
      logEntries: log.length,
      ...(inv.flags['full'] ? { design } : {}),
    },
    warnings: driftedFromLog ? ['design.studio.json was edited outside ops; undo history may not match'] : [],
  };
};

export const scene: Handler = async (inv) => {
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'background']) if (str(inv, k) !== undefined) patch[k] = str(inv, k);
  for (const k of ['width', 'height', 'fps', 'duration']) if (num(inv, k) !== undefined) patch[k] = num(inv, k);
  if (!Object.keys(patch).length) throw new CliError('INVALID_ARGS', 'give at least one of --name --width --height --fps --duration --background', 2);
  return apply(inv, [{ type: 'scene.set', args: { patch } }], 'scene');
};

export const add: Handler = async (inv) => {
  const type = inv.positionals[0];
  if (!type || !(LAYER_TYPES as readonly string[]).includes(type))
    throw new CliError('INVALID_ARGS', `give a layer type: ${LAYER_TYPES.join(', ')}`, 2, 'studio design add rect --props \'{"w":300}\'');
  const props = inv.flags['props'] ? (parseJson('--props', String(inv.flags['props'])) as Record<string, unknown>) : {};
  const layer: Record<string, unknown> = { ...props, type };
  if (str(inv, 'name')) layer['name'] = str(inv, 'name');
  if (str(inv, 'parent')) layer['parent'] = str(inv, 'parent');
  if (str(inv, 'src')) layer['src'] = str(inv, 'src');
  if (str(inv, 'text') !== undefined) layer['text'] = str(inv, 'text');
  return apply(inv, [{ type: 'layer.add', args: { layer, ...(num(inv, 'index') !== undefined ? { index: num(inv, 'index') } : {}) } }], `add ${type}`);
};

export const set: Handler = async (inv) => {
  const patch = parseJson('--props', need(inv, 'props')) as Record<string, unknown>;
  const ids = need(inv, 'id').split(',');
  return apply(inv, ids.map((id) => ({ type: 'layer.set', args: { id, patch } })), 'set');
};

export const move: Handler = async (inv) => {
  const parent = str(inv, 'parent');
  return apply(inv, [{ type: 'layer.move', args: { id: need(inv, 'id'), ...(parent !== undefined ? { parent: parent === 'scene' || parent === 'none' ? null : parent } : {}), ...(num(inv, 'index') !== undefined ? { index: num(inv, 'index') } : {}) } }], 'move');
};

export const remove: Handler = async (inv) =>
  apply(inv, need(inv, 'id').split(',').map((id) => ({ type: 'layer.delete', args: { id } })), 'delete');

export const duplicate: Handler = async (inv) =>
  apply(inv, [{ type: 'layer.duplicate', args: { id: need(inv, 'id'), ...(num(inv, 'dx') !== undefined ? { dx: num(inv, 'dx') } : {}), ...(num(inv, 'dy') !== undefined ? { dy: num(inv, 'dy') } : {}) } }], 'duplicate');

export const keyframe: Handler = async (inv) => {
  const del = str(inv, 'delete');
  const layer = need(inv, 'layer');
  if (del) return apply(inv, [{ type: 'kf.delete', args: { layer, id: del } }], 'delete keyframe');
  const v = inv.flags['v'];
  const value = typeof v === 'number' ? v : str(inv, 'color') ?? (typeof v === 'string' ? v : undefined);
  if (value === undefined) throw new CliError('INVALID_ARGS', '--v is required (a number, or --color #RRGGBB for fill and stroke)', 2);
  return apply(inv, [{ type: 'kf.set', args: { layer, prop: need(inv, 'prop'), t: num(inv, 't') ?? 0, v: value, ...(str(inv, 'ease') ? { ease: str(inv, 'ease') } : {}) } }], 'keyframe');
};

export const clear: Handler = async (inv) =>
  apply(inv, [{ type: 'kf.clear', args: { layer: need(inv, 'layer'), ...(str(inv, 'prop') ? { prop: str(inv, 'prop') } : {}) } }], 'clear keyframes');

export const animate: Handler = async (inv) => {
  const args: Record<string, unknown> = { layer: need(inv, 'layer'), preset: need(inv, 'preset') };
  for (const k of ['at', 'dur', 'distance', 'amount', 'count']) if (num(inv, k) !== undefined) args[k] = num(inv, k);
  for (const k of ['ease', 'from', 'to']) if (str(inv, k) !== undefined) args[k] = str(inv, k);
  const layers = String(args['layer']).split(',');
  return apply(inv, layers.map((layer) => ({ type: 'anim.preset', args: { ...args, layer } })), `animate ${args['preset']}`);
};

export const presets: Handler = async () => ({
  data: { presets: PRESETS.map((p) => ({ id: p.id, summary: p.summary, defaultDurMs: p.defaults.dur, defaultEase: p.defaults.ease, ...(p.types ? { layerTypes: p.types } : {}) })), animatable: [...NUMERIC_PROPS, 'fill', 'stroke'] },
});

export const group: Handler = async (inv) => {
  const { design } = store(inv).load();
  const ids = need(inv, 'ids').split(',');
  const layers = ids.map((id) => design.layers.find((l) => l.id === id));
  if (layers.some((l) => !l)) throw new CliError('NOT_FOUND', `unknown layer in ${ids.join(',')}`, 2);
  const ls = layers as Layer[];
  const parent = ls[0]!.parent;
  if (ls.some((l) => l.parent !== parent)) throw new CliError('INVALID_ARGS', 'layers must share a parent to be grouped', 2);
  const box = { x: Math.min(...ls.map((l) => l.x)), y: Math.min(...ls.map((l) => l.y)), r: Math.max(...ls.map((l) => l.x + l.w)), b: Math.max(...ls.map((l) => l.y + l.h)) };
  const sibs = design.layers.filter((l) => l.parent === parent);
  const index = Math.min(...ls.map((l) => sibs.findIndex((s) => s.id === l.id)));
  const gid = makeId('l', new Set(design.layers.map((l) => l.id)), cryptoRng());
  const specs: OpSpec[] = [
    { type: 'layer.add', args: { layer: { type: 'group', id: gid, name: str(inv, 'name') ?? 'Group', parent, x: box.x, y: box.y, w: box.r - box.x, h: box.b - box.y }, index } },
    ...ls.flatMap((l) => [
      { type: 'layer.move', args: { id: l.id, parent: gid } },
      { type: 'layer.set', args: { id: l.id, patch: { x: l.x - box.x, y: l.y - box.y } } },
    ]),
  ];
  return apply(inv, specs, 'group');
};

export const ungroup: Handler = async (inv) => {
  const { design } = store(inv).load();
  const g = design.layers.find((l) => l.id === need(inv, 'id'));
  if (!g || !CONTAINERS.includes(g.type)) throw new CliError('INVALID_ARGS', 'give the id of a group or frame', 2);
  const kids = design.layers.filter((l) => l.parent === g.id);
  const sibs = design.layers.filter((l) => l.parent === g.parent);
  const at = sibs.findIndex((s) => s.id === g.id);
  const specs: OpSpec[] = [
    ...kids.flatMap((k, i) => [
      { type: 'layer.move', args: { id: k.id, parent: g.parent, index: at + 1 + i } },
      { type: 'layer.set', args: { id: k.id, patch: { x: k.x + g.x, y: k.y + g.y } } },
    ]),
    { type: 'layer.delete', args: { id: g.id } },
  ];
  return apply(inv, specs, 'ungroup');
};

export const align: Handler = async (inv) => {
  const { design } = store(inv).load();
  const ids = need(inv, 'ids').split(',');
  const to = need(inv, 'to');
  const ls = ids.map((id) => design.layers.find((l) => l.id === id));
  if (ls.some((l) => !l)) throw new CliError('NOT_FOUND', `unknown layer in ${ids.join(',')}`, 2);
  const L = ls as Layer[];
  const rel = str(inv, 'relative') ?? (L.length > 1 ? 'selection' : 'scene');
  const box =
    rel === 'scene'
      ? { x: 0, y: 0, r: design.meta.width, b: design.meta.height }
      : { x: Math.min(...L.map((l) => l.x)), y: Math.min(...L.map((l) => l.y)), r: Math.max(...L.map((l) => l.x + l.w)), b: Math.max(...L.map((l) => l.y + l.h)) };
  const patchFor = (l: Layer): Record<string, number> => {
    switch (to) {
      case 'left': return { x: box.x };
      case 'right': return { x: box.r - l.w };
      case 'center': return { x: (box.x + box.r) / 2 - l.w / 2 };
      case 'top': return { y: box.y };
      case 'bottom': return { y: box.b - l.h };
      case 'middle': return { y: (box.y + box.b) / 2 - l.h / 2 };
      default: throw new CliError('INVALID_ARGS', '--to must be left, center, right, top, middle, or bottom', 2);
    }
  };
  return apply(inv, L.map((l) => ({ type: 'layer.set', args: { id: l.id, patch: patchFor(l) } })), `align ${to}`);
};

export const applyOps: Handler = async (inv) => {
  const src = inv.positionals[0];
  if (!src) throw new CliError('INVALID_ARGS', 'give an ops file, or - for stdin: studio design apply ops.json', 2);
  const text = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(inv.dir, src), 'utf8');
  const specs = parseJson(src, text) as OpSpec[];
  if (!Array.isArray(specs)) throw new CliError('INVALID_ARGS', 'the file must hold a JSON array of {type, args}', 2);
  return apply(inv, specs, 'batch');
};

export const undo: Handler = async (inv) => {
  try {
    const n = num(inv, 'n') ?? 1;
    let last;
    for (let i = 0; i < n; i++) last = store(inv).undo({ actor: inv.actor, dryRun: inv.dryRun });
    return { data: { undone: n, layers: last!.design.layers.length, after: last!.entry.after }, artifacts: [{ kind: 'design', path: DESIGN_FILE }] };
  } catch (e) {
    return opErr(e);
  }
};
export const redo: Handler = async (inv) => {
  try {
    const n = num(inv, 'n') ?? 1;
    let last;
    for (let i = 0; i < n; i++) last = store(inv).redo({ actor: inv.actor, dryRun: inv.dryRun });
    return { data: { redone: n, layers: last!.design.layers.length, after: last!.entry.after }, artifacts: [{ kind: 'design', path: DESIGN_FILE }] };
  } catch (e) {
    return opErr(e);
  }
};
export const log: Handler = async (inv) => {
  const entries = store(inv).readLog().slice(-(num(inv, 'limit') ?? 20));
  return { data: { entries: entries.map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, ts: e.ts, ...(e.kind === 'apply' ? { label: e.label, ops: e.ops.map((o) => o.type) } : { target: e.target }) })) } };
};

export const assetAdd: Handler = async (inv) => {
  const files = inv.positionals;
  if (!files.length) throw new CliError('INVALID_ARGS', 'give one or more files: studio design asset logo.png', 2);
  const out: { from: string; src: string }[] = [];
  mkdirSync(join(inv.dir, 'assets'), { recursive: true });
  for (const f of files) {
    const abs = resolve(f);
    if (!existsSync(abs)) throw new CliError('NOT_FOUND', `${f} does not exist`, 2);
    const ext = extname(abs).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext))
      throw new CliError('INVALID_ARGS', `${basename(abs)}: use an image (png, jpg, webp, gif, svg) or audio (mp3, wav, m4a, aac, ogg) file`, 2);
    const name = basename(abs).replace(/[^A-Za-z0-9_.-]/g, '_');
    const dest = join(inv.dir, 'assets', name);
    if (existsSync(dest) && !inv.force) throw new CliError('WOULD_OVERWRITE', `assets/${name} exists`, 5, 'pass --force');
    if (!inv.dryRun) copyFileSync(abs, dest);
    out.push({ from: f, src: `assets/${name}` });
  }
  return { data: { assets: out, use: 'studio design add image --src assets/NAME' } };
};

export const validate: Handler = async (inv) => {
  try {
    const { design } = store(inv).load();
    return { data: { ok: true, layers: design.layers.length, subtree: subtree(design, design.layers[0]?.id ?? '').length } };
  } catch (e) {
    return opErr(e);
  }
};

export const render: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const fmt = (str(inv, 'format') ?? 'mp4') as import('@studio/engines').DesignFormat;
  if (!['mp4', 'webm', 'mov', 'gif', 'png-seq', 'png'].includes(fmt)) throw new CliError('INVALID_ARGS', '--format must be mp4, webm, mov, gif, png-seq, or png', 2);
  let range: [number, number] | undefined;
  if (str(inv, 'range')) {
    const m = /^(\d+):(\d+)$/.exec(str(inv, 'range')!);
    if (!m) throw new CliError('INVALID_ARGS', '--range must be A:B in ms', 2);
    range = [Number(m[1]), Number(m[2])];
  }
  if (inv.dryRun) return { data: { wouldRender: fmt, ...(range ? { range } : {}) } };
  try {
    const r = await E.exportDesign({
      dir: inv.dir, format: fmt,
      ...(str(inv, 'out') ? { out: str(inv, 'out')! } : {}),
      ...(num(inv, 'at') !== undefined ? { at: num(inv, 'at')! } : {}),
      ...(range ? { range } : {}),
      ...(num(inv, 'scale') ? { scale: num(inv, 'scale')! } : {}),
      alpha: !!inv.flags['alpha'], force: inv.force,
      ...(num(inv, 'concurrency') ? { concurrency: num(inv, 'concurrency')! } : {}),
      onProgress: (d, t) => d % 30 === 0 && inv.log(`  ${d}/${t} frames`),
    });
    return { data: r, warnings: r.warnings, artifacts: [{ kind: 'render', path: r.output }] };
  } catch (e) {
    const err = e as { code?: string; message: string; fix?: string };
    if (err.code === 'WOULD_OVERWRITE') throw new CliError('WOULD_OVERWRITE', err.message, 5, err.fix);
    if (err.code === 'INVALID_INPUT') throw new CliError('INVALID_INPUT', err.message, 2, err.fix);
    return opErr(e);
  }
};

export const still: Handler = async (inv) =>
  render({ ...inv, flags: { ...inv.flags, format: 'png', at: num(inv, 'at') ?? 0 } } as Invocation);


export const ui: Handler = (inv) => import('./design-ui.js').then((m) => m.designUi(inv));
