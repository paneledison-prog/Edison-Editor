/**
 * Plugin activation. Plugins come from two places: `<studio>/plugins` (shipped) and `<project>/plugins`
 * (the user's own). Activation registers each plugin's templates in the motion catalogue and remembers its
 * effects, so every other part of Studio (the CLI, the renderer, the UI server) sees them like built-ins.
 */
import {
  discoverIn,
  graphParams,
  resolveEffectParams,
  PluginError,
  type LoadedPlugin,
  type Manifest,
} from '@studio/core';
import { registerTemplate, TEMPLATES, type TemplateSpec } from '@studio/motion';
import { studioRoot } from './models.js';
import { EngineError } from './run.js';

type EffectDecl = NonNullable<Manifest['effects']>[number];

const active = new Map<string, LoadedPlugin>();
const effects = new Map<string, { plugin: LoadedPlugin; decl: EffectDecl }>();
const owner = new Map<string, LoadedPlugin>();
let loadedFor: string | undefined;
let problems: { dir: string; message: string; fix?: string }[] = [];

export function activatePlugins(projectDir: string): void {
  if (loadedFor === projectDir) return;
  for (const id of owner.keys()) delete TEMPLATES[id];
  active.clear();
  effects.clear();
  owner.clear();
  problems = [];
  const shipped = discoverIn(studioRoot(), 'builtin');
  const mine = projectDir === studioRoot() ? { plugins: [], errors: [] } : discoverIn(projectDir, 'project');
  problems.push(...shipped.errors, ...mine.errors);
  for (const p of [...shipped.plugins, ...mine.plugins]) {
    const id = p.manifest.id;
    const clash = (what: string) => {
      problems.push({ dir: p.dir, message: `${id}: ${what}`, fix: 'rename the id or remove the duplicate' });
    };
    if (active.has(id)) {
      clash(`a plugin with this id is already loaded from ${active.get(id)!.dir}`);
      continue;
    }
    let ok = true;
    for (const t of p.manifest.templates ?? [])
      if (TEMPLATES[t.id]) {
        clash(`template "${t.id}" already exists`);
        ok = false;
      }
    for (const e of p.manifest.effects ?? [])
      if (effects.has(e.id)) {
        clash(`effect "${e.id}" already exists`);
        ok = false;
      }
    if (!ok) continue;
    active.set(id, p);
    for (const t of p.manifest.templates ?? []) {
      registerTemplate(t as TemplateSpec);
      owner.set(t.id, p);
    }
    for (const e of p.manifest.effects ?? []) effects.set(e.id, { plugin: p, decl: e });
  }
  loadedFor = projectDir;
}

export const loadedPlugins = (): LoadedPlugin[] => [...active.values()];
export const pluginProblems = () => problems;
/** The plugin that owns a template id, if it is not built in. */
export const pluginForTemplate = (comp: string): LoadedPlugin | undefined => owner.get(comp);
export const pluginEffects = () => [...effects.values()];

/** What a graph may use of the clip it runs on: `{W}` `{H}` canvas size, `{T0}` clip start (s), `{FPS}` project rate, `{SRCFPS}`, `{SPEED}`, `{INTERPFPS}`. */
export interface FxContext {
  W: number;
  H: number;
  FPS: number;
  SRCFPS: number;
  SPEED: number;
  /** the clip's start on the timeline, in seconds: lets a generated source line up with the clip's timestamps */
  T0: number;
}

export const pluginEffectDecl = (id: string) => effects.get(id)?.decl;

/**
 * The FFmpeg lines for one plugin effect: it reads `from` and writes `to`.
 * Internal labels get a per-clip suffix; parameters are validated and substituted; built-in variables are filled from `ctx`.
 */
export function effectLines(
  fx: { id: string; params?: Record<string, unknown> },
  from: string,
  to: string,
  uid: string,
  ctx: FxContext = { W: 1280, H: 720, FPS: 24, SRCFPS: 24, SPEED: 1, T0: 0 },
): string[] {
  const e = effects.get(fx.id);
  if (!e)
    throw new EngineError(
      'INVALID_INPUT',
      `no plugin effect "${fx.id}"; available: ${[...effects.keys()].join(', ') || 'none'}`,
      'studio plugins list shows the effects',
    );
  let values: Record<string, string>;
  try {
    values = resolveEffectParams(e.decl, fx.params);
  } catch (err) {
    throw new EngineError('INVALID_INPUT', (err as PluginError).message, `studio plugins list --id ${e.plugin.manifest.id}`);
  }
  const interp = Math.min(120, Math.max(ctx.SRCFPS, Math.round(ctx.SRCFPS / Math.max(ctx.SPEED, 0.05))));
  const builtin: Record<string, string> = {
    W: String(ctx.W),
    H: String(ctx.H),
    FPS: String(ctx.FPS),
    SRCFPS: String(Math.round(ctx.SRCFPS * 1000) / 1000),
    SPEED: String(ctx.SPEED),
    INTERPFPS: String(interp),
    T0: String(Math.round(ctx.T0 * 1000) / 1000),
  };
  let g = e.decl.graph;
  for (const k of graphParams(g)) g = g.replaceAll(`{${k}}`, values[k] ?? builtin[k]!);
  // rename every label except [in] and [out]
  g = g.replace(/\[([A-Za-z0-9_]+)\]/g, (m, name: string) =>
    name === 'in' ? `[${from}]` : name === 'out' ? `[${to}]` : `[${name}_${uid}]`,
  );
  return splitGraph(g);
}

/** Splits a filtergraph on `;` that are outside single quotes (an expression may contain `;`). */
export function splitGraph(g: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of g) {
    if (ch === "'") q = !q;
    if (ch === ';' && !q) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
