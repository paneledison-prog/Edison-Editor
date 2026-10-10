/**
 * `studio matte ...` and `studio cutout`: cut an object out of a video without a green screen. The agent looks at a frame,
 * says where the object is (a box, dots and strokes on it and on what is not it, or a rough outline), and Studio cuts it out
 * of that frame and follows it through the shot. The agent looks at the result, marks more frames where it drifts, and uses
 * the matte: as a cutout (transparent outside), or to limit any effect to the object or to everything else.
 * The marks are ops in the project; the matte video is derived and cached (packages/engines/src/matte.ts).
 */
import { join } from 'node:path';
import { cryptoRng, makeId, Matte, MatteSeeds, type Fx, type Project } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { clipOf, fxSpecs } from './fx.js';
import { newEntry, playedRange } from './track.js';
import { num, runSpecs, store, str } from './shared.js';

const engines = () => import('@studio/engines');
type Seeds = Matte['keys'][number]['seeds'];


/** The edge settings given by flags (`--edge-width --no-refine --hair --smooth --no-decontaminate`), or undefined when none. */
function edgeFrom(inv: Invocation): Matte['edge'] | undefined {
  const e: Record<string, unknown> = {};
  if (num(inv, 'edge-width') !== undefined) e['width'] = Math.round(num(inv, 'edge-width')!);
  if (inv.flags['no-refine']) e['refine'] = false;
  if (inv.flags['hair']) e['hair'] = true;
  if (num(inv, 'smooth') !== undefined) e['smooth'] = num(inv, 'smooth');
  if (inv.flags['no-smooth']) e['smooth'] = 0;
  if (inv.flags['no-decontaminate']) e['decontaminate'] = false;
  if (str(inv, 'edge-model')) e['model'] = str(inv, 'edge-model') === 'none' ? undefined : str(inv, 'edge-model');
  return Object.keys(e).length ? (e as Matte['edge']) : undefined;
}

// ----- the marks ---------------------------------------------------------------------------------------------------------------------------

/** Points as `x,y;x,y;...` (fractions of the frame, or pixels with --px). */
function points(flag: string, text: string, size: { w: number; h: number } | null): [number, number][] {
  return text
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const v = p.split(',').map(Number);
      if (v.length !== 2 || v.some((x) => !Number.isFinite(x))) throw new CliError('INVALID_ARGS', `--${flag}: "${p}" is not x,y`, 2, 'points are x,y separated by ; and strokes by |');
      return size ? [v[0]! / size.w, v[1]! / size.h] : [v[0]!, v[1]!];
    });
}
function shapes(inv: Invocation, flag: string, closed: boolean, size: { w: number; h: number } | null): Seeds['fg'] {
  const t = str(inv, flag);
  if (!t) return undefined;
  const r = num(inv, 'radius');
  return t
    .split('|')
    .filter((x) => x.trim())
    .map((stroke) => ({ p: points(flag, stroke, size), ...(r ? { r: size ? r / size.w : r } : {}), ...(closed ? { closed: true } : {}) }));
}
/** The marks given by flags (`--box --fg --fg-fill --bg --bg-fill --outline --band`, or `--seeds JSON`), or undefined when none. */
export function seedsFrom(inv: Invocation, size: { w: number; h: number }): Seeds | undefined {
  const px = !!inv.flags['px'];
  const sz = px ? size : null;
  const out: Record<string, unknown> = {};
  const raw = str(inv, 'seeds');
  if (raw) {
    try {
      Object.assign(out, JSON.parse(raw));
    } catch (e) {
      throw new CliError('INVALID_ARGS', `--seeds is not valid JSON: ${(e as Error).message}`, 2);
    }
  }
  const box = str(inv, 'box');
  if (box) {
    const v = box.split(',').map(Number);
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new CliError('INVALID_ARGS', '--box is x,y,w,h', 2);
    out['box'] = sz ? [v[0]! / sz.w, v[1]! / sz.h, v[2]! / sz.w, v[3]! / sz.h] : v;
  }
  const fg = [...(shapes(inv, 'fg', false, sz) ?? []), ...(shapes(inv, 'fg-fill', true, sz) ?? [])];
  const bg = [...(shapes(inv, 'bg', false, sz) ?? []), ...(shapes(inv, 'bg-fill', true, sz) ?? [])];
  if (fg.length) out['fg'] = [...((out['fg'] as unknown[]) ?? []), ...fg];
  if (bg.length) out['bg'] = [...((out['bg'] as unknown[]) ?? []), ...bg];
  const ol = str(inv, 'outline');
  if (ol) out['outline'] = { p: points('outline', ol, sz), ...(num(inv, 'band') ? { band: sz ? num(inv, 'band')! / sz.w : num(inv, 'band') } : {}) };
  if (!Object.keys(out).length) return undefined;
  const r = MatteSeeds.safeParse(out);
  if (!r.success) throw new CliError('INVALID_ARGS', `marks: ${r.error.issues[0]!.path.join('.')} ${r.error.issues[0]!.message}`, 2);
  return r.data;
}
const MARKS_HELP = 'give a --box around the object, dots or strokes on it (--fg "x,y;x,y") and on what is not it (--bg), or a rough --outline "x,y;x,y;x,y"; coordinates are fractions of the frame, or pixels with --px';

const parsedMatte = (m: unknown): Matte => {
  const r = Matte.safeParse(m);
  if (!r.success) throw new CliError('INVALID_ARGS', `matte: ${r.error.issues[0]!.path.join('.')} ${r.error.issues[0]!.message}`, 2);
  return r.data;
};
const mref = (project: Project, id: string | undefined): string => {
  if (!id) throw new CliError('INVALID_ARGS', 'give the matte id', 2, 'studio matte list');
  if (!project.mattes?.[id]) throw new CliError('NOT_FOUND', `no matte ${id}`, 2, 'studio matte list');
  return id;
};
const usedBy = (p: Project, id: string) => p.clips.filter((c) => (c.fx ?? []).some((f) => (f.type === 'cutout' || f.type === 'plugin' || f.type === 'lut') && f.matte?.id === id)).map((c) => c.id);

function sizeOf(project: Project, assetId: string): { w: number; h: number } {
  const a = project.assets[assetId]!;
  const rot = a.probe.rotation === 90 || a.probe.rotation === 270;
  return { w: (rot ? a.probe.h : a.probe.w) ?? 1920, h: (rot ? a.probe.w : a.probe.h) ?? 1080 };
}
function videoAsset(project: Project, id: string | undefined) {
  if (!id) throw new CliError('INVALID_ARGS', '--asset is required', 2, 'studio project show lists assets');
  const a = project.assets[id];
  if (!a) throw new CliError('NOT_FOUND', `no asset ${id}`, 2, 'studio project show lists assets');
  if (a.kind !== 'video') throw new CliError('INVALID_ARGS', `${id} is ${a.kind}; only video can be cut out`, 2);
  return a;
}

/** What an agent needs to judge a matte. */
function summary(d: import('@studio/engines').MatteData) {
  const cov = d.coverage;
  const sample = Array.from({ length: Math.min(10, d.frames) }, (_, i) => {
    const f = Math.round((i * (d.frames - 1)) / Math.max(1, Math.min(10, d.frames) - 1));
    return { frame: f, ms: Math.round(d.fromMs + (f * 1000) / d.fps), coveragePct: Math.round((cov[f] ?? 0) * 1000) / 10 };
  });
  return {
    frames: d.frames,
    analysis: `${d.analysis?.w ?? d.w}x${d.analysis?.h ?? d.h} at ${d.fps} fps; matte ${d.w}x${d.h}`,
    ...(d.edge ? { edge: d.edge } : {}),
    markedFrames: d.keys.map((k) => k.at),
    coveragePct: { min: Math.round(Math.min(...cov) * 1000) / 10, max: Math.round(Math.max(...cov) * 1000) / 10 },
    sample,
    ...(d.drift.length ? { agreementAtMarkedFrames: d.drift.map((x) => ({ from: x.from, to: x.to, direction: x.direction, iou: x.iou })) } : { agreementAtMarkedFrames: 'one marked frame: nothing to compare following against; mark a second frame where the object has moved to measure it' }),
    ...(d.flagged.length ? { checkThese: d.flagged } : {}),
    ms: d.stats.ms,
  };
}
const warningsOf = (id: string, d: import('@studio/engines').MatteData): string[] => {
  const w: string[] = [];
  for (const x of d.drift) if (x.iou < 0.9) w.push(`matte ${id}: following from ${x.from} ms ${x.direction === 'forward' ? 'forward' : 'backward'} reaches the marked frame at ${x.to} ms with only ${Math.round(x.iou * 100)}% agreement; look with studio matte preview and add marks in between`);
  if (d.flagged.length) w.push(`matte ${id}: ${d.flagged.length} frame(s) to check, first at ${d.flagged[0]!.ms} ms (${d.flagged[0]!.why})`);
  if (Math.max(...d.coverage) < 0.002) w.push(`matte ${id} covers almost nothing; the marks may be on the wrong place (look with studio matte preview ${id})`);
  return w;
};

async function build(inv: Invocation, project: Project, id: string, force = false) {
  const E = await engines();
  const t0 = Date.now();
  const r = await E.buildMatte({ projectDir: inv.dir, project, id, force, log: inv.log });
  return { ...r, wallMs: Date.now() - t0 };
}

// ----- commands --------------------------------------------------------------------------------------------------------------------------------

export const add: Handler = async (inv) => {
  const { project } = store(inv).load();
  const a = videoAsset(project, str(inv, 'asset'));
  const from = Math.round(num(inv, 'from') ?? 0);
  const to = Math.round(num(inv, 'to') ?? a.probe.durMs ?? 0);
  const at = Math.round(num(inv, 'at') ?? from);
  const seeds = seedsFrom(inv, sizeOf(project, str(inv, 'asset')!));
  const prior = str(inv, 'prior');
  if (!seeds && !prior) throw new CliError('INVALID_ARGS', `say what to cut out: ${MARKS_HELP}`, 2, 'studio inspect frame shows the frame to mark');
  const matte = parsedMatte({
    asset: str(inv, 'asset'), from, to,
    keys: [{ at, seeds: seeds ?? {}, ...(prior ? { prior } : {}), ...(str(inv, 'pick') ? { pick: str(inv, 'pick') } : {}) }],
    ...(num(inv, 'fps') !== undefined ? { fps: num(inv, 'fps') } : {}),
    ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width') } : {}),
    ...(str(inv, 'engine') ? { engine: str(inv, 'engine') } : {}),
    ...(edgeFrom(inv) ? { edge: edgeFrom(inv) } : {}),
    ...(str(inv, 'label') ? { label: str(inv, 'label') } : {}),
  });
  const id = makeId('mt', new Set(Object.keys(project.mattes ?? {})), cryptoRng());
  const ahead = { ...project, mattes: { ...(project.mattes ?? {}), [id]: matte } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'matte.add', args: { id, matte } }], `matte add ${matte.asset}`);
  return {
    ...r,
    data: { ...(r.data as object), matte: id, ...(built ? { result: summary(built.data), wallMs: built.wallMs, next: [`studio matte preview ${id}   (look at it: tinted outline on the frames, and the cut-out beside each)`, `studio matte key ${id} --at MS ...   (mark another frame where it drifts)`, `studio cutout --clip c_xx --matte ${id}   (make everything else transparent)`] } : { result: `not built (studio matte build ${id})` }) },
    ...(built ? { warnings: warningsOf(id, built.data) } : {}),
  };
};

/** Marks another frame (or adds marks to one already marked), then follows again. */
export const key: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const m = project.mattes![id]!;
  const at = num(inv, 'at');
  if (at === undefined) throw new CliError('INVALID_ARGS', '--at is required: the frame (ms of the asset) you are marking', 2);
  const seeds = seedsFrom(inv, sizeOf(project, m.asset));
  const prior = str(inv, 'prior');
  const pick = str(inv, 'pick') as 'auto' | 'whole' | 'smallest' | 'best' | 'first' | undefined;
  const absent = !!inv.flags['absent'];
  if (!seeds && !prior && !absent) throw new CliError('INVALID_ARGS', `give the marks: ${MARKS_HELP}, or --absent when the object is not in the picture at that time`, 2);
  const info = project.assets[m.asset]!.probe.fps ?? 30;
  const near = Math.max(1, Math.round(500 / Math.min(60, m.fps ?? Math.min(30, info))));
  const keys = m.keys.map((k) => ({ ...k }));
  const i = keys.findIndex((k) => Math.abs(k.at - at) <= near);
  if (absent) {
    const ak = { at: i >= 0 ? keys[i]!.at : Math.round(at), seeds: {} as Seeds, absent: true as const };
    if (i >= 0) keys[i] = ak;
    else keys.push(ak);
  } else if (i >= 0) {
    const old = keys[i]!;
    if (inv.flags['add'] && seeds) {
      const merged: Record<string, unknown> = { ...old.seeds };
      if (seeds.box) merged['box'] = seeds.box;
      if (seeds.outline) merged['outline'] = seeds.outline;
      if (seeds.fg) merged['fg'] = [...(old.seeds.fg ?? []), ...seeds.fg];
      if (seeds.bg) merged['bg'] = [...(old.seeds.bg ?? []), ...seeds.bg];
      keys[i] = { at: old.at, seeds: merged as Seeds, ...(prior ? { prior: prior as 'u2net' } : old.prior ? { prior: old.prior } : {}), ...(pick ? { pick } : old.pick ? { pick: old.pick } : {}) };
    } else keys[i] = { at: old.at, seeds: seeds ?? old.seeds, ...(prior ? { prior: prior as 'u2net' } : {}), ...(pick ? { pick } : {}) };
  } else keys.push({ at: Math.round(at), seeds: seeds ?? {}, ...(prior ? { prior: prior as 'u2net' } : {}), ...(pick ? { pick } : {}) });
  keys.sort((x, y) => x.at - y.at);
  const next = parsedMatte({ ...m, keys });
  const ahead = { ...project, mattes: { ...project.mattes, [id]: next } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'matte.set', args: { id, patch: { keys: next.keys } } }], `matte key ${id}`);
  return { ...r, data: { ...(r.data as object), matte: id, markedFrames: next.keys.map((k) => k.at), ...(built ? { result: summary(built.data) } : {}) }, ...(built ? { warnings: warningsOf(id, built.data) } : {}) };
};

export const unkey: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const m = project.mattes![id]!;
  const at = num(inv, 'at');
  if (at === undefined) throw new CliError('INVALID_ARGS', '--at is required', 2);
  const keys = m.keys.filter((k) => Math.abs(k.at - at) > 40);
  if (keys.length === m.keys.length) throw new CliError('NOT_FOUND', `no marked frame near ${at} ms; marked: ${m.keys.map((k) => k.at).join(', ')}`, 2);
  if (!keys.length) throw new CliError('INVALID_ARGS', 'a matte needs at least one marked frame; remove the matte instead', 2);
  const ahead = { ...project, mattes: { ...project.mattes, [id]: { ...m, keys } } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'matte.set', args: { id, patch: { keys } } }], `matte unkey ${id}`);
  return { ...r, data: { ...(r.data as object), matte: id, markedFrames: keys.map((k) => k.at), ...(built ? { result: summary(built.data) } : {}) } };
};

export const buildCmd: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const r = await build(inv, project, id, inv.force);
  return { data: { matte: id, cached: r.cached, result: summary(r.data), wallMs: r.wallMs }, warnings: warningsOf(id, r.data) };
};

export const list: Handler = async (inv) => {
  const { project } = store(inv).load();
  const E = await engines();
  const rows = Object.entries(project.mattes ?? {}).map(([id, m]) => {
    const d = E.loadMatte(inv.dir, project, id);
    return { id, asset: m.asset, rangeMs: [m.from, m.to], markedFrames: m.keys.map((k) => k.at), ...(m.label ? { label: m.label } : {}), built: !!d, ...(d ? { coveragePct: { min: Math.round(Math.min(...d.coverage) * 1000) / 10, max: Math.round(Math.max(...d.coverage) * 1000) / 10 }, checkThese: d.flagged.length } : { next: `studio matte build ${id}` }), usedBy: usedBy(project, id) };
  });
  return { data: { mattes: rows } };
};

export const show: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const d = E.loadMatte(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `matte ${id} has not been built`, 2, `studio matte build ${id}`);
  return { data: { matte: id, definition: project.mattes![id], result: summary(d), file: d.file } };
};

export const preview: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const d = E.loadMatte(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `matte ${id} has not been built`, 2, `studio matte build ${id}`);
  const times = str(inv, 'at')?.split(',').map(Number).filter(Number.isFinite);
  const frames = times?.map((t) => Math.round(((t - d.fromMs) * d.fps) / 1000));
  const rel = `renders/matte-${id}.png`;
  const r = await E.matteSheet({ projectDir: inv.dir, project, id, data: d, out: join(inv.dir, rel), count: num(inv, 'frames'), ...(frames ? { frames } : {}) });
  return {
    data: { file: rel, frames: r.frames, key: 'two tiles per frame: the picture with the matte tinted and outlined (yellow outline; on marked frames also the marks: white box, green = object, red = not object, cyan outline), and the cut-out on a checkerboard. Tiles read left to right, top to bottom.' },
    artifacts: [{ kind: 'image', path: rel }],
  };
};

export const remove: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const used = usedBy(project, id);
  if (used.length) throw new CliError('INVALID_ARGS', `matte ${id} is used by ${used.join(', ')}`, 2, `remove or change those effects first: studio fx list --clip ${used[0]}`);
  return runSpecs(inv, [{ type: 'matte.remove', args: { id } }], `matte remove ${id}`);
};

export const exportCmd: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const d = E.loadMatte(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `matte ${id} has not been built`, 2, `studio matte build ${id}`);
  const out = str(inv, 'out') ?? `renders/matte-${id}.mkv`;
  if (out.startsWith('/') || out.split(/[\\/]/).includes('..')) throw new CliError('INVALID_ARGS', '--out must be a path inside the project folder', 2);
  E.exportMatte(inv.dir, d, join(inv.dir, out));
  return { data: { file: out, format: `gray 8-bit lossless video (FFV1 in Matroska), ${d.w}x${d.h} at ${d.fps} fps, frame 0 at ${d.fromMs} ms of ${d.asset}; brightness is how much of the object is there` }, artifacts: [{ kind: 'matte', path: out }] };
};

/** `studio cutout --clip c`: transparent everywhere but the object. Makes the matte too when marks are given. */
export const cutout: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const aid = clip.asset!;
  const a = videoAsset(project, aid);
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  let id = str(inv, 'matte');
  let ahead = project;
  if (id) {
    mref(project, id);
    if (project.mattes![id]!.asset !== aid) throw new CliError('INVALID_ARGS', `matte ${id} was made on ${project.mattes![id]!.asset}, this clip plays ${aid}`, 2);
  } else {
    const seeds = seedsFrom(inv, sizeOf(project, aid));
    const prior = str(inv, 'prior');
    if (!seeds && !prior) throw new CliError('INVALID_ARGS', `give --matte mt_xxxx, or the marks to make one: ${MARKS_HELP}`, 2);
    const [from, to] = playedRange(clip);
    const at = Math.round(num(inv, 'at') ?? from);
    const matte = parsedMatte({ asset: aid, from: Math.max(0, from - 200), to: Math.min(a.probe.durMs ?? to + 200, to + 200), keys: [{ at, seeds: seeds ?? {}, ...(prior ? { prior } : {}) }], ...(str(inv, 'engine') ? { engine: str(inv, 'engine') } : {}), label: `cutout ${clip.id}` });
    id = makeId('mt', new Set(Object.keys(project.mattes ?? {})), cryptoRng());
    ahead = { ...project, mattes: { ...(project.mattes ?? {}), [id]: matte } } as Project;
    specs.push({ type: 'matte.add', args: { id, matte } });
  }
  const feather = num(inv, 'feather');
  const choke = num(inv, 'choke');
  const fx: Fx = { type: 'cutout', matte: { id, ...(inv.flags['invert'] ? { invert: true } : {}), ...(feather ? { feather } : {}), ...(choke ? { choke } : {}) } };
  const { list: stack, node } = newEntry(project, clip, fx);
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [...specs, ...fxSpecs(clip, stack)], `cutout ${clip.id}`);
  return {
    ...r,
    data: { ...(r.data as object), node, matte: id, ...(built ? { result: summary(built.data) } : {}), next: [`studio matte preview ${id}`, `studio render --still <ms> --out check   (the picture is transparent outside the matte; put a track below the clip to see what shows through)`, `studio fx set --clip ${clip.id} --node ${node} --feather 2 --choke 1   (soften or shrink the edge)`] },
    ...(built ? { warnings: warningsOf(id, built.data) } : {}),
  };
};
void ({} as typeof MatteSeeds);

// ----- the Object Mask Tool: `studio mask ...` is the matte machinery with the promptable segmenter as the default engine ---------------------------

/** `--point` (inside the object) and `--neg` (outside it) are dots; they become foreground and background marks. */
function dotsToMarks(inv: Invocation): Invocation {
  const flags = { ...inv.flags };
  const join = (a: unknown, b: string) => (typeof a === 'string' && a ? `${a}|${b}` : b);
  const pt = str(inv, 'point');
  if (pt) flags['fg'] = join(flags['fg'], pt.split(';').map((p) => p.trim()).filter(Boolean).join('|'));
  const ng = str(inv, 'neg');
  if (ng) flags['bg'] = join(flags['bg'], ng.split(';').map((p) => p.trim()).filter(Boolean).join('|'));
  delete flags['point'];
  delete flags['neg'];
  return { ...inv, flags };
}
/** Select an object by clicking on it: points on it, points off it, a box; the segmenter finds the object and Studio follows it. */
export const maskAdd: Handler = async (inv) => {
  const i = dotsToMarks(inv);
  if (!i.flags['engine']) i.flags['engine'] = 'sam';
  return add(i);
};
export const maskKey: Handler = async (inv) => key(dotsToMarks(inv));

/** What the segmenter makes of the prompts on one frame: its three candidates side by side. Nothing is stored. */
export const maskPick: Handler = async (inv) => {
  const { project } = store(inv).load();
  const i = dotsToMarks(inv);
  const aid = str(inv, 'asset');
  const a = videoAsset(project, aid);
  const seeds = seedsFrom(i, sizeOf(project, aid!));
  if (!seeds) throw new CliError('INVALID_ARGS', 'give a point on the object (--point x,y), a box, or an outline', 2, 'studio inspect frame shows the frame to mark');
  const at = Math.round(num(inv, 'at') ?? 0);
  const rel = `renders/mask-candidates-${aid}-${at}.png`;
  const E = await engines();
  const r = await E.maskCandidates({ projectDir: inv.dir, project, asset: aid!, at, seeds, ...(num(inv, 'width') ? { width: num(inv, 'width') } : {}), out: join(inv.dir, rel), log: inv.log });
  return {
    data: { file: rel, key: 'top left: the frame. Then the segmenter\'s three candidates (tinted), with your points (green = on the object, red = not) and box. Pick one with --pick 0|1|2-style index via `mask add --pick whole|best|first`, or correct the points and look again.', auto: r.auto, candidates: r.candidates, ms: r.ms },
    artifacts: [{ kind: 'image', path: rel }],
  };
};

/** Changes how the edge of a matte is made (resolution, refining, hair, flicker control, colour cleaning) and builds it again. */
export const edge: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const m = project.mattes![id]!;
  const given = edgeFrom(inv);
  if (inv.flags['reset']) {
    return runSpecs(inv, [{ type: 'matte.set', args: { id, patch: { edge: null } } }], `matte edge ${id} reset`);
  }
  if (!given) throw new CliError('INVALID_ARGS', 'give at least one of --edge-width --smooth --no-smooth --no-refine --hair --no-decontaminate (or --reset)', 2);
  const merged = { ...(m.edge ?? {}), ...given };
  const next = parsedMatte({ ...m, edge: merged });
  const ahead = { ...project, mattes: { ...project.mattes, [id]: next } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'matte.set', args: { id, patch: { edge: merged } } }], `matte edge ${id}`);
  return { ...r, data: { ...(r.data as object), matte: id, edge: merged, ...(built ? { result: summary(built.data) } : {}) }, ...(built ? { warnings: warningsOf(id, built.data) } : {}) };
};

// ----- erase: take an object out of the picture, with the background rebuilt from the other frames ---------------------------------------

const platesSummary = (d: import('@studio/engines').PlateData) => ({
  frames: d.frames,
  size: `${d.w}x${d.h} at ${d.fps} fps`,
  removedAreaPct: { max: Math.max(...d.holePct), mean: Math.round((d.holePct.reduce((x, y) => x + y, 0) / d.holePct.length) * 10) / 10 },
  filledFromOtherFramesPct: Math.round((d.filled.reduce((x, y) => x + y, 0) / d.filled.length) * 1000) / 10,
  neverVisiblePct: Math.round((d.spread.reduce((x, y) => x + y, 0) / d.spread.length) * 1000) / 10,
  camera: d.registration,
  ...(d.flagged.length ? { checkThese: d.flagged } : {}),
  ms: d.stats.ms,
});
const plateWarnings = (d: import('@studio/engines').PlateData): string[] => {
  const w: string[] = [];
  const spread = d.spread.reduce((x, y) => x + y, 0) / d.spread.length;
  if (spread > 0.05) w.push(`erase ${d.matte}: ${Math.round(spread * 100)}% of the removed area is never visible in another frame of the shot, so that part is smeared in from its surroundings, not real background; move the object less, or mark a shorter range where it moves away`);
  if (d.registration.lost.length) w.push(`erase ${d.matte}: the camera could not be followed in ${d.registration.lost.length} frame(s); the plate there may not line up`);
  if (d.flagged.length) w.push(`erase ${d.matte}: ${d.flagged.length} frame(s) to check, first at ${d.flagged[0]!.ms} ms (${d.flagged[0]!.why})`);
  return w;
};

/** Takes an object out of the clip: inside the matte the picture is the background as other frames of the shot saw it. */
export const erase: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const aid = clip.asset!;
  const a = videoAsset(project, aid);
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  let id = str(inv, 'matte');
  let ahead = project;
  if (id) {
    mref(project, id);
    if (project.mattes![id]!.asset !== aid) throw new CliError('INVALID_ARGS', `matte ${id} was made on ${project.mattes![id]!.asset}, this clip plays ${aid}`, 2);
  } else {
    const i = dotsToMarks(inv);
    const seeds = seedsFrom(i, sizeOf(project, aid));
    if (!seeds) throw new CliError('INVALID_ARGS', `give --matte mt_xxxx, or point at what to remove: ${MARKS_HELP}`, 2, 'studio mask pick --asset a_xx --at MS --point x,y shows what the segmenter takes');
    const [from, to] = playedRange(clip);
    const at = Math.round(num(inv, 'at') ?? from);
    const matte = parsedMatte({ asset: aid, from: Math.max(0, from - 200), to: Math.min(a.probe.durMs ?? to + 200, to + 200), keys: [{ at, seeds }], engine: str(inv, 'engine') ?? 'sam', ...(edgeFrom(inv) ? { edge: edgeFrom(inv) } : {}), label: `erase ${clip.id}` });
    id = makeId('mt', new Set(Object.keys(project.mattes ?? {})), cryptoRng());
    ahead = { ...project, mattes: { ...(project.mattes ?? {}), [id]: matte } } as Project;
    specs.push({ type: 'matte.add', args: { id, matte } });
  }
  const pad = num(inv, 'pad');
  const feather = num(inv, 'feather');
  const fx: Fx = { type: 'erase', matte: { id, ...(feather !== undefined ? { feather } : {}) }, ...(pad !== undefined ? { pad } : {}) } as Fx;
  const { list: stack, node } = newEntry(project, clip, fx);
  const E = await engines();
  let built: Awaited<ReturnType<typeof E.buildPlate>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await E.buildPlate({ projectDir: inv.dir, project: ahead, matte: id, ...(pad !== undefined ? { pad } : {}), log: inv.log });
  const r = runSpecs(inv, [...specs, ...fxSpecs(clip, stack)], `erase ${clip.id}`);
  return {
    ...r,
    data: { ...(r.data as object), node, matte: id, ...(built ? { plate: platesSummary(built.data), next: [`studio erase preview ${id}   (the picture, the removed area tinted, and the rebuilt picture)`, `studio render --still <ms> --out check`, `studio fx set --clip ${clip.id} --node ${node} --feather 3   (soften the seam)`] } : { plate: `not built (studio erase build ${id})` }) },
    ...(built ? { warnings: plateWarnings(built.data) } : {}),
  };
};

export const eraseBuild: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const pad = num(inv, 'pad');
  const r = await E.buildPlate({ projectDir: inv.dir, project, matte: id, ...(pad !== undefined ? { pad } : {}), force: !!inv.flags['force'], log: inv.log });
  return { data: { matte: id, cached: r.cached, plate: platesSummary(r.data) }, warnings: plateWarnings(r.data) };
};

export const erasePreview: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const pad = num(inv, 'pad') ?? E.DEFAULT_PAD;
  const d = E.loadPlate(inv.dir, project, id, pad);
  if (!d) throw new CliError('NOT_FOUND', `no clean plate for ${id} yet`, 2, `studio erase build ${id}`);
  const md = E.loadMatte(inv.dir, project, id)!;
  const times = str(inv, 'at')?.split(',').map(Number).filter(Number.isFinite);
  const frames = times?.map((t) => Math.round(((t - d.fromMs) * d.fps) / 1000));
  const rel = `renders/erase-${id}.png`;
  const r = await E.plateSheet({ projectDir: inv.dir, project, data: d, matteData: md, out: join(inv.dir, rel), count: num(inv, 'frames'), ...(frames ? { frames } : {}) });
  return { data: { file: rel, frames: r.frames, key: 'three tiles per frame: the picture, the removed area tinted, and the picture with the object rebuilt from other frames' }, artifacts: [{ kind: 'image', path: rel }] };
};
