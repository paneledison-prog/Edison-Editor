// Short, stable base32 ids with a kind prefix (Context §3). No i, l, o, u: they read as 1, 1, 0, v.
export const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdPrefix = 'a' | 't' | 'c' | 'k' | 'm' | 'op' | 'tx' | 'f' | 'tk' | 'mt';

export type Rng = () => number; // [0, 1)

export function cryptoRng(): Rng {
  return () => {
    const b = new Uint32Array(1);
    globalThis.crypto.getRandomValues(b);
    return (b[0] as number) / 2 ** 32;
  };
}

/** Generates an id not present in `taken`. Lengthens after repeated collisions. */
export function makeId(prefix: IdPrefix, taken: ReadonlySet<string>, rng: Rng, len = 4): string {
  for (let attempt = 0; ; attempt++) {
    const n = len + Math.floor(attempt / 8);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    const id = `${prefix}_${s}`;
    if (!taken.has(id)) return id;
  }
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
