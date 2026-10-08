/**
 * Where a design lives: `design.studio.json` and `design.ops.log.jsonl` in a design project folder, next to `assets/`
 * and `renders/`. It never reads or writes `project.studio.json`: a design and a media project can share a folder
 * without touching each other.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyBatch, defaultCtx, inverseSpecs, makeTxId, type Actor, type Ctx, type Op, type OpSpec,
} from './ops.js';
import { DesignSchema, emptyDesign, type Design, type Meta } from './schema.js';
import { canonicalize, OpError } from './util.js';
import { validateDesign } from './validate.js';

export const DESIGN_FILE = 'design.studio.json';
export const DESIGN_LOG = 'design.ops.log.jsonl';

export type LogEntry =
  | { kind: 'apply'; id: string; actor: Actor; ts: number; label?: string; before: string; after: string; ops: Op[] }
  | { kind: 'undo' | 'redo'; id: string; actor: Actor; ts: number; target: string; before: string; after: string; ops: OpSpec[] };

export interface Step {
  design: Design;
  entry: LogEntry;
}

export const designHash = (d: Design) => 'sha256:' + createHash('sha256').update(canonicalize(d)).digest('hex');

function atomicWrite(path: string, data: string) {
  const tmp = path + '.partial';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function stacks(log: LogEntry[]) {
  const s = { undo: [] as string[], redo: [] as string[], txns: new Map<string, Extract<LogEntry, { kind: 'apply' }>>() };
  for (const e of log) {
    if (e.kind === 'apply') {
      s.txns.set(e.id, e);
      s.undo.push(e.id);
      s.redo = [];
    } else if (e.kind === 'undo') {
      if (s.undo.pop() !== e.target) throw new Error(`log is inconsistent: undo of ${e.target}`);
      s.redo.push(e.target);
    } else {
      if (s.redo.pop() !== e.target) throw new Error(`log is inconsistent: redo of ${e.target}`);
      s.undo.push(e.target);
    }
  }
  return s;
}

export class DesignStore {
  constructor(public readonly dir: string) {}
  get file() {
    return join(this.dir, DESIGN_FILE);
  }
  get logFile() {
    return join(this.dir, DESIGN_LOG);
  }
  static exists(dir: string) {
    return existsSync(join(dir, DESIGN_FILE));
  }

  static init(dir: string, meta: Partial<Meta> & { name: string }, force = false): DesignStore {
    const s = new DesignStore(dir);
    if (existsSync(s.file) && !force) throw new OpError('INVALID_ARGS', `${DESIGN_FILE} already exists in ${dir}; pass --force to overwrite`);
    for (const d of ['assets', 'renders']) mkdirSync(join(dir, d), { recursive: true });
    const d = emptyDesign(meta);
    const parsed = DesignSchema.safeParse(d);
    if (!parsed.success) throw new OpError('INVALID_ARGS', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    atomicWrite(s.file, canonicalize(parsed.data));
    writeFileSync(s.logFile, '');
    return s;
  }

  load(): { design: Design; log: LogEntry[]; driftedFromLog: boolean } {
    if (!existsSync(this.file)) throw new OpError('NOT_FOUND', `no ${DESIGN_FILE} in ${this.dir}; run \`studio design new <name>\``);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      throw new OpError('VALIDATION', `${DESIGN_FILE} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = DesignSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      throw new OpError('VALIDATION', `${DESIGN_FILE}: ${i.path.join('.')} ${i.message}`);
    }
    const issues = validateDesign(parsed.data);
    if (issues.length) throw new OpError('VALIDATION', `${DESIGN_FILE}: ${issues[0]!.message}`, issues);
    const log = this.readLog();
    const last = log[log.length - 1];
    return { design: parsed.data, log, driftedFromLog: !!last && last.after !== designHash(parsed.data) };
  }

  readLog(): LogEntry[] {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l, i) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          throw new OpError('VALIDATION', `${DESIGN_LOG} line ${i + 1} is not valid JSON`);
        }
      });
  }

  private commit(step: Step, dry: boolean): Step {
    if (!dry) {
      atomicWrite(this.file, canonicalize(step.design));
      appendFileSync(this.logFile, JSON.stringify(step.entry) + '\n');
    }
    return step;
  }

  /** The agent's CLI and the editor server may write at once: a lock directory serializes read-modify-write. */
  private locked<T>(fn: () => T): T {
    const lock = join(this.dir, '.studio', 'design.lock');
    mkdirSync(dirname(lock), { recursive: true });
    const until = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
        } catch {
          /* released between the two calls */
        }
        if (Date.now() > until) throw new OpError('INVALID_ARGS', `the design is locked by another writer (${lock})`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  private taken(log: LogEntry[]) {
    return new Set(log.map((e) => e.id));
  }

  apply(specs: OpSpec[], o: { actor?: Actor; label?: string; dryRun?: boolean; ctx?: Ctx } = {}): Step {
    return this.locked(() => {
      const { design, log } = this.load();
      const ctx = o.ctx ?? defaultCtx(o.actor ?? 'agent');
      const r = applyBatch(design, specs, ctx);
      const entry: LogEntry = {
        kind: 'apply', id: makeTxId(this.taken(log), ctx), actor: ctx.actor, ts: ctx.now(),
        ...(o.label ? { label: o.label } : {}), before: designHash(design), after: designHash(r.design), ops: r.ops,
      };
      return this.commit({ design: r.design, entry }, !!o.dryRun);
    });
  }

  private walk(kind: 'undo' | 'redo', o: { actor?: Actor; dryRun?: boolean; ctx?: Ctx }): Step {
    return this.locked(() => {
      const { design, log } = this.load();
      const ctx = o.ctx ?? defaultCtx(o.actor ?? 'agent');
      const st = stacks(log);
      const target = (kind === 'undo' ? st.undo : st.redo).at(-1);
      if (!target) throw new OpError('NOT_FOUND', `nothing to ${kind}`);
      const txn = st.txns.get(target)!;
      const specs = kind === 'undo' ? inverseSpecs(txn.ops) : txn.ops.map((x) => ({ type: x.type, args: x.args }));
      const r = applyBatch(design, specs, ctx);
      const entry: LogEntry = {
        kind, id: makeTxId(this.taken(log), ctx), actor: ctx.actor, ts: ctx.now(), target,
        before: designHash(design), after: designHash(r.design), ops: specs,
      };
      return this.commit({ design: r.design, entry }, !!o.dryRun);
    });
  }
  undo(o: { actor?: Actor; dryRun?: boolean; ctx?: Ctx } = {}) {
    return this.walk('undo', o);
  }
  redo(o: { actor?: Actor; dryRun?: boolean; ctx?: Ctx } = {}) {
    return this.walk('redo', o);
  }
  stacks() {
    return stacks(this.readLog());
  }
}
