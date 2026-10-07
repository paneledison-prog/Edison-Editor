import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** Files above this size get a sampled fast-hash instead of a full sha256. */
export const FULL_HASH_LIMIT = 1024 ** 3; // 1 GiB
const BLOCK = 64 * 1024;
const SAMPLES = 16;

export interface HashResult {
  /** "sha256:<hex>" or "fast-hash:<hex>" */
  hash: string;
  kind: 'sha256' | 'fast-hash';
  hex: string;
  size: number;
}

/**
 * sha256 of the whole file when small enough. Above FULL_HASH_LIMIT: sha256 over
 * (size, first 1 MiB, last 1 MiB, 16 evenly spaced 64 KiB blocks), labeled fast-hash.
 * A fast-hash can miss a change between sampled blocks; it identifies, it does not prove equality.
 */
export async function hashFile(path: string, limit = FULL_HASH_LIMIT): Promise<HashResult> {
  const { size } = await stat(path);
  const h = createHash('sha256');
  if (size <= limit) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(path)
        .on('data', (d) => h.update(d))
        .on('end', () => resolve())
        .on('error', reject);
    });
    const hex = h.digest('hex');
    return { hash: `sha256:${hex}`, kind: 'sha256', hex, size };
  }
  const fh = await open(path, 'r');
  try {
    h.update(`size:${size}`);
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(Math.min(len, Math.max(0, size - pos)));
      await fh.read(buf, 0, buf.length, pos);
      h.update(buf);
    };
    await read(0, 1024 * 1024);
    await read(Math.max(0, size - 1024 * 1024), 1024 * 1024);
    for (let i = 0; i < SAMPLES; i++)
      await read(Math.floor(((size - BLOCK) * (i + 1)) / (SAMPLES + 1)), BLOCK);
  } finally {
    await fh.close();
  }
  const hex = h.digest('hex');
  return { hash: `fast-hash:${hex}`, kind: 'fast-hash', hex, size };
}
