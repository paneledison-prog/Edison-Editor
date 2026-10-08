/**
 * Feature tracks through a whole shot: points found in one frame and followed as long as they can be (Lucas-Kanade with a
 * forward-backward check), replaced by fresh ones as they are lost, so the picture stays covered. A track is the run of
 * positions of one scene point; it is what structure from motion starts from.
 */
import { detectCorners } from './features.js';
import { buildPyr, trackChecked, type Pyr } from './flow.js';
import type { Pt } from './geom.js';
import type { Gray } from './image.js';

export interface FeatureTrack {
  /** frame of the first position */
  first: number;
  /** positions in consecutive frames from `first` (pixel index coordinates of the analysed image) */
  xs: number[];
  ys: number[];
}

export interface TrackSet {
  tracks: FeatureTrack[];
  frames: number;
  w: number;
  h: number;
}

/** Position of a track in a frame, or null when it was not followed there. */
export function trackAt(t: FeatureTrack, frame: number): Pt | null {
  const i = frame - t.first;
  return i >= 0 && i < t.xs.length ? [t.xs[i]!, t.ys[i]!] : null;
}

export async function trackFeatures(
  frames: AsyncIterable<Gray> | Iterable<Gray>,
  o: { max?: number; minDist?: number; minLength?: number; log?: (frame: number, active: number) => void } = {},
): Promise<TrackSet> {
  const max = o.max ?? 400;
  const tracks: FeatureTrack[] = [];
  let active: { id: number; x: number; y: number; vx: number; vy: number }[] = [];
  let prev: Pyr | undefined;
  let w = 0;
  let h = 0;
  let n = 0;
  let since = 0;
  for await (const img of frames as AsyncIterable<Gray>) {
    w = img.w;
    h = img.h;
    const minDist = o.minDist ?? Math.max(5, Math.round(Math.min(w, h) / 36));
    const cur = buildPyr(img, 4, true);
    if (prev && active.length) {
      const pts: Pt[] = active.map((a) => [a.x, a.y]);
      const guess: Pt[] = active.map((a) => [a.x + a.vx, a.y + a.vy]);
      const tr = trackChecked(prev, cur, pts, { guess });
      const next: typeof active = [];
      tr.forEach((t, i) => {
        const a = active[i]!;
        if (!t.ok || t.x < 6 || t.y < 6 || t.x > w - 7 || t.y > h - 7) return;
        tracks[a.id]!.xs.push(t.x);
        tracks[a.id]!.ys.push(t.y);
        next.push({ id: a.id, x: t.x, y: t.y, vx: 0.7 * (t.x - a.x) + 0.3 * a.vx, vy: 0.7 * (t.y - a.y) + 0.3 * a.vy });
      });
      active = next;
    }
    since++;
    if (!prev || active.length < max * 0.8 || since >= 12) {
      const fresh = detectCorners(img, { max, minDist, border: 10 });
      const grid = new Map<number, true>();
      const cell = minDist;
      const key = (x: number, y: number) => Math.floor(x / cell) * 100003 + Math.floor(y / cell);
      for (const a of active) grid.set(key(a.x, a.y), true);
      const near = (x: number, y: number) => {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (grid.has((cx + dx) * 100003 + cy + dy)) return true;
        return false;
      };
      for (const c of fresh) {
        if (active.length >= max) break;
        if (near(c.x, c.y)) continue;
        grid.set(key(c.x, c.y), true);
        const id = tracks.length;
        tracks.push({ first: n, xs: [c.x], ys: [c.y] });
        active.push({ id, x: c.x, y: c.y, vx: 0, vy: 0 });
      }
      since = 0;
    }
    o.log?.(n, active.length);
    prev = cur;
    n++;
  }
  const minLen = o.minLength ?? 3;
  return { tracks: tracks.filter((t) => t.xs.length >= minLen), frames: n, w, h };
}
