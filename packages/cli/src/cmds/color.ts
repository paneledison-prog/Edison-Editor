/**
 * The agent's colour tools. Every grade is a stack of nodes on a clip (the clip's `fx` array); each node is a plugin
 * effect or a LUT, so a change is a validated, logged, undoable op. Measurements come from the pixels actually rendered.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cryptoRng, makeId, type Clip, type Fx } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, parseJson, runSpecs, selfRun, store, str } from './shared.js';

type Node = Extract<Fx, { type: 'plugin' | 'lut' }>;
const isNode = (f: Fx): f is Node => f.type === 'plugin' || f.type === 'lut';

// ---------------------------------------------------------------------------------------------------------------
// measurement

export interface Stats {
  /** Rec.709 luma of the encoded values, 0..1 */
  luma: { mean: number; p1: number; p5: number; p25: number; p50: number; p75: number; p95: number; p99: number };
  clippedHighlightsPct: number;
  clippedShadowsPct: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** mean of the middle tones (luma 0.2 to 0.8), where a colour cast shows */
  midMean: [number, number, number];
  saturation: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function statsOf(raw: Buffer): Stats {
  const n = Math.floor(raw.length / 3);
  const Y = new Float64Array(n);
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  const mid = [0, 0, 0];
  let midN = 0;
  let sat = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const c = [raw[i * 3]! / 255, raw[i * 3 + 1]! / 255, raw[i * 3 + 2]! / 255];
    const y = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    Y[i] = y;
    for (let k = 0; k < 3; k++) {
      sum[k]! += c[k]!;
      sq[k]! += c[k]! * c[k]!;
    }
    if (y >= 0.2 && y <= 0.8) {
      midN++;
      for (let k = 0; k < 3; k++) mid[k]! += c[k]!;
    }
    const mx = Math.max(...c);
    sat += mx > 1e-4 ? (mx - Math.min(...c)) / mx : 0;
    if (y >= 0.992) hi++;
    if (y <= 0.008) lo++;
  }
  const sorted = Float64Array.from(Y).sort();
  const p = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]!;
  const m = sum.map((s) => s / n);
  const mm = midN ? mid.map((s) => s / midN) : m;
  return {
    luma: {
      mean: r4(Y.reduce((a, b) => a + b, 0) / n),
      p1: r4(p(0.01)),
      p5: r4(p(0.05)),
      p25: r4(p(0.25)),
      p50: r4(p(0.5)),
      p75: r4(p(0.75)),
      p95: r4(p(0.95)),
      p99: r4(p(0.99)),
    },
    clippedHighlightsPct: Math.round((hi / n) * 1000) / 10,
    clippedShadowsPct: Math.round((lo / n) * 1000) / 10,
    mean: m.map(r4) as [number, number, number],
    std: sq.map((s, k) => r4(Math.sqrt(Math.max(0, s / n - m[k]! * m[k]!)))) as [number, number, number],
    midMean: mm.map(r4) as [number, number, number],
    saturation: r4(sat / n),
  };
}

/** Decodes an image or video frame to 160x90 rgb24 and measures it. */
export function measureFile(file: string, atMs = 0): Stats {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', ...(atMs > 0 ? ['-ss', String(atMs / 1000)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=160:90:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 24 },
  );
  if (raw.length < 160 * 90 * 3)
    throw new CliError('ENGINE_FAILED', `could not decode a frame from ${file}`, 1, 'check the file with studio inspect frame');
  return statsOf(raw);
}

/** Renders the timeline at `ms` (every layer and node, as exported) at 640 px wide and returns the file. */
async function grabFrame(inv: Invocation, ms: number, tag: string): Promise<string> {
  const r = await selfRun(inv.dir, ['render', '--still', String(Math.round(ms)), '--out', `color-${tag}`, '--width', '640', '--no-normalize', '--force'], inv.log);
  if (r.code !== 0 || !r.json?.ok)
    throw new CliError(
      r.json?.error?.code ?? 'ENGINE_FAILED',
      `could not render the frame at ${ms} ms: ${r.json?.error?.message ?? r.stderr.trim().split('\n').pop()}`,
      r.code === 2 || r.code === 3 || r.code === 4 ? r.code : 1,
      r.json?.error?.fix,
    );
  return join(inv.dir, r.json.data.output as string);
}

const relTo = (inv: Invocation, p: string) => relative(inv.dir, p) || p;

// ---------------------------------------------------------------------------------------------------------------
// helpers on the node stack

async function engines() {
  return import('@studio/engines');
}

function clipOf(inv: Invocation, id: string | undefined): Clip {
  if (!id) throw new CliError('INVALID_ARGS', '--clip is required', 2, 'studio project show lists clips');
  const clip = store(inv).load().project.clips.find((c) => c.id === id);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${id}`, 2, 'studio project show lists clips');
  if (clip.comp) throw new CliError('INVALID_ARGS', `${id} is a composition clip; colour nodes apply to media clips`, 2);
  return clip;
}

/** Applies a new `fx` array to a clip as one op. */
function setFx(inv: Invocation, clipId: string, fx: Fx[], label: string) {
  return runSpecs(inv, [{ type: 'clip.set', args: { id: clipId, patch: { fx } } }], label);
}

function nodeAt(clip: Clip, idx: number | undefined): { index: number; node: Node } {
  const fx = clip.fx ?? [];
  if (idx === undefined || !Number.isInteger(idx) || idx < 0 || idx >= fx.length)
    throw new CliError('INVALID_ARGS', `--node must be an index 0..${fx.length - 1} (studio color stack --clip ${clip.id})`, 2);
  const node = fx[idx]!;
  if (!isNode(node))
    throw new CliError('INVALID_ARGS', `fx ${idx} is a "${node.type}" effect, not a colour node; change it with studio tl set`, 2);
  return { index: idx, node };
}

async function validateNode(id: string, params: Record<string, unknown> | undefined) {
  const E = await engines();
  E.effectLines({ id, ...(params ? { params } : {}) }, 'a', 'b', 'v');
}

function pluginsParams(raw: unknown, flag: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const p = parseJson(flag, String(raw));
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new CliError('INVALID_ARGS', `${flag} must be a JSON object`, 2);
  return p as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// the node stack

export const effects: Handler = async (inv) => {
  const E = await engines();
  const q = str(inv, 'query')?.toLowerCase();
  const list = E.pluginEffects()
    .filter((e) => !q || `${e.decl.id} ${e.decl.summary}`.toLowerCase().includes(q))
    .map((e) => ({
      id: e.decl.id,
      plugin: e.plugin.manifest.id,
      summary: e.decl.summary,
      cost: e.decl.cost ?? 'light',
      ...(e.decl.stage === 'source' ? { stage: 'source' } : {}),
      params: Object.fromEntries(
        Object.entries(e.decl.params).map(([k, p]) => [
          k,
          { type: p.type, default: p.default, ...(p.min !== undefined ? { min: p.min, max: p.max } : {}), ...(p.values ? { values: p.values } : {}), desc: p.desc },
        ]),
      ),
    }));
  return { data: { count: list.length, effects: list, lut: 'a LUT node is added with studio color lut' } };
};

export const stack: Handler = async (inv) => {
  const E = await engines();
  const clip = clipOf(inv, str(inv, 'clip'));
  const nodes = (clip.fx ?? []).map((f, index) => {
    if (f.type === 'plugin') {
      const decl = E.pluginEffectDecl(f.id);
      const params = decl
        ? Object.fromEntries(Object.entries(decl.params).map(([k, p]) => [k, f.params?.[k] ?? p.default]))
        : (f.params ?? {});
      return { index, kind: 'effect', id: f.id, bypass: !!f.bypass, params, ...(decl ? {} : { missing: 'no loaded plugin provides this effect' }) };
    }
    if (f.type === 'lut') return { index, kind: 'lut', file: f.file, bypass: !!f.bypass };
    return { index, kind: f.type, note: 'not a colour node (edit with studio tl set)' };
  });
  return { data: { clip: clip.id, nodes, order: 'LUTs run first, then plugin nodes in this order' } };
};

async function addNode(inv: Invocation, clipId: string, id: string, params: Record<string, unknown> | undefined, at?: number, label?: string) {
  const clip = clipOf(inv, clipId);
  await validateNode(id, params);
  const fx = [...(clip.fx ?? [])];
  const taken = new Set(store(inv).load().project.clips.flatMap((c) => (c.fx ?? []).map((f) => (f as { node?: string }).node).filter(Boolean) as string[]));
  const node: Fx = { type: 'plugin', id, ...(params ? { params: params as Record<string, number | string | boolean> } : {}), node: makeId('f', taken, cryptoRng()) };
  if (at === undefined) fx.push(node);
  else if (at >= 0 && at <= fx.length) fx.splice(at, 0, node);
  else throw new CliError('INVALID_ARGS', `--at must be 0..${fx.length}`, 2);
  return setFx(inv, clip.id, fx, label ?? `color add ${id}`);
}

export const add: Handler = async (inv) => {
  const id = str(inv, 'effect');
  if (!id) throw new CliError('INVALID_ARGS', '--effect is required', 2, 'studio color effects lists them');
  return addNode(inv, clipOf(inv, str(inv, 'clip')).id, id, pluginsParams(inv.flags['params'], '--params'), num(inv, 'at'));
};

export const set: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const { index, node } = nodeAt(clip, num(inv, 'node'));
  if (node.type !== 'plugin') throw new CliError('INVALID_ARGS', 'a LUT node has no parameters; remove it and add another', 2);
  const patch = pluginsParams(inv.flags['params'], '--params');
  if (!patch) throw new CliError('INVALID_ARGS', '--params is required', 2);
  const params = inv.flags['replace'] ? patch : { ...(node.params ?? {}), ...patch };
  await validateNode(node.id, params);
  const fx = [...(clip.fx ?? [])];
  fx[index] = { ...node, params: params as Record<string, number | string | boolean> };
  return setFx(inv, clip.id, fx, `color set ${node.id}`);
};

export const remove: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const { index } = nodeAt(clip, num(inv, 'node'));
  const fx = (clip.fx ?? []).filter((_, i) => i !== index);
  return setFx(inv, clip.id, fx, 'color remove');
};

export const move: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const { index, node } = nodeAt(clip, num(inv, 'node'));
  const to = num(inv, 'to');
  const fx = [...(clip.fx ?? [])];
  if (to === undefined || !Number.isInteger(to) || to < 0 || to >= fx.length)
    throw new CliError('INVALID_ARGS', `--to must be an index 0..${fx.length - 1}`, 2);
  fx.splice(index, 1);
  fx.splice(to, 0, node);
  return setFx(inv, clip.id, fx, 'color move');
};

export const bypass: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const { index, node } = nodeAt(clip, num(inv, 'node'));
  const on = !inv.flags['off'];
  const fx = [...(clip.fx ?? [])];
  const next = { ...node } as Node;
  if (on) next.bypass = true;
  else delete next.bypass;
  fx[index] = next;
  return setFx(inv, clip.id, fx, `color ${on ? 'bypass' : 'enable'}`);
};

export const lut: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const given = str(inv, 'file');
  if (!given) throw new CliError('INVALID_ARGS', '--file is required (a .cube or .3dl inside the project)', 2);
  const abs = isAbsolute(given) ? given : resolve(inv.dir, given);
  const rel = relative(inv.dir, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new CliError('INVALID_ARGS', `${given} is outside the project`, 2, 'copy the LUT into the project, for example luts/');
  if (!existsSync(abs)) throw new CliError('NOT_FOUND', `${rel} does not exist`, 2);
  if (!/\.(cube|3dl)$/i.test(rel)) throw new CliError('INVALID_ARGS', 'a LUT must be a .cube or .3dl file', 2);
  const fx: Fx[] = [...(clip.fx ?? []), { type: 'lut', file: rel }];
  return setFx(inv, clip.id, fx, 'color lut');
};

// ---------------------------------------------------------------------------------------------------------------
// seeing: analysis and scopes

async function frameForTarget(inv: Invocation, tag: string): Promise<{ file: string; atMs: number | null; clip?: string }> {
  const file = str(inv, 'file');
  if (file) {
    const abs = resolve(inv.dir, file);
    if (!existsSync(abs)) throw new CliError('NOT_FOUND', `${file} does not exist`, 2);
    return { file: abs, atMs: num(inv, 'at') ?? null };
  }
  const clip = clipOf(inv, str(inv, 'clip'));
  const at = num(inv, 'at') ?? Math.round(clip.start + clip.dur / 2);
  return { file: await grabFrame(inv, at, tag), atMs: at, clip: clip.id };
}

export const analyze: Handler = async (inv) => {
  const t = await frameForTarget(inv, 'analyze');
  const s = measureFile(t.file, t.clip ? 0 : (t.atMs ?? 0));
  const [rm, gm, bm] = s.midMean;
  const notes: string[] = [];
  if (s.clippedHighlightsPct > 1) notes.push(`${s.clippedHighlightsPct}% of pixels are clipped white`);
  if (s.clippedShadowsPct > 5) notes.push(`${s.clippedShadowsPct}% of pixels are crushed black`);
  if (s.luma.p50 < 0.25) notes.push('the picture is dark (median luma under 0.25)');
  if (s.luma.p50 > 0.65) notes.push('the picture is bright (median luma over 0.65)');
  if (s.luma.p95 - s.luma.p5 < 0.45) notes.push('low contrast: the 5th to 95th percentile spread is under 0.45');
  const cast = (rm - bm) / Math.max(0.05, (rm + bm) / 2);
  if (Math.abs(cast) > 0.08) notes.push(cast > 0 ? 'warm cast in the midtones' : 'cool cast in the midtones');
  const gcast = (gm - (rm + bm) / 2) / Math.max(0.05, gm);
  if (Math.abs(gcast) > 0.06) notes.push(gcast > 0 ? 'green cast in the midtones' : 'magenta cast in the midtones');
  return {
    data: { source: relTo(inv, t.file), atMs: t.atMs, ...(t.clip ? { clip: t.clip } : {}), stats: s, notes, caveat: 'measured on an 160x90 copy of the rendered frame, encoded values (not linear light)' },
    artifacts: [{ kind: 'frame', path: relTo(inv, t.file) }],
  };
};

export const scopes: Handler = async (inv) => {
  const t = await frameForTarget(inv, 'scopes');
  const outDir = join(inv.dir, 'renders', 'color');
  mkdirSync(outDir, { recursive: true });
  const base = `scopes-${(t.clip ?? 'file')}-${t.atMs ?? 0}`;
  const E = await engines();
  const src = t.file;
  const seek = t.clip ? [] : ['-ss', String((t.atMs ?? 0) / 1000)];
  const make = async (name: string, vf: string) => {
    const out = join(outDir, `${base}-${name}.png`);
    await E.ffmpeg(['-hide_banner', '-y', ...seek, '-i', src, '-frames:v', '1', '-vf', vf, out]);
    return out;
  };
  const made = {
    waveform: await make('waveform', 'scale=640:360,format=yuv444p,waveform=filter=lowpass:intensity=0.12:graticule=green:scale=digital:flags=numbers,scale=480:300'),
    parade: await make('parade', 'scale=640:360,format=gbrp,waveform=display=parade:components=7:intensity=0.12:graticule=green:scale=digital,format=rgb24,scale=480:300'),
    vectorscope: await make('vectorscope', 'scale=640:360,format=yuv444p,vectorscope=mode=color3:graticule=green:colorspace=709:intensity=0.08,scale=300:300'),
    histogram: await make('histogram', 'scale=640:360,format=yuv444p,histogram=display_mode=overlay:levels_mode=linear:components=7,scale=300:300'),
  };
  const sheet = join(outDir, `${base}.png`);
  await E.ffmpeg([
    '-hide_banner', '-y',
    '-i', made.waveform, '-i', made.parade, '-i', made.vectorscope, '-i', made.histogram,
    '-filter_complex', '[0]scale=480:300[a];[1]scale=480:300[b];[2]scale=300:300,pad=480:300:90:0[c];[3]scale=300:300,pad=480:300:90:0[d];[a][b][c][d]xstack=inputs=4:layout=0_0|480_0|0_300|480_300',
    '-frames:v', '1', sheet,
  ]);
  const rels = Object.fromEntries(Object.entries(made).map(([k, v]) => [k, relTo(inv, v)]));
  return {
    data: { source: relTo(inv, src), atMs: t.atMs, scopes: rels, sheet: relTo(inv, sheet), how: 'sheet: waveform and RGB parade on top, vectorscope and histogram below; look at it with a viewer' },
    artifacts: [{ kind: 'scopes', path: relTo(inv, sheet) }, ...Object.values(rels).map((p) => ({ kind: 'scope', path: p as string }))],
  };
};

// ---------------------------------------------------------------------------------------------------------------
// doing: auto correction and shot match

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Corrections that move a measured frame toward a well-exposed, balanced one. Damped, bounded, and reported.
 * Contrast and the end points are computed from the percentiles *after* the exposure change, so a dark frame is not
 * crushed by a contrast step that assumed its old levels.
 */
export function autoParams(s: Stats) {
  const stops = clamp(Math.log2(Math.pow(0.45, 2.2) / Math.pow(Math.max(s.luma.p50, 0.02), 2.2)), -2, 2) * 0.8;
  const exposure = r1(stops);
  const g = Math.pow(2, exposure);
  const after = (p: number) => Math.pow(clamp(Math.pow(p, 2.2) * g, 0, 1), 1 / 2.2);
  const p1 = after(s.luma.p1);
  const p5 = after(s.luma.p5);
  const p95 = after(s.luma.p95);
  const p99 = after(s.luma.p99);
  const spread = Math.max(0.05, p95 - p5);
  // contrast pivots at mid grey: cap the factor so the 5th percentile stays above 0.03
  const cap = p5 < 0.5 ? (0.5 - 0.03) / (0.5 - p5) : 3;
  const factor = clamp(0.75 / spread, 0.8, Math.min(1.4, cap));
  const contrast = Math.round((factor - 1) * 100);
  const blacks = p1 > 0.06 ? -Math.round(clamp((p1 - 0.03) * 300, 0, 40)) : 0;
  const whites = p99 < 0.9 ? Math.round(clamp((0.95 - p99) * 300, 0, 40)) : 0;
  const [rm, gm, bm] = s.midMean;
  const temperature = Math.round(clamp(((100 * (bm - rm)) / (0.15 * Math.max(0.05, bm + rm))) * 0.5, -30, 30));
  const tint = Math.round(clamp(1000 * (1 - (rm + bm) / 2 / Math.max(0.05, gm)) * 0.5, -25, 25));
  return { exposure, contrast, blacks, whites, temperature, tint };
}

export const auto: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const at = num(inv, 'at') ?? Math.round(clip.start + clip.dur / 2);
  const before = measureFile(await grabFrame(inv, at, 'auto-before'));
  const params = autoParams(before);
  const apply = !inv.flags['report-only'] && !inv.dryRun;
  if (!apply) return { data: { clip: clip.id, atMs: at, before, suggested: params, applied: false } };
  const out = await addNode(inv, clip.id, 'lumetri', params, undefined, 'color auto');
  const after = measureFile(await grabFrame(inv, at, 'auto-after'));
  const worse = Math.abs(after.luma.p50 - 0.45) > Math.abs(before.luma.p50 - 0.45) || after.clippedShadowsPct > before.clippedShadowsPct + 10;
  return {
    ...out,
    ...(worse ? { warnings: ['the automatic correction made this frame worse (median luma further from 0.45, or many more crushed pixels); undo it with studio project undo and grade it by hand'] } : {}),
    data: {
      ...(out.data as Record<string, unknown>),
      clip: clip.id,
      atMs: at,
      applied: params,
      before: { medianLuma: before.luma.p50, spread: r4(before.luma.p95 - before.luma.p5), midMean: before.midMean, clippedHighlightsPct: before.clippedHighlightsPct, clippedShadowsPct: before.clippedShadowsPct },
      after: { medianLuma: after.luma.p50, spread: r4(after.luma.p95 - after.luma.p5), midMean: after.midMean, clippedHighlightsPct: after.clippedHighlightsPct, clippedShadowsPct: after.clippedShadowsPct },
      note: 'a starting point from one frame; look at the result and adjust the node with studio color set',
    },
  };
};

export const match: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const ref = str(inv, 'ref');
  if (!ref) throw new CliError('INVALID_ARGS', '--ref is required (a clip id or an image/video file)', 2);
  const at = num(inv, 'at') ?? Math.round(clip.start + clip.dur / 2);
  const tgt = measureFile(await grabFrame(inv, at, 'match-target'));
  let refStats: Stats;
  const proj = store(inv).load().project;
  const refClip = proj.clips.find((c) => c.id === ref);
  if (refClip) refStats = measureFile(await grabFrame(inv, num(inv, 'ref-at') ?? Math.round(refClip.start + refClip.dur / 2), 'match-ref'));
  else {
    const f = resolve(inv.dir, ref);
    if (!existsSync(f)) throw new CliError('NOT_FOUND', `${ref} is neither a clip id nor a file`, 2);
    refStats = measureFile(f, num(inv, 'ref-at') ?? 0);
  }
  const k = clamp(num(inv, 'strength') ?? 1, 0, 1);
  const params: Record<string, number> = {};
  (['R', 'G', 'B'] as const).forEach((c, i) => {
    const gain = clamp(1 + (clamp(refStats.std[i]! / Math.max(0.02, tgt.std[i]!), 0.5, 2) - 1) * k, 0.5, 2);
    const offset = clamp((refStats.mean[i]! - gain * tgt.mean[i]!) * k, -0.4, 0.4);
    params[`gain${c}`] = r4(gain);
    params[`offset${c}`] = r4(offset);
  });
  const res = await addNode(inv, clip.id, 'primary', params, undefined, 'color match');
  const after = measureFile(await grabFrame(inv, at, 'match-after'));
  const dist = (a: Stats) => r4(a.mean.reduce((s, v, i) => s + Math.abs(v - refStats.mean[i]!), 0) / 3 + a.std.reduce((s, v, i) => s + Math.abs(v - refStats.std[i]!), 0) / 3);
  return {
    ...res,
    data: {
      ...(res.data as Record<string, unknown>),
      clip: clip.id,
      matchedTo: ref,
      applied: params,
      distance: { before: dist(tgt), after: dist(after), meaning: 'mean absolute difference of per-channel mean and spread to the reference (0 is identical); lower is closer' },
      caveat: 'matches per-channel mean and spread of one frame; it does not match skin tones or specific colours',
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// gallery

const gradeFile = (inv: Invocation, name: string) => join(inv.dir, 'grades', `${name}.json`);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const save: Handler = async (inv) => {
  const clip = clipOf(inv, str(inv, 'clip'));
  const name = str(inv, 'name');
  if (!name || !NAME.test(name)) throw new CliError('INVALID_ARGS', '--name must be lowercase letters, digits, dashes (max 40)', 2);
  const nodes = (clip.fx ?? []).filter(isNode);
  if (!nodes.length) throw new CliError('INVALID_ARGS', `${clip.id} has no colour nodes to save`, 2, 'studio color stack --clip ' + clip.id);
  const file = gradeFile(inv, name);
  if (existsSync(file) && !inv.force) throw new CliError('WOULD_OVERWRITE', `grades/${name}.json exists`, 5, 'pass --force to overwrite');
  if (!inv.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name, from: clip.id, nodes }, null, 2) + '\n');
  }
  return { data: { name, nodes: nodes.length, file: `grades/${name}.json` }, artifacts: inv.dryRun ? [] : [{ kind: 'grade', path: `grades/${name}.json` }] };
};

export const gallery: Handler = async (inv) => {
  const dir = join(inv.dir, 'grades');
  const grades = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
          const g = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { name: string; nodes: Node[] };
          return { name: g.name, nodes: g.nodes.map((n) => (n.type === 'plugin' ? n.id : `lut:${n.file}`)) };
        })
    : [];
  return { data: { grades } };
};

export const apply: Handler = async (inv) => {
  const name = str(inv, 'name');
  if (!name || !NAME.test(name)) throw new CliError('INVALID_ARGS', '--name is required', 2, 'studio color gallery');
  const file = gradeFile(inv, name);
  if (!existsSync(file)) throw new CliError('NOT_FOUND', `no saved grade "${name}"`, 2, 'studio color gallery');
  const g = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Node[] };
  const ids = (str(inv, 'clips') ?? '').split(',').filter(Boolean);
  if (!ids.length) throw new CliError('INVALID_ARGS', '--clips is required (comma separated clip ids)', 2);
  const E = await engines();
  for (const n of g.nodes) if (n.type === 'plugin') E.effectLines(n, 'a', 'b', 'v');
  const specs = ids.map((id) => {
    const clip = clipOf(inv, id);
    const keep = inv.flags['replace'] ? (clip.fx ?? []).filter((f) => !isNode(f)) : (clip.fx ?? []);
    return { type: 'clip.set', args: { id, patch: { fx: [...keep, ...g.nodes] } } };
  });
  return runSpecs(inv, specs, `color apply ${name}`);
};

// ---------------------------------------------------------------------------------------------------------------
// images

export const still: Handler = async (inv) => {
  const E = await engines();
  const file = str(inv, 'file');
  if (!file) throw new CliError('INVALID_ARGS', '--file is required', 2);
  const src = resolve(inv.dir, file);
  if (!existsSync(src)) throw new CliError('NOT_FOUND', `${file} does not exist`, 2);
  const nodes = parseJson('--nodes', String(inv.flags['nodes'] ?? '[]')) as { id: string; params?: Record<string, unknown> }[];
  if (!Array.isArray(nodes) || !nodes.length) throw new CliError('INVALID_ARGS', '--nodes must be a JSON array like [{"id":"lumetri","params":{"exposure":0.5}}]', 2);
  const probe = await E.probeFile(src);
  const w = probe.probe.w;
  const h = probe.probe.h;
  if (!w || !h) throw new CliError('INVALID_INPUT', `${file} has no picture size`, 2);
  const even = (n: number) => n - (n % 2);
  const outRel = str(inv, 'out') ?? join('renders', 'color', `${(file.split('/').pop() ?? 'image').replace(/\.[^.]+$/, '')}-graded.png`);
  const out = resolve(inv.dir, outRel);
  if (existsSync(out) && !inv.force) throw new CliError('WOULD_OVERWRITE', `${outRel} exists`, 5, 'pass --force or choose another --out');
  const lines: string[] = [`[0:v]scale=${even(w)}:${even(h)},format=yuv420p[n0]`];
  nodes.forEach((n, i) => {
    lines.push(...E.effectLines(n, `n${i}`, `n${i + 1}`, `s${i}`, { W: even(w), H: even(h), FPS: 24, SRCFPS: 24, SPEED: 1, T0: 0 }));
  });
  if (inv.dryRun) return { data: { wouldWrite: outRel, graph: lines.join(';') } };
  mkdirSync(dirname(out), { recursive: true });
  const before = measureFile(src);
  await E.ffmpeg(['-hide_banner', '-y', '-i', src, '-filter_complex', lines.join(';'), '-map', `[n${nodes.length}]`, '-frames:v', '1', '-pix_fmt', 'rgb24', out]);
  const after = measureFile(out);
  return {
    data: { output: outRel, nodes: nodes.map((n) => n.id), before: { medianLuma: before.luma.p50, mean: before.mean }, after: { medianLuma: after.luma.p50, mean: after.mean } },
    artifacts: [{ kind: 'image', path: outRel }],
  };
};
