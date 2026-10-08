/**
 * Camera-path stabilization from a tracked path. A path is one homography per frame (reference coordinates -> that frame's
 * coordinates, all in the unit square). The four images of the unit square describe it completely, so a path is eight number
 * series, and smoothing it is smoothing eight series. The correction for a frame is M = P S^-1: it takes a point of the
 * steadied picture to where it is in the shaky frame, which is exactly what a warp that samples the shaky frame needs.
 */
import { fitHomography, type Pt } from './geom.js';
import { apply, inv3, mul3, type Mat3 } from './linalg.js';

export const UNIT: [Pt, Pt, Pt, Pt] = [[0, 0], [1, 0], [1, 1], [0, 1]];
export type Corners = [Pt, Pt, Pt, Pt];

export const cornersOf = (H: Mat3): Corners => UNIT.map(([x, y]) => apply(H, x, y)) as Corners;
export const fromCorners = (c: Corners): Mat3 | null => fitHomography(UNIT, c);

/** Gaussian smoothing of a series with odd reflection at the ends (keeps a steady drift at the edges instead of flattening it). */
export function smoothSeries(x: number[], sigma: number): number[] {
  const n = x.length;
  if (n < 2 || sigma < 0.3) return x.slice();
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const s = k.reduce((a, b) => a + b, 0);
  const at = (i: number) => {
    if (i < 0) return 2 * x[0]! - x[Math.min(n - 1, -i)]!;
    if (i >= n) return 2 * x[n - 1]! - x[Math.max(0, 2 * (n - 1) - i)]!;
    return x[i]!;
  };
  return x.map((_, i) => {
    let a = 0;
    for (let j = -r; j <= r; j++) a += k[j + r]! * at(i + j);
    return a / s;
  });
}

export const flat = (c: Corners) => c.flat();
export const unflat = (v: number[]): Corners => [[v[0]!, v[1]!], [v[2]!, v[3]!], [v[4]!, v[5]!], [v[6]!, v[7]!]];

/** The smallest enlargement z >= 1 for which the output rectangle, pulled through M, lies inside the unit square. */
export function zoomNeeded(M: Mat3): number {
  const inside = (z: number) => {
    for (const [u, v] of UNIT) {
      const [x, y] = apply(M, 0.5 + (u - 0.5) / z, 0.5 + (v - 0.5) / z);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return false;
    }
    return true;
  };
  if (inside(1)) return 1;
  let lo = 1;
  let hi = 8;
  if (!inside(hi)) return Infinity;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface StabPlan {
  /** per analysis frame: the correction M (steady coordinates -> source frame), zoom already applied to the output rectangle */
  corners: Corners[];
  /** the enlargement used (static) */
  zoom: number;
  /** how much of the smoothing was kept (1 = all; less when the border limit forced it down) */
  alpha: number;
  /** rms distance between the shaky path and the steadied one, in fractions of the frame width */
  removed: number;
  /** the smoothed paths (for pinning on the steadied picture) */
  smoothed: Mat3[];
  paths: Mat3[];
}

/**
 * Plans the correction. `sigmaFrames` is the smoothing length in frames; `lock` holds the frame fixed on the reference.
 * If the borders would need more than `maxZoom` of enlargement, the amount of correction is scaled back until they do not.
 */
export function planStabilization(paths: Mat3[], o: { sigmaFrames: number; lock: boolean; maxZoom: number }): StabPlan {
  const n = paths.length;
  const P = paths.map(cornersOf).map(flat);
  const series = Array.from({ length: 8 }, (_, k) => P.map((p) => p[k]!));
  const smooth = o.lock ? UNIT.flat() : null;
  const S = o.lock
    ? P.map(() => UNIT.flat())
    : (() => {
        const sm = series.map((s) => smoothSeries(s, o.sigmaFrames));
        return P.map((_, i) => sm.map((s) => s[i]!));
      })();
  void smooth;
  const build = (alpha: number) => {
    const Ms: Mat3[] = [];
    const Hs: Mat3[] = [];
    for (let i = 0; i < n; i++) {
      const target = P[i]!.map((v, k) => v + alpha * (S[i]![k]! - v));
      const Hs_ = fromCorners(unflat(target));
      const Hp = paths[i]!;
      const Hsi = Hs_ ? inv3(Hs_) : null;
      Hs.push(Hs_ ?? Hp);
      Ms.push(Hsi ? mul3(Hp, Hsi) : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3));
    }
    const z = Math.max(1, ...Ms.map(zoomNeeded));
    return { Ms, Hs, z };
  };
  let alpha = 1;
  let r = build(1);
  if (r.z > o.maxZoom) {
    let lo = 0;
    let hi = 1;
    let best = build(0);
    alpha = 0;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const t = build(mid);
      if (t.z <= o.maxZoom) {
        lo = mid;
        best = t;
        alpha = mid;
      } else hi = mid;
    }
    r = best;
  }
  const z = Math.min(Math.max(r.z, 1), o.maxZoom);
  const corners = r.Ms.map((M) =>
    UNIT.map(([u, v]) => apply(M, 0.5 + (u - 0.5) / z, 0.5 + (v - 0.5) / z)) as Corners,
  );
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i]!;
    const b = a.map((v, k) => v + alpha * (S[i]![k]! - v));
    for (let k = 0; k < 8; k++) sq += (a[k]! - b[k]!) ** 2;
  }
  return { corners, zoom: z, alpha, removed: Math.sqrt(sq / (8 * Math.max(1, n))), smoothed: r.Hs, paths };
}

/**
 * Where a point of the source frame ends up in the steadied picture of frame i (the inverse of the correction, with the
 * enlargement). Used to keep a pinned graphic on its plane in the steadied picture.
 */
export function sourceToSteady(M: Mat3, zoom: number, p: Pt): Pt {
  const Mi = inv3(M);
  if (!Mi) return p;
  const [u, v] = apply(Mi, p[0], p[1]);
  return [0.5 + (u - 0.5) * zoom, 0.5 + (v - 0.5) * zoom];
}

/**
 * Fills the frames a tracker lost: each corner series is interpolated linearly between the nearest frames that were tracked
 * and held at the ends. With nothing tracked at all, every frame is the identity.
 */
export function fillGaps(paths: (Mat3 | null)[]): Mat3[] {
  const n = paths.length;
  const known = paths.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return paths.map(() => [1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3);
  const C = paths.map((p) => (p ? flat(cornersOf(p)) : null));
  return paths.map((p, i) => {
    if (p) return p;
    const a = [...known].reverse().find((k) => k < i);
    const b = known.find((k) => k > i);
    let v: number[];
    if (a === undefined) v = C[b!]!;
    else if (b === undefined) v = C[a]!;
    else {
      const t = (i - a) / (b - a);
      v = C[a]!.map((x, k) => x + t * (C[b]![k]! - x));
    }
    return fromCorners(unflat(v)) ?? paths[a ?? b!]!;
  });
}

/** The homography between two sets of four unit-square corners, interpolated at fraction t (corner by corner). */
export function lerpCorners(a: Corners, b: Corners, t: number): Corners {
  return a.map((p, i) => [p[0] + t * (b[i]![0] - p[0]), p[1] + t * (b[i]![1] - p[1])]) as Corners;
}
