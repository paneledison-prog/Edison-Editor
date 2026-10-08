import type { OpSpec, ProjectView } from '../api';
import { snapToFrame } from './format';

type Clip = ProjectView['clips'][number];

export const SNAP_PX = 8;

/** Whole milliseconds on a frame boundary (the project stores integer ms). */
export const frameMs = (ms: number, fps: number) => Math.round(snapToFrame(ms, fps));

const speedOf = (c: Clip) => c.fx?.find((f) => f.type === 'speed')?.factor ?? 1;

/** Times a drag may snap to: other clips' edges, the playhead, markers, and 0. Returned sorted. */
export function snapPoints(p: ProjectView, exceptId: string, playheadMs: number): number[] {
  const pts = new Set<number>([0, Math.round(playheadMs)]);
  for (const c of p.clips) {
    if (c.id === exceptId) continue;
    pts.add(c.start);
    pts.add(c.start + c.dur);
  }
  for (const m of p.markers) pts.add(m.t);
  return [...pts].sort((a, b) => a - b);
}

/** Snaps `ms` to the closest point within SNAP_PX, else to the frame grid. */
export function snapTime(ms: number, points: number[], pxPerMs: number, fps: number): number {
  let best: number | undefined;
  for (const q of points)
    if (
      Math.abs(q - ms) * pxPerMs <= SNAP_PX &&
      (best === undefined || Math.abs(q - ms) < Math.abs(best - ms))
    )
      best = q;
  return best ?? frameMs(ms, fps);
}

/** Overlap is only allowed on graphics tracks: elsewhere the clips beside a clip bound where it can go. */
function neighbours(p: ProjectView, c: Clip, trackId: string) {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.type === 'graphics') return { lo: 0, hi: Infinity };
  let lo = 0;
  let hi = Infinity;
  for (const o of p.clips) {
    if (o.id === c.id || o.track !== trackId) continue;
    // classify by where the other clip lies relative to the clip's original position
    if (o.start + o.dur <= c.start + 1) lo = Math.max(lo, o.start + o.dur);
    else if (o.start >= c.start + c.dur - 1) hi = Math.min(hi, o.start);
    else {
      // The other clip overlaps the original position (cannot happen in a valid project) or lies on another track's span.
      lo = Math.max(lo, o.start + o.dur);
    }
  }
  return { lo, hi };
}

/** Where a clip may be moved to: start clamped between its neighbours on the target track. */
export function moveClip(
  p: ProjectView,
  c: Clip,
  wantStart: number,
  trackId: string,
): { start: number; track: string } {
  // On a different track the neighbours are the clips there that the dragged clip would overlap when dropped.
  let lo = 0;
  let hi = Infinity;
  const t = p.tracks.find((x) => x.id === trackId);
  if (trackId === c.track) ({ lo, hi } = neighbours(p, c, trackId));
  else if (t && t.type !== 'graphics') {
    const others = p.clips
      .filter((o) => o.track === trackId && o.id !== c.id)
      .sort((a, b) => a.start - b.start);
    const mid = wantStart + c.dur / 2;
    for (const o of others) {
      if (o.start + o.dur / 2 <= mid) lo = Math.max(lo, o.start + o.dur);
      else hi = Math.min(hi, o.start);
    }
  }
  let start = Math.max(0, wantStart);
  if (start < lo) start = lo;
  if (hi !== Infinity && start + c.dur > hi) start = hi - c.dur;
  if (start < lo) start = lo; // does not fit between the neighbours: stays at the left edge and the server will refuse
  return { start: Math.round(start), track: trackId };
}

export interface TrimResult {
  start: number;
  dur: number;
  srcIn?: number;
}

/** Drag of the left or right edge to timeline time `to` (already snapped). Media cannot grow past its source. */
export function trimClip(
  p: ProjectView,
  c: Clip,
  edge: 'left' | 'right',
  to: number,
  fps: number,
): TrimResult {
  const minDur = Math.max(1, Math.round(1000 / fps));
  const speed = speedOf(c);
  const a = c.asset ? p.assets[c.asset] : undefined;
  const srcLen = a?.kind === 'image' || !a ? Infinity : (a.probe.durMs ?? Infinity);
  const { lo, hi } = neighbours(p, c, c.track);
  const end = c.start + c.dur;
  if (edge === 'right') {
    let newEnd = Math.max(c.start + minDur, Math.min(to, hi));
    // source-limited: srcIn + dur x speed <= source length
    const maxDur = Math.floor((srcLen - (c.srcIn ?? 0)) / speed);
    newEnd = Math.min(newEnd, c.start + maxDur);
    return { start: c.start, dur: Math.max(minDur, newEnd - c.start) };
  }
  let newStart = Math.min(end - minDur, Math.max(to, lo));
  let srcIn = c.srcIn;
  if (c.asset && a?.kind !== 'image') {
    // trimming the head moves the source in-point by the same amount of source time
    const shift = Math.round((newStart - c.start) * speed);
    const want = (c.srcIn ?? 0) + shift;
    if (want < 0) {
      newStart = c.start - Math.floor((c.srcIn ?? 0) / speed);
      srcIn = 0;
    } else srcIn = want;
  }
  return { start: newStart, dur: end - newStart, ...(srcIn !== undefined ? { srcIn } : {}) };
}

export const moveSpec = (c: Clip, start: number, track: string): OpSpec => ({
  type: 'clip.move',
  args: { id: c.id, start, ...(track !== c.track ? { track } : {}) },
});
export const trimSpec = (c: Clip, r: TrimResult): OpSpec => ({
  type: 'clip.trim',
  args: {
    id: c.id,
    start: r.start,
    dur: r.dur,
    ...(r.srcIn !== undefined ? { srcIn: r.srcIn } : {}),
  },
});
export const splitSpec = (c: Clip, at: number): OpSpec => ({
  type: 'clip.split',
  args: { id: c.id, at },
});

/** Whether a split at `at` is strictly inside the clip. */
export const canSplit = (c: Clip, at: number) => at > c.start && at < c.start + c.dur;

/** Moving a keyframe in time is delete + set with the same id, so it is one undo step. */
export function kfSetSpecs(
  clipId: string,
  prop: string,
  k: { id: string; t: number; v: number; ease?: string },
  next: { t?: number; v?: number; ease?: string },
): OpSpec[] {
  const t = next.t ?? k.t;
  const set: OpSpec = {
    type: 'kf.set',
    args: { clip: clipId, prop, t, v: next.v ?? k.v, ease: next.ease ?? k.ease, id: k.id },
  };
  if (!set.args['ease']) delete set.args['ease'];
  return t === k.t ? [set] : [{ type: 'kf.delete', args: { clip: clipId, id: k.id } }, set];
}

export const KF_STEP: Record<string, number> = {
  scale: 0.05,
  x: 0.01,
  y: 0.01,
  opacity: 0.05,
  rot: 1,
};
