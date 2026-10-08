import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  ProjectStore,
  displaySize,
  parseEvents,
  planZoom,
  speedOf,
  toSrt,
  toVtt,
  type DemoEvent,
  type OpSpec,
  type Project,
  type ZoomPlan,
} from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { must, num, selfRun, store, str } from './shared.js';

const rel = (inv: Invocation, p: string) =>
  p.startsWith(inv.dir + '/') ? p.slice(inv.dir.length + 1) : p;
const slug = (s: string) =>
  s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'demo';

interface DemoMeta {
  name: string;
  recording: string;
  events?: string;
  vo?: string;
  music?: string;
  logo?: string;
  privacy: {
    sheets: string[];
    findings: { kind: string; where: string; text: string }[];
    ocr: false;
    textScan: string[];
  };
}
const metaPath = (inv: Invocation, name: string) => join(inv.dir, 'demo', name, 'demo.json');
function loadMeta(inv: Invocation, name: string | undefined): DemoMeta {
  const names = existsSync(join(inv.dir, 'demo'))
    ? (readdirSyncSafe(join(inv.dir, 'demo')) as string[])
    : [];
  const n = name ?? (names.length === 1 ? names[0] : undefined);
  if (!n)
    throw new CliError(
      'INVALID_ARGS',
      `give --name (known demos: ${names.join(', ') || 'none; run studio demo ingest'})`,
    );
  const f = metaPath(inv, n);
  if (!existsSync(f))
    throw new CliError(
      'INVALID_ARGS',
      `no demo "${n}" in this project`,
      2,
      'studio demo ingest <recording> --name N',
    );
  return JSON.parse(readFileSync(f, 'utf8'));
}
import { readdirSync } from 'node:fs';
const readdirSyncSafe = (d: string) =>
  readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

// ---------------------------------------------------------------------------------------------
export const ingest: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const recording = inv.positionals[0];
  if (!recording)
    throw new CliError(
      'INVALID_ARGS',
      'name the screen recording',
      2,
      'studio demo ingest <recording> [--events events.jsonl] [--vo f] [--music f] [--logo f] --name N',
    );
  const name = slug(str(inv, 'name') ?? basename(recording).replace(/\.[^.]+$/, ''));
  const files = [
    recording,
    ...['vo', 'music', 'logo'].map((k) => str(inv, k)).filter(Boolean),
  ] as string[];
  if (inv.dryRun) return { data: { wouldIngest: files, name } };
  const ing = await must(inv.dir, ['ingest', ...files], inv.log);
  const rows: { path: string; id: string; kind: string }[] = ing.data.ingested.map((r: any) => ({
    path: r.path,
    id: r.id ?? '',
    kind: r.kind,
  }));
  const { project } = store(inv).load();
  const idOf = (path: string) => {
    const hash = ing.data.ingested.find((r: any) => r.path === path)?.hash;
    return (
      Object.entries(project.assets).find(([, a]) => a.hash === hash)?.[0] ??
      rows.find((r) => r.path === path)?.id ??
      ''
    );
  };
  const recId = idOf(recording);
  const rec = project.assets[recId];
  if (!rec || rec.kind !== 'video')
    throw new CliError('UNSUPPORTED_INPUT', `${recording} is not a video`);
  const d = displaySize(rec.probe);
  const dur = rec.probe.durMs ?? 0;
  const warnings: string[] = [];
  if (Math.min(d.w ?? 0, d.h ?? 0) < 1080)
    warnings.push(
      `effective resolution is ${d.w}x${d.h}; a 1440p or higher recording zooms more sharply`,
    );
  if (rec.probe.vfr || rec.workingCopy)
    warnings.push(
      `variable frame rate: a constant-frame-rate working copy is used (${rec.workingCopy?.path ?? 'none'})`,
    );
  let eventsRel: string | undefined;
  let evReport: ReturnType<typeof parseEvents> | undefined;
  const dir = join(inv.dir, 'demo', name);
  mkdirSync(dir, { recursive: true });
  const evPath = str(inv, 'events');
  if (evPath) {
    if (!existsSync(evPath))
      throw new CliError('INVALID_ARGS', `events file ${evPath} does not exist`);
    evReport = parseEvents(readFileSync(evPath, 'utf8'), { w: d.w!, h: d.h! }, dur);
    if (!evReport.events.some((e) => e.type === 'click'))
      warnings.push('events file has no clicks, so autozoom has nothing to follow');
    if (evReport.problems.length)
      throw new CliError(
        'UNSUPPORTED_INPUT',
        `${evReport.problems.length} problem(s) in ${evPath}: ${evReport.problems.slice(0, 3).join('; ')}`,
        2,
        'fix the events file (recording pixels, ms from start) and rerun',
        { problems: evReport.problems },
      );
    eventsRel = join('demo', name, 'events.jsonl');
    writeFileSync(
      join(inv.dir, eventsRel),
      evReport.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  } else
    warnings.push(
      'no events.jsonl: there is no cursor data, so no click-driven zoom is possible. Plan zooms from inspected frames and the transcript instead; pixel cursor tracking is not provided',
    );
  // Privacy scan, step 1 and 2: contact sheets to view, and a text scan of what we have. No OCR is installed.
  const src = join(inv.dir, rec.workingCopy?.path ?? rec.path);
  const sheetsDir = join(dir, 'privacy');
  inv.log('privacy scan: building 1 fps contact sheets');
  const sheets = (await E.contactSheets(src, sheetsDir, dur)).map((s) => rel(inv, s));
  const targets = (evReport?.events ?? [])
    .filter((e) => e.target)
    .map((e) => ({ where: `event at ${e.t} ms`, text: e.target! }));
  const findings = E.scanText(targets);
  const meta: DemoMeta = {
    name,
    recording: recId,
    ...(eventsRel ? { events: eventsRel } : {}),
    ...(str(inv, 'vo') ? { vo: idOf(str(inv, 'vo')!) } : {}),
    ...(str(inv, 'music') ? { music: idOf(str(inv, 'music')!) } : {}),
    ...(str(inv, 'logo') ? { logo: assetPathOf(project, idOf(str(inv, 'logo')!)) } : {}),
    privacy: { sheets, findings, ocr: false, textScan: ['event target labels'] },
  };
  E.writeJson(metaPath(inv, name), meta);
  warnings.push(
    `privacy scan is NOT finished: view the ${sheets.length} contact sheet(s) in ${rel(inv, sheetsDir)} (30 s each, 5x6 tiles at 1 fps), then pass --privacy-reviewed to \`demo build\`. OCR is not installed, so pixels are not scanned automatically`,
  );
  if (findings.length)
    warnings.push(
      `${findings.length} possible secret(s) in event labels: ${findings
        .slice(0, 3)
        .map((f) => `${f.kind} "${f.text}"`)
        .join(', ')}`,
    );
  return {
    data: {
      name,
      recording: recId,
      effective: `${d.w}x${d.h}`,
      durationMs: dur,
      fps: rec.probe.fps,
      events: evReport ? { file: eventsRel, counts: evReport.counts } : null,
      assets: { vo: meta.vo ?? null, music: meta.music ?? null, logo: meta.logo ?? null },
      privacy: { sheets, textFindings: findings.length, ocr: 'not installed', reviewed: false },
    },
    warnings,
    artifacts: [{ kind: 'demo', path: rel(inv, metaPath(inv, name)) }],
  };
};
const assetPathOf = (p: Project, id: string) => p.assets[id]?.path ?? '';

// ---------------------------------------------------------------------------------------------
/** Where the recording sits on the canvas when fitted by width/height, as fractions of the canvas. */
export function placementFor(rec: { w: number; h: number }, canvas: { w: number; h: number }) {
  const k = Math.min(canvas.w / rec.w, canvas.h / rec.h);
  const w = (rec.w * k) / canvas.w;
  const h = (rec.h * k) / canvas.h;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function groupKfs(plan: ZoomPlan) {
  const keyframes: Record<string, { id: string; t: number; v: number; ease?: string }[]> = {};
  plan.keyframes.forEach((k, i) =>
    (keyframes[k.prop] ??= []).push({ id: `k_${i}`, t: k.t, v: k.v, ease: k.ease }),
  );
  return keyframes;
}

export const autozoom: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const clipId = str(inv, 'clip');
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.asset)
    throw new CliError(
      'INVALID_ARGS',
      `give --clip <media clip id> (got ${clipId ?? 'nothing'})`,
      2,
      'studio project show lists clips',
    );
  const evFile = str(inv, 'events');
  if (!evFile)
    throw new CliError(
      'INVALID_ARGS',
      'missing --events <events.jsonl>',
      2,
      'without cursor data there is nothing to follow; plan zooms from inspected frames with `studio tl keyframe`',
    );
  const asset = project.assets[clip.asset]!;
  const d = displaySize(asset.probe);
  const rep = parseEvents(
    readFileSync(resolve(inv.dir, evFile), 'utf8'),
    { w: d.w!, h: d.h! },
    asset.probe.durMs,
  );
  if (rep.problems.length)
    throw new CliError(
      'UNSUPPORTED_INPUT',
      `${rep.problems.length} problem(s) in ${evFile}: ${rep.problems[0]}`,
      2,
    );
  const speed = speedOf(clip);
  const a = clip.srcIn ?? 0;
  const b = a + Math.round(clip.dur * speed);
  const local: DemoEvent[] = rep.events
    .filter((e) => e.t >= a && e.t < b)
    .map((e) => ({ ...e, t: Math.round((e.t - a) / speed) }));
  const canvas = { w: project.meta.width, h: project.meta.height };
  const plan = planZoom(local, {
    frame: { w: d.w!, h: d.h! },
    clipDurMs: clip.dur,
    outWidth: num(inv, 'out-width') ?? canvas.w,
    boxFrac: num(inv, 'box-frac'),
    maxScale: num(inv, 'max-scale'),
    allowSoft: !!inv.flags['allow-soft'],
    strictSharp: !!inv.flags['strict-sharp'],
    placement: placementFor({ w: d.w!, h: d.h! }, canvas),
  });
  const existing = Object.values(clip.keyframes ?? {}).flat();
  const specs: OpSpec[] = [
    ...existing.map((k) => ({ type: 'kf.delete', args: { clip: clip.id, id: k.id } }) as OpSpec),
    ...plan.keyframes.map(
      (k) =>
        ({
          type: 'kf.set',
          args: { clip: clip.id, prop: k.prop, t: k.t, v: k.v, ease: k.ease },
        }) as OpSpec,
    ),
  ];
  const list = plan.steps.map((s) => ({
    kind: s.kind,
    fromMs: s.startMs,
    toMs: s.endMs,
    scale: s.scale,
    focus: [s.cx, s.cy],
    events: s.events,
    cropPx: Math.round(d.w! / s.scale),
  }));
  const warnings = [
    ...plan.notes,
    ...plan.skipped.map((s) => `skipped near ${s.atMs} ms: ${s.reason}`),
    ...(plan.soft
      ? [
          `effective resolution at max zoom is ${plan.cropPx} source px across a ${canvas.w} px output: soft (upscaled ${(canvas.w / plan.cropPx).toFixed(2)}x)`,
        ]
      : []),
    `${local.filter((e) => e.type === 'click').length} click(s) in range, ${plan.clusters} target(s); keyframes are ordinary and editable: studio tl keyframe, or undo with studio project undo`,
  ];
  if (!plan.steps.length)
    return {
      data: { clip: clip.id, zooms: [], clusters: plan.clusters, applied: false },
      warnings: [...warnings, 'no zoom was applied'],
    };
  if (inv.dryRun)
    return { data: { clip: clip.id, zooms: list, wouldSet: plan.keyframes.length }, warnings };
  const step = store(inv).apply(specs, {
    actor: inv.actor,
    label: `autozoom ${clip.id}`,
    dryRun: false,
  });
  return {
    data: {
      clip: clip.id,
      zooms: list,
      maxScale: plan.maxScale,
      cropPx: plan.cropPx,
      soft: plan.soft,
      keyframes: plan.keyframes.length,
      txn: step.entry.id,
      applied: true,
    },
    warnings,
    artifacts: [{ kind: 'project', path: 'project.studio.json' }],
  };
};

// ---------------------------------------------------------------------------------------------
interface Beat {
  id: string;
  name: string;
  srcStartMs: number;
  srcEndMs: number;
}
interface BuildPlan {
  beats?: Beat[];
  intro?: { title: string; subtitle?: string };
  outro?: { title: string; cta?: string };
  lowerThird?: { title: string; subtitle?: string; beat?: string; atMs?: number; durMs?: number };
  callouts?: {
    srcMs: number;
    durMs?: number;
    box: { x: number; y: number; w: number; h: number };
    label: string;
    labelPos?: 'above' | 'below';
  }[];
  /** ramp low-activity spans longer than 1 s to this speed (4..8) */
  rampSpeed?: number;
  /** ms of a removed still span that stays on each side */
  keepMs?: number;
}
interface Seg {
  beat: string;
  srcStart: number;
  srcEnd: number;
  speed: number;
  tlStart: number;
  dur: number;
  id: string;
}

const ASPECTS = {
  '16x9': {
    w: 1920,
    h: 1080,
    preset: 'youtube-1080p',
    boxFrac: 0.5,
    maxScale: 2.2,
    caption: { style: 'clean', extra: [] as string[] },
    layout: 'horizontal',
  },
  '9x16': {
    w: 1080,
    h: 1920,
    preset: 'vertical-1080x1920',
    boxFrac: 0.4,
    maxScale: 2.6,
    caption: { style: 'social', extra: ['--words-per-cue', '3'] },
    layout: 'vertical',
  },
  '1x1': {
    w: 1080,
    h: 1080,
    preset: 'square-1080',
    boxFrac: 0.45,
    maxScale: 2.4,
    caption: { style: 'social', extra: ['--words-per-cue', '3'] },
    layout: 'horizontal',
  },
} as const;
type AspectKey = keyof typeof ASPECTS;

const subtract = (a: number, b: number, cuts: [number, number][]) => {
  let out: [number, number][] = [[a, b]];
  for (const [c0, c1] of cuts)
    out = out.flatMap(([s, e]) =>
      c1 <= s || c0 >= e
        ? [[s, e] as [number, number]]
        : (
            [
              [s, Math.max(s, c0)],
              [Math.min(e, c1), e],
            ] as [number, number][]
          ).filter((q) => q[1] > q[0]),
    );
  return out;
};

/** Beats -> segments: still spans cut (keeping a little), low-activity spans ramped, everything else at 1x. */
export function planSegments(
  beats: Beat[],
  spans: { still: { startMs: number; endMs: number }[]; low: { startMs: number; endMs: number }[] },
  o: { keepMs: number; rampSpeed: number; startAt: number },
) {
  const segs: Seg[] = [];
  let at = o.startAt;
  let n = 0;
  const cutMs: { beat: string; ms: number }[] = [];
  for (const beat of beats) {
    const cuts = spans.still
      .map((s) => [s.startMs + o.keepMs, s.endMs - o.keepMs] as [number, number])
      .filter(([x, y]) => y - x > 0);
    const pieces = subtract(beat.srcStartMs, beat.srcEndMs, cuts);
    const removed = beat.srcEndMs - beat.srcStartMs - pieces.reduce((s, [x, y]) => s + (y - x), 0);
    cutMs.push({ beat: beat.id, ms: removed });
    for (const [s, e] of pieces) {
      // split the piece at low-activity spans
      const bounds: [number, number, number][] = [];
      let cur = s;
      for (const l of spans.low) {
        const ls = Math.max(l.startMs, s);
        const le = Math.min(l.endMs, e);
        if (le - ls < 1000) continue;
        if (ls > cur) bounds.push([cur, ls, 1]);
        bounds.push([ls, le, o.rampSpeed]);
        cur = le;
      }
      if (cur < e) bounds.push([cur, e, 1]);
      for (const [x, y, sp] of bounds) {
        const dur = Math.floor((y - x) / sp);
        if (dur < 100) continue;
        segs.push({
          beat: beat.id,
          srcStart: x,
          srcEnd: x + dur * sp,
          speed: sp,
          tlStart: at,
          dur,
          id: `c_v${String(++n).padStart(2, '0')}`,
        });
        at += dur;
      }
    }
  }
  return { segs, end: at, cutMs };
}

const mapSrc = (segs: Seg[], t: number) => {
  const s = segs.find((x) => t >= x.srcStart && t < x.srcEnd);
  return s
    ? { seg: s, tl: s.tlStart + (t - s.srcStart) / s.speed, local: (t - s.srcStart) / s.speed }
    : undefined;
};

export const build: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const meta = loadMeta(inv, str(inv, 'name'));
  const name = meta.name;
  if (!inv.flags['privacy-reviewed'])
    throw new CliError(
      'PRIVACY_NOT_REVIEWED',
      `the privacy scan is not finished for "${name}": nobody has said the contact sheets were viewed`,
      4,
      `view the sheets in demo/${name}/privacy (30 s each), blur or crop anything private (an fx of type blur-region), then rerun with --privacy-reviewed`,
      { sheets: meta.privacy.sheets, textFindings: meta.privacy.findings },
    );
  const planFile = str(inv, 'plan');
  const plan: BuildPlan = planFile
    ? JSON.parse(readFileSync(resolve(inv.dir, planFile), 'utf8'))
    : {};
  const { project: master } = store(inv).load();
  const rec = master.assets[meta.recording];
  if (!rec) throw new CliError('INVALID_ARGS', `recording ${meta.recording} is not in the project`);
  const d = displaySize(rec.probe);
  const recSrc = join(inv.dir, rec.workingCopy?.path ?? rec.path);
  const fps = Math.round(rec.probe.fps ?? 30);
  const beats: Beat[] = plan.beats ?? [
    { id: 'all', name: 'Everything', srcStartMs: 0, srcEndMs: rec.probe.durMs! },
  ];
  const warnings: string[] = [];
  for (const b of beats)
    if (!(b.srcEndMs > b.srcStartMs) || b.srcEndMs > (rec.probe.durMs ?? 0) + 1)
      throw new CliError(
        'INVALID_ARGS',
        `beat ${b.id}: ${b.srcStartMs}-${b.srcEndMs} ms is outside the ${rec.probe.durMs} ms recording`,
      );
  // Dead time: frame-difference activity of the whole recording.
  inv.log('analysing screen activity');
  const prof = await E.activityProfile(recSrc);
  const spans = E.activitySpans(prof);
  const intro = plan.intro ? 2800 : 0;
  const outroMs = plan.outro ? 3200 : 0;
  const {
    segs,
    end: bodyEnd,
    cutMs,
  } = planSegments(beats, spans, {
    keepMs: plan.keepMs ?? 300,
    rampSpeed: plan.rampSpeed ?? 6,
    startAt: intro,
  });
  const total = bodyEnd + outroMs;
  if (total < 60_000 || total > 90_000)
    warnings.push(
      `the demo is ${(total / 1000).toFixed(1)} s; a feature demo is 60-90 s (15-30 s for a social cut). Change the beats in the plan`,
    );
  const events = meta.events
    ? parseEvents(readFileSync(join(inv.dir, meta.events), 'utf8'), { w: d.w!, h: d.h! }).events
    : [];
  // Transcribe the VO once; every aspect reuses it.
  let transcriptAbs: string | undefined;
  if (meta.vo) {
    const t = await must(
      inv.dir,
      ['transcribe', meta.vo, '--model', str(inv, 'model') ?? 'whisper-small', '--force'],
      inv.log,
    );
    transcriptAbs = join(inv.dir, t.data.transcript);
    warnings.push(...(t.warnings ?? []).filter((w: string) => /review|no detected speech/.test(w)));
  }
  const outDir = join(inv.dir, `demo-${name}`);
  mkdirSync(outDir, { recursive: true });
  const wanted = (str(inv, 'aspects') ?? '16x9,9x16,1x1').split(',') as AspectKey[];
  for (const a of wanted)
    if (!ASPECTS[a]) throw new CliError('INVALID_ARGS', `unknown aspect ${a}; use 16x9, 9x16, 1x1`);
  const { palette } = E.loadPalette(inv.dir);
  const results: Record<string, any> = {};
  for (const key of wanted) {
    const A = ASPECTS[key];
    inv.log(`== ${key} (${A.w}x${A.h})`);
    const vdir = join(inv.dir, 'variants', name, key);
    rmSync(vdir, { recursive: true, force: true });
    mkdirSync(dirname(vdir), { recursive: true });
    const vs = ProjectStore.init(
      vdir,
      {
        name: `demo-${name}-${key}`,
        width: A.w,
        height: A.h,
        fps,
        background: palette.colors['bg']!.slice(0, 7),
      },
      true,
    );
    rmSync(join(vdir, 'assets'), { recursive: true, force: true });
    rmSync(join(vdir, '.studio', 'cache'), { recursive: true, force: true });
    symlinkSync(relative(vdir, join(inv.dir, 'assets')), join(vdir, 'assets'));
    symlinkSync(
      relative(join(vdir, '.studio'), join(inv.dir, '.studio', 'cache')),
      join(vdir, '.studio', 'cache'),
    );
    if (meta.logo) {
      mkdirSync(join(vdir, 'brand'), { recursive: true });
    }
    const place = placementFor({ w: d.w!, h: d.h! }, { w: A.w, h: A.h });
    const specs: OpSpec[] = [];
    const used = [meta.recording, meta.vo, meta.music].filter(Boolean) as string[];
    for (const id of used)
      specs.push({ type: 'asset.add', args: { id, asset: master.assets[id]! } } as OpSpec);
    specs.push(
      { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } } as OpSpec,
      { type: 'track.add', args: { id: 't_vo', type: 'audio', name: 'VO' } } as OpSpec,
      { type: 'track.add', args: { id: 't_mu', type: 'audio', name: 'Music' } } as OpSpec,
      { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } } as OpSpec,
    );
    if (meta.vo && rec.probe.audio)
      specs.push({ type: 'track.set', args: { id: 't_v1', patch: { muted: true } } } as OpSpec);
    const info = {
      zooms: [] as any[],
      maxScale: 1,
      cropPx: d.w!,
      soft: false,
      notes: [] as string[],
      rings: 0,
      callouts: 0,
      badges: 0,
    };
    const rings: { t: number; x: number; y: number }[] = [];
    const zoomOf: Record<string, ZoomPlan> = {};
    for (const s of segs) {
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: s.id,
            track: 't_v1',
            asset: meta.recording,
            start: s.tlStart,
            dur: s.dur,
            srcIn: s.srcStart,
            ...(s.speed !== 1 ? { fx: [{ type: 'speed', factor: s.speed }] } : {}),
          },
        },
      } as OpSpec);
      if (s.speed !== 1) continue;
      const local = events
        .filter((e) => e.t >= s.srcStart && e.t < s.srcEnd)
        .map((e) => ({ ...e, t: e.t - s.srcStart }));
      const z = planZoom(local, {
        frame: { w: d.w!, h: d.h! },
        clipDurMs: s.dur,
        outWidth: A.w,
        boxFrac: A.boxFrac,
        maxScale: A.maxScale,
        placement: place,
        allowSoft: !!inv.flags['allow-soft'],
      });
      zoomOf[s.id] = z;
      for (const k of z.keyframes)
        specs.push({
          type: 'kf.set',
          args: { clip: s.id, prop: k.prop, t: k.t, v: k.v, ease: k.ease },
        } as OpSpec);
      for (const st of z.steps)
        info.zooms.push({
          atMs: s.tlStart + st.startMs,
          kind: st.kind,
          scale: st.scale,
          clip: s.id,
        });
      info.maxScale = Math.max(info.maxScale, z.maxScale);
      info.notes.push(...z.notes);
      if (z.steps.length) {
        info.cropPx = Math.min(info.cropPx, z.cropPx);
        info.soft ||= z.soft;
      }
    }
    // canvas position of a recording point at clip-local time t, through the planned zoom
    const toCanvas = (segId: string, localMs: number, rx: number, ry: number) => {
      const z = zoomOf[segId];
      const cx = place.x + (rx / d.w!) * place.w;
      const cy = place.y + (ry / d.h!) * place.h;
      if (!z?.steps.length) return { x: cx, y: cy };
      const clipLike: any = { id: segId, keyframes: groupKf(z) };
      const s = E.valueAt(E.propPoints(clipLike, 'scale', 1), localMs / 1000);
      const fx0 = E.valueAt(E.propPoints(clipLike, 'x', 0.5), localMs / 1000);
      const fy0 = E.valueAt(E.propPoints(clipLike, 'y', 0.5), localMs / 1000);
      const fx = Math.min(Math.max(fx0, 0.5 / s), 1 - 0.5 / s);
      const fy = Math.min(Math.max(fy0, 0.5 / s), 1 - 0.5 / s);
      return { x: (cx - fx) * s + 0.5, y: (cy - fy) * s + 0.5 };
    };
    for (const e of events) {
      if (e.type !== 'click') continue;
      const m = mapSrc(segs, e.t);
      if (!m || m.seg.speed !== 1) continue;
      const p = toCanvas(m.seg.id, m.local, e.x!, e.y!);
      if (p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98)
        rings.push({
          t: Math.round(m.tl),
          x: Math.round(p.x * 1e4) / 1e4,
          y: Math.round(p.y * 1e4) / 1e4,
        });
    }
    if (rings.length) {
      const t0 = rings[0]!.t;
      const t1 = rings[rings.length - 1]!.t + 700;
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_ring',
            track: 't_g1',
            comp: 'cursor-highlight',
            start: t0,
            dur: t1 - t0,
            props: { clicks: rings.map((r) => ({ ...r, t: r.t - t0 })) },
          },
        },
      } as OpSpec);
      info.rings = rings.length;
    }
    let ci = 0;
    for (const c of plan.callouts ?? []) {
      const m = mapSrc(segs, c.srcMs);
      if (!m || m.seg.speed !== 1) {
        warnings.push(
          `callout "${c.label}" at ${c.srcMs} ms falls in a cut or sped-up span; skipped`,
        );
        continue;
      }
      const p0 = toCanvas(m.seg.id, m.local, c.box.x * d.w!, c.box.y * d.h!);
      const p1 = toCanvas(
        m.seg.id,
        m.local,
        (c.box.x + c.box.w) * d.w!,
        (c.box.y + c.box.h) * d.h!,
      );
      const box = { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
      if (box.x < 0 || box.y < 0 || box.x + box.w > 1 || box.y + box.h > 1 || box.w <= 0) {
        warnings.push(
          `callout "${c.label}" at ${c.srcMs} ms is not fully on screen at that moment (${A.w}x${A.h}); skipped`,
        );
        continue;
      }
      const dur = Math.min(c.durMs ?? 3000, m.seg.tlStart + m.seg.dur - m.tl);
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: `c_co${++ci}`,
            track: 't_g1',
            comp: 'callout',
            start: Math.round(m.tl),
            dur,
            props: {
              box,
              label: c.label,
              layout: A.layout,
              ...(c.labelPos ? { labelPos: c.labelPos } : {}),
            },
          },
        },
      } as OpSpec);
      info.callouts++;
    }
    for (const s of segs.filter((x) => x.speed !== 1 && x.dur >= 800))
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: `c_sb${++info.badges}`,
            track: 't_g1',
            comp: 'speed-badge',
            start: s.tlStart,
            dur: s.dur,
            props: { label: `${s.speed}x` },
          },
        },
      } as OpSpec);
    if (plan.intro)
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_intro',
            track: 't_g1',
            comp: 'intro',
            start: 0,
            dur: intro,
            props: { ...plan.intro, ...(meta.logo ? { logo: meta.logo } : {}) },
          },
        },
      } as OpSpec);
    if (plan.outro)
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_outro',
            track: 't_g1',
            comp: 'outro',
            start: bodyEnd,
            dur: outroMs,
            props: { ...plan.outro, ...(meta.logo ? { logo: meta.logo } : {}) },
          },
        },
      } as OpSpec);
    if (plan.lowerThird) {
      const lt = plan.lowerThird;
      const first = segs.find((s) => !lt.beat || s.beat === lt.beat);
      if (first)
        specs.push({
          type: 'clip.add',
          args: {
            clip: {
              id: 'c_lt',
              track: 't_g1',
              comp: 'lower-third',
              start: first.tlStart + (lt.atMs ?? 600),
              dur: lt.durMs ?? 4000,
              props: { title: lt.title, ...(lt.subtitle ? { subtitle: lt.subtitle } : {}) },
            },
          },
        } as OpSpec);
    }
    if (meta.vo) {
      const vo = master.assets[meta.vo]!;
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_vo',
            track: 't_vo',
            asset: meta.vo,
            start: intro,
            dur: Math.min(vo.probe.durMs!, total - intro),
          },
        },
      } as OpSpec);
    }
    if (meta.music) {
      const mu = master.assets[meta.music]!;
      specs.push({
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_mu',
            track: 't_mu',
            asset: meta.music,
            start: 0,
            dur: Math.min(mu.probe.durMs!, total),
          },
        },
      } as OpSpec);
      if (mu.probe.durMs! < total)
        warnings.push(
          `music is ${(mu.probe.durMs! / 1000).toFixed(1)} s, shorter than the ${(total / 1000).toFixed(1)} s demo; it ends early`,
        );
    }
    vs.apply(specs, { actor: 'agent', label: `demo build ${name} ${key}` });
    // audio chain and captions through the normal commands, so each is an op in the variant's log
    if (meta.vo) await must(vdir, ['audio', 'clean-podcast', '--clip', 'c_vo'], inv.log);
    if (meta.vo && meta.music)
      await must(vdir, ['audio', 'duck', '--clip', 'c_mu', '--by', 't_vo'], inv.log);
    if (transcriptAbs) {
      const cues = `captions/${name}-${key}.cues.json`;
      await must(
        vdir,
        [
          'captions',
          'build',
          '--transcript',
          transcriptAbs,
          '--clip',
          'c_vo',
          '--style',
          A.caption.style,
          ...A.caption.extra,
          '--out',
          cues,
          '--force',
        ],
        inv.log,
      );
      await must(vdir, ['captions', 'add', '--cues', cues], inv.log);
    }
    const base = `demo-${name}-${key}-v1`;
    const r = await must(vdir, ['render', '--preset', A.preset, '--out', base, '--force'], inv.log);
    const qc = await selfRun(vdir, ['inspect', 'qc', r.data.output], inv.log);
    const qcData = qc.json?.data ?? qc.json?.error?.details;
    copyFileSync(join(vdir, r.data.output), join(outDir, `${base}.mp4`));
    results[key] = {
      dir: rel(inv, vdir),
      output: join(`demo-${name}`, `${base}.mp4`),
      render: r.data,
      qc: qcData
        ? {
            passed: qcData.passed,
            summary: qcData.summary,
            checks: qcData.checks.map((c: any) => ({
              id: c.id,
              status: c.status,
              value: c.value,
              detail: c.detail,
            })),
          }
        : { passed: false, error: qc.json?.error?.message },
      ...info,
    };
  }
  // sidecar captions and poster from the 16:9 variant when it exists
  const main = results['16x9'] ?? Object.values(results)[0];
  const mainKey = results['16x9'] ? '16x9' : wanted[0]!;
  const sidecars: string[] = [];
  if (meta.vo) {
    const cuesFile = join(
      inv.dir,
      'variants',
      name,
      mainKey,
      'captions',
      `${name}-${mainKey}.cues.json`,
    );
    if (existsSync(cuesFile)) {
      const doc = JSON.parse(readFileSync(cuesFile, 'utf8'));
      writeFileSync(join(outDir, 'captions.srt'), toSrt(doc.cues));
      writeFileSync(join(outDir, 'captions.vtt'), toVtt(doc.cues));
      sidecars.push('captions.srt', 'captions.vtt');
    }
  }
  const poster = await poster16x9(inv, main, join(outDir, 'poster.png'));
  const reportPath = join(outDir, 'report.md');
  writeFileSync(
    reportPath,
    reportMd({
      name,
      meta,
      plan,
      beats,
      segs,
      cutMs,
      total,
      intro,
      outroMs,
      results,
      spans,
      d,
      fps,
      warnings,
      sidecars,
      poster,
      rampSpeed: plan.rampSpeed ?? 6,
    }),
  );
  copyFileSync(
    join(inv.dir, 'variants', name, mainKey, 'project.studio.json'),
    join(outDir, 'project.studio.json'),
  );
  const failedQc = Object.entries(results)
    .filter(([, v]: any) => !v.qc.passed)
    .map(([k]) => k);
  const data = {
    name,
    outputs: Object.fromEntries(Object.entries(results).map(([k, v]: any) => [k, v.output])),
    durationMs: total,
    report: rel(inv, reportPath),
    poster: rel(inv, join(outDir, 'poster.png')),
    sidecars,
    qc: Object.fromEntries(Object.entries(results).map(([k, v]: any) => [k, v.qc.passed])),
    zooms: Object.fromEntries(
      Object.entries(results).map(([k, v]: any) => [
        k,
        { count: v.zooms.length, maxScale: v.maxScale, cropPx: v.cropPx, soft: v.soft },
      ]),
    ),
    cutRemovedMs: cutMs,
  };
  if (failedQc.length)
    throw new CliError(
      'QC_FAILED',
      `QC failed for ${failedQc.join(', ')}; see ${rel(inv, reportPath)}`,
      4,
      'the report lists each failing check with measured values',
      data,
    );
  return { data, warnings, artifacts: [{ kind: 'report', path: rel(inv, reportPath) }] };
};

function groupKf(plan: ZoomPlan) {
  const keyframes: Record<string, { id: string; t: number; v: number; ease?: string }[]> = {};
  plan.keyframes.forEach((k, i) =>
    (keyframes[k.prop] ??= []).push({ id: `k_${i}`, t: k.t, v: k.v, ease: k.ease }),
  );
  return keyframes;
}

/** Best frame for the poster: the sharpest of frames taken in the middle of each zoom hold and at even steps. */
async function poster16x9(
  inv: Invocation,
  main: any,
  out: string,
): Promise<{ file: string; atMs: number; candidates: number } | null> {
  if (!main) return null;
  const sharp = (await import('sharp')).default;
  const { run } = await import('@studio/engines');
  const src = join(inv.dir, main.dir, main.render.output);
  const times: number[] = [];
  for (let i = 0; i < main.zooms.length; i++)
    if (main.zooms[i].kind !== 'zoom-out') times.push(main.zooms[i].atMs + 1500);
  const dur = main.render.durationMs;
  for (let t = 4000; t < dur - 4000; t += 6000) times.push(t);
  const uniq = [...new Set(times.filter((t) => t > 3000 && t < dur - 3500))].slice(0, 24);
  let best = { t: uniq[0] ?? 5000, score: -1 };
  const tmp = join(dirname(out), '.poster-cand');
  mkdirSync(tmp, { recursive: true });
  for (const t of uniq) {
    const f = join(tmp, `${t}.png`);
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        (t / 1000).toFixed(3),
        '-i',
        src,
        '-frames:v',
        '1',
        f,
      ],
      { timeoutMs: 60000 },
    );
    const { data } = await sharp(f)
      .greyscale()
      .resize(640)
      .convolve({
        width: 3,
        height: 3,
        kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
        scale: 1,
        offset: 128,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let m = 0;
    for (const v of data) m += v;
    m /= data.length;
    let v2 = 0;
    for (const v of data) v2 += (v - m) ** 2;
    const score = v2 / data.length;
    if (score > best.score) best = { t, score };
  }
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      (best.t / 1000).toFixed(3),
      '-i',
      src,
      '-frames:v',
      '1',
      out,
    ],
    { timeoutMs: 60000 },
  );
  rmSync(tmp, { recursive: true, force: true });
  return { file: basename(out), atMs: best.t, candidates: uniq.length };
}

function reportMd(r: any): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const L: string[] = [];
  L.push(
    `# Demo report: ${r.name}`,
    '',
    `Runtime ${sec(r.total)} s (intro ${sec(r.intro)} s, outro ${sec(r.outroMs)} s). Source: ${r.d.w}x${r.d.h} at ${r.fps} fps.`,
    '',
  );
  L.push(
    '## Beats',
    '',
    '| Beat | Source span | Timeline runtime | Cut as dead time |',
    '| --- | --- | --- | --- |',
  );
  for (const b of r.beats) {
    const segs = r.segs.filter((s: Seg) => s.beat === b.id);
    L.push(
      `| ${b.name} | ${sec(b.srcStartMs)}-${sec(b.srcEndMs)} s | ${sec(segs.reduce((n: number, s: Seg) => n + s.dur, 0))} s | ${sec(r.cutMs.find((c: any) => c.beat === b.id)?.ms ?? 0)} s |`,
    );
  }
  const ramps = r.segs.filter((s: Seg) => s.speed !== 1);
  L.push(
    '',
    '## Dead time and speed',
    '',
    `- Still spans found in the recording (nothing changes on screen, over 1 s): ${r.spans.still.length}. They are cut, keeping 0.3 s on each side.`,
    `- Low-activity spans (loading, typing) over 1 s: ${r.spans.low.length}. Ramped at ${r.rampSpeed}x with a speed badge: ${ramps.length} segment(s), ${ramps.map((s: Seg) => `${sec(s.srcEnd - s.srcStart)} s -> ${sec(s.dur)} s`).join(', ') || 'none'}.`,
  );
  L.push('', '## Zoom', '');
  for (const [k, v] of Object.entries<any>(r.results)) {
    L.push(
      `- ${k}: ${v.zooms.length} zoom change(s), max scale ${v.maxScale}x, crop ${v.cropPx} source px across a ${(ASPECTS as any)[k].w} px output${v.soft ? ' (**soft**: upscaled)' : ' (sharp)'}; ${v.rings} click ring(s), ${v.callouts} callout(s), ${v.badges} speed badge(s).`,
    );
    for (const n of new Set<string>(v.notes)) L.push(`  - ${n}`);
  }
  L.push(
    '',
    '## Privacy scan',
    '',
    `- Contact sheets at 1 fps: ${r.meta.privacy.sheets.length} generated in \`demo/${r.name}/privacy\`; the operator stated they were viewed (\`--privacy-reviewed\`).`,
    `- Text scan of ${r.meta.privacy.textScan.join(', ')}: ${r.meta.privacy.findings.length} finding(s).`,
    '- OCR: **not installed, so pixels were not scanned automatically.** Anything private that a person did not spot on the sheets is not caught.',
  );
  L.push('', '## Audio', '');
  for (const [k, v] of Object.entries<any>(r.results)) {
    const lu = v.qc.checks?.find((c: any) => c.id === 'loudness');
    L.push(`- ${k}: ${lu ? JSON.stringify(lu.value) : 'no loudness measurement'}`);
  }
  L.push(
    '',
    '## QC',
    '',
    '| Aspect | Passed | Pass | Fail | Warn | Skipped |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const [k, v] of Object.entries<any>(r.results))
    L.push(
      `| ${k} | ${v.qc.passed ? 'yes' : '**no**'} | ${v.qc.summary?.pass ?? '?'} | ${v.qc.summary?.fail ?? '?'} | ${v.qc.summary?.warn ?? '?'} | ${v.qc.summary?.skipped ?? '?'} |`,
    );
  for (const [k, v] of Object.entries<any>(r.results))
    for (const c of v.qc.checks ?? [])
      if (c.status === 'fail' || c.status === 'warn')
        L.push(
          '',
          `- ${k} ${c.id}: ${c.status} ${JSON.stringify(c.value)}${c.detail ? ` (${c.detail})` : ''}`,
        );
  L.push('', '## Files', '');
  for (const [k, v] of Object.entries<any>(r.results))
    L.push(
      `- ${v.output} (${k}, ${v.render.width}x${v.render.height}, ${(v.render.bytes / 1048576).toFixed(1)} MB, render ${(v.render.renderMs / 1000).toFixed(1)} s, backend ${v.render.backend})`,
    );
  if (r.poster)
    L.push(
      `- ${r.poster.file}: sharpest of ${r.poster.candidates} candidate frames (Laplacian variance); chosen at ${sec(r.poster.atMs)} s`,
    );
  for (const s of r.sidecars) L.push(`- ${s}`);
  L.push('- project.studio.json (the 16:9 variant)', '', '## Not done or not verified', '');
  L.push(
    '- Window or device frame (rounded corners, shadow, padding): not implemented. The recording fills the canvas width on the brand background; in 9:16 and 1:1 the brand background shows above and below.',
    '- Chapter cards: not needed under 90 s and not implemented.',
    '- On-screen text size (28 px equivalent at 1080 wide) and contrast against the real video frame: not measured.',
    '- Visuals are not re-timed to the narration: the VO starts after the intro and runs at its natural pace.',
    '- Pixel cursor tracking is not provided; zooms follow the events file only.',
    '- Captions: word timings come from the recognizer and are not frame-accurate (see docs/perf.md).',
  );
  for (const w of r.warnings) L.push(`- ${w}`);
  return L.join('\n') + '\n';
}
