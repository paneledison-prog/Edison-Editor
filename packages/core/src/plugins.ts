/**
 * Plugins: a folder with a `plugin.json` manifest and a few small source files. No install step, no
 * dependencies, no network. A plugin can add three kinds of thing, each one an extension point Studio
 * already has:
 *
 *   templates  motion templates (props schema in the manifest, drawing code in `page`), rendered by the
 *              same Chromium renderer, cache, and hybrid compositing as the built-in ones
 *   effects    video effects: a small FFmpeg filter graph with typed parameters, applied to a clip as an
 *              ordinary `{type:"plugin"}` fx, so they are validated, logged, undoable ops
 *   scripts    automation: ES modules that change the project only through `studio` commands
 *
 * Size is a hard budget: a plugin whose files total more than MAX_PLUGIN_BYTES is refused, not loaded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

export const PLUGIN_API = 1;
export const MAX_PLUGIN_BYTES = 64 * 1024;
const ID = /^[a-z][a-z0-9-]{1,31}$/;

const PropSpec = z
  .object({
    type: z.enum(['string', 'number', 'color', 'ease', 'boolean', 'enum', 'box', 'list']),
    default: z.unknown().optional(),
    desc: z.string().min(1).max(160),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLen: z.number().int().positive().max(500000).optional(),
    values: z.array(z.string().max(40)).max(40).optional(),
    optional: z.boolean().optional(),
  })
  .strict();

export const TemplateDecl = z
  .object({
    id: z.string().regex(ID),
    summary: z.string().min(1).max(200),
    kind: z.enum(['overlay', 'full']),
    defaultDurMs: z.number().int().min(100).max(120000),
    props: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), PropSpec),
  })
  .strict();

const HEX6 = /^#[0-9a-fA-F]{6}$/;
/** "x/y x/y ...": curve points, x strictly increasing, both 0..1, at least two, at most 12 */
const POINTS = /^(\d(?:\.\d{1,4})?\/\d(?:\.\d{1,4})?)( \d(?:\.\d{1,4})?\/\d(?:\.\d{1,4})?){1,11}$/;
export function validPoints(v: string): boolean {
  if (!POINTS.test(v)) return false;
  const pts = v.split(' ').map((p) => p.split('/').map(Number) as [number, number]);
  return pts.every(([x, y], i) => x >= 0 && x <= 1 && y >= 0 && y <= 1 && (i === 0 || x > pts[i - 1]![0]));
}

const EffectParam = z
  .object({
    /** `color` is #RRGGBB (graph gets {name.r} {name.g} {name.b} as 0..1); `points` is a curve "0/0 0.5/0.6 1/1" */
    type: z.enum(['number', 'enum', 'boolean', 'color', 'points']),
    default: z.union([z.number(), z.string(), z.boolean()]),
    desc: z.string().min(1).max(160),
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,24}$/)).max(24).optional(),
    /** a number that must be a whole number (the value is rounded) */
    integer: z.boolean().optional(),
  })
  .strict();

export const EffectDecl = z
  .object({
    id: z.string().regex(ID),
    summary: z.string().min(1).max(200),
    params: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), EffectParam),
    /**
     * An FFmpeg filter graph from `[in]` to `[out]`. `{name}` is replaced by a validated parameter.
     * Internal labels are renamed per clip, so two clips never collide.
     */
    graph: z.string().min(3).max(6000),
    /**
     * `clip` (default): runs on the clip's finished picture. `source`: runs on the source frames before the clip is
     * retimed, so frame interpolation for slow motion sees real neighbouring frames.
     */
    stage: z.enum(['clip', 'source']).optional(),
    /** a rough cost label shown by `plugins list`; `heavy` effects are measured and flagged in render warnings */
    cost: z.enum(['light', 'medium', 'heavy']).optional(),
  })
  .strict();

export const ScriptDecl = z
  .object({
    name: z.string().regex(ID),
    summary: z.string().min(1).max(200),
    file: z.string().regex(/^[A-Za-z0-9_./-]{1,80}\.mjs$/),
  })
  .strict();

export const Manifest = z
  .object({
    api: z.literal(PLUGIN_API),
    id: z.string().regex(ID),
    name: z.string().min(1).max(60),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    summary: z.string().min(1).max(200),
    license: z.string().min(1).max(40),
    /** browser-side source for `templates` (relative path to a .js file) */
    page: z.string().regex(/^[A-Za-z0-9_./-]{1,80}\.js$/).optional(),
    templates: z.array(TemplateDecl).max(16).optional(),
    effects: z.array(EffectDecl).max(48).optional(),
    scripts: z.array(ScriptDecl).max(32).optional(),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

export interface LoadedPlugin {
  manifest: Manifest;
  dir: string;
  source: 'builtin' | 'project';
  bytes: number;
  /** sha256 over the manifest and every source file, so a changed plugin invalidates cached frames */
  hash: string;
  pageCode?: string;
}

export class PluginError extends Error {
  readonly code = 'PLUGIN_INVALID';
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

const SAFE_GRAPH = /^[A-Za-z0-9_.,:;=\[\]{}()+\-*/<>?!&|%^ '~@#$]+$/;
/** Filters a plugin graph may not use: they read or write files, run programs, or pull in other inputs. */
const BANNED_FILTERS = [
  'movie',
  'amovie',
  'sendcmd',
  'asendcmd',
  'zmq',
  'azmq',
  'subtitles',
  'ass',
  'drawtext',
  'lut3d',
  'haldclut',
  'frei0r',
  'ladspa',
  'lv2',
  'openclsrc',
  'sdl',
  'coreimage',
  'ocr',
  'readeia608',
  'readvitc',
];

function walkBytes(dir: string, files: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walkBytes(p, files);
    else files.push(p);
  }
  return files;
}

function inside(root: string, rel: string): string {
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(root + sep))
    throw new PluginError(`path "${rel}" leaves the plugin folder`);
  return p;
}

/** Placeholders in a graph, e.g. `{amount}` */
export function graphParams(graph: string): string[] {
  return [...new Set([...graph.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*(?:\.[rgb])?)\}/g)].map((m) => m[1]!))];
}

/** Values the renderer fills in itself, so a graph can size a source filter to the picture. */
export const BUILTIN_VARS = ['W', 'H', 'FPS', 'SRCFPS', 'SPEED', 'INTERPFPS', 'T0'] as const;

export function loadPlugin(dir: string, source: LoadedPlugin['source']): LoadedPlugin {
  const root = resolve(dir);
  const mf = join(root, 'plugin.json');
  if (!existsSync(mf)) throw new PluginError(`${dir}: no plugin.json`, 'run `studio plugins new <id>`');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mf, 'utf8'));
  } catch (e) {
    throw new PluginError(`${dir}/plugin.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success)
    throw new PluginError(
      `${dir}/plugin.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      'see docs/plugins.md for the manifest fields',
    );
  const m = parsed.data;
  if (root.split(sep).pop() !== m.id)
    throw new PluginError(`${dir}: the folder name must equal the plugin id "${m.id}"`);
  const files = walkBytes(root);
  if (files.some((f) => f.split(sep).includes('node_modules')))
    throw new PluginError(`${m.id}: node_modules is not allowed; a plugin has no dependencies`);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  if (bytes > MAX_PLUGIN_BYTES)
    throw new PluginError(
      `${m.id}: ${bytes} bytes of source is over the ${MAX_PLUGIN_BYTES} byte budget`,
      'a plugin must stay lightweight: remove embedded assets, or split it',
    );
  const seen = new Set<string>();
  for (const id of [...(m.templates ?? []).map((t) => t.id), ...(m.effects ?? []).map((e) => e.id)]) {
    if (seen.has(id)) throw new PluginError(`${m.id}: "${id}" is declared twice`);
    seen.add(id);
  }
  if ((m.templates?.length ?? 0) > 0 && !m.page)
    throw new PluginError(`${m.id}: templates need a "page" file with their drawing code`);
  let pageCode: string | undefined;
  if (m.page) {
    const p = inside(root, m.page);
    if (!existsSync(p)) throw new PluginError(`${m.id}: page file ${m.page} is missing`);
    pageCode = readFileSync(p, 'utf8');
  }
  for (const s of m.scripts ?? [])
    if (!existsSync(inside(root, s.file))) throw new PluginError(`${m.id}: script file ${s.file} is missing`);
  for (const t of m.templates ?? [])
    for (const [k, ps] of Object.entries(t.props))
      if (ps.type === 'enum' && !ps.values?.length)
        throw new PluginError(`${m.id}: template ${t.id} prop ${k} is an enum without values`);
  for (const e of m.effects ?? []) {
    if (!SAFE_GRAPH.test(e.graph)) throw new PluginError(`${m.id}: effect ${e.id} graph has a disallowed character`);
    if (!e.graph.includes('[in]') || !e.graph.includes('[out]'))
      throw new PluginError(`${m.id}: effect ${e.id} graph must read [in] and write [out]`);
    for (const b of BANNED_FILTERS)
      if (new RegExp(`(^|[;,\\]\\s])${b}\\s*[=,;\\[]`).test(e.graph) || new RegExp(`(^|[;,\\]\\s])${b}$`).test(e.graph))
        throw new PluginError(`${m.id}: effect ${e.id} uses the "${b}" filter, which reads files or runs code`);
    const used = graphParams(e.graph);
    for (const u of used) {
      const base = u.replace(/\.[rgb]$/, '');
      const ok = (BUILTIN_VARS as readonly string[]).includes(u) || (base in e.params && (u === base || e.params[base]!.type === 'color'));
      if (!ok) throw new PluginError(`${m.id}: effect ${e.id} graph uses {${u}} but declares no such param`);
    }
    for (const [k, ps] of Object.entries(e.params)) {
      if (ps.type === 'enum' && !ps.values?.includes(String(ps.default)))
        throw new PluginError(`${m.id}: effect ${e.id} param ${k} default is not in its values`);
      if (ps.type === 'number' && (ps.min === undefined || ps.max === undefined))
        throw new PluginError(`${m.id}: effect ${e.id} param ${k} needs min and max`);
      if (ps.type === 'color' && !(typeof ps.default === 'string' && HEX6.test(ps.default)))
        throw new PluginError(`${m.id}: effect ${e.id} param ${k} default must be #RRGGBB`);
      if (ps.type === 'points' && !(typeof ps.default === 'string' && validPoints(ps.default)))
        throw new PluginError(`${m.id}: effect ${e.id} param ${k} default is not a valid curve like "0/0 0.5/0.6 1/1"`);
    }
  }
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(f.slice(root.length)).update(readFileSync(f));
  return {
    manifest: m,
    dir: root,
    source,
    bytes,
    hash: h.digest('hex').slice(0, 12),
    ...(pageCode !== undefined ? { pageCode } : {}),
  };
}

/** Every plugin under `<base>/plugins/*`, bad ones reported instead of hidden. */
export function discoverIn(
  base: string,
  source: LoadedPlugin['source'],
): { plugins: LoadedPlugin[]; errors: { dir: string; message: string; fix?: string }[] } {
  const root = join(base, 'plugins');
  const plugins: LoadedPlugin[] = [];
  const errors: { dir: string; message: string; fix?: string }[] = [];
  if (!existsSync(root)) return { plugins, errors };
  for (const n of readdirSync(root).sort()) {
    const d = join(root, n);
    if (!statSync(d).isDirectory()) continue;
    try {
      plugins.push(loadPlugin(d, source));
    } catch (e) {
      const err = e as PluginError;
      errors.push({ dir: d, message: err.message, ...(err.fix ? { fix: err.fix } : {}) });
    }
  }
  return { plugins, errors };
}

/** Checks a parameter set against an effect's declaration and fills defaults; returns the values to substitute. */
export function resolveEffectParams(
  decl: z.infer<typeof EffectDecl>,
  given: Record<string, unknown> | undefined,
): Record<string, string> {
  const problems: string[] = [];
  const out: Record<string, string> = {};
  const g = given ?? {};
  for (const k of Object.keys(g)) if (!(k in decl.params)) problems.push(`unknown param "${k}"`);
  for (const [k, ps] of Object.entries(decl.params)) {
    const v = g[k] !== undefined ? g[k] : ps.default;
    if (ps.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`param "${k}": expected a number`);
      else if (v < ps.min! || v > ps.max!) problems.push(`param "${k}": ${v} is outside ${ps.min}..${ps.max}`);
      else out[k] = String(ps.integer ? Math.round(v) : Math.round(v * 10000) / 10000);
    } else if (ps.type === 'boolean') {
      if (typeof v !== 'boolean') problems.push(`param "${k}": expected true or false`);
      else out[k] = v ? '1' : '0';
    } else if (ps.type === 'color') {
      if (typeof v !== 'string' || !HEX6.test(v)) problems.push(`param "${k}": expected a #RRGGBB color`);
      else {
        const n = parseInt(v.slice(1), 16);
        out[`${k}.r`] = String(Math.round(((n >> 16) & 255) / 2.55) / 100);
        out[`${k}.g`] = String(Math.round(((n >> 8) & 255) / 2.55) / 100);
        out[`${k}.b`] = String(Math.round((n & 255) / 2.55) / 100);
        out[k] = v.slice(1);
      }
    } else if (ps.type === 'points') {
      if (typeof v !== 'string' || !validPoints(v))
        problems.push(`param "${k}": expected curve points like "0/0 0.5/0.6 1/1" (x increasing, 0..1, 2 to 12 points)`);
      else out[k] = v;
    } else if (typeof v !== 'string' || !ps.values?.includes(v))
      problems.push(`param "${k}": expected one of ${ps.values?.join(', ')}`);
    else out[k] = v;
  }
  if (problems.length) throw new PluginError(`${decl.id}: ${problems.join('; ')}`);
  return out;
}
