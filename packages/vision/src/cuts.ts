/** Shot cuts: where one picture is replaced by an unrelated one, found by how much consecutive frames differ. */

/** Mean absolute difference of two RGB frames on a coarse grid (0..1). */
function diff(a: Uint8Array, b: Uint8Array, w: number, h: number): number {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 36));
  let s = 0;
  let n = 0;
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = 3 * (y * w + x);
      s += (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 765;
      n++;
    }
  return s / n;
}

/**
 * The indices of frames that start a new shot. A cut is a jump in frame difference far above its neighbours' (6 times the
 * median and at least 0.12), so fast motion or a flash does not count.
 */
export function detectCuts(frames: Uint8Array[], w: number, h: number): number[] {
  const d: number[] = [];
  for (let i = 1; i < frames.length; i++) d.push(diff(frames[i - 1]!, frames[i]!, w, h));
  const med = [...d].sort((x, y) => x - y)[d.length >> 1] ?? 0;
  const out: number[] = [];
  d.forEach((v, i) => {
    if (v > Math.max(0.12, 6 * med)) out.push(i + 1);
  });
  return out;
}
