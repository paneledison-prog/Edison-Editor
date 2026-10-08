import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileExpr } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { easeFns } from './expr.js';
import { must, parseJson, store, str } from './shared.js';

interface Found {
  name: string;
  file: string;
  where: 'project' | 'library' | 'plugin';
  summary?: string;
}

async function find(inv: Parameters<Handler>[0]): Promise<Found[]> {
  const E = await import('@studio/engines');
  const out: Found[] = [];
  // A file counts as a Studio script only if it declares `meta` and a default export. This is checked by
  // reading the text, so listing never runs a file that merely sits in a folder (a build script, say).
  const isScript = (f: string) => {
    const t = readFileSync(f, 'utf8');
    return /export\s+const\s+meta\b/.test(t) && /export\s+default\b/.test(t);
  };
  const scan = (dir: string, where: Found['where']) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const n of readdirSync(dir).sort()) {
      const file = join(dir, n);
      if (n.endsWith('.mjs') && isScript(file)) out.push({ name: n.slice(0, -4), file, where });
    }
  };
  scan(join(inv.dir, 'scripts'), 'project');
  scan(join(E.studioRoot(), 'studio-scripts'), 'library');
  for (const p of E.loadedPlugins())
    for (const s of p.manifest.scripts ?? [])
      out.push({ name: `${p.manifest.id}/${s.name}`, file: join(p.dir, s.file), where: 'plugin', summary: s.summary });
  return out;
}

async function meta(f: Found): Promise<{ summary?: string; args?: Record<string, any> }> {
  try {
    const m = await import(pathToFileURL(f.file).href);
    return { summary: m.meta?.summary ?? f.summary, args: m.meta?.args ?? {} };
  } catch {
    return { summary: f.summary };
  }
}

export const list: Handler = async (inv) => {
  const found = await find(inv);
  const scripts = [];
  for (const f of found) scripts.push({ name: f.name, where: f.where, ...(await meta(f)) });
  return { data: { scripts } };
};

/**
 * Runs a script in this process. Scripts are local code you chose to run, like any shell script; what they
 * can change in the project is limited to `studio` commands, so every change is a validated, logged, undoable op.
 */
export const run: Handler = async (inv) => {
  const name = inv.positionals[0];
  if (!name) throw new CliError('INVALID_ARGS', 'give a script name', 2, 'studio script list');
  const f = (await find(inv)).find((s) => s.name === name);
  if (!f)
    throw new CliError('NOT_FOUND', `no script "${name}"`, 2, 'studio script list shows the library, the project, and plugins');
  const mod = await import(pathToFileURL(f.file).href);
  if (typeof mod.default !== 'function')
    throw new CliError('INVALID_INPUT', `${name} must export a default async function`, 2);
  const given = inv.flags['args'] ? parseJson('--args', String(inv.flags['args'])) : {};
  const args: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries<any>(mod.meta?.args ?? {})) {
    const v = given[k] ?? spec.default;
    if (v === undefined && spec.required)
      throw new CliError('INVALID_ARGS', `script ${name}: argument "${k}" is required (${spec.desc ?? ''})`, 2);
    if (v !== undefined) args[k] = v;
  }
  for (const k of Object.keys(given))
    if (!(k in (mod.meta?.args ?? {}))) throw new CliError('INVALID_ARGS', `script ${name}: unknown argument "${k}"`, 2);
  if (inv.dryRun) return { data: { wouldRun: name, args } };
  const steps: string[] = [];
  const api = {
    args,
    dir: inv.dir,
    get project() {
      return store(inv).load().project;
    },
    async studio(argv: string[]) {
      steps.push(argv.slice(0, 2).join(' '));
      return (await must(inv.dir, argv, inv.log)).data;
    },
    expr: (src: string, vars: Record<string, number>) => compileExpr(src, easeFns() as never)(vars),
    log: inv.log,
  };
  const result = await mod.default(api);
  return { data: { script: name, args, result: result ?? null, studioCalls: steps.length, steps } };
};
