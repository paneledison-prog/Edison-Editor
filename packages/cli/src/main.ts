import { acquireLease, checkAgentName, hasProject, readLease, touchLease } from '@studio/workspace';
import { CliError, GLOBAL_FLAGS, parseArgs, type FlagValue } from './args.js';
import { acquireJob, isHeavy } from './jobs.js';
import { emit } from './output.js';
import { COMMANDS, type CmdMeta } from './registry.js';

export interface Invocation {
  meta: CmdMeta;
  flags: Record<string, FlagValue>;
  positionals: string[];
  dir: string;
  dryRun: boolean;
  force: boolean;
  actor: 'agent' | 'ui' | 'cli';
  /** Human logs go to stderr so stdout stays pure JSON. */
  log: (msg: string) => void;
}
export type Handler = (inv: Invocation) => Promise<import('./output.js').Success>;

const loaders: Record<CmdMeta['module'], () => Promise<Record<string, unknown>>> = {
  tools: () => import('./cmds/tools.js'),
  project: () => import('./cmds/project.js'),
  ops: () => import('./cmds/ops.js'),
  tl: () => import('./cmds/tl.js'),
  doctor: () => import('./cmds/doctor.js'),
  ingest: () => import('./cmds/ingest.js'),
  cache: () => import('./cmds/cache.js'),
  render: () => import('./cmds/render.js'),
  inspect: () => import('./cmds/inspect.js'),
  ui: () => import('./cmds/ui.js'),
  video: () => import('./cmds/video.js'),
  audio: () => import('./cmds/audio.js'),
  image: () => import('./cmds/image.js'),
  models: () => import('./cmds/models.js'),
  motion: () => import('./cmds/motion.js'),
  captions: () => import('./cmds/captions.js'),
  mcp: () => import('./cmds/mcp.js'),
  plugins: () => import('./cmds/plugins.js'),
  expr: () => import('./cmds/expr.js'),
  script: () => import('./cmds/script.js'),
  color: () => import('./cmds/color.js'),
  design: () => import('./cmds/design.js'),
  workspace: () => import('./cmds/workspace.js'),
  fx: () => import('./cmds/fx.js'),
};

function findCommand(argv: string[]): { meta: CmdMeta; rest: string[] } | undefined {
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) break;
    words.push(a);
    if (words.length === 3) break;
  }
  for (const len of [3, 2, 1]) {
    const meta = COMMANDS.find(
      (c) => c.argv.length === len && c.argv.every((w, i) => w === words[i]),
    );
    if (meta) return { meta, rest: argv.slice(len) };
  }
  return undefined;
}

const EXIT: Record<string, 1 | 2 | 3 | 4 | 5> = {
  INVALID_ARGS: 2,
  UNKNOWN_OP: 2,
  NOT_FOUND: 2,
  UNSUPPORTED_INPUT: 2,
  VALIDATION: 4,
  ENGINE_MISSING: 3,
  WOULD_OVERWRITE: 5,
  ENGINE_FAILED: 1,
  INVALID_INPUT: 2,
  QC_FAILED: 4,
  ENCODER_UNSUPPORTED: 3,
  PARTIAL_FAILURE: 1,
  NEEDS_CONFIRMATION: 2,
  PLUGIN_INVALID: 4,
  WORKSPACE_LIMIT: 5,
  WORKSPACE_BUSY: 5,
  AGENT_WORKING: 5,
};

export async function main(argv: string[]): Promise<void> {
  const t0 = performance.now();
  let name =
    argv
      .filter((a) => !a.startsWith('--'))
      .slice(0, 3)
      .join('.') || '(none)';
  let pretty = argv.includes('--pretty');
  try {
    const found = findCommand(argv);
    if (!found) {
      throw new CliError(
        'INVALID_ARGS',
        `unknown command "${
          argv
            .filter((a) => !a.startsWith('--'))
            .slice(0, 3)
            .join(' ') || ''
        }"`,
        2,
        'run `studio tools` for the command list',
      );
    }
    const { meta, rest } = found;
    name = meta.name;
    const { flags, positionals } = parseArgs(rest, [...meta.flags, ...GLOBAL_FLAGS]);
    pretty = !!flags['pretty'];
    const inv: Invocation = {
      meta,
      flags,
      positionals,
      dir: String(flags['project'] ?? process.cwd()),
      dryRun: !!flags['dry-run'],
      force: !!flags['force'],
      actor: (flags['actor'] as Invocation['actor']) ?? 'agent',
      log: (m) => process.stderr.write(m + '\n'),
    };
    // Plugins add templates and effects; every module that renders or validates a composition must see them.
    if (!['tools', 'project', 'ops', 'doctor', 'models', 'cache', 'ingest', 'design', 'workspace'].includes(meta.module)) {
      const { activatePlugins } = await import('@studio/engines');
      activatePlugins(inv.dir);
    }
    const mod = await loaders[meta.module]();
    const fn = mod[meta.fn] as Handler | undefined;
    if (!fn)
      throw new Error(`command ${meta.name} has no handler "${meta.fn}" in module ${meta.module}`);

    // Parallel agents. A write that names its agent takes the workspace (the editor turns view-only for the person, and
    // another live agent is refused); any write while a lease is live keeps it alive, also during a long render.
    const agent = typeof flags['agent'] === 'string' ? checkAgentName(flags['agent']) : undefined;
    const serving = ['ui', 'design.ui', 'mcp'].includes(meta.name);
    let stopBeat: (() => void) | undefined;
    if (meta.writes && meta.module !== 'workspace' && !serving && !inv.dryRun && inv.actor !== 'ui' && hasProject(inv.dir)) {
      if (agent) acquireLease(inv.dir, agent);
      if (agent || readLease(inv.dir)) {
        const beat = setInterval(() => touchLease(inv.dir, agent), 10_000);
        beat.unref();
        stopBeat = () => {
          clearInterval(beat);
          touchLease(inv.dir, agent);
        };
      }
    }
    // Heavy commands queue for one of a few machine-wide job slots, so five parallel workspaces cannot start five renders at once.
    const held = isHeavy(meta.name, flags) && !inv.dryRun ? await acquireJob(meta.name, { inherit: true, log: inv.log }) : undefined;
    let res;
    try {
      res = await fn(inv);
    } finally {
      held?.release();
      stopBeat?.();
    }
    emit(
      {
        ok: true,
        command: meta.name,
        data: res.data ?? {},
        artifacts: res.artifacts ?? [],
        warnings: res.warnings ?? [],
        timingMs: Math.round(performance.now() - t0),
        ...(res.opId ? { opId: res.opId } : {}),
        ...(inv.dryRun ? { dryRun: true } : {}),
      },
      pretty,
    );
  } catch (e) {
    const err = e as Error & {
      code?: string;
      fix?: string;
      exit?: number;
      details?: unknown;
      issues?: unknown[];
    };
    const code = err.code && typeof err.code === 'string' ? err.code : 'ENGINE_FAILED';
    const exit = err instanceof CliError ? err.exit : (EXIT[code] ?? 1);
    const fix =
      err.fix ??
      (code === 'VALIDATION' ? 'run `studio project validate` for the full issue list' : undefined);
    emit(
      {
        ok: false,
        command: name,
        error: {
          code,
          message: err.message,
          ...(fix ? { fix } : {}),
          ...(err.issues?.length ? { issues: err.issues } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
        timingMs: Math.round(performance.now() - t0),
      },
      pretty,
    );
    process.exitCode = exit;
  }
}

main(process.argv.slice(2));
