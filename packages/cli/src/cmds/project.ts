import {
  OpError,
  ProjectStore,
  stacksFromLog,
  timelineDuration,
  validateProject,
  type LogEntry,
} from '@studio/core';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num, runSpecs, str, store, stepResult } from './shared.js';

export const init: Handler = async (inv) => {
  const name = inv.positionals[0];
  if (!name) throw new CliError('INVALID_ARGS', 'missing project name', 2, 'studio init <name>');
  const meta = {
    name,
    ...(num(inv, 'width') !== undefined ? { width: num(inv, 'width')! } : {}),
    ...(num(inv, 'height') !== undefined ? { height: num(inv, 'height')! } : {}),
    ...(num(inv, 'fps') !== undefined ? { fps: num(inv, 'fps')! } : {}),
    ...(typeof inv.flags['background'] === 'string' ? { background: inv.flags['background'] } : {}),
  };
  const s = new ProjectStore(inv.dir);
  const exists = (await import('node:fs')).existsSync(s.projectPath);
  if (exists && !inv.force)
    throw new CliError(
      'WOULD_OVERWRITE',
      `${s.projectPath} already exists`,
      5,
      'pass --force to overwrite (this also clears the op log)',
    );
  if (inv.dryRun)
    return {
      data: {
        dir: inv.dir,
        meta,
        wouldCreate: [
          'project.studio.json',
          'ops.log.jsonl',
          'assets/',
          '.studio/cache/',
          'renders/',
          'brand/',
        ],
      },
    };
  ProjectStore.init(inv.dir, meta, inv.force);
  return {
    data: { dir: inv.dir, meta: s.load().project.meta },
    artifacts: [{ kind: 'project', path: 'project.studio.json' }],
  };
};

export const set: Handler = async (inv) => {
  const patch: Record<string, unknown> = {};
  for (const k of ['width', 'height', 'fps'] as const)
    if (num(inv, k) !== undefined) patch[k] = num(inv, k);
  for (const k of ['name', 'background'] as const)
    if (str(inv, k) !== undefined) patch[k] = str(inv, k);
  const res = runSpecs(inv, [{ type: 'project.set', args: { patch } }], 'project set');
  return {
    ...res,
    warnings: [
      ...(patch['width'] !== undefined ||
      patch['height'] !== undefined ||
      patch['fps'] !== undefined
        ? [
            'canvas size or frame rate changed: cached motion overlays are keyed by size and fps, so they render again on the next render',
          ]
        : []),
    ],
  };
};

export const show: Handler = async (inv) => {
  const { project, log, driftedFromLog } = store(inv).load();
  const st = stacksFromLog(log);
  const clipsBy = (id: string) => project.clips.filter((c) => c.track === id).length;
  return {
    data: {
      meta: project.meta,
      timelineMs: timelineDuration(project),
      assets: Object.entries(project.assets).map(([id, a]) => ({
        id,
        path: a.path,
        kind: a.kind,
        durMs: a.probe.durMs,
        w: a.probe.w,
        h: a.probe.h,
        rotation: a.probe.rotation,
        vfr: a.probe.vfr,
        hash: a.hash.split(':')[0],
        workingCopy: a.workingCopy?.path,
      })),
      tracks: project.tracks.map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        clips: clipsBy(t.id),
      })),
      clips: project.clips.length,
      markers: project.markers.length,
      exports: project.exports.map((e) => e.id),
      undoDepth: st.undo.length,
      redoDepth: st.redo.length,
      logEntries: log.length,
      ...(inv.flags['full'] ? { project } : {}),
    },
    warnings: driftedFromLog
      ? ['project.studio.json differs from the last log entry: it was edited outside ops']
      : [],
  };
};

export const validate: Handler = async (inv) => {
  const { project, driftedFromLog } = store(inv).load();
  const issues = validateProject(project);
  if (issues.length)
    throw new OpError('VALIDATION', `${issues.length} issue(s): ${issues[0]!.message}`, issues);
  return {
    data: { valid: true, clips: project.clips.length, driftedFromLog },
    warnings: driftedFromLog
      ? [
          'file differs from the last log entry (edited outside ops); undo history may not apply cleanly',
        ]
      : [],
  };
};

const brief = (e: LogEntry) => ({
  id: e.id,
  kind: e.kind,
  actor: e.actor,
  ts: e.ts,
  ...(e.kind === 'apply' && e.label ? { label: e.label } : {}),
  ...(e.kind !== 'apply' ? { target: e.target } : {}),
  ops: e.ops.map((o: any) => o.type),
});

export const log: Handler = async (inv) => {
  const entries = store(inv).readLog();
  const limit = num(inv, 'limit') ?? 20;
  return { data: { total: entries.length, entries: entries.slice(-limit).map(brief) } };
};

export const diff: Handler = async (inv) => {
  const id = inv.positionals[0];
  if (!id) throw new CliError('INVALID_ARGS', 'missing id', 2, 'studio project diff <txnId|opId>');
  const entries = store(inv).readLog();
  const e =
    entries.find((x) => x.id === id) ??
    entries.find((x) => x.kind === 'apply' && x.ops.some((o) => o.id === id));
  if (!e) throw new OpError('NOT_FOUND', `no log entry or op with id ${id}`);
  return {
    data: {
      ...brief(e),
      before: e.before,
      after: e.after,
      ops: e.ops.map((o: any) => ({
        ...(o.id ? { id: o.id } : {}),
        type: o.type,
        args: o.args,
        ...(o.inverse ? { inverse: o.inverse } : {}),
      })),
    },
  };
};

/** Undo/redo n transactions. A dry run previews exactly one step, since later steps depend on earlier ones. */
async function many(inv: Parameters<Handler>[0], kind: 'undo' | 'redo') {
  const n = num(inv, 'n') ?? 1;
  if (!Number.isInteger(n) || n < 1)
    throw new CliError('INVALID_ARGS', '--n must be a positive integer');
  if (inv.dryRun && n > 1)
    throw new CliError('INVALID_ARGS', '--dry-run previews one step; use --n 1');
  const s = store(inv);
  const steps: string[] = [];
  let last;
  for (let i = 0; i < n; i++) {
    last = s[kind]({ actor: inv.actor, dryRun: inv.dryRun });
    steps.push(last.entry.id);
  }
  const res = stepResult(last!, inv);
  return { ...res, data: { ...(res.data as object), steps } };
}
export const undo: Handler = (inv) => many(inv, 'undo');
export const redo: Handler = (inv) => many(inv, 'redo');
