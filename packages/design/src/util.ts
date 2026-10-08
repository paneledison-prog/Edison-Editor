// Small, dependency-free helpers shared by the node side (store, CLI) and the browser side (editor, renderer).
export const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export type Rng = () => number;

export function cryptoRng(): Rng {
  return () => {
    const b = new Uint32Array(1);
    globalThis.crypto.getRandomValues(b);
    return (b[0] as number) / 2 ** 32;
  };
}

/** Deterministic rng for tests and replays (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An id like `l_k3f9` that is not in `taken`. Lengthens after repeated collisions. */
export function makeId(prefix: string, taken: ReadonlySet<string>, rng: Rng, len = 4): string {
  for (let attempt = 0; ; attempt++) {
    const n = len + Math.floor(attempt / 8);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    const id = `${prefix}_${s}`;
    if (!taken.has(id)) return id;
  }
}

export type OpErrorCode = 'NOT_FOUND' | 'INVALID_ARGS' | 'VALIDATION' | 'UNKNOWN_OP';
export interface Issue {
  code: string;
  message: string;
  path: string;
}
export class OpError extends Error {
  constructor(
    public code: OpErrorCode,
    message: string,
    public issues: Issue[] = [],
  ) {
    super(message);
  }
}

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
/** Stable serialization: sorted keys, keyframes sorted by time. Equal documents give equal bytes. */
export function canonicalize(doc: unknown): string {
  const c = structuredClone(doc) as { layers?: { anim?: Record<string, { t: number }[]> }[] };
  for (const l of c.layers ?? []) for (const kfs of Object.values(l.anim ?? {})) kfs.sort((a, b) => a.t - b.t);
  return JSON.stringify(sortKeys(c), null, 2) + '\n';
}
