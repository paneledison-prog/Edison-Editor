/**
 * Product-demo logic that is pure: the events.jsonl format, and the auto-zoom planner (rules/07).
 * Times are integer ms; coordinates are recording pixels. No file or process access here.
 */

export interface DemoEvent {
  /** ms from recording start */
  t: number;
  type: 'move' | 'click' | 'key' | 'scroll';
  x?: number;
  y?: number;
  button?: string;
  target?: string;
  /** optional bounding box of the target in recording pixels */
  box?: { x: number; y: number; w: number; h: number };
}

export interface EventsReport {
  events: DemoEvent[];
  counts: Record<string, number>;
  problems: string[];
  outOfRange: number;
}

/** Parses and validates events.jsonl text. Bad lines are reported with their line number, never silently skipped. */
export function parseEvents(
  text: string,
  frame: { w: number; h: number },
  durMs?: number,
): EventsReport {
  const events: DemoEvent[] = [];
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  let outOfRange = 0;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: not valid JSON`);
      return;
    }
    if (!Number.isFinite(o.t) || o.t < 0)
      return void problems.push(`line ${i + 1}: "t" must be a non-negative number of ms`);
    if (!['move', 'click', 'key', 'scroll'].includes(o.type))
      return void problems.push(
        `line ${i + 1}: type "${o.type}" is not move, click, key, or scroll`,
      );
    const needsPos = o.type === 'click' || o.type === 'move';
    if (needsPos && !(Number.isFinite(o.x) && Number.isFinite(o.y)))
      return void problems.push(`line ${i + 1}: ${o.type} needs numeric x and y`);
    if (needsPos && (o.x < 0 || o.y < 0 || o.x > frame.w || o.y > frame.h)) {
      outOfRange++;
      return void problems.push(
        `line ${i + 1}: position ${o.x},${o.y} is outside the ${frame.w}x${frame.h} recording (wrong coordinate space?)`,
      );
    }
    if (durMs !== undefined && o.t > durMs + 500)
      return void problems.push(
        `line ${i + 1}: t=${o.t} is after the end of the ${durMs} ms recording`,
      );
    counts[o.type] = (counts[o.type] ?? 0) + 1;
    events.push({
      t: Math.round(o.t),
      type: o.type,
      ...(o.x !== undefined ? { x: o.x, y: o.y } : {}),
      ...(o.button ? { button: o.button } : {}),
      ...(o.target ? { target: String(o.target) } : {}),
      ...(o.box ? { box: o.box } : {}),
    });
  });
  events.sort((a, b) => a.t - b.t);
  return { events, counts, problems, outOfRange };
}

export interface ZoomOptions {
  /** recording size in px (effective, after rotation) */
  frame: { w: number; h: number };
  /** the clip's length on the timeline, ms (events are already clip-local) */
  clipDurMs: number;
  /** output width in px, for the sharpness check */
  outWidth: number;
  /** target box width as a fraction of the frame (0.45-0.6) */
  boxFrac?: number;
  maxScale?: number;
  /** where the recording sits inside the canvas, as fractions (default: all of it); used for vertical layouts */
  placement?: { x: number; y: number; w: number; h: number };
  /** allow zooms up to the maximum even when the crop has fewer source pixels than the output width */
  allowSoft?: boolean;
  /** never zoom below the sharpness limit, even when that leaves no useful zoom (default: zoom to 1.7x and report the softness) */
  strictSharp?: boolean;
  /** also let key and scroll events anchor zooms (they have no position: they extend an existing cluster only) */
  leadMs?: number;
  easeMs?: number;
}

export interface ZoomStep {
  kind: 'zoom-in' | 'pan' | 'zoom-out';
  /** transition start / end, ms */
  startMs: number;
  endMs: number;
  scale: number;
  /** focus point as fractions of the recording */
  cx: number;
  cy: number;
  events: number;
}
export interface ZoomPlan {
  steps: ZoomStep[];
  keyframes: { prop: 'scale' | 'x' | 'y'; t: number; v: number; ease: string }[];
  clusters: number;
  skipped: { atMs: number; reason: string }[];
  maxScale: number;
  /** source pixels across the crop at the largest zoom, and whether that is below the output width */
  cropPx: number;
  soft: boolean;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

interface Cluster {
  t0: number;
  t1: number;
  cx: number;
  cy: number;
  n: number;
  box?: { x: number; y: number; w: number; h: number };
}

/** Merge clicks within 1.2 s and within 25% of the frame width of the cluster centroid. */
export function clusterClicks(
  events: DemoEvent[],
  frameW: number,
  windowMs = 1200,
  distFrac = 0.25,
): Cluster[] {
  const out: Cluster[] = [];
  let sx = 0;
  let sy = 0;
  let cur: Cluster | undefined;
  for (const e of events) {
    if (e.type !== 'click' || e.x === undefined || e.y === undefined) continue;
    if (cur && e.t - cur.t1 <= windowMs && Math.abs(e.x - sx / cur.n) <= distFrac * frameW) {
      cur.t1 = e.t;
      cur.n++;
      sx += e.x;
      sy += e.y;
      cur.cx = sx / cur.n;
      cur.cy = sy / cur.n;
      if (e.box) cur.box = e.box;
    } else {
      cur = { t0: e.t, t1: e.t, cx: e.x, cy: e.y, n: 1, box: e.box };
      sx = e.x;
      sy = e.y;
      out.push(cur);
    }
  }
  // Key and scroll events extend the hold of the cluster they follow closely.
  for (const e of events) {
    if (e.type !== 'key' && e.type !== 'scroll') continue;
    const c = [...out].reverse().find((k) => k.t1 <= e.t && e.t - k.t1 <= windowMs);
    if (c) c.t1 = Math.max(c.t1, e.t);
  }
  return out;
}

/** The auto-zoom algorithm of rules/07. Every output is an ordinary keyframe a person can edit. */
export function planZoom(events: DemoEvent[], o: ZoomOptions): ZoomPlan {
  const lead = o.leadMs ?? 500;
  const ease = o.easeMs ?? 500;
  const holdAfter = 800;
  const minHold = 1200;
  const minChange = 1500;
  const idleOut = 1500;
  const boxFrac = clamp(o.boxFrac ?? 0.5, 0.3, 0.7);
  const hardMax = Math.min(o.maxScale ?? 2.5, 2.5);
  const place = o.placement ?? { x: 0, y: 0, w: 1, h: 1 };
  const notes: string[] = [];
  const skipped: ZoomPlan['skipped'] = [];
  // Sharpness: the crop must contain at least outWidth source pixels across, or the zoom is soft.
  const sharpCap = o.frame.w / o.outWidth;
  const usefulMin = 1.7;
  let cap = hardMax;
  if (!o.allowSoft && sharpCap < hardMax) {
    if (o.strictSharp || sharpCap >= usefulMin) {
      cap = sharpCap;
      notes.push(
        `max zoom limited to ${r4(sharpCap)}x so the crop keeps ${o.outWidth} source pixels across (recording is ${o.frame.w} px wide, output ${o.outWidth} px)`,
      );
    } else {
      cap = usefulMin;
      notes.push(
        `sharp zoom would be limited to ${r4(sharpCap)}x, which is not worth animating; zooming to ${usefulMin}x instead, so the crop has ${Math.round(o.frame.w / usefulMin)} source pixels for ${o.outWidth} output pixels (soft, upscaled ${r4(o.outWidth / (o.frame.w / usefulMin))}x)`,
      );
    }
  }
  const clusters = clusterClicks(events, o.frame.w);
  const steps: ZoomStep[] = [];
  const kfs: ZoomPlan['keyframes'] = [];
  if (!clusters.length || cap < 1.2) {
    if (cap < 1.2)
      notes.push('the recording is too low resolution for any sharp zoom at this output width');
    return {
      steps,
      keyframes: kfs,
      clusters: clusters.length,
      skipped,
      maxScale: 1,
      cropPx: o.frame.w,
      soft: false,
      notes,
    };
  }
  // Canvas-space focus (placement maps recording fractions to the canvas), clamped so the crop stays inside.
  const focus = (cx: number, cy: number, s: number) => ({
    x: r4(clamp(place.x + (cx / o.frame.w) * place.w, 0.5 / s, 1 - 0.5 / s)),
    y: r4(clamp(place.y + (cy / o.frame.h) * place.h, 0.5 / s, 1 - 0.5 / s)),
  });
  const scaleFor = (c: Cluster) => {
    let s: number;
    if (c.box) {
      const frac = Math.max(c.box.w / o.frame.w, c.box.h / o.frame.h) * 1.3; // 15% padding each side
      s = 1 / clamp(frac, 0.2, 1);
    } else s = 1 / boxFrac;
    return r4(clamp(s, 1.2, cap));
  };
  let cur = { s: 1, cx: o.frame.w / 2, cy: o.frame.h / 2, at: 0 };
  let lastChange = -Infinity;
  let holdEnd = 0;
  const push = (
    kind: ZoomStep['kind'],
    start: number,
    end: number,
    s: number,
    cx: number,
    cy: number,
    n: number,
  ) => {
    steps.push({
      kind,
      startMs: Math.round(start),
      endMs: Math.round(end),
      scale: s,
      cx: Math.round(cx),
      cy: Math.round(cy),
      events: n,
    });
    cur = { s, cx, cy, at: end };
    lastChange = start;
  };
  let smoothX = NaN;
  let smoothY = NaN;
  clusters.forEach((c) => {
    const s = scaleFor(c);
    // Low-pass the focus path across consecutive targets so a pan does not jump.
    const tx = Number.isNaN(smoothX) || cur.s === 1 ? c.cx : 0.7 * c.cx + 0.3 * smoothX;
    const ty = Number.isNaN(smoothY) || cur.s === 1 ? c.cy : 0.7 * c.cy + 0.3 * smoothY;
    const startIdeal = Math.max(0, c.t0 - lead);
    const zoomed = cur.s > 1.001;
    const dist = Math.hypot(c.cx - cur.cx, c.cy - cur.cy) / o.frame.w;
    const idle = startIdeal - holdEnd;
    if (zoomed && (idle > idleOut || dist >= 0.4)) {
      // Leave the current target: zoom out when idle or far; the next zoom starts from 1.0.
      const outAt = holdEnd;
      if (outAt - lastChange < minChange) {
        skipped.push({
          atMs: c.t0,
          reason: `needs a zoom change within ${minChange} ms of the previous one; zoom skipped`,
        });
        return;
      }
      push('zoom-out', outAt, outAt + ease, 1, o.frame.w / 2, o.frame.h / 2, 0);
    }
    const start = Math.max(startIdeal, cur.at);
    const kind: ZoomStep['kind'] = cur.s > 1.001 ? 'pan' : 'zoom-in';
    if (kind === 'pan' && start - lastChange < minChange) {
      skipped.push({
        atMs: c.t0,
        reason: `pan would come ${Math.round(start - lastChange)} ms after the last change (minimum ${minChange} ms); stays on the previous target`,
      });
      holdEnd = Math.max(holdEnd, c.t1 + holdAfter);
      return;
    }
    if (kind === 'zoom-in' && start - lastChange < minChange && steps.length) {
      skipped.push({
        atMs: c.t0,
        reason: `zoom change within ${minChange} ms of the previous one; skipped`,
      });
      return;
    }
    const sPan = kind === 'pan' ? Math.max(cur.s, Math.min(s, cap)) : s;
    // The previous hold must last at least minHold from the end of its own transition.
    if (kind === 'pan' && start - cur.at < minHold) {
      skipped.push({
        atMs: c.t0,
        reason: `previous target would be held ${Math.round(start - cur.at)} ms (minimum ${minHold} ms); stays on it`,
      });
      holdEnd = Math.max(holdEnd, c.t1 + holdAfter);
      return;
    }
    push(kind, start, start + ease, sPan, tx, ty, c.n);
    smoothX = tx;
    smoothY = ty;
    holdEnd = Math.max(c.t1 + holdAfter, start + ease + minHold);
  });
  // Return to 1.0 after the last hold if the clip continues long enough.
  if (cur.s > 1.001 && holdEnd + ease <= o.clipDurMs && holdEnd - lastChange >= minChange)
    push('zoom-out', holdEnd, holdEnd + ease, 1, o.frame.w / 2, o.frame.h / 2, 0);

  // A transition that would end after the clip is dropped (keyframes must lie inside the clip).
  while (steps.length && steps[steps.length - 1]!.endMs > o.clipDurMs) {
    const d = steps.pop()!;
    skipped.push({
      atMs: d.startMs,
      reason: `${d.kind} would end at ${d.endMs} ms, after the ${o.clipDurMs} ms clip; dropped`,
    });
  }
  // Keyframes: each keyframe's ease shapes the segment after it. Hold segments are linear between equal values.
  let prev = {
    s: 1,
    x: focus(o.frame.w / 2, o.frame.h / 2, 1).x,
    y: focus(o.frame.w / 2, o.frame.h / 2, 1).y,
  };
  const kAt = (t: number, v: typeof prev, e: string) => {
    for (const [prop, val] of [
      ['scale', v.s],
      ['x', v.x],
      ['y', v.y],
    ] as const) {
      const last = kfs.filter((k) => k.prop === prop).at(-1);
      if (last && last.t >= t) t = last.t + 1;
      kfs.push({ prop, t: Math.round(t), v: r4(val), ease: e });
    }
  };
  for (const st of steps) {
    const f = focus(st.cx, st.cy, st.scale);
    kAt(st.startMs, prev, 'expo.inOut');
    const next = { s: st.scale, x: f.x, y: f.y };
    kAt(st.endMs, next, 'linear');
    prev = next;
  }
  const maxScale = Math.max(1, ...steps.map((s) => s.scale));
  return {
    steps,
    keyframes: kfs,
    clusters: clusters.length,
    skipped,
    maxScale,
    cropPx: Math.round(o.frame.w / maxScale),
    soft: Math.round(o.frame.w / maxScale) < o.outWidth,
    notes,
  };
}
