export interface Success {
  data?: unknown;
  artifacts?: { kind: string; path: string }[];
  warnings?: string[];
  opId?: string;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .filter((k) => (v as any)[k] !== undefined)
        .map((k) => [k, sortKeys((v as any)[k])]),
    );
  }
  return v;
}

/** stdout carries exactly one JSON object and a newline, keys sorted so diffs are meaningful. */
export function emit(obj: unknown, pretty: boolean): void {
  process.stdout.write(JSON.stringify(sortKeys(obj), null, pretty ? 2 : undefined) + '\n');
}
