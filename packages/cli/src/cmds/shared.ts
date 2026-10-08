import { ProjectStore, timelineDuration, type OpSpec, type Step } from '@studio/core';
import type { Invocation } from '../main.js';
import type { Success } from '../output.js';

export const store = (inv: Invocation) => new ProjectStore(inv.dir);

export const str = (inv: Invocation, k: string): string | undefined => {
  const v = inv.flags[k];
  return typeof v === 'string' ? v : undefined;
};
export const num = (inv: Invocation, k: string): number | undefined => {
  const v = inv.flags[k];
  return typeof v === 'number' ? v : undefined;
};

export function parseJson(label: string, text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`${label} is not valid JSON: ${(e as Error).message}`);
    (err as any).code = 'INVALID_ARGS';
    throw err;
  }
}

export function stepResult(step: Step, inv: Invocation): Success {
  const e = step.entry;
  return {
    data: {
      txn: e.id,
      kind: e.kind,
      dryRun: inv.dryRun || undefined,
      ops: e.ops.map((o: any) => ({
        id: o.id,
        type: o.type,
        ...(o.args?.id ? { target: o.args.id } : {}),
      })),
      timelineMs: timelineDuration(step.project),
      before: e.before,
      after: e.after,
    },
    artifacts: inv.dryRun ? [] : [{ kind: 'project', path: 'project.studio.json' }],
    opId: e.kind === 'apply' ? (e.ops[0] as any)?.id : undefined,
  };
}

export function runSpecs(inv: Invocation, specs: OpSpec[], label?: string): Success {
  const step = store(inv).apply(specs, { actor: inv.actor, label, dryRun: inv.dryRun });
  return stepResult(step, inv);
}

import { join } from 'node:path';
import { speedOf, type Clip, type Project } from '@studio/core';
import { CliError } from '../args.js';

export interface ClipCtx {
  project: Project;
  clip: Clip;
  assetId: string;
  asset: Project['assets'][string];
  /** the file the renderer reads for this asset */
  src: string;
  /** hash digits, the cache directory name */
  hex: string;
  channels: number;
  speed: number;
  /** source range the clip consumes (ms) */
  srcFromMs: number;
  srcToMs: number;
}

/** Looks up a clip and the source it reads, the way the renderer will. */
export function clipContext(inv: Invocation, clipId: string | undefined): ClipCtx {
  if (!clipId)
    throw new CliError(
      'INVALID_ARGS',
      'missing --clip',
      2,
      `studio ${inv.meta.usage.replace('studio ', '')}`,
    );
  const { project } = store(inv).load();
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip)
    throw new CliError(
      'INVALID_ARGS',
      `clip ${clipId} not found`,
      2,
      'studio project show lists clips',
    );
  if (!clip.asset)
    throw new CliError('INVALID_ARGS', `clip ${clipId} is a composition and has no source media`);
  const asset = project.assets[clip.asset]!;
  const speed = speedOf(clip);
  const srcFromMs = clip.srcIn ?? 0;
  return {
    project,
    clip,
    assetId: clip.asset,
    asset,
    src: join(inv.dir, asset.workingCopy?.path ?? asset.path),
    hex: asset.hash.split(':')[1]!,
    channels: asset.probe.audio?.ch ?? 0,
    speed,
    srcFromMs,
    srcToMs: srcFromMs + Math.round(clip.dur * speed),
  };
}

export interface SelfResult {
  code: number;
  json: any;
  stderr: string;
}
/** Runs another `studio` command in a project directory (same bundle) and returns its JSON, without throwing on failure. */
export function selfRun(
  dir: string,
  args: string[],
  log?: (m: string) => void,
): Promise<SelfResult> {
  return new Promise((resolveP) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(
        process.execPath,
        [process.argv[1]!, ...args, '--project', dir],
        { maxBuffer: 512 * 1024 * 1024, timeout: 3 * 3600_000 },
        (err, stdout, stderr) => {
          let json: any;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          if (log && stderr)
            for (const l of stderr.split('\n').filter(Boolean).slice(-3)) log(`  ${l}`);
          resolveP({ code: err ? ((err as any).code as number) || 1 : 0, json, stderr });
        },
      );
    });
  });
}

/** Like selfRun, but a failure becomes a CliError carrying the child's message, so a build stops at the failing step. */
export async function must(dir: string, args: string[], log?: (m: string) => void): Promise<any> {
  const r = await selfRun(dir, args, log);
  if (r.code !== 0 || !r.json?.ok) {
    const e = r.json?.error;
    const err = new Error(
      `step "studio ${args.slice(0, 2).join(' ')}" failed: ${e?.message ?? (r.stderr.trim().split('\n').pop() || 'exit ' + r.code)}`,
    );
    (err as any).code = e?.code ?? 'ENGINE_FAILED';
    (err as any).fix = e?.fix;
    (err as any).exit = r.code === 2 || r.code === 3 || r.code === 4 || r.code === 5 ? r.code : 1;
    throw err;
  }
  return r.json;
}
