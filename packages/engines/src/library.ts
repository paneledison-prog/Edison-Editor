import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from '@studio/core';
import { hashFile } from './hash.js';
import { probeFile } from './probe.js';
import { EngineError } from './run.js';

/** Local music/SFX index (`.studio/library.json`). It searches names and tags only: it does not understand audio. */
export interface LibraryEntry {
  id: string;
  /** relative to the project when inside it, otherwise absolute */
  path: string;
  name: string;
  hash: string;
  durationMs: number;
  tags: string[];
  /** a license note, or "unknown" */
  license: string;
  bpm?: number;
  loop?: { startMs: number; endMs: number };
}
interface Library {
  schema: 1;
  entries: LibraryEntry[];
}

const file = (dir: string) => join(dir, '.studio', 'library.json');

export function loadLibrary(dir: string): Library {
  const f = file(dir);
  if (!existsSync(f)) return { schema: 1, entries: [] };
  try {
    const l = JSON.parse(readFileSync(f, 'utf8'));
    if (l.schema !== 1 || !Array.isArray(l.entries)) throw new Error('unexpected shape');
    return l;
  } catch (e) {
    throw new EngineError(
      'INVALID_INPUT',
      `${f} is not a valid library file: ${(e as Error).message}`,
      'fix or delete the file; it only holds the index, not the audio',
    );
  }
}

function save(dir: string, l: Library) {
  mkdirSync(join(dir, '.studio'), { recursive: true });
  const f = file(dir);
  l.entries.sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(f + '.partial', JSON.stringify(l, null, 2) + '\n');
  renameSync(f + '.partial', f);
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

export async function addToLibrary(
  dir: string,
  src: string,
  o: { tags: string[]; license: string; bpm?: number; loop?: { startMs: number; endMs: number } },
): Promise<{ entry: LibraryEntry; created: boolean; warnings: string[] }> {
  if (!o.license.trim())
    throw new EngineError(
      'INVALID_INPUT',
      'a license note is required',
      'pass --license "<note>", or --license unknown if you do not know it (a warning is raised at export)',
    );
  const abs = resolve(src);
  if (!existsSync(abs)) throw new EngineError('INVALID_INPUT', `${src}: file not found`);
  const pr = await probeFile(abs);
  if (!pr.probe.audio) throw new EngineError('INVALID_INPUT', `${src} has no audio stream`);
  const h = await hashFile(abs);
  const lib = loadLibrary(dir);
  const warnings: string[] = [];
  const tags = [...new Set(o.tags.map(norm).filter(Boolean))];
  const existing = lib.entries.find((e) => e.hash === h.hash);
  if (o.license.trim().toLowerCase() === 'unknown')
    warnings.push(
      'license is unknown: a warning will be raised when this audio is used in an export',
    );
  if (existing) {
    existing.tags = [...new Set([...existing.tags, ...tags])];
    if (o.license.trim().toLowerCase() !== 'unknown' || existing.license === 'unknown')
      existing.license = o.license.trim();
    save(dir, lib);
    warnings.push(`already in the library as ${existing.id}; tags merged`);
    return { entry: existing, created: false, warnings };
  }
  const rel = relative(dir, abs);
  const used = new Set(lib.entries.map((e) => e.id));
  let n = lib.entries.length + 1;
  while (used.has(`s_${String(n).padStart(3, '0')}`)) n++;
  const entry: LibraryEntry = {
    id: `s_${String(n).padStart(3, '0')}`,
    path: rel.startsWith('..') || isAbsolute(rel) ? abs : rel,
    name: basename(abs),
    hash: h.hash,
    durationMs: pr.probe.durMs ?? 0,
    tags,
    license: o.license.trim(),
    ...(o.bpm !== undefined ? { bpm: o.bpm } : {}),
    ...(o.loop ? { loop: o.loop } : {}),
  };
  lib.entries.push(entry);
  save(dir, lib);
  return { entry, created: true, warnings };
}

/** Names and tags only. Score = number of query words found; ties break by id. */
export function searchLibrary(
  dir: string,
  query: string,
  limit = 10,
): { entry: LibraryEntry; score: number; matched: string[] }[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) throw new EngineError('INVALID_INPUT', 'empty query');
  const out = [];
  for (const entry of loadLibrary(dir).entries) {
    const hay = [norm(entry.name), ...entry.tags];
    const matched = words.filter((w) => hay.some((h) => h.includes(w)));
    if (matched.length) out.push({ entry, score: matched.length, matched });
  }
  return out
    .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))
    .slice(0, limit);
}

/** Notes for assets in the project whose library entry has an unknown license. */
export function licenseWarnings(
  dir: string,
  project: Project,
  usedAssetIds: Iterable<string>,
): string[] {
  if (!existsSync(file(dir))) return [];
  const lib = loadLibrary(dir);
  const out: string[] = [];
  for (const id of new Set(usedAssetIds)) {
    const a = project.assets[id];
    const e = a && lib.entries.find((x) => x.hash === a.hash);
    if (e && e.license.toLowerCase() === 'unknown')
      out.push(
        `license unknown for ${e.name} (${e.id}, used as ${id}); check it before publishing`,
      );
  }
  return out;
}
export { dirname };
