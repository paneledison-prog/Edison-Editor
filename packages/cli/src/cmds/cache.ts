import { join } from 'node:path';
import { OpError } from '@studio/core';
import type { Handler } from '../main.js';
import { store, str } from './shared.js';

export const build: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const { project } = store(inv).load();
  const want = str(inv, 'assets')?.split(',').filter(Boolean);
  const ids = want ?? Object.keys(project.assets);
  for (const id of ids)
    if (!project.assets[id]) throw new OpError('NOT_FOUND', `asset ${id} not found`);
  if (inv.dryRun) return { data: { wouldBuild: ids } };
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const a = project.assets[id]!;
    const hex = a.hash.split(':')[1]!;
    const dir = E.cacheDir(inv.dir, hex);
    const src = a.workingCopy ? join(inv.dir, a.workingCopy.path) : join(inv.dir, a.path);
    inv.log(`building ${id}`);
    out[id] = await E.withLock(dir, () =>
      E.deriveAll(
        dir,
        { path: src, kind: a.kind, durMs: a.probe.durMs, hasAudio: !!a.probe.audio },
        E.displayHeight(a.probe),
      ),
    );
  }
  return { data: { assets: out } };
};
