import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { assertAgentIdle } from '@studio/workspace';
import { canonicalize, projectHash } from './canonical.js';
import {
  stepApply,
  stepRedo,
  stepUndo,
  stacksFromLog,
  type LogEntry,
  type Step,
} from './history.js';
import { defaultCtx, OpError, type Actor, type Ctx, type OpSpec } from './ops.js';
import {
  emptyProject,
  migrateToCurrent,
  ProjectSchema,
  type Meta,
  type Project,
} from './schema.js';
import { validateProject } from './validate.js';

export const PROJECT_FILE = 'project.studio.json';
export const LOG_FILE = 'ops.log.jsonl';

export interface Loaded {
  project: Project;
  log: LogEntry[];
  /** True when project.studio.json no longer matches the last log entry (edited outside ops). */
  driftedFromLog: boolean;
}

/** Write via a .partial file then rename, so a crash never leaves a half-written project. */
export function atomicWrite(path: string, data: string): void {
  const tmp = path + '.partial';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class ProjectStore {
  constructor(public readonly dir: string) {}
  get projectPath() {
    return join(this.dir, PROJECT_FILE);
  }
  get logPath() {
    return join(this.dir, LOG_FILE);
  }

  static init(dir: string, meta: Partial<Meta> & { name: string }, force = false): ProjectStore {
    const s = new ProjectStore(dir);
    if (existsSync(s.projectPath) && !force) {
      throw new OpError(
        'INVALID_ARGS',
        `${s.projectPath} already exists; pass --force to overwrite`,
      );
    }
    for (const d of ['assets', '.studio/cache', 'renders', 'brand'])
      mkdirSync(join(dir, d), { recursive: true });
    const p = emptyProject(meta);
    const issues = validateProject(p);
    if (issues.length) throw new OpError('VALIDATION', issues[0]!.message, issues);
    atomicWrite(s.projectPath, canonicalize(p));
    if (!existsSync(s.logPath) || force) writeFileSync(s.logPath, '');
    return s;
  }

  load(): Loaded {
    if (!existsSync(this.projectPath)) {
      throw new OpError(
        'NOT_FOUND',
        `no ${PROJECT_FILE} in ${this.dir}; run \`studio init <name>\``,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.projectPath, 'utf8'));
    } catch (e) {
      throw new OpError('VALIDATION', `${PROJECT_FILE} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = ProjectSchema.safeParse(migrateToCurrent(raw));
    if (!parsed.success) {
      throw new OpError(
        'VALIDATION',
        `${PROJECT_FILE}: ${parsed.error.issues[0]!.path.join('.')} ${parsed.error.issues[0]!.message}`,
      );
    }
    const log = this.readLog();
    const last = log[log.length - 1];
    return {
      project: parsed.data,
      log,
      driftedFromLog: !!last && last.after !== projectHash(parsed.data),
    };
  }

  readLog(): LogEntry[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l, i) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          throw new OpError('VALIDATION', `${LOG_FILE} line ${i + 1} is not valid JSON`);
        }
      });
  }

  private commit(step: Step, dryRun: boolean): Step {
    if (!dryRun) {
      atomicWrite(this.projectPath, canonicalize(step.project));
      appendFileSync(this.logPath, JSON.stringify(step.entry) + '\n');
    }
    return step;
  }

  private taken(log: LogEntry[]): Set<string> {
    return new Set(log.map((e) => e.id));
  }

  /**
   * Two writers (the agent's CLI and the UI server) can act at once. A lock directory serializes the
   * read-modify-write; a lock older than 30 s is from a killed process and is taken over.
   */
  private locked<T>(fn: () => T): T {
    const lock = join(this.dir, '.studio', 'lock');
    mkdirSync(dirname(lock), { recursive: true });
    const until = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000)
            rmSync(lock, { recursive: true, force: true });
        } catch {
          /* released between the two calls: retry */
        }
        if (Date.now() > until)
          throw new OpError('INVALID_ARGS', `project is locked by another writer (${lock})`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  /** A person's edit (actor "ui") is refused while an agent holds the workspace; the agent's own writes are never blocked. */
  private personMayEdit(opts: { actor?: Actor; ctx?: Ctx }): void {
    if ((opts.ctx?.actor ?? opts.actor) === 'ui') assertAgentIdle(this.dir);
  }

  apply(
    specs: OpSpec[],
    opts: { actor?: Actor; label?: string; dryRun?: boolean; ctx?: Ctx } = {},
  ): Step {
    this.personMayEdit(opts);
    return this.locked(() => {
      const { project, log } = this.load();
      const ctx = opts.ctx ?? defaultCtx(opts.actor ?? 'agent');
      return this.commit(
        stepApply(project, specs, ctx, projectHash, this.taken(log), opts.label),
        !!opts.dryRun,
      );
    });
  }

  undo(opts: { actor?: Actor; dryRun?: boolean; ctx?: Ctx } = {}): Step {
    this.personMayEdit(opts);
    return this.locked(() => {
      const { project, log } = this.load();
      const ctx = opts.ctx ?? defaultCtx(opts.actor ?? 'agent');
      return this.commit(stepUndo(project, log, ctx, projectHash, this.taken(log)), !!opts.dryRun);
    });
  }

  redo(opts: { actor?: Actor; dryRun?: boolean; ctx?: Ctx } = {}): Step {
    this.personMayEdit(opts);
    return this.locked(() => {
      const { project, log } = this.load();
      const ctx = opts.ctx ?? defaultCtx(opts.actor ?? 'agent');
      return this.commit(stepRedo(project, log, ctx, projectHash, this.taken(log)), !!opts.dryRun);
    });
  }

  stacks() {
    return stacksFromLog(this.readLog());
  }
}
