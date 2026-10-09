/**
 * The effect stack of a clip, edited by name. Effects never touch the source file: they are entries on the clip (`fx`),
 * each one an op, so any of them can be changed, switched off, moved, keyframed or removed later, and undone.
 * This is the one place that lists and edits every kind of video effect (plugin effects, LUTs, blur regions) the same way.
 */
import { cryptoRng, makeId, type Clip, type Fx, type Project } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, parseJson, runSpecs, store, str } from './shared.js';

type Video = Extract<Fx, { type: 'plugin' | 'lut' | 'blur-region' | 'stabilize' | 'pin' | 'cutout' }>;
export const isVideo = (f: Fx): f is Video => f.type === 'plugin' || f.type === 'lut' || f.type === 'blur-region' || f.type === 'stabilize' || f.type === 'pin' || f.type === 'cutout';
export const nodeOf = (f: Fx): string | undefined => (f as { node?: string }).node;

const engines = () => import('@studio/engines');

export function clipOf(inv: Invocation): { project: Project; clip: Clip } {
  const id = str(inv, 'clip');
  if (!id) throw new CliError('INVALID_ARGS', '--clip is required', 2, 'studio project show lists clips');
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === id);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${id}`, 2, 'studio project show lists clips');
  if (clip.comp) throw new CliError('INVALID_ARGS', `${id} is a composition clip; effects apply to media clips`, 2);
  return { project, clip };
}

/** Every node id in the project, so a new one never repeats. */
export const takenNodes = (p: Project) => new Set(p.clips.flatMap((c) => (c.fx ?? []).map(nodeOf).filter(Boolean) as string[]));

/** The clip's effects with a node id on every video effect (legacy entries without one get theirs here). */
export function named(p: Project, c: Clip, extra: Fx[] = []): Fx[] {
  const taken = takenNodes(p);
  const rng = cryptoRng();
  const give = (f: Fx): Fx => {
    if (!(isVideo(f) || f.type === 'gain') || nodeOf(f)) return f;
    const node = makeId('f', taken, rng);
    taken.add(node);
    return { ...f, node } as Fx;
  };
  return [...(c.fx ?? []), ...extra].map(give);
}

/** A node by id (`f_k3f9`) or by position (`2` or `#2`). */
function pick(c: Clip, ref: string | undefined): { index: number; fx: Fx; node: string | undefined } {
  const fx = c.fx ?? [];
  if (!ref) throw new CliError('INVALID_ARGS', '--node is required (an id such as f_k3f9, or a position)', 2, `studio fx list --clip ${c.id}`);
  let index = fx.findIndex((f) => nodeOf(f) === ref);
  if (index < 0 && /^#?\d+$/.test(ref)) index = Number(ref.replace('#', ''));
  const f = fx[index];
  if (index < 0 || !f) throw new CliError('NOT_FOUND', `clip ${c.id} has no effect "${ref}"`, 2, `studio fx list --clip ${c.id}`);
  return { index, fx: f, node: nodeOf(f) };
}

/** The same effect's entry after `named` has run: ids may have been given to the whole stack. */
function after(list: Fx[], index: number): Fx {
  return list[index]!;
}

/** The ops that put `fx` on the clip; keyframes of dropped effects go in the same step, so one undo brings both back. */
export function fxSpecs(c: Clip, fx: Fx[], drop: string[] = []) {
  const kfs = c.keyframes ?? {};
  const dead = Object.entries(kfs).flatMap(([prop, ks]) => (drop.some((n) => prop.startsWith(`fx.${n}.`)) ? ks.map((k) => k.id) : []));
  // an empty stack is no field at all, so adding and then removing an effect leaves the clip exactly as it was
  return [...dead.map((id) => ({ type: 'kf.delete', args: { clip: c.id, id } })), { type: 'clip.set', args: { id: c.id, patch: { fx: fx.length ? fx : null } } }];
}
function setFx(inv: Invocation, c: Clip, fx: Fx[], label: string, drop: string[] = []) {
  return runSpecs(inv, fxSpecs(c, fx, drop), label);
}

function paramsOf(inv: Invocation, flag = 'params'): Record<string, number | string | boolean> | undefined {
  const raw = inv.flags[flag];
  if (raw === undefined) return undefined;
  const p = parseJson(`--${flag}`, String(raw));
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new CliError('INVALID_ARGS', `--${flag} must be a JSON object`, 2);
  return p;
}

async function check(f: Fx) {
  if (f.type !== 'plugin') return;
  const E = await engines();
  E.effectLines({ id: f.id, ...(f.params ? { params: f.params } : {}) }, 'a', 'b', 'v');
}

export const label = (f: Fx): string =>
  f.type === 'cutout' ? `cutout ${f.matte.id}${f.matte.invert ? ' (inverted)' : ''}` : f.type === 'stabilize' ? `stabilize ${f.tracker}${f.lock ? ' (locked)' : ''}` : f.type === 'pin' ? `pin ${f.asset} on ${f.tracker}` : f.type === 'gain' ? `gain ${f.db} dB` : f.type === 'plugin' ? f.id : f.type === 'lut' ? f.file : f.type === 'blur-region' ? `blur ${Math.round(f.x * 100)},${Math.round(f.y * 100)} ${Math.round(f.w * 100)}x${Math.round(f.h * 100)}%` : f.type;

// ---------------------------------------------------------------------------------------------------------------

export const list: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const E = await engines();
  const animated = (node: string | undefined) =>
    node
      ? Object.fromEntries(Object.entries(clip.keyframes ?? {}).filter(([p]) => p.startsWith(`fx.${node}.`)).map(([p, k]) => [p.slice(`fx.${node}.`.length), k.length]))
      : {};
  const stack = (clip.fx ?? []).map((f, index) => {
    const node = nodeOf(f);
    const base = { index, ...(node ? { node } : { node: null, note: 'no id yet: any fx command that edits this clip names it' }), type: f.type, what: label(f) };
    if (f.type === 'plugin') {
      const decl = E.pluginEffectDecl(f.id);
      const params = decl ? Object.fromEntries(Object.entries(decl.params).map(([k, p]) => [k, f.params?.[k] ?? p.default])) : (f.params ?? {});
      const a = animated(node);
      return { ...base, enabled: !f.bypass, params, ...(f.matte ? { onlyInside: f.matte } : {}), ...(f.mix !== undefined ? { mix: f.mix } : {}), ...(Object.keys(a).length ? { animated: a } : {}), ...(decl ? {} : { problem: 'no loaded plugin provides this effect' }) };
    }
    if (f.type === 'cutout') return { ...base, enabled: !f.bypass, matte: f.matte, ...(project.mattes?.[f.matte.id] ? {} : { problem: `matte ${f.matte.id} does not exist` }) };
    if (f.type === 'lut') return { ...base, enabled: !f.bypass, ...(f.matte ? { onlyInside: f.matte } : {}), ...(f.mix !== undefined ? { mix: f.mix } : {}), ...(Object.keys(animated(node)).length ? { animated: animated(node) } : {}) };
    if (f.type === 'blur-region') return { ...base, enabled: true, region: { x: f.x, y: f.y, w: f.w, h: f.h }, strength: f.strength ?? 24 };
    if (f.type === 'stabilize' || f.type === 'pin') {
      const { type: _t, node: _n, bypass: _b, ...rest } = f as Record<string, unknown>;
      return { ...base, enabled: !f.bypass, settings: rest, ...(project.trackers?.[f.tracker] ? {} : { problem: `tracker ${f.tracker} does not exist` }) };
    }
    const { type: _t, node: _n, ...rest } = f as Record<string, unknown>;
    return { ...base, enabled: true, settings: rest, ...(Object.keys(animated(node)).length ? { animated: animated(node) } : {}) };
  });
  const a = clip.asset ? project.assets[clip.asset] : undefined;
  let verified: boolean | undefined;
  if (inv.flags['verify'] && a) verified = await sourceUntouched(inv, a);
  return {
    data: {
      clip: clip.id,
      source: a ? { asset: clip.asset, file: a.workingCopy?.path ?? a.path, original: a.path, recordedHash: a.hash, ...(verified !== undefined ? { untouched: verified } : {}) } : null,
      stack,
      note: 'effects sit on top of the source: nothing here is written into it. Change, switch off, move or remove any of them; each is one undoable step.',
    },
  };
}

async function sourceUntouched(inv: Invocation, a: Project['assets'][string]): Promise<boolean> {
  const E = await engines();
  const { join } = await import('node:path');
  const h = await E.hashFile(join(inv.dir, a.path));
  return h.hash === a.hash;
}

export const verify: Handler = async (inv) => {
  const { project } = store(inv).load();
  const only = str(inv, 'clip');
  const ids = only ? [project.clips.find((c) => c.id === only)?.asset].filter(Boolean) as string[] : Object.keys(project.assets);
  const rows = [];
  for (const id of ids) {
    const a = project.assets[id]!;
    rows.push({ asset: id, file: a.path, untouched: await sourceUntouched(inv, a) });
  }
  const bad = rows.filter((r) => !r.untouched);
  return {
    data: { checked: rows.length, allUntouched: bad.length === 0, assets: rows },
    ...(bad.length ? { warnings: bad.map((b) => `${b.asset} (${b.file}) differs from the hash recorded when it was ingested`) } : {}),
  };
};

/** `--matte mt_x [--matte-invert] [--feather px] [--choke px]` as the effect's matte use. */
export function matteUse(inv: Invocation, project: Project, clip: Clip): NonNullable<Extract<Fx, { type: 'cutout' }>['matte']> | undefined {
  const id = str(inv, 'matte');
  if (!id) return undefined;
  const m = project.mattes?.[id];
  if (!m) throw new CliError('NOT_FOUND', `no matte ${id}`, 2, 'studio matte list');
  if (m.asset !== clip.asset) throw new CliError('INVALID_ARGS', `matte ${id} was made on ${m.asset}, this clip plays ${clip.asset}`, 2);
  const feather = num(inv, 'feather');
  const choke = num(inv, 'choke');
  return { id, ...(inv.flags['matte-invert'] ? { invert: true } : {}), ...(feather ? { feather } : {}), ...(choke ? { choke } : {}) };
}

export const add: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const effect = str(inv, 'effect');
  const lut = str(inv, 'lut');
  const region = str(inv, 'region');
  const gain = num(inv, 'gain');
  if ([effect, lut, region, gain].filter((v) => v !== undefined).length !== 1)
    throw new CliError('INVALID_ARGS', 'give exactly one of --effect ID, --lut FILE, --region x,y,w,h, --gain DB', 2, 'studio color effects lists effect ids');
  let fx: Video | Extract<Fx, { type: 'gain' }>;
  if (gain !== undefined) fx = { type: 'gain', db: gain };
  else if (effect) fx = { type: 'plugin', id: effect, ...(paramsOf(inv) ? { params: paramsOf(inv)! } : {}) };
  else if (lut) fx = { type: 'lut', file: lut };
  else {
    const v = region!.split(',').map(Number);
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new CliError('INVALID_ARGS', '--region is x,y,w,h as fractions of the frame, e.g. 0.1,0.1,0.3,0.2', 2);
    fx = { type: 'blur-region', x: v[0]!, y: v[1]!, w: v[2]!, h: v[3]!, ...(num(inv, 'strength') !== undefined ? { strength: num(inv, 'strength')! } : {}) };
  }
  if (inv.flags['bypass'] && (fx.type === 'plugin' || fx.type === 'lut')) (fx as { bypass?: boolean }).bypass = true;
  const use = matteUse(inv, project, clip);
  if (use) {
    if (fx.type !== 'plugin' && fx.type !== 'lut') throw new CliError('INVALID_ARGS', '--matte limits plugin effects and LUTs to a cut-out', 2);
    fx.matte = use;
  }
  const mix = num(inv, 'mix');
  if (mix !== undefined) {
    if (fx.type !== 'plugin' && fx.type !== 'lut') throw new CliError('INVALID_ARGS', '--mix applies to plugin effects and LUTs', 2);
    if (mix < 0 || mix > 1) throw new CliError('INVALID_ARGS', '--mix is 0..1', 2);
    if (mix !== 1) fx.mix = mix;
  }
  await check(fx);
  const at = num(inv, 'at');
  const base = named(project, clip); // the effects already there are named first, so the new one cannot repeat an id
  const node = makeId('f', new Set([...takenNodes(project), ...(base.map(nodeOf).filter(Boolean) as string[])]), cryptoRng());
  const list = [...base];
  const entry = { ...fx, node } as Fx;
  if (at === undefined) list.push(entry);
  else if (Number.isInteger(at) && at >= 0 && at <= list.length) list.splice(at, 0, entry);
  else throw new CliError('INVALID_ARGS', `--at must be 0..${list.length}`, 2);
  const r = setFx(inv, clip, list, `fx add ${label(fx)}`);
  return { ...r, data: { ...(r.data as object), node, added: label(fx) } };
};

export const set: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const { index, fx: cur } = pick(clip, str(inv, 'node'));
  const list = named(project, clip);
  const f = { ...after(list, index) } as Record<string, unknown>;
  const patch = paramsOf(inv);
  if (patch !== undefined) {
    if (cur.type === 'stabilize' || cur.type === 'pin') {
      // their settings are fields of the effect itself (smooth, lock, maxZoom, opacity, quad ...); null clears one
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'type' || k === 'node') throw new CliError('INVALID_ARGS', `${k} cannot be changed`, 2);
        if (v === null) delete f[k];
        else f[k] = v;
      }
    } else if (cur.type !== 'plugin') throw new CliError('INVALID_ARGS', `a ${cur.type} effect has no parameters; use its own flags`, 2);
    else f['params'] = inv.flags['replace'] ? patch : { ...((f['params'] as object) ?? {}), ...patch };
  }
  if (cur.type === 'blur-region') {
    const reg = str(inv, 'region');
    if (reg) {
      const v = reg.split(',').map(Number);
      if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new CliError('INVALID_ARGS', '--region is x,y,w,h as fractions of the frame', 2);
      [f['x'], f['y'], f['w'], f['h']] = v;
    }
    if (num(inv, 'strength') !== undefined) f['strength'] = num(inv, 'strength');
  }
  const mix = num(inv, 'mix');
  if (mix !== undefined) {
    if (cur.type !== 'plugin' && cur.type !== 'lut') throw new CliError('INVALID_ARGS', '--mix applies to plugin effects and LUTs', 2);
    if (mix < 0 || mix > 1) throw new CliError('INVALID_ARGS', '--mix is 0..1', 2);
    if (mix === 1) delete f['mix'];
    else f['mix'] = mix;
  }
  if (str(inv, 'matte') === 'none') {
    if (cur.type === 'cutout') throw new CliError('INVALID_ARGS', 'a cutout is its matte; remove the cutout instead', 2);
    delete f['matte'];
  } else if (str(inv, 'matte') || num(inv, 'feather') !== undefined || num(inv, 'choke') !== undefined || inv.flags['matte-invert']) {
    if (cur.type !== 'plugin' && cur.type !== 'lut' && cur.type !== 'cutout') throw new CliError('INVALID_ARGS', `a ${cur.type} effect does not take a matte`, 2);
    const had = (cur as { matte?: { id: string; invert?: boolean; feather?: number; choke?: number } }).matte;
    const given = matteUse(inv, project, clip);
    const id = given?.id ?? had?.id;
    if (!id) throw new CliError('INVALID_ARGS', 'give --matte mt_xxxx', 2);
    const next: Record<string, unknown> = { id };
    const invert = inv.flags['matte-invert'] ? true : had?.invert;
    const feather = num(inv, 'feather') ?? had?.feather;
    const choke = num(inv, 'choke') ?? had?.choke;
    if (invert) next['invert'] = true;
    if (feather) next['feather'] = feather;
    if (choke) next['choke'] = choke;
    f['matte'] = next;
  }
  if (inv.flags['bypass'] && inv.flags['enable']) throw new CliError('INVALID_ARGS', 'give --bypass or --enable, not both', 2);
  if (inv.flags['bypass']) f['bypass'] = true;
  if (inv.flags['enable']) delete f['bypass'];
  await check(f as Fx);
  list[index] = f as Fx;
  return setFx(inv, clip, list, `fx set ${label(f as Fx)}`);
};

export const remove: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  if (inv.flags['all']) {
    const gone = (clip.fx ?? []).filter(isVideo);
    if (!gone.length) throw new CliError('NOT_FOUND', `clip ${clip.id} has no video effects`, 2);
    const keep = (clip.fx ?? []).filter((f) => !isVideo(f));
    const nodes = named(project, clip).filter(isVideo).map((f) => nodeOf(f)!);
    return setFx(inv, clip, keep, 'fx remove all', nodes);
  }
  const { index, node } = pick(clip, str(inv, 'node'));
  const list = named(project, clip);
  const gone = after(list, index);
  list.splice(index, 1);
  return setFx(inv, clip, list, `fx remove ${label(gone)}`, [nodeOf(gone) ?? node ?? '']);
};

export const move: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const { index } = pick(clip, str(inv, 'node'));
  const to = num(inv, 'to');
  const list = named(project, clip);
  if (to === undefined || !Number.isInteger(to) || to < 0 || to >= list.length) throw new CliError('INVALID_ARGS', `--to must be a position 0..${list.length - 1}`, 2);
  const [m] = list.splice(index, 1);
  list.splice(to, 0, m!);
  return setFx(inv, clip, list, `fx move ${label(m!)}`);
};

export const bypass: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const { index, fx: cur } = pick(clip, str(inv, 'node'));
  if (cur.type !== 'plugin' && cur.type !== 'lut' && cur.type !== 'stabilize' && cur.type !== 'pin' && cur.type !== 'cutout') throw new CliError('INVALID_ARGS', `a ${cur.type} effect cannot be switched off; remove it`, 2);
  const list = named(project, clip);
  const f = { ...after(list, index) } as Record<string, unknown>;
  if (inv.flags['off']) delete f['bypass'];
  else f['bypass'] = true;
  list[index] = f as Fx;
  return setFx(inv, clip, list, `fx ${inv.flags['off'] ? 'enable' : 'bypass'} ${label(f as Fx)}`);
};

/** A keyframe on one parameter of one effect. `--delete k_id` removes it. */
export const key: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const del = str(inv, 'delete');
  if (del) return runSpecs(inv, [{ type: 'kf.delete', args: { clip: clip.id, id: del } }], 'fx key delete');
  const { index, fx: cur } = pick(clip, str(inv, 'node'));
  const param = str(inv, 'param');
  const t = num(inv, 't');
  const v = num(inv, 'v');
  if (!param || t === undefined || v === undefined) throw new CliError('INVALID_ARGS', '--param, --t and --v are required', 2, 'studio fx key --clip c --node f_xxxx --param exposure --t 0 --v 0');
  const list = named(project, clip);
  const node = nodeOf(after(list, index))!;
  const E = await engines();
  E.checkEffectKeyframe(cur.type === 'plugin' ? { type: 'plugin', id: cur.id } : { type: cur.type }, param, v);
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  if (!nodeOf(cur)) specs.push({ type: 'clip.set', args: { id: clip.id, patch: { fx: list } } }); // the effect gets its id first
  specs.push({ type: 'kf.set', args: { clip: clip.id, prop: `fx.${node}.${param}`, t, v, ...(str(inv, 'ease') ? { ease: str(inv, 'ease') } : {}) } });
  return runSpecs(inv, specs, `fx key ${param}`);
};
