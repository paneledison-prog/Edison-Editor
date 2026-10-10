/**
 * Stabilize and pin as FFmpeg filter graphs, from tracker data.
 *
 * FFmpeg's `perspective` filter warps each frame by four corner positions that may be expressions of the frame number
 * (`eval=frame`). A table of per-frame corners becomes a balanced tree of `if(lt(on,N),..,..)`, so a frame costs a few
 * comparisons however long the clip is. A tree for a long clip is large, so a clip is cut into pieces of SEGMENT frames, each
 * piece with its own filter and table, and joined again; the filtergraph then goes to FFmpeg as a script file (see run.ts).
 *
 * Verified convention (tests/trackfx.test.ts): corners are in pixel-index coordinates with extents 0..W and 0..H, so a
 * correction given in unit coordinates is evaluated at the pixel centres' corner points, (0.5, 0.5), (W + 0.5, 0.5) ... minus 0.5.
 */
import { apply, cornersOf, fitHomography, fromCorners, inv3, lerpCorners, planStabilization, type Corners, type Mat3, type Pt, type Quad, type StabPlan } from '@studio/vision';
import { frameAt, pathOf, type TrackData } from './track.js';

/** Transparent border (px) around a pinned graphic's layer. */
export const PIN_MARGIN = 2;

/** Frames per perspective filter. */
export const SEGMENT = 360;

export interface StabilizeSettings {
  smooth?: number;
  lock?: boolean;
  maxZoom?: number;
}

/** The correction plan for a track (one per analysed frame). `smooth` is the window in seconds: sigma = smooth / 2. */
export function stabilizePlan(d: TrackData, s: StabilizeSettings): StabPlan {
  return planStabilization(pathOf(d), {
    sigmaFrames: ((s.smooth ?? 0.6) * d.fps) / 2,
    lock: !!s.lock,
    maxZoom: s.maxZoom ?? 1.25,
  });
}

export interface ClipTiming {
  /** the clip's first frame in source time (ms) */
  srcIn: number;
  speed: number;
  fps: number;
  /** frames the clip has in this render */
  frames: number;
}
const srcTime = (t: ClipTiming, k: number) => t.srcIn + (k * 1000 * t.speed) / t.fps;

/** Per output frame, the source-frame positions of the steadied picture's four corners (unit coordinates). */
export function correctionTable(plan: StabPlan, d: TrackData, t: ClipTiming): Corners[] {
  const out: Corners[] = [];
  for (let k = 0; k < t.frames; k++) {
    const { i, t: u } = frameAt(d, srcTime(t, k));
    const a = plan.corners[i]!;
    out.push(u === 0 || i + 1 >= plan.corners.length ? a : lerpCorners(a, plan.corners[i + 1]!, u));
  }
  return out;
}

const f6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/**
 * A balanced if-tree over the frame number that returns table[k] for frame k (the last value past the end). FFmpeg's `on`
 * counts from 1 (frame k has on = k + 1; measured in tests/track.test.ts), so frame k is before `mid` when on < mid + 1.
 */
function tree(vals: number[], lo = 0, hi = vals.length): string {
  if (hi - lo === 1) return f6(vals[lo]!);
  const mid = (lo + hi) >> 1;
  return `if(lt(on,${mid + 1}),${tree(vals, lo, mid)},${tree(vals, mid, hi)})`;
}

/** The filter's eight expressions for a run of frames: [x0,y0,x1,y1,x2,y2,x3,y3] (top-left, top-right, bottom-left, bottom-right). */
function exprs(vals: number[][]): string[] {
  return Array.from({ length: 8 }, (_, j) => tree(vals.map((v) => v[j]!)));
}

/**
 * The index-space source positions of a frame's four corners, as fractions of the frame (the filter multiplies by W and H),
 * for a correction M that takes an output point (unit) to a source point (unit). `size` is the nominal frame size, used only
 * for the half-pixel terms.
 */
function sourceCorners(M: Mat3, size: { w: number; h: number }): number[] {
  const pts: Pt[] = [[0.5 / size.w, 0.5 / size.h], [(size.w + 0.5) / size.w, 0.5 / size.h], [0.5 / size.w, (size.h + 0.5) / size.h], [(size.w + 0.5) / size.w, (size.h + 0.5) / size.h]];
  return pts.flatMap(([x, y]) => {
    const [u, v] = apply(M, x, y);
    return [u - 0.5 / size.w, v - 0.5 / size.h];
  });
}

/** Where on the clip's frames a table applies: [from, to) in output frames. */
const pieces = (n: number): [number, number][] => {
  const k = Math.ceil(n / SEGMENT);
  const per = Math.ceil(n / k);
  return Array.from({ length: k }, (_, i) => [i * per, Math.min(n, (i + 1) * per)] as [number, number]).filter(([a, b]) => b > a);
};

/**
 * Warps the frames of `from` (already at the output frame rate, frame 0 = the clip's first) by a table of corners into `to`.
 * `W` and `H` in the expressions are the filter's own frame size, so the same table serves any resolution.
 */
export function stabilizeLines(from: string, to: string, uid: string, corners: Corners[], size: { w: number; h: number }): string[] {
  const rows = corners.map((c) => {
    const M = fromCorners(c);
    return M ? sourceCorners(M, size) : [0, 0, 1, 0, 0, 1, 1, 1];
  });
  const filt = (vals: number[][]) => {
    const e = exprs(vals);
    const w = (j: number) => `'${j % 2 === 0 ? 'W' : 'H'}*${e[j]!.startsWith('if(') ? `(${e[j]})` : e[j]}'`;
    return `perspective=x0=${w(0)}:y0=${w(1)}:x1=${w(2)}:y1=${w(3)}:x2=${w(4)}:y2=${w(5)}:x3=${w(6)}:y3=${w(7)}:interpolation=cubic:sense=source:eval=frame`;
  };
  const ps = pieces(rows.length);
  if (ps.length <= 1) return [`[${from}]${filt(rows)}[${to}]`];
  const lines = [`[${from}]split=${ps.length}${ps.map((_, i) => `[${uid}i${i}]`).join('')}`];
  ps.forEach(([a, b], i) => {
    const last = i === ps.length - 1;
    lines.push(`[${uid}i${i}]trim=start_frame=${a}${last ? '' : `:end_frame=${b}`},setpts=PTS-STARTPTS,${filt(rows.slice(a, b))}[${uid}o${i}]`);
  });
  lines.push(`${ps.map((_, i) => `[${uid}o${i}]`).join('')}concat=n=${ps.length}:v=1:a=0[${to}]`);
  return lines;
}

// ----- pin ----------------------------------------------------------------------------------------------------------------------

/**
 * A layer's four corners (canvas pixels, continuous) as the filter wants them: the layer image is stretched over the whole
 * canvas, its rectangle maps to the quad, and the corners are those of the pixel-index grid (see the convention above).
 */
function destCorners(q: Quad, canvas: { w: number; h: number }): number[] | null {
  // the graphic sits inside a transparent margin: FFmpeg repeats the edge pixels of what lies outside the layer, so without
  // the margin the graphic's own edge would be smeared over the rest of the picture
  const m = PIN_MARGIN;
  const rect: Pt[] = [[m, m], [canvas.w - m, m], [canvas.w - m, canvas.h - m], [m, canvas.h - m]];
  const C = fitHomography(rect, q);
  if (!C) return null;
  const at = (x: number, y: number) => apply(C, x + 0.5, y + 0.5).map((v) => v - 0.5);
  return [...at(0, 0), ...at(canvas.w, 0), ...at(0, canvas.h), ...at(canvas.w, canvas.h)];
}

/**
 * Warps `from` (a layer already scaled to the canvas, with alpha) so that it covers the quad of each frame: `quads[k]` is the
 * quad in canvas pixels for output frame k.
 */
export function pinWarpLines(from: string, to: string, uid: string, quads: Quad[], canvas: { w: number; h: number }): string[] {
  const rows = quads.map((q) => destCorners(q, canvas) ?? [0, 0, 1, 0, 0, 1, 1, 1].map((v, i) => v * (i % 2 ? canvas.h : canvas.w)));
  const filt = (vals: number[][]) => {
    const e = exprs(vals);
    const w = (j: number) => `'${e[j]!.startsWith('if(') ? `(${e[j]})` : e[j]}'`;
    return `perspective=x0=${w(0)}:y0=${w(1)}:x1=${w(2)}:y1=${w(3)}:x2=${w(4)}:y2=${w(5)}:x3=${w(6)}:y3=${w(7)}:interpolation=cubic:sense=destination:eval=frame`;
  };
  const ps = pieces(rows.length);
  if (ps.length <= 1) return [`[${from}]${filt(rows)}[${to}]`];
  const lines = [`[${from}]split=${ps.length}${ps.map((_, i) => `[${uid}i${i}]`).join('')}`];
  ps.forEach(([a, b], i) => {
    const last = i === ps.length - 1;
    lines.push(`[${uid}i${i}]trim=start_frame=${a}${last ? '' : `:end_frame=${b}`},setpts=PTS-STARTPTS,${filt(rows.slice(a, b))}[${uid}o${i}]`);
  });
  lines.push(`${ps.map((_, i) => `[${uid}o${i}]`).join('')}concat=n=${ps.length}:v=1:a=0[${to}]`);
  return lines;
}

/**
 * Places a layer (`from`: a canvas-sized picture, with or without alpha) on the canvas by a per-frame affine map
 * (`maps[k]` = [a, b, c, d, e, f], canvas pixels, see layerMaps in zoom.ts). The picture is first given a transparent margin,
 * so what it no longer covers is transparent rather than its edge pixels repeated, then warped, then cut back to the canvas.
 * Whole-pixel moves sample whole pixels: the picture is moved, not resampled.
 */
export function layerWarpLines(from: string, to: string, uid: string, maps: number[][], canvas: { w: number; h: number }, atSec: number): string[] {
  const m = PIN_MARGIN * 4;
  const W = canvas.w + 2 * m;
  const H = canvas.h + 2 * m;
  const rows = maps.map(([a, b, c, d, e, f]) => {
    // corner (x, y) of the padded picture (index space, as the filter counts them) goes where the map sends the matching canvas
    // point; pixel centres sit at i + 0.5
    const at = (x: number, y: number) => {
      const px = x - m + 0.5;
      const py = y - m + 0.5;
      return [a! * px + b! * py + c! + m - 0.5, d! * px + e! * py + f! + m - 0.5];
    };
    return [...at(0, 0), ...at(W, 0), ...at(0, H), ...at(W, H)];
  });
  const filt = (vals: number[][]) => {
    const e = exprs(vals);
    const q = (j: number) => `'${e[j]!.startsWith('if(') ? `(${e[j]})` : e[j]}'`;
    return `perspective=x0=${q(0)}:y0=${q(1)}:x1=${q(2)}:y1=${q(3)}:x2=${q(4)}:y2=${q(5)}:x3=${q(6)}:y3=${q(7)}:interpolation=cubic:sense=destination:eval=frame`;
  };
  const head = `format=yuva420p,pad=${W}:${H}:${m}:${m}:color=black@0`;
  const tail = `crop=${canvas.w}:${canvas.h}:${m}:${m}`;
  const ps = pieces(rows.length);
  if (ps.length <= 1) return [`[${from}]${head},${filt(rows)},${tail}[${to}]`];
  const lines = [`[${from}]${head},split=${ps.length}${ps.map((_, i) => `[${uid}i${i}]`).join('')}`];
  ps.forEach(([a, b], i) => {
    const last = i === ps.length - 1;
    lines.push(`[${uid}i${i}]trim=start_frame=${a}${last ? '' : `:end_frame=${b}`},setpts=PTS-STARTPTS,${filt(rows.slice(a, b))}[${uid}o${i}]`);
  });
  // the pieces are joined from time 0; the clip's place on the timeline is put back after
  lines.push(`${ps.map((_, i) => `[${uid}o${i}]`).join('')}concat=n=${ps.length}:v=1:a=0,${tail},setpts=PTS+${atSec.toFixed(3)}/TB[${to}]`);
  return lines;
}

/**
 * Where a pin's quad is in each output frame, in canvas pixels. `quadRef` is the quad at the tracker's reference frame (unit
 * coordinates); `steady` is the clip's stabilization table when there is one (the picture the pin sits on is then the steadied
 * one); `fit` places the displayed frame on the canvas (reframing).
 */
export function pinQuads(
  d: TrackData,
  quadRef: Quad,
  t: ClipTiming,
  steady: Corners[] | null,
  fit: { x: number; y: number; w: number; h: number },
): Quad[] {
  const path = pathOf(d);
  const out: Quad[] = [];
  for (let k = 0; k < t.frames; k++) {
    const { i, t: u } = frameAt(d, srcTime(t, k));
    const c = u === 0 || i + 1 >= path.length ? cornersOf(path[i]!) : lerpCorners(cornersOf(path[i]!), cornersOf(path[i + 1]!), u);
    const H = fromCorners(c) ?? path[i]!;
    let pts: Pt[] = quadRef.map(([x, y]) => apply(H, x, y));
    if (steady) {
      const M = fromCorners(steady[k]!);
      const Mi = M ? inv3(M) : null;
      if (Mi) pts = pts.map(([x, y]) => apply(Mi, x, y));
    }
    out.push(pts.map(([x, y]) => [fit.x + x * fit.w, fit.y + y * fit.h]) as Quad);
  }
  return out;
}
