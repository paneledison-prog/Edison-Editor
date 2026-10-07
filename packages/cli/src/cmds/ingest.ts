import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { runSpecs, store, str } from './shared.js';

export const ingest: Handler = async (inv) => {
  const paths = inv.positionals;
  if (!paths.length)
    throw new CliError('INVALID_ARGS', 'no input files', 2, 'studio ingest <path...>');
  const E = await import('@studio/engines');
  const s = store(inv);
  const { project } = s.load();
  const known = Object.fromEntries(
    Object.entries(project.assets).map(([id, a]) => [id, { hash: a.hash, path: a.path }]),
  );
  const taken = new Set(Object.values(project.assets).map((a) => a.path));

  // Plan everything first. Any rejected file stops the command before anything is copied or written.
  const plans: Awaited<ReturnType<typeof E.planIngest>>[] = [];
  const rejected: { path: string; code: string; reason: string }[] = [];
  const seen = new Map<string, string>();
  for (const p of paths) {
    try {
      inv.log(`probing ${p}`);
      const plan = await E.planIngest(inv.dir, p, { ...known }, taken);
      const dupe = seen.get(plan.asset.hash);
      if (dupe && !plan.existing) {
        plan.existing = `(same content as ${dupe} in this command)`;
      }
      seen.set(plan.asset.hash, p);
      plans.push(plan);
    } catch (e) {
      rejected.push({
        path: p,
        code: (e as any).code ?? 'ENGINE_FAILED',
        reason: (e as Error).message,
      });
    }
  }
  if (rejected.length) {
    const missing = rejected.find((r) => r.code === 'ENGINE_MISSING');
    throw new CliError(
      missing ? 'ENGINE_MISSING' : 'UNSUPPORTED_INPUT',
      `${rejected.length} of ${paths.length} input(s) rejected: ${rejected.map((r) => r.reason).join(' | ')}`,
      missing ? 3 : 2,
      missing
        ? 'run `studio doctor`'
        : 'nothing was ingested; fix or remove the listed files and rerun',
      { rejected },
    );
  }

  const fresh = plans.filter((p) => !p.existing);
  const warnings = plans.flatMap((p) => p.warnings.map((w) => `${p.src}: ${w}`));
  const report = (p: (typeof plans)[number]) => ({
    path: p.src,
    kind: p.asset.kind,
    hash: p.asset.hash,
    bytes: p.size,
    assetPath: p.assetRelPath,
    ...(p.existing ? { alreadyIngested: p.existing } : {}),
    probe: p.asset.probe,
  });
  if (inv.dryRun)
    return {
      data: {
        wouldIngest: fresh.map(report),
        skipped: plans.filter((p) => p.existing).map(report),
      },
      warnings,
    };
  if (!fresh.length)
    return {
      data: { ingested: [], skipped: plans.map(report) },
      warnings: [...warnings, 'every input was already ingested; nothing changed'],
    };

  for (const p of fresh) {
    await E.copyIntoProject(inv.dir, p);
    if (p.asset.probe.vfr)
      inv.log(
        `${p.src}: variable frame rate; building constant-rate working copy (re-encodes once)`,
      );
    await E.prepareWorkingCopy(inv.dir, p);
  }
  const res = runSpecs(
    inv,
    fresh.map((p) => ({ type: 'asset.add', args: { asset: p.asset } })),
    str(inv, 'label') ?? `ingest ${fresh.length} file(s)`,
  );
  const last = s.readLog().at(-1);
  const ids = (last?.kind === 'apply' ? last.ops : []).map((o) => o.args.id as string);

  const derive: Record<string, unknown> = { mode: 'none' };
  if (!inv.flags['no-derive']) {
    if (inv.flags['sync']) {
      const out: Record<string, unknown> = {};
      for (const [i, p] of fresh.entries()) {
        const a = p.asset;
        const dir = E.cacheDir(inv.dir, p.hex);
        const src = a.workingCopy ? join(inv.dir, a.workingCopy.path) : join(inv.dir, a.path);
        inv.log(`deriving ${ids[i]}`);
        out[ids[i]!] = await E.withLock(dir, () =>
          E.deriveAll(
            dir,
            { path: src, kind: a.kind, durMs: a.probe.durMs, hasAudio: !!a.probe.audio },
            E.displayHeight(a.probe),
          ),
        );
      }
      Object.assign(derive, { mode: 'sync', reports: out });
    } else {
      const logDir = join(inv.dir, '.studio', 'cache');
      mkdirSync(logDir, { recursive: true });
      const fd = openSync(join(logDir, 'build.log'), 'a');
      const child = spawn(
        process.execPath,
        [process.argv[1]!, 'cache', 'build', '--project', inv.dir, '--assets', ids.join(',')],
        { detached: true, stdio: ['ignore', fd, fd] },
      );
      child.unref();
      Object.assign(derive, {
        mode: 'background',
        pid: child.pid,
        log: '.studio/cache/build.log',
        note: 'run `studio cache build` to finish or verify; it skips completed artifacts',
      });
    }
  }
  return {
    ...res,
    data: {
      ...(res.data as object),
      ingested: fresh.map((p, i) => ({
        id: ids[i],
        ...report(p),
        ...(p.asset.workingCopy ? { workingCopy: p.asset.workingCopy } : {}),
      })),
      skipped: plans.filter((p) => p.existing).map(report),
      derive,
    },
    warnings,
  };
};
