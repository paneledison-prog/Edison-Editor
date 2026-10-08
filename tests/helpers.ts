import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBatch,
  emptyProject,
  seededRng,
  type Ctx,
  type OpSpec,
  type Project,
} from '@studio/core';

export const testCtx = (seed = 1, actor: Ctx['actor'] = 'agent'): Ctx => {
  let t = 1_700_000_000_000;
  return { actor, now: () => t++, rng: seededRng(seed) };
};

export const tmpDir = (name = 'studio-test-') => mkdtempSync(join(tmpdir(), name));

export const VIDEO_ASSET = {
  path: 'assets/rec.mp4',
  kind: 'video' as const,
  hash: 'sha256:' + 'a'.repeat(64),
  probe: {
    durMs: 60_000,
    fps: 30,
    w: 1920,
    h: 1080,
    vfr: false,
    rotation: 0,
    audio: { sr: 48000, ch: 2 },
  },
};

/** Project with one video asset, a video track, an audio track, and a graphics track. */
export function baseProject(ctx = testCtx(99)): Project {
  const specs: OpSpec[] = [
    { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
    { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'VO' } },
    { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } },
  ];
  return applyBatch(emptyProject({ name: 'test' }), specs, ctx).project;
}

import { copyIntoProject, planIngest, prepareWorkingCopy } from '@studio/engines';
import { ProjectStore } from '@studio/core';

/** Ingests fixture files into a fresh project (same path as `studio ingest`) and returns their asset ids by file name. */
export async function projectWith(
  files: string[],
  name = 'p1',
): Promise<{ dir: string; store: ProjectStore; ids: Record<string, string> }> {
  const dir = tmpDir('studio-p1-');
  const store = ProjectStore.init(dir, { name, width: 640, height: 360, fps: 30 });
  const known: Record<string, { hash: string; path: string }> = {};
  const taken = new Set<string>();
  const plans = [];
  for (const f of files) {
    const plan = await planIngest(dir, f, known, taken);
    await copyIntoProject(dir, plan);
    await prepareWorkingCopy(dir, plan);
    plans.push(plan);
  }
  const step = store.apply(
    plans.map((p) => ({ type: 'asset.add', args: { asset: p.asset } })),
    { ctx: testCtx(11) },
  );
  const ids: Record<string, string> = {};
  step.entry.ops.forEach((o: any, i) => (ids[files[i]!.split('/').pop()!] = o.args.id));
  return { dir, store, ids };
}
