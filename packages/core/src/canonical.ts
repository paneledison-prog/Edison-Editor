import { createHash } from 'node:crypto';
import type { Project } from './schema.js';

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

/**
 * Stable serialization: sorted object keys, clips sorted by id, markers by (t, id),
 * exports by id, keyframes by t. Track order is meaningful and kept.
 * Equal projects always produce equal bytes, which makes undo verifiable with cmp.
 */
export function canonicalize(p: Project): string {
  const c = structuredClone(p);
  c.clips.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  c.markers.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  c.exports.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const clip of c.clips) {
    for (const kfs of Object.values(clip.keyframes ?? {})) kfs.sort((a, b) => a.t - b.t);
  }
  return JSON.stringify(sortKeys(c), null, 2) + '\n';
}

export function projectHash(p: Project): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(p)).digest('hex');
}

/** Timeline duration is always derived (rules/01), never stored. */
export function timelineDuration(p: Project): number {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.start + c.dur);
  return end;
}
