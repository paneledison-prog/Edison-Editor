export interface Interval {
  startMs: number;
  endMs: number;
}

export interface CutPlan {
  kept: Interval[];
  removed: Interval[];
  removedMs: number;
  /** Silences too short, after padding, to be worth removing */
  skipped: number;
}

/**
 * Turns detected silences into kept and removed spans of a clip of `totalMs`.
 * A pause is trimmed, not deleted: `padMs` of it stays on each side of speech, so a 2.0 s pause with 100 ms
 * padding loses 1.8 s. Leading and trailing silence keep only the padding next to speech.
 * Silences under `minRemoveMs` after padding are left alone (rules/02: never cut natural rhythm).
 */
export function planSilenceCuts(
  silences: Interval[],
  totalMs: number,
  padMs = 100,
  minRemoveMs = 100,
): CutPlan {
  const removed: Interval[] = [];
  let skipped = 0;
  for (const s of [...silences].sort((a, b) => a.startMs - b.startMs)) {
    const rs = s.startMs <= 0 ? 0 : s.startMs + padMs;
    const re = s.endMs >= totalMs - 1 ? totalMs : s.endMs - padMs;
    if (re - rs >= minRemoveMs)
      removed.push({ startMs: Math.max(0, rs), endMs: Math.min(totalMs, re) });
    else skipped++;
  }
  const kept: Interval[] = [];
  let at = 0;
  for (const r of removed) {
    if (r.startMs > at) kept.push({ startMs: at, endMs: r.startMs });
    at = Math.max(at, r.endMs);
  }
  if (at < totalMs) kept.push({ startMs: at, endMs: totalMs });
  return {
    kept,
    removed,
    removedMs: removed.reduce((n, r) => n + (r.endMs - r.startMs), 0),
    skipped,
  };
}

/**
 * Joins silences separated by less than `gapMs`. A level threshold flaps when the room noise has peaks above it,
 * splitting one pause into pieces; no word fits in a gap that short, so it is a noise spike.
 */
export function mergeSilences(
  spans: Interval[],
  gapMs = 200,
): { spans: Interval[]; merged: number } {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  let merged = 0;
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startMs - last.endMs < gapMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
      merged++;
    } else out.push({ ...s });
  }
  return { spans: out, merged };
}
