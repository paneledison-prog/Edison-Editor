/**
 * `studio matte ...` and `studio cutout`: cut an object out of a video without a green screen. The agent looks at a frame,
 * says where the object is (a box, dots and strokes on it and on what is not it, or a rough outline), and Studio cuts it out
 * of that frame and follows it through the shot. The agent looks at the result, marks more frames where it drifts, and uses
 * the matte: as a cutout (transparent outside), or to limit any effect to the object or to everything else.
 * The marks are ops in the project; the matte video is derived and cached (packages/engines/src/matte.ts).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cryptoRng, makeId, Matte, MatteSeeds, type Clip, type Fx, type Project } from '@studio/core';
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
    ...(d.quality ? { quality: d.quality.summary } : {}),
    ...(d.stats.members ? { union: d.stats.members } : {}),
    ms: d.stats.ms,
  };
}

/** The frames of a matte most worth looking at: carried by motion alone, hidden, in pieces, or changing area suddenly (worst first). */
function needsLook(d: import('@studio/engines').MatteData, max = 8): number[] {
  const q = d.quality?.frames;
  if (!q) return d.flagged.map((f) => f.frame).slice(0, max);
  const rank = q.map((f, i) => ({ i, score: (f.how === 'prediction' ? 3 : f.how === 'best' ? 2 : f.how === 'hidden' ? 2 : 0) + (f.islands > 0 ? 2 : 0) + Math.min(2, f.areaChangePct / 15) + (f.keptOut > 0 ? 0.3 : 0) })).filter((r) => r.score >= 1);
  rank.sort((a, b) => b.score - a.score);
  // spread them: no two within 3 frames of each other
  const out: number[] = [];
  for (const r of rank) if (out.length < max && out.every((o) => Math.abs(o - r.i) > 3)) out.push(r.i);
  return out.sort((a, b) => a - b);
}
const warningsOf = (id: string, d: import('@studio/engines').MatteData): string[] => {
  const w: string[] = [];
  for (const x of d.drift) if (x.iou < 0.9) w.push(`matte ${id}: following from ${x.from} ms ${x.direction === 'forward' ? 'forward' : 'backward'} reaches the marked frame at ${x.to} ms with only ${Math.round(x.iou * 100)}% agreement; look with studio matte preview and add marks in between`);
  if (d.flagged.length) w.push(`matte ${id}: ${d.flagged.length} frame(s) to check, first at ${d.flagged[0]!.ms} ms (${d.flagged[0]!.why})`);
  if (d.quality && d.quality.summary.fallbackFrames > 0) w.push(`matte ${id}: ${d.quality.summary.fallbackFrames} frame(s) were carried by motion alone (the segmenter's masks did not fit); look at them: studio bg check ${id}`);
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


// ----- background removal: find the subjects, say which to keep, check the result --------------------------------------------------------------

const compactSubject = (x: import('@studio/engines').Subject) => ({
  id: x.id,
  at: x.at,
  ...(x.top ? {} : { partOf: x.partOf }),
  areaPct: x.areaPct,
  bbox: x.bbox,
  point: x.point,
  colour: x.colour,
  shape: x.shape,
  salience: x.salience,
  moves: x.moving ? `moves against the background (${x.speedPctPerSec}% of the width per second)` : 'still against the background',
  ...(x.touches.length ? { touchesEdge: x.touches } : {}),
  quality: x.quality,
});

/** `studio bg subjects`: what is in the shot, numbered, with what is needed to say which to keep. */
export const bgSubjects: Handler = async (inv) => {
  const { project } = store(inv).load();
  const a = videoAsset(project, str(inv, 'asset'));
  const E = await engines();
  const at = str(inv, 'at')?.split(',').map(Number).filter(Number.isFinite);
  const t0 = Date.now();
  const r = await E.findSubjects({
    projectDir: inv.dir,
    project,
    asset: str(inv, 'asset')!,
    ...(at?.length ? { at } : {}),
    ...(num(inv, 'from') !== undefined ? { from: num(inv, 'from')! } : {}),
    ...(num(inv, 'to') !== undefined ? { to: num(inv, 'to')! } : {}),
    ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width')! } : {}),
    ...(num(inv, 'max') !== undefined ? { maxThings: num(inv, 'max')! } : {}),
    log: inv.log,
  });
  void a;
  const things = r.subjects.filter((x) => x.top);
  return {
    data: {
      run: r.run,
      sheet: r.sheet,
      ...(r.each ? { each: r.each } : {}),
      times: r.times,
      ...(r.cuts.length ? { cuts: r.cuts, shots: `the shot changes at ${r.cuts.join(', ')} ms: one moment was looked at in each shot; to keep a thing in every shot name it in each, joined with + (e.g. 3+15)` } : {}),
      key: `${r.sheet}: the frame at each time, every thing tinted, outlined and numbered in white; parts of things (yellow numbers) are not outlined. ${r.each ? `${r.each}: each thing cut out on a checkerboard with its number, to see exactly what its mask holds.` : ''}`,
      subjects: r.subjects.map(compactSubject),
      next: [
        `studio bg remove --run ${r.run} --keep ${things[0] ? things[0].n : 1} --clip c_xx   (keep those subjects, take everything else out; "1,3" keeps two things, "1+5" says 1 and 5 are the same thing seen at two times)`,
        `studio bg remove --run ${r.run} --keep ... --remove ...   (--remove names things that must go even where they touch what is kept)`,
        'Look at the sheet first: a mask may hold only part of a person (a part is listed with partOf), or two things joined.',
      ],
      wallMs: Date.now() - t0,
    },
    artifacts: [{ kind: 'image', path: r.sheet }, ...(r.each ? [{ kind: 'image', path: r.each }] : [])],
  };
};

/** `1,3` or `1+5,3` (or with an s in front): groups of subject ids; a group is one thing, seen in more than one place. */
function keepGroups(text: string): string[][] {
  return text
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => g.split('+').map((x) => (x.trim().startsWith('s') ? x.trim() : `s${x.trim()}`)));
}

type Engines = Awaited<ReturnType<typeof engines>>;

/** What `bg remove` and `bg layers` share: the subjects named, and one matte per kept thing (not yet in the project). */
interface KeptPlan {
  E: Engines;
  project: Project;
  clip?: Clip;
  assetId: string;
  from: number;
  to: number;
  run: string;
  found: import('@studio/engines').SubjectsRun;
  byId: Map<string, import('@studio/engines').Subject>;
  groups: string[][];
  removeIds: Set<string>;
  notes: string[];
  edge: Matte['edge'] | undefined;
  /** one matte per kept thing, in the order of --keep */
  members: { id: string; matte: Matte; group: string[] }[];
  specs: { type: string; args: Record<string, unknown> }[];
  mattes: Record<string, Matte>;
  taken: Set<string>;
}

async function keptPlan(inv: Invocation, what: string): Promise<KeptPlan> {
  const { project } = store(inv).load();
  const E = await engines();
  const clipId = str(inv, 'clip');
  const clip = clipId ? clipOf(inv).clip : undefined;
  let run = str(inv, 'run');
  const aid = clip?.asset ?? str(inv, 'asset') ?? (run ? E.loadSubjects(inv.dir, run).asset : undefined);
  const a = videoAsset(project, aid);
  const assetId = aid!;
  const [pFrom, pTo] = clip ? playedRange(clip) : [0, a.probe.durMs ?? 0];
  const from = Math.round(num(inv, 'from') ?? Math.max(0, pFrom - (clip ? 200 : 0)));
  const to = Math.round(num(inv, 'to') ?? Math.min(a.probe.durMs ?? pTo + 200, pTo + (clip ? 200 : 0)));
  const notes: string[] = [];
  let keep = str(inv, 'keep');
  let found: import('@studio/engines').SubjectsRun;
  if (!run) {
    if (!inv.flags['auto']) throw new CliError('INVALID_ARGS', 'say what to keep: --run sub_xxxx --keep 1,3 (studio bg subjects --asset ' + aid + ' lists the subjects), or --auto to keep the most prominent one', 2);
    inv.log('looking for the main subject');
    found = await E.findSubjects({ projectDir: inv.dir, project, asset: assetId, from, to, log: inv.log });
    run = found.run;
  } else found = E.loadSubjects(inv.dir, run);
  if (found.asset !== assetId) throw new CliError('INVALID_ARGS', `subjects ${run} were found on ${found.asset}, not ${assetId}`, 2);
  const byId = new Map(found.subjects.map((x) => [x.id, x]));
  if (!keep) {
    if (!inv.flags['auto']) throw new CliError('INVALID_ARGS', '--keep is required: the numbers of the subjects to keep, e.g. --keep 1,3', 2, `studio bg subjects --asset ${assetId}`);
    // the most prominent thing at the first moment: salient, large, moving
    const first = found.subjects.filter((x) => x.top && x.at === found.times[0]);
    const score = (x: (typeof first)[number]) => 0.5 * x.salience + 0.35 * Math.sqrt(x.areaPct / 100) + (x.moving ? 0.15 : 0) - (x.touches.length >= 3 ? 0.2 : 0);
    first.sort((x, y) => score(y) - score(x));
    if (!first.length) throw new CliError('INVALID_ARGS', 'no subject was found in this shot', 2, 'look at the frame: studio inspect frame');
    keep = first[0]!.n.toString();
    notes.push(`--auto kept ${first[0]!.id} (${first[0]!.colour}, ${first[0]!.areaPct}% of the frame, salience ${first[0]!.salience}${first[0]!.moving ? ', moving' : ''}); the others were ${first.slice(1).map((x) => `${x.id} (${x.colour}, ${x.areaPct}%)`).join(', ') || 'none'}`);
  }
  const groups = keepGroups(keep);
  const removeIds = new Set(str(inv, 'remove') ? keepGroups(str(inv, 'remove')!).flat() : []);
  for (const id of [...groups.flat(), ...removeIds]) if (!byId.has(id)) throw new CliError('NOT_FOUND', `no subject ${id} in ${run}`, 2, `the ids are ${[...byId.keys()].join(' ')}`);
  for (const id of removeIds) if (groups.flat().includes(id)) throw new CliError('INVALID_ARGS', `${id} is both kept and removed`, 2);
  const taken = new Set(Object.keys(project.mattes ?? {}));
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  const members: KeptPlan['members'] = [];
  const mattes: Record<string, Matte> = {};
  const edge = edgeFrom(inv);
  for (const g of groups) {
    const subs = g.map((id) => byId.get(id)!);
    // one marked frame per moment the group's subjects were found at
    const byAt = new Map<number, typeof subs>();
    for (const x of subs) byAt.set(x.at, [...(byAt.get(x.at) ?? []), x]);
    const keys = [...byAt.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([at, xs]) => {
        // the chosen subject's own mask (when two parts make one thing at this moment, their masks together)
        const w0 = xs[0]!.mask.w;
        const h0 = xs[0]!.mask.h;
        const union = new Uint8Array(w0 * h0);
        for (const x of xs) {
          let at2 = 0;
          let v = 0;
          for (const r of x.mask.rle) {
            if (v) for (let q = at2; q < Math.min(union.length, at2 + r); q++) union[q] = 1;
            at2 += r;
            v ^= 1;
          }
        }
        const mask = E.maskToRle(union, w0, h0);
        // things named with --remove that were found at this moment: dots on them mark them as not the object, wherever the mask itself is not already
        const bg = found.subjects
          .filter((o) => removeIds.has(o.id) && o.at === at)
          .flatMap((o) => o.prompt.points.filter((q) => !union[Math.min(h0 - 1, Math.floor(q[1] * h0)) * w0 + Math.min(w0 - 1, Math.floor(q[0] * w0))]).map((q) => ({ p: [q] as [number, number][] })));
        return { at: Math.min(Math.max(at, from), to - 1), seeds: { mask, ...(bg.length ? { bg } : {}) } };
      });
    // "visible from / until": the thing is not in the picture outside that time (it is hidden, or not yet or no longer there)
    const vFrom = num(inv, 'visible-from');
    const vUntil = num(inv, 'visible-until');
    const step = 1000 / Math.min(30, a.probe.fps ?? 30);
    if (vFrom !== undefined && vFrom - step > from) keys.unshift({ at: Math.round(vFrom - step), seeds: {}, absent: true } as unknown as (typeof keys)[number]);
    if (vUntil !== undefined && vUntil + step < to) keys.push({ at: Math.round(vUntil + step), seeds: {}, absent: true } as unknown as (typeof keys)[number]);
    keys.sort((x, y) => x.at - y.at);
    const matte = parsedMatte({
      asset: assetId, from, to, keys, engine: 'sam',
      ...(num(inv, 'fps') !== undefined ? { fps: num(inv, 'fps') } : {}),
      ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width') } : {}),
      ...(edge ? { edge } : {}),
      label: `${what}: keep ${g.join('+')}`,
    });
    const id = makeId('mt', taken, cryptoRng());
    taken.add(id);
    mattes[id] = matte;
    members.push({ id, matte, group: g });
    specs.push({ type: 'matte.add', args: { id, matte } });
  }
  return { E, project, ...(clip ? { clip } : {}), assetId, from, to, run: run!, found, byId, groups, removeIds, notes, edge, members, specs, mattes, taken };
}

/** The union of the plan's mattes (added to the plan), or its single matte. */
function unionOfPlan(plan: KeptPlan, what: string): string {
  if (plan.members.length === 1) return plan.members[0]!.id;
  const id = makeId('mt', plan.taken, cryptoRng());
  plan.taken.add(id);
  const u = parsedMatte({ asset: plan.assetId, from: plan.from, to: plan.to, keys: [], union: plan.members.map((m) => m.id), ...(plan.edge ? { edge: plan.edge } : {}), label: `${what}: ${plan.groups.map((g) => g.join('+')).join(', ')}` });
  plan.mattes[id] = u;
  plan.specs.push({ type: 'matte.add', args: { id, matte: u } });
  return id;
}

const describeGroup = (plan: KeptPlan, g: string[]) => g.map((id) => plan.byId.get(id)!).map((x) => `${x.id} (${x.colour}, ${x.areaPct}%${x.top ? '' : ', a part'})`).join(' + ');

/** `studio bg remove`: keep the chosen subjects, take out the rest of every frame. */
export const bgRemove: Handler = async (inv) => {
  const plan = await keptPlan(inv, 'bg remove');
  const { E, clip, found, groups, removeIds, notes, members } = plan;
  const finalId = unionOfPlan(plan, 'bg remove: keep');
  const ahead = { ...plan.project, mattes: { ...(plan.project.mattes ?? {}), ...plan.mattes } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, finalId);
  let node: string | undefined;
  const specs = [...plan.specs];
  if (clip) {
    const feather = num(inv, 'feather');
    const choke = num(inv, 'choke');
    const fx: Fx = { type: 'cutout', matte: { id: finalId, ...(feather ? { feather } : {}), ...(choke ? { choke } : {}) } };
    const { list: stack, node: nd } = newEntry(plan.project, clip, fx);
    node = nd;
    specs.push(...fxSpecs(clip, stack));
  }
  const r = runSpecs(inv, specs, `bg remove ${plan.assetId}`);
  let preview: string | undefined;
  if (built && !inv.dryRun) {
    const look = needsLook(built.data, 4);
    const rel = `renders/bg-${finalId}.png`;
    await E.matteSheet({ projectDir: inv.dir, project: ahead, id: finalId, data: built.data, out: join(inv.dir, rel), frames: [...new Set([0, Math.floor((built.data.frames - 1) / 2), built.data.frames - 1, ...look])].slice(0, 8) });
    preview = rel;
  }
  const keptAll = new Set(groups.flat());
  return {
    ...r,
    data: {
      ...(r.data as object),
      matte: finalId,
      ...(members.length > 1 ? { members: members.map((m) => m.id) } : {}),
      ...(node ? { cutout: { clip: clip!.id, node } } : {}),
      kept: groups.map((g) => describeGroup(plan, g)),
      ...(removeIds.size ? { removedExplicitly: [...removeIds] } : {}),
      leftOut: found.subjects.filter((x) => x.top && !keptAll.has(x.id)).map((x) => `${x.id} (${x.colour}, ${x.areaPct}%)`),
      ...(notes.length ? { notes } : {}),
      ...(built ? { result: summary(built.data), wallMs: built.wallMs } : { result: `not built (studio matte build ${finalId})` }),
      ...(built ? { needsALook: needsLook(built.data).map((f) => ({ frame: f, ms: Math.round(built!.data.fromMs + (f * 1000) / built!.data.fps), how: built!.data.quality?.frames[f]?.how })) } : {}),
      ...(preview ? { preview } : {}),
      next: [`studio bg check ${finalId}   (the frames most likely to be wrong, on one sheet)`, `studio mask key ${members[0]!.id} --at MS --neg "x,y" --add   (a neighbour joined: mark it where it did; --absent where the object is not in the picture)`, node && clip ? `studio fx set --clip ${clip.id} --node ${node} --feather 1.5   (soften the edge)` : `studio cutout --clip c_xx --matte ${finalId}`, `studio bg layers --run ${plan.run} --keep ... --clip c_xx   (instead: each kept thing a layer of its own that can be moved, with the background rebuilt behind it)`],
    },
    ...(built ? { warnings: warningsOf(finalId, built.data) } : {}),
    ...(preview ? { artifacts: [{ kind: 'image', path: preview }] } : {}),
  };
};

/**
 * `studio bg layers`: a shot split into layers. Each kept thing becomes a clip of its own on its own track above the shot, cut
 * out by its own matte (an element that can be moved, sized, turned and given effects); the shot itself stays below as the
 * background, with the kept things erased from it (rebuilt from other frames), so that moving an element leaves no copy of it
 * behind. All the layers are linked: moving or trimming one in time moves or trims them all.
 */
export const bgLayers: Handler = async (inv) => {
  if (!str(inv, 'clip')) throw new CliError('INVALID_ARGS', '--clip is required: the shot to split into layers', 2, 'studio project show lists clips');
  const plan = await keptPlan(inv, 'layer');
  const { E, clip, members, notes } = plan;
  const shot = clip!;
  const project = plan.project;
  const doErase = !inv.flags['no-erase'];
  const eraseId = doErase ? unionOfPlan(plan, 'layers: erased from the background') : undefined;
  const specs = [...plan.specs];
  const link = shot.link ?? `ly_${createHash('sha256').update(`${shot.id}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 6)}`;
  // the background: the shot, with the kept things erased from it
  const bgLabel = shot.label ?? `background (${plan.groups.map((g) => g.join('+')).join(', ')} ${doErase ? 'erased' : 'still in it'})`;
  let bgFx = shot.fx ?? [];
  if (eraseId) {
    const pad = num(inv, 'pad');
    const fx: Fx = { type: 'erase', matte: { id: eraseId }, ...(pad !== undefined ? { pad } : {}) } as Fx;
    bgFx = newEntry(project, shot, fx).list;
  }
  specs.push({ type: 'clip.set', args: { id: shot.id, patch: { fx: bgFx.length ? bgFx : null, link, label: bgLabel } } });
  // the elements: a copy of the shot (same timing, same motion, same look) on a new track above it, cut out by one matte each
  const trackIdx = project.tracks.findIndex((t) => t.id === shot.track);
  const tracksTaken = new Set(project.tracks.map((t) => t.id));
  const clipsTaken = new Set(project.clips.map((c) => c.id));
  const nodesTaken = new Set(project.clips.flatMap((c) => (c.fx ?? []).map((f) => (f as { node?: string }).node).filter(Boolean) as string[]));
  for (const f of bgFx) if ((f as { node?: string }).node) nodesTaken.add((f as { node?: string }).node!);
  const rng = cryptoRng();
  const kfTaken = new Set(project.clips.flatMap((c) => Object.values(c.keyframes ?? {}).flat().map((k) => k.id)));
  const d = project.assets[plan.assetId]!.probe;
  const layers: { clip: string; track: string; kind: 'element' | 'background'; what: string; matte?: string; anchor?: [number, number] }[] = [{ clip: shot.id, track: shot.track, kind: 'background', what: bgLabel, ...(eraseId ? { matte: eraseId } : {}) }];
  const feather = num(inv, 'feather');
  const choke = num(inv, 'choke');
  members.forEach((m, k) => {
    const tid = makeId('t', tracksTaken, rng);
    tracksTaken.add(tid);
    const cid = makeId('c', clipsTaken, rng);
    clipsTaken.add(cid);
    const what = describeGroup(plan, m.group);
    specs.push({ type: 'track.add', args: { id: tid, type: 'video', name: `element ${m.group.join('+')}`, index: trackIdx + 1 + k } });
    // the shot's own effects (look, timing, steadying), each under a new name; its keyframes follow their effects
    const rename = new Map<string, string>();
    const fx: Fx[] = [];
    for (const f of shot.fx ?? []) {
      if (f.type === 'erase' || f.type === 'cutout' || f.type === 'pin') continue;
      const old = (f as { node?: string }).node;
      if (old) {
        const nn = makeId('f', nodesTaken, rng);
        nodesTaken.add(nn);
        rename.set(old, nn);
        fx.push({ ...f, node: nn } as Fx);
      } else fx.push({ ...f } as Fx);
    }
    const cutNode = makeId('f', nodesTaken, rng);
    nodesTaken.add(cutNode);
    fx.push({ type: 'cutout', matte: { id: m.id, ...(feather ? { feather } : {}), ...(choke ? { choke } : {}) }, node: cutNode } as Fx);
    const keyframes: NonNullable<Clip['keyframes']> = {};
    for (const [prop, ks] of Object.entries(shot.keyframes ?? {})) {
      const fm = /^fx\.(f_[^.]+)\.(.+)$/.exec(prop);
      if (fm && !rename.has(fm[1]!)) continue;
      keyframes[fm ? `fx.${rename.get(fm[1]!)}.${fm[2]}` : prop] = ks.map((x) => ({ ...x }));
    }
    // the anchor (where it is sized and turned about) is where the thing is at the moment it was found, on the canvas
    const first = plan.byId.get(m.group[0]!)!;
    const fit = canvasFit(project, d);
    const ax = Math.round((fit.x + (first.bbox[0] + first.bbox[2] / 2) * fit.w) * 1000) / 1000;
    const ay = Math.round((fit.y + (first.bbox[1] + first.bbox[3] / 2) * fit.h) * 1000) / 1000;
    const t0 = shot.transform ?? {};
    const transform = { ...t0, ...(t0.ax === undefined ? { ax } : {}), ...(t0.ay === undefined ? { ay } : {}) };
    // keyframe ids are new too
    for (const ks of Object.values(keyframes)) for (const x of ks) (x.id = makeId('k', kfTaken, rng)), kfTaken.add(x.id);
    specs.push({
      type: 'clip.add',
      args: {
        clip: {
          id: cid, track: tid, asset: plan.assetId, start: shot.start, dur: shot.dur,
          ...(shot.srcIn !== undefined ? { srcIn: shot.srcIn } : {}),
          transform, fx,
          ...(Object.keys(keyframes).length ? { keyframes } : {}),
          link, label: `element ${what}`,
        },
      },
    });
    layers.push({ clip: cid, track: tid, kind: 'element', what, matte: m.id, anchor: [transform.ax!, transform.ay!] });
  });
  const ahead = { ...project, mattes: { ...(project.mattes ?? {}), ...plan.mattes } } as Project;
  const builtMattes: Record<string, import('@studio/engines').MatteData> = {};
  let plate: Awaited<ReturnType<typeof E.buildPlate>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) {
    for (const m of members) builtMattes[m.id] = (await build(inv, ahead, m.id)).data;
    if (eraseId) {
      if (!builtMattes[eraseId]) builtMattes[eraseId] = (await build(inv, ahead, eraseId)).data;
      const pad = num(inv, 'pad');
      plate = await E.buildPlate({ projectDir: inv.dir, project: ahead, matte: eraseId, ...(pad !== undefined ? { pad } : {}), log: inv.log });
    }
  }
  const r = runSpecs(inv, specs, `bg layers ${shot.id}`);
  const warnings: string[] = [];
  for (const [id, md] of Object.entries(builtMattes)) warnings.push(...warningsOf(id, md));
  if (plate) warnings.push(...plateWarnings(plate.data));
  const el = layers.find((l) => l.kind === 'element');
  return {
    ...r,
    data: {
      ...(r.data as object),
      link,
      layers,
      ...(Object.keys(builtMattes).length ? { mattes: Object.fromEntries(Object.entries(builtMattes).map(([id, md]) => [id, { quality: md.quality?.summary, checkThese: md.flagged.length }])) } : {}),
      ...(plate ? { background: platesSummary(plate.data) } : eraseId ? { background: `plate not built (studio erase build ${eraseId})` } : {}),
      ...(notes.length ? { notes } : {}),
      next: el
        ? [
            `studio layer move --clip ${el.clip} --dx 200 --dy -40 --size 0.8 --rot 10   (place it; values in project pixels, size about its anchor)`,
            `studio layer move --clip ${el.clip} --t 0 --dx 0   then   --t 1500 --dx 400 --ease expo.inOut   (animate it: keyframes, ms from the clip start)`,
            `studio fx add --clip ${el.clip} --effect ...   (an effect on this element only)`,
            `studio layer hide --clip ${shot.id}   (no background: the elements over the tracks below, or over the project background)`,
            `studio render --still MS --out check   (look at it)`,
            `studio erase preview ${eraseId ?? 'mt_x'}   (the background with the kept things taken out)`,
          ]
        : [],
    },
    ...(warnings.length ? { warnings } : {}),
  };
};

/** Where the asset's picture sits on the canvas when it is fitted (letterboxed), as fractions of the canvas. */
function canvasFit(project: Project, d: Project['assets'][string]['probe']): { x: number; y: number; w: number; h: number } {
  const rot = d.rotation === 90 || d.rotation === 270;
  const w = (rot ? d.h : d.w) ?? project.meta.width;
  const h = (rot ? d.w : d.h) ?? project.meta.height;
  const k = Math.min(project.meta.width / w, project.meta.height / h);
  const fw = (w * k) / project.meta.width;
  const fh = (h * k) / project.meta.height;
  return { x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh };
}

/** `studio bg check`: how clean a matte is, and a sheet of the frames most likely to be wrong. */
export const bgCheck: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = mref(project, inv.positionals[0] ?? str(inv, 'matte'));
  const E = await engines();
  const d = E.loadMatte(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `matte ${id} has not been built`, 2, `studio matte build ${id}`);
  const frames = needsLook(d, num(inv, 'frames') !== undefined ? Math.max(2, Math.min(8, Math.round(num(inv, 'frames')!))) : 6);
  const base = [0, d.frames - 1];
  const rel = `renders/bg-check-${id}.png`;
  const list = [...new Set([...frames, ...(frames.length < 3 ? base : [])])].slice(0, 8);
  const r = await E.matteSheet({ projectDir: inv.dir, project, id, data: d, out: join(inv.dir, rel), frames: list });
  const q = d.quality;
  return {
    data: {
      matte: id,
      result: summary(d),
      frames: list.map((f) => ({ frame: f, ms: Math.round(d.fromMs + (f * 1000) / d.fps), ...(q?.frames[f] ?? {}) })),
      file: rel,
      tiles: r.frames.length,
      key: 'two tiles per frame: the picture with the matte tinted and outlined, and the cut-out on a checkerboard. The frames are the ones most likely to be wrong (carried by motion alone, in pieces, or changing area suddenly), in time order.',
      next: ['a neighbour joined the object: studio mask key MT --at MS --neg "x,y" --add', 'the object is hidden or out of the picture: studio mask key MT --at MS --absent', 'the edge is rough: studio matte edge MT --hair   or   --edge-model vitmatte'],
    },
    artifacts: [{ kind: 'image', path: rel }],
  };
};
