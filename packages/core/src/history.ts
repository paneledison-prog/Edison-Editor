import {
  applyBatch,
  defaultCtx,
  inverseSpecs,
  makeTxId,
  OpError,
  type Actor,
  type Ctx,
  type Op,
  type OpSpec,
} from './ops.js';
import type { Project } from './schema.js';

/** One line of ops.log.jsonl. Append-only; undo and redo are entries, history is never rewritten. */
export type LogEntry =
  | {
      kind: 'apply';
      id: string;
      actor: Actor;
      ts: number;
      label?: string;
      before: string;
      after: string;
      ops: Op[];
    }
  | {
      kind: 'undo';
      id: string;
      actor: Actor;
      ts: number;
      target: string;
      before: string;
      after: string;
      ops: OpSpec[];
    }
  | {
      kind: 'redo';
      id: string;
      actor: Actor;
      ts: number;
      target: string;
      before: string;
      after: string;
      ops: OpSpec[];
    };

export interface Stacks {
  undo: string[]; // txn ids, top is last
  redo: string[];
  txns: Map<string, Extract<LogEntry, { kind: 'apply' }>>;
}

export function stacksFromLog(log: LogEntry[]): Stacks {
  const s: Stacks = { undo: [], redo: [], txns: new Map() };
  for (const e of log) {
    if (e.kind === 'apply') {
      s.txns.set(e.id, e);
      s.undo.push(e.id);
      s.redo = [];
    } else if (e.kind === 'undo') {
      const top = s.undo.pop();
      if (top !== e.target)
        throw new Error(`log is inconsistent: undo of ${e.target} but top was ${top}`);
      s.redo.push(e.target);
    } else {
      const top = s.redo.pop();
      if (top !== e.target)
        throw new Error(`log is inconsistent: redo of ${e.target} but top was ${top}`);
      s.undo.push(e.target);
    }
  }
  return s;
}

export interface Step {
  project: Project;
  entry: LogEntry;
}

/** Applies a new transaction. `hash` computes the canonical project hash (injected to keep this module pure). */
export function stepApply(
  project: Project,
  specs: OpSpec[],
  ctx: Ctx,
  hash: (p: Project) => string,
  taken: ReadonlySet<string>,
  label?: string,
): Step {
  const r = applyBatch(project, specs, ctx);
  return {
    project: r.project,
    entry: {
      kind: 'apply',
      id: makeTxId(taken, ctx),
      actor: ctx.actor,
      ts: ctx.now(),
      ...(label ? { label } : {}),
      before: hash(project),
      after: hash(r.project),
      ops: r.ops,
    },
  };
}

export function stepUndo(
  project: Project,
  log: LogEntry[],
  ctx: Ctx,
  hash: (p: Project) => string,
  taken: ReadonlySet<string>,
): Step {
  const st = stacksFromLog(log);
  const target = st.undo[st.undo.length - 1];
  if (!target) throw new OpError('NOT_FOUND', 'nothing to undo');
  const specs = inverseSpecs(st.txns.get(target)!.ops);
  const r = applyBatch(project, specs, ctx);
  return {
    project: r.project,
    entry: {
      kind: 'undo',
      id: makeTxId(taken, ctx),
      actor: ctx.actor,
      ts: ctx.now(),
      target,
      before: hash(project),
      after: hash(r.project),
      ops: specs,
    },
  };
}

export function stepRedo(
  project: Project,
  log: LogEntry[],
  ctx: Ctx,
  hash: (p: Project) => string,
  taken: ReadonlySet<string>,
): Step {
  const st = stacksFromLog(log);
  const target = st.redo[st.redo.length - 1];
  if (!target) throw new OpError('NOT_FOUND', 'nothing to redo');
  const specs: OpSpec[] = st.txns.get(target)!.ops.map((o) => ({ type: o.type, args: o.args }));
  const r = applyBatch(project, specs, ctx);
  return {
    project: r.project,
    entry: {
      kind: 'redo',
      id: makeTxId(taken, ctx),
      actor: ctx.actor,
      ts: ctx.now(),
      target,
      before: hash(project),
      after: hash(r.project),
      ops: specs,
    },
  };
}

export { defaultCtx };
