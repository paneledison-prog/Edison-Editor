export const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** HH:MM:SS.mmm */
export function timecode(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(t / 3_600_000)}:${pad((t / 60_000) % 60)}:${pad((t / 1000) % 60)}.${pad(t % 1000, 3)}`;
}

const STEPS = [
  10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];
/** Smallest tick step (ms) whose spacing is at least `minPx` at this zoom. */
export function tickStep(pxPerMs: number, minPx = 80): number {
  return STEPS.find((s) => s * pxPerMs >= minPx) ?? STEPS[STEPS.length - 1]!;
}

export function tickLabel(ms: number, step: number): string {
  if (step >= 1000) return `${Math.floor(ms / 60_000)}:${pad((ms / 1000) % 60)}`;
  return `${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)}`;
}

/** Nearest frame boundary, from absolute time (never accumulated). */
export const snapToFrame = (ms: number, fps: number) =>
  Math.round((Math.round((ms * fps) / 1000) * 1000) / fps);
