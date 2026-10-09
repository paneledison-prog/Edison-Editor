/**
 * `studio track ...`, `studio stabilize`, `studio pin`: follow a flat region of a video through time, steady shaky footage with
 * the camera path that gives, and fix a graphic onto the region. The definitions (tracker, stabilize and pin effects) are ops in
 * the project; the analysis they rest on is derived and cached (see packages/engines/src/track.ts).
 */
import { join } from 'node:path';
import { cryptoRng, makeId, speedOf, Tracker, type Clip, type Fx, type Project } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { clipOf, fxSpecs, label, named, nodeOf, takenNodes } from './fx.js';
import { num, runSpecs, store, str } from './shared.js';

const engines = () => import('@studio/engines');
type Quad = Tracker['quad'];

// ----- arguments --------------------------------------------------------------------------------------------------------------

const nums = (flag: string, text: string, count: number): number[] => {
  const v = text.split(',').map((x) => Number(x.trim()));
  if (v.length !== count || v.some((x) => !Number.isFinite(x))) throw new CliError('INVALID_ARGS', `--${flag} needs ${count} numbers separated by commas`, 2);
  return v;
};
/** `--box x,y,w,h` or `--quad x1,y1,x2,y2,x3,y3,x4,y4` (clockwise from the top left), as fractions of the frame. */
function regionOf(inv: Invocation, box = 'box', quad = 'quad'): Quad | undefined {
  const b = str(inv, box);
  const q = str(inv, quad);
  if (b && q) throw new CliError('INVALID_ARGS', `give --${box} or --${quad}, not both`, 2);
  if (b) {
    const [x, y, w, h] = nums(box, b, 4) as [number, number, number, number];
    if (w <= 0 || h <= 0) throw new CliError('INVALID_ARGS', `--${box} width and height must be above 0`, 2);
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  if (q) {
    const v = nums(quad, q, 8);
    return [[v[0]!, v[1]!], [v[2]!, v[3]!], [v[4]!, v[5]!], [v[6]!, v[7]!]];
  }
  return undefined;
}
const inset = (m: number): Quad => [[m, m], [1 - m, m], [1 - m, 1 - m], [m, 1 - m]];
const asNum = (q: Quad) => q.map((p) => p.map((v) => Math.round(v * 10000) / 10000)) as Quad;

function videoAsset(project: Project, id: string | undefined) {
  if (!id) throw new CliError('INVALID_ARGS', '--asset is required', 2, 'studio project show lists assets');
  const a = project.assets[id];
  if (!a) throw new CliError('NOT_FOUND', `no asset ${id}`, 2, 'studio project show lists assets');
  if (a.kind !== 'video') throw new CliError('INVALID_ARGS', `${id} is ${a.kind}; only video can be tracked`, 2);
  return a;
}
const parsed = (t: unknown): Tracker => {
  const r = Tracker.safeParse(t);
  if (!r.success) throw new CliError('INVALID_ARGS', `tracker: ${r.error.issues[0]!.path.join('.')} ${r.error.issues[0]!.message}`, 2);
  return r.data;
};
const refOf = (project: Project, id: string | undefined): string => {
  if (!id) throw new CliError('INVALID_ARGS', 'give the tracker id', 2, 'studio track list');
  if (!project.trackers?.[id]) throw new CliError('NOT_FOUND', `no tracker ${id}`, 2, 'studio track list');
  return id;
};
const usedBy = (p: Project, id: string) => p.clips.filter((c) => (c.fx ?? []).some((f) => (f.type === 'stabilize' || f.type === 'pin') && f.tracker === id)).map((c) => c.id);

/** The numbers an agent needs to judge a track. */
function summary(d: import('@studio/engines').TrackData) {
  const s = d.stats;
  return {
    frames: d.frames,
    analysis: `${d.w}x${d.h} at ${d.fps} fps`,
    referenceFrame: d.refIndex,
    followed: d.frames - s.lost,
    alignedToReference: s.refined,
    lost: s.lost,
    ...(s.lostRanges.length ? { lostRangesMs: s.lostRanges } : {}),
    meanPointsAgreeing: s.meanInliers,
    ms: s.ms,
    ...(s.solve
      ? {
          camera: {
            focalPx: Math.round(s.solve.f * 10) / 10,
            horizontalFovDeg: Math.round(s.solve.hfovDeg * 10) / 10,
            reprojectionRmsPx: Math.round(s.solve.rmsPx * 1000) / 1000,
            framesSolved: s.solve.registered,
            points: s.solve.points,
            planeFit: `${s.solve.planeInliers} of ${s.solve.planePoints} points inside the region lie on the plane (rms ${Math.round(s.solve.planeRms * 10000) / 10000} scene units)`,
            solveFromCache: s.solve.cached,
          },
        }
      : {}),
  };
}
const trackWarnings = (id: string, d: import('@studio/engines').TrackData): string[] => {
  const w: string[] = [];
  if (d.stats.lost > 0) w.push(`tracker ${id} lost the region in ${d.stats.lost} of ${d.frames} frames (${d.stats.lostRanges.map((r) => `${r[0]}–${r[1]} ms`).join(', ')}); those frames are interpolated, so check them with studio track preview ${id}`);
  if (d.stats.solve && d.stats.solve.rmsPx > 1.5) w.push(`tracker ${id}: the camera solve reprojects with ${d.stats.solve.rmsPx.toFixed(2)} px error, which is loose; the scene may move, or the lens may be strongly distorted`);
  if (d.stats.meanInliers < 12 && !d.stats.solve) w.push(`tracker ${id}: only ${d.stats.meanInliers} feature points agreed on average; the region may lack texture (flat colour or very blurry), so the result is less certain`);
  return w;
};

async function build(inv: Invocation, project: Project, id: string, force = false) {
  const E = await engines();
  const t0 = Date.now();
  const r = await E.buildTrack({ projectDir: inv.dir, project, id, force, log: inv.log });
  return { ...r, wallMs: Date.now() - t0 };
}

// ----- commands --------------------------------------------------------------------------------------------------------------

export const add: Handler = async (inv) => {
  const { project } = store(inv).load();
  const a = videoAsset(project, str(inv, 'asset'));
  const dur = a.probe.durMs ?? 0;
  const from = Math.round(num(inv, 'from') ?? 0);
  const to = Math.round(num(inv, 'to') ?? dur);
  const at = Math.round(num(inv, 'at') ?? from);
  const quad = regionOf(inv) ?? inset(0.06);
  const tracker = parsed({
    asset: str(inv, 'asset'),
    from,
    to,
    at,
    quad: asNum(quad),
    model: str(inv, 'model') ?? 'homography',
    ...(inv.flags['no-refine'] ? { refine: false } : { refine: true }),
    ...(num(inv, 'focal-deg') !== undefined ? { focal: num(inv, 'focal-deg') } : {}),
    ...(inv.flags['fix-focal'] ? { fixFocal: true } : {}),
    ...(num(inv, 'fps') !== undefined ? { fps: num(inv, 'fps') } : {}),
    ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width') } : {}),
    ...(str(inv, 'label') ? { label: str(inv, 'label') } : {}),
  });
  const id = makeId('tk', new Set(Object.keys(project.trackers ?? {})), cryptoRng());
  const ahead = { ...project, trackers: { ...(project.trackers ?? {}), [id]: tracker } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'tracker.add', args: { id, tracker } }], `track add ${tracker.asset}`);
  return {
    ...r,
    data: { ...(r.data as object), tracker: id, definition: tracker, ...(built ? { track: summary(built.data), wallMs: built.wallMs } : { track: 'not built (studio track build ' + id + ')' }) },
    ...(built ? { warnings: trackWarnings(id, built.data) } : {}),
  };
}

export const buildCmd: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = refOf(project, inv.positionals[0] ?? str(inv, 'tracker'));
  const r = await build(inv, project, id, inv.force);
  return { data: { tracker: id, cached: r.cached, track: summary(r.data), wallMs: r.wallMs }, warnings: trackWarnings(id, r.data) };
};

export const list: Handler = async (inv) => {
  const { project } = store(inv).load();
  const E = await engines();
  const rows = Object.entries(project.trackers ?? {}).map(([id, t]) => {
    const d = E.loadTrack(inv.dir, project, id);
    return {
      id,
      asset: t.asset,
      rangeMs: [t.from, t.to],
      referenceMs: t.at,
      model: t.model,
      refine: t.refine !== false,
      ...(t.label ? { label: t.label } : {}),
      analysed: !!d,
      ...(d ? { track: summary(d) } : { next: `studio track build ${id}` }),
      usedBy: usedBy(project, id),
    };
  });
  return { data: { trackers: rows } };
};

export const show: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = refOf(project, inv.positionals[0] ?? str(inv, 'tracker'));
  const E = await engines();
  const d = E.loadTrack(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `tracker ${id} has not been analysed`, 2, `studio track build ${id}`);
  const t = project.trackers![id]!;
  const every = Math.max(1, Math.round(num(inv, 'every') ?? d.frames / 12));
  const path = E.pathOf(d);
  const samples = [];
  for (let i = 0; i < d.frames; i += every) {
    const q = E.quadAt(d, d.fromMs + (i * 1000) / d.fps, t.quad as never, path);
    samples.push({ frame: i, ms: Math.round(d.fromMs + (i * 1000) / d.fps), state: d.state[i] === 'r' ? 'aligned' : d.state[i] === 'f' ? 'points' : 'lost', corners: q.map((p) => p.map((v) => Math.round(v * 10000) / 10000)) });
  }
  return { data: { tracker: id, definition: t, track: summary(d), samples, note: 'corners are fractions of the frame, clockwise from the top left, where the tracked region is in that frame' } };
};

export const set: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = refOf(project, inv.positionals[0] ?? str(inv, 'tracker'));
  const patch: Record<string, unknown> = {};
  const q = regionOf(inv);
  if (q) patch['quad'] = asNum(q);
  for (const k of ['from', 'to', 'at', 'fps', 'width'] as const) if (num(inv, k) !== undefined) patch[k] = Math.round(num(inv, k)!);
  if (str(inv, 'model')) patch['model'] = str(inv, 'model');
  if (inv.flags['no-refine']) patch['refine'] = false;
  if (inv.flags['refine']) patch['refine'] = true;
  if (str(inv, 'label')) patch['label'] = str(inv, 'label');
  if (num(inv, 'focal-deg') !== undefined) patch['focal'] = num(inv, 'focal-deg');
  if (inv.flags['fix-focal']) patch['fixFocal'] = true;
  if (!Object.keys(patch).length) throw new CliError('INVALID_ARGS', 'nothing to change: give --box/--quad, --from/--to/--at, --model, --refine/--no-refine, --fps, --width or --label', 2);
  const next = parsed({ ...project.trackers![id]!, ...patch });
  const ahead = { ...project, trackers: { ...project.trackers, [id]: next } } as Project;
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.flags['no-build'] && !inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [{ type: 'tracker.set', args: { id, patch } }], `track set ${id}`);
  return { ...r, data: { ...(r.data as object), tracker: id, ...(built ? { track: summary(built.data) } : {}) }, ...(built ? { warnings: trackWarnings(id, built.data) } : {}) };
};

export const remove: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = refOf(project, inv.positionals[0] ?? str(inv, 'tracker'));
  const used = usedBy(project, id);
  if (used.length) throw new CliError('INVALID_ARGS', `tracker ${id} is used by ${used.join(', ')}`, 2, `remove those stabilize or pin effects first: studio fx list --clip ${used[0]}`);
  return runSpecs(inv, [{ type: 'tracker.remove', args: { id } }], `track remove ${id}`);
};

export const preview: Handler = async (inv) => {
  const { project } = store(inv).load();
  const id = refOf(project, inv.positionals[0] ?? str(inv, 'tracker'));
  const E = await engines();
  const d = E.loadTrack(inv.dir, project, id);
  if (!d) throw new CliError('NOT_FOUND', `tracker ${id} has not been analysed`, 2, `studio track build ${id}`);
  const out = join(inv.dir, 'renders', `track-${id}.png`);
  const r = await E.trackSheet({ projectDir: inv.dir, project, id, data: d, out, count: num(inv, 'frames') });
  return { data: { file: `renders/track-${id}.png`, frames: r.frames, key: 'yellow = the reference frame; green = followed; red = lost (interpolated). Tiles read left to right, top to bottom.' }, artifacts: [{ kind: 'image', path: `renders/track-${id}.png` }] };
};

// ----- stabilize and pin -------------------------------------------------------------------------------------------------------

/** The source range a clip plays, in ms of its asset. */
export const playedRange = (c: Clip): [number, number] => [Math.round(c.srcIn ?? 0), Math.round((c.srcIn ?? 0) + c.dur * speedOf(c))];

export function newEntry(project: Project, clip: Clip, fx: Fx, at?: number) {
  const base = named(project, clip);
  const node = makeId('f', new Set([...takenNodes(project), ...(base.map(nodeOf).filter(Boolean) as string[])]), cryptoRng());
  const list = [...base];
  const entry = { ...fx, node } as Fx;
  if (at === undefined) list.push(entry);
  else list.splice(Math.max(0, Math.min(list.length, at)), 0, entry);
  return { list, node };
}

export const stabilize: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const aid = clip.asset!;
  const a = videoAsset(project, aid);
  const E = await engines();
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  let id = str(inv, 'tracker');
  let ahead = project;
  let tracker: Tracker;
  if (id) {
    tracker = project.trackers?.[refOf(project, id)]!;
    if (tracker.asset !== aid) throw new CliError('INVALID_ARGS', `tracker ${id} was made on ${tracker.asset}, this clip plays ${aid}`, 2);
  } else {
    const [from, to] = playedRange(clip);
    const region = regionOf(inv) ?? inset(0.05);
    tracker = parsed({
      asset: aid, from, to, at: from, quad: asNum(region), model: str(inv, 'model') ?? 'homography',
      // the camera path is what matters; a slow drift in it is smoothed away with the rest, so no reference alignment is needed
      refine: inv.flags['refine'] ? true : false,
      ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width') } : {}),
      label: `stabilize ${clip.id}`,
    });
    id = makeId('tk', new Set(Object.keys(project.trackers ?? {})), cryptoRng());
    ahead = { ...project, trackers: { ...(project.trackers ?? {}), [id]: tracker } } as Project;
    specs.push({ type: 'tracker.add', args: { id, tracker } });
  }
  if ((clip.fx ?? []).some((f) => f.type === 'stabilize' && !f.bypass)) throw new CliError('INVALID_ARGS', `clip ${clip.id} is already stabilized`, 2, `studio fx list --clip ${clip.id}; change it with studio fx set, or remove it first`);
  const fx: Fx = {
    type: 'stabilize',
    tracker: id,
    ...(num(inv, 'smooth') !== undefined ? { smooth: num(inv, 'smooth') } : {}),
    ...(inv.flags['lock'] ? { lock: true } : {}),
    ...(num(inv, 'max-zoom') !== undefined ? { maxZoom: num(inv, 'max-zoom') } : {}),
  };
  const { list, node } = newEntry(project, clip, fx, 0); // stabilize works on the source frames, so it leads the stack
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.dryRun) built = await build(inv, ahead, id);
  const plan = built ? E.stabilizePlan(built.data, fx as never) : undefined;
  const r = runSpecs(inv, [...specs, ...fxSpecs(clip, list)], `stabilize ${clip.id}`);
  const px = (v: number) => Math.round(v * (a.probe.w ?? 0) * 10) / 10;
  return {
    ...r,
    data: {
      ...(r.data as object),
      node,
      tracker: id,
      ...(built && plan
        ? {
            track: summary(built.data),
            plan: {
              zoom: Math.round(plan.zoom * 1000) / 1000,
              correctionKept: Math.round(plan.alpha * 100) / 100,
              pathMovedPx: px(plan.removed),
              mode: fx.type === 'stabilize' && fx.lock ? 'locked on the first frame' : `smoothed over ${(fx as { smooth?: number }).smooth ?? 0.6} s`,
            },
          }
        : {}),
      next: [`studio render --still <ms> --clip ... to look at frames`, `studio fx set --clip ${clip.id} --node ${node} --params '{"smooth":1.5}' to change how much shake is kept`, `studio fx bypass --clip ${clip.id} --node ${node} to compare`],
    },
    warnings: [
      ...(built ? trackWarnings(id, built.data) : []),
      ...(plan && plan.alpha < 0.999 ? [`the zoom limit (maxZoom ${(fx as { maxZoom?: number }).maxZoom ?? 1.25}) allowed only ${Math.round(plan.alpha * 100)}% of the correction; raise --max-zoom for a steadier picture with more cropped away`] : []),
    ],
  };
};

export const pin: Handler = async (inv) => {
  const { project, clip } = clipOf(inv);
  const aid = clip.asset!;
  videoAsset(project, aid);
  const pinAsset = str(inv, 'asset');
  if (!pinAsset || !project.assets[pinAsset]) throw new CliError('NOT_FOUND', `--asset must be an image or video already ingested (${pinAsset ?? 'missing'})`, 2, 'studio ingest <file>, then use its asset id');
  if (project.assets[pinAsset]!.kind === 'audio') throw new CliError('INVALID_ARGS', `${pinAsset} is audio; a pin needs an image or video`, 2);
  const specs: { type: string; args: Record<string, unknown> }[] = [];
  let id = str(inv, 'tracker');
  let ahead = project;
  if (id) {
    refOf(project, id);
    if (project.trackers![id]!.asset !== aid) throw new CliError('INVALID_ARGS', `tracker ${id} was made on ${project.trackers![id]!.asset}, this clip plays ${aid}`, 2);
  } else {
    const region = regionOf(inv);
    if (!region) throw new CliError('INVALID_ARGS', 'say where the plane is: --tracker tk_xxxx, or --box x,y,w,h / --quad x1,y1,...,x4,y4 (fractions of the frame, at the reference frame)', 2, 'studio track preview shows frames with a tracker drawn on them');
    const [from, to] = playedRange(clip);
    const tracker = parsed({
      asset: aid, from, to, at: Math.round(num(inv, 'at') ?? from), quad: asNum(region), model: str(inv, 'model') ?? 'homography', refine: !inv.flags['no-refine'],
      ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width') } : {}), label: `pin ${pinAsset}`,
    });
    id = makeId('tk', new Set(Object.keys(project.trackers ?? {})), cryptoRng());
    ahead = { ...project, trackers: { ...(project.trackers ?? {}), [id]: tracker } } as Project;
    specs.push({ type: 'tracker.add', args: { id, tracker } });
  }
  const place = regionOf(inv, 'place', 'place-quad');
  const op = num(inv, 'opacity');
  const fx: Fx = { type: 'pin', tracker: id, asset: pinAsset, ...(place ? { quad: asNum(place) } : {}), ...(op !== undefined && op !== 1 ? { opacity: op } : {}) };
  const { list, node } = newEntry(project, clip, fx);
  let built: Awaited<ReturnType<typeof build>> | undefined;
  if (!inv.dryRun) built = await build(inv, ahead, id);
  const r = runSpecs(inv, [...specs, ...fxSpecs(clip, list)], `pin ${pinAsset}`);
  return {
    ...r,
    data: {
      ...(r.data as object), node, tracker: id, ...(built ? { track: summary(built.data) } : {}),
      next: [`studio track preview ${id}   (look at the tracked region on frames across the clip)`, `studio render --still <ms> --out check`, `studio fx set --clip ${clip.id} --node ${node} --params '{"opacity":0.8}'`],
    },
    ...(built ? { warnings: trackWarnings(id, built.data) } : {}),
  };
};

void label;

// ----- the camera solve itself --------------------------------------------------------------------------------------------------

/** Where an output file may go: inside the project folder. */
function inside(inv: Invocation, rel: string): string {
  const path = join(inv.dir, rel);
  if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) throw new CliError('INVALID_ARGS', '--out must be a path inside the project folder', 2, 'e.g. --out renders/camera.json');
  return path;
}

export const solve: Handler = async (inv) => {
  const { project } = store(inv).load();
  const E = await engines();
  const aid = str(inv, 'asset');
  const a = videoAsset(project, aid);
  const from = Math.round(num(inv, 'from') ?? 0);
  const to = Math.round(num(inv, 'to') ?? a.probe.durMs ?? 0);
  const info = { w: a.probe.w ?? 480, h: a.probe.h ?? 270, fps: a.probe.fps ?? 30 };
  const fps = num(inv, 'fps') ?? Math.min(30, Math.round(info.fps * 100) / 100);
  const width = Math.round(num(inv, 'width') ?? Math.min(480, info.w));
  const file = a.workingCopy?.path ?? a.path;
  const t0 = Date.now();
  const r = await E.ensureSolve({
    projectDir: inv.dir, file, assetHash: a.hash, fromMs: from, toMs: to, fps, width,
    ...(num(inv, 'focal-deg') !== undefined ? { focalDeg: num(inv, 'focal-deg') } : {}), fixFocal: !!inv.flags['fix-focal'], log: inv.log, force: inv.force,
  });
  const s = r.solve;
  const artifacts: { kind: string; path: string }[] = [];
  let exported: string | undefined;
  const out = str(inv, 'out');
  if (out) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const p = inside(inv, out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(E.cameraExport(s), null, 1));
    exported = out;
    artifacts.push({ kind: 'camera', path: out });
  }
  let sheet: Awaited<ReturnType<typeof E.solveSheet>> | undefined;
  if (inv.flags['preview']) {
    const rel = `renders/solve-${s.key.slice(0, 8)}.png`;
    sheet = await E.solveSheet({ projectDir: inv.dir, file, solve: s, out: join(inv.dir, rel), count: num(inv, 'frames') });
    artifacts.push({ kind: 'image', path: rel });
  }
  const solved = [...s.how].filter((c) => c === 'b' || c === 'r').length;
  const warnings: string[] = [];
  if (s.stats.rmsPx > 1.5) warnings.push(`the solve reprojects with ${s.stats.rmsPx.toFixed(2)} px error, which is loose; the scene may move, or the lens may be strongly distorted`);
  if (solved < s.frames * 0.9) warnings.push(`only ${solved} of ${s.frames} frames were placed by the solver; the rest are interpolated or held`);
  if (!s.fixedFocal && Math.abs(s.f - s.fInit) / s.fInit > 0.35) warnings.push(`the focal length moved far from its starting value (${s.fInit.toFixed(0)} to ${s.f.toFixed(0)} px); if you know the lens, give --focal-deg and --fix-focal`);
  return {
    data: {
      asset: aid,
      rangeMs: [from, to],
      analysis: `${s.w}x${s.h} at ${s.fps} fps, ${s.frames} frames`,
      camera: {
        focalPx: Math.round(s.f * 10) / 10,
        horizontalFovDeg: Math.round(s.stats.hfovDeg * 10) / 10,
        focalWasFixed: s.fixedFocal,
        startedAtPx: Math.round(s.fInit * 10) / 10,
      },
      quality: {
        framesSolved: solved,
        frames: s.frames,
        points: s.stats.points,
        featureTracks: s.stats.tracks,
        reprojectionRmsPx: Math.round(s.stats.rmsPx * 1000) / 1000,
        reprojectionMedianPx: Math.round(s.stats.medianPx * 1000) / 1000,
        reprojection95thPx: Math.round(s.stats.p95Px * 100) / 100,
        firstPair: { frames: s.stats.initPair, parallaxDeg: Math.round(s.stats.initAngleDeg * 10) / 10 },
      },
      cached: r.cached,
      wallMs: Date.now() - t0,
      ...(exported ? { exported, exportFormat: 'studio-camera-solve/1: per-frame camera position and rotation (camera-to-world quaternion), the focal length in pixels and the point cloud; x right, y down, z forward; unitless scale' } : {}),
      ...(sheet ? { preview: { file: sheet.file.replace(inv.dir + '/', ''), frames: sheet.frames, key: 'crosses are the solved 3D points where the camera says they are: green < 0.6 px from where they were tracked, yellow < 1.2, red more' } } : {}),
      next: [`studio track add --asset ${aid} --model plane3d --quad ... --at MS   (follow a flat surface through the solved camera)`],
    },
    artifacts,
    ...(warnings.length ? { warnings } : {}),
  };
};
