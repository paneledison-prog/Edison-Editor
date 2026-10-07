import { copyFile, mkdir, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Asset } from '@studio/core';
import { buildCfr, cacheDir } from './derive.js';
import { hashFile } from './hash.js';
import { EngineError } from './run.js';
import { probeFile } from './probe.js';

export interface IngestPlan {
  src: string;
  /** Existing asset id when this exact content was ingested before. */
  existing?: string;
  assetRelPath: string;
  asset: Asset;
  hex: string;
  hashKind: 'sha256' | 'fast-hash';
  size: number;
  warnings: string[];
}

/**
 * Probes and hashes one file and decides where it goes. Writes nothing.
 * Rejects with a precise reason when the input cannot be edited as-is.
 */
export async function planIngest(
  projectDir: string,
  srcPath: string,
  known: Record<string, { hash: string; path: string }>,
  taken: Set<string>,
): Promise<IngestPlan> {
  const src = resolve(srcPath);
  let st;
  try {
    st = await stat(src);
  } catch {
    throw new EngineError('UNSUPPORTED_INPUT', `${srcPath}: file not found`, 'check the path');
  }
  if (!st.isFile()) throw new EngineError('UNSUPPORTED_INPUT', `${srcPath}: not a regular file`);
  if (st.size === 0)
    throw new EngineError('UNSUPPORTED_INPUT', `${srcPath}: file is empty (0 bytes)`);

  const pr = await probeFile(src);
  const h = await hashFile(src);
  const existing = Object.entries(known).find(([, a]) => a.hash === h.hash)?.[0];

  const ext = extname(src);
  const stem = basename(src, ext).replace(/[^\w.-]+/g, '_');
  let rel = `assets/${stem}${ext}`;
  const clash = (r: string) => taken.has(r) || existsSync(join(projectDir, r));
  if (!existing && clash(rel)) rel = `assets/${stem}-${h.hex.slice(0, 8)}${ext}`;
  if (!existing) taken.add(rel);

  const warnings = [...pr.warnings];
  if (h.kind === 'fast-hash')
    warnings.push(
      'file is large: identified by fast-hash (size + sampled blocks), not a full sha256',
    );
  const asset: Asset = {
    path: existing ? known[existing]!.path : rel,
    kind: pr.kind,
    hash: h.hash,
    probe: pr.probe as Asset['probe'],
  };
  return {
    src,
    existing,
    assetRelPath: asset.path,
    asset,
    hex: h.hex,
    hashKind: h.kind,
    size: h.size,
    warnings,
  };
}

/** Copies the original into assets/ (copy-on-write where the filesystem supports it). Never overwrites. */
export async function copyIntoProject(projectDir: string, plan: IngestPlan): Promise<void> {
  const dest = join(projectDir, plan.assetRelPath);
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  await copyFile(plan.src, dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

/** VFR sources get a CFR working copy before anything is edited against them (rules/02). */
export async function prepareWorkingCopy(projectDir: string, plan: IngestPlan): Promise<void> {
  const p = plan.asset.probe;
  const target = p.rFps ?? p.fps;
  if (plan.asset.kind !== 'video' || !p.vfr || !target) return;
  const dir = cacheDir(projectDir, plan.hex);
  // Target the container's nominal (max) rate, not the average, so sparse sections are held rather than thinned.
  const fps = await buildCfr(dir, join(projectDir, plan.assetRelPath), target);
  plan.asset.workingCopy = {
    path: `.studio/cache/${plan.hex}/cfr.mp4`,
    reason: `variable frame rate source (avg ${p.fps} fps); constant ${fps} fps copy for sync-safe editing`,
  };
}
