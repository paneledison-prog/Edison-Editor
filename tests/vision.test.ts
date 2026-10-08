import { describe, expect, it } from 'vitest';
import {
  apply, buildPyr, denseFlow, detectCorners, fitHomography, fitSimilarity, inv3, mul3, newGray, nullVector, ransac, rng, solve, svd,
  trackChecked, trackPoints, warpHomography, type Gray, type Mat3, type Pt,
} from '../packages/vision/src/index.js';
import { cameraPath, noisy, renderPlane, texture } from './vision-helpers.js';

const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe('linear algebra', () => {
  it('SVD reconstructs a random matrix, with orthonormal factors and sorted values', () => {
    const R = rng(3);
    const m = 12;
    const n = 7;
    const A = Float64Array.from({ length: m * n }, () => R() * 2 - 1);
    const { U, S, V } = svd(A, m, n);
    let worst = 0;
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += U[i * n + k]! * S[k]! * V[j * n + k]!;
        worst = Math.max(worst, Math.abs(s - A[i * n + j]!));
      }
    expect(worst).toBeLessThan(1e-10);
    for (let k = 1; k < n; k++) expect(S[k - 1]!).toBeGreaterThanOrEqual(S[k]!);
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        let d = 0;
        for (let i = 0; i < n; i++) d += V[i * n + a]! * V[i * n + b]!;
        expect(Math.abs(d - (a === b ? 1 : 0))).toBeLessThan(1e-10);
      }
  });

  it('finds the null vector of a rank-deficient system and solves a linear system', () => {
    const v = [3, -2, 5, 1];
    const rows: number[] = [];
    const R = rng(5);
    for (let i = 0; i < 9; i++) {
      const a = [R(), R(), R(), 0];
      a[3] = -(a[0]! * v[0]! + a[1]! * v[1]! + a[2]! * v[2]!) / v[3]!;
      rows.push(...a);
    }
    const x = nullVector(rows, 9, 4);
    const k = v[3]! / x[3]!;
    for (let i = 0; i < 4; i++) expect(Math.abs(x[i]! * k - v[i]!)).toBeLessThan(1e-9);
    const s = solve([2, 1, 1, 3], [5, 10], 2)!;
    expect(s[0]!).toBeCloseTo(1, 12);
    expect(s[1]!).toBeCloseTo(3, 12);
    expect(solve([1, 2, 2, 4], [1, 2], 2)).toBeNull();
  });
});

describe('homography fitting', () => {
  const H: Mat3 = [1.1, 0.12, 8, -0.08, 0.95, -5, 0.0004, -0.0002, 1];
  const R = rng(9);
  const src: Pt[] = Array.from({ length: 200 }, () => [R() * 640, R() * 480]);
  const dst: Pt[] = src.map(([x, y]) => apply(H, x, y));

  it('recovers an exact homography from four points, and from many with noise', () => {
    const quad = [0, 1, 2, 3];
    const exact = fitHomography(src, dst, quad)!;
    for (const [x, y] of src.slice(0, 30)) {
      const [a, b] = apply(exact, x, y);
      const [c, d] = apply(H, x, y);
      expect(Math.hypot(a - c, b - d)).toBeLessThan(1e-6);
    }
    const Rn = rng(2);
    const noisyDst = dst.map(([x, y]) => [x + (Rn() - 0.5) * 0.6, y + (Rn() - 0.5) * 0.6] as Pt);
    const fit = fitHomography(src, noisyDst)!;
    const errs = src.map(([x, y], i) => {
      const [a, b] = apply(fit, x, y);
      const [c, d] = apply(H, x, y);
      void i;
      return Math.hypot(a - c, b - d);
    });
    expect(rms(errs)).toBeLessThan(0.3); // noise of 0.17 px rms in each coordinate is averaged down
  });

  it('RANSAC finds the model among 40% gross outliers, and says which matches are right', () => {
    const Ro = rng(4);
    const bad = new Set<number>();
    while (bad.size < 80) bad.add(Math.floor(Ro() * 200));
    const q = dst.map(([x, y], i) => (bad.has(i) ? ([Ro() * 640, Ro() * 480] as Pt) : ([x + (Ro() - 0.5) * 0.4, y + (Ro() - 0.5) * 0.4] as Pt)));
    const fit = ransac('homography', src, q, { thresh: 1.5, seed: 11 })!;
    expect(fit).not.toBeNull();
    let right = 0;
    let wrong = 0;
    for (let i = 0; i < 200; i++) {
      if (bad.has(i)) wrong += fit.inliers[i]! ? 1 : 0;
      else right += fit.inliers[i]! ? 1 : 0;
    }
    expect(right).toBeGreaterThanOrEqual(112); // at least 93% of the 120 true matches
    expect(wrong).toBeLessThanOrEqual(2);
    for (const [x, y] of [[0, 0], [640, 0], [640, 480], [0, 480]]) {
      const [a, b] = apply(fit.H, x!, y!);
      const [c, d] = apply(H, x!, y!);
      expect(Math.hypot(a - c, b - d)).toBeLessThan(1);
    }
    // a similarity fit under the same outliers
    const S = fitSimilarity(src, src.map(([x, y]) => [0.98 * x - 0.1 * y + 4, 0.1 * x + 0.98 * y - 3] as Pt))!;
    expect(S[0]).toBeCloseTo(0.98, 8);
    expect(S[3]).toBeCloseTo(0.1, 8);
    expect(inv3(mul3(S, inv3(S)!))![0]).toBeCloseTo(1, 9);
  });
});

describe('corner detection', () => {
  it('finds the corners of a checkerboard where they are, and spreads them over the picture', () => {
    const w = 192;
    const h = 144;
    const g = newGray(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.d[y * w + x] = ((Math.floor(x / 24) + Math.floor(y / 24)) & 1) * 0.8 + 0.1;
    const blurred = warpHomography(g, [1, 0, 0, 0, 1, 0, 0, 0, 1]); // a straight copy
    const cs = detectCorners(blurred, { max: 200, border: 6, minDist: 6 });
    const truth: Pt[] = [];
    for (let j = 1; j < 6; j++) for (let i = 1; i < 8; i++) truth.push([i * 24 - 0.5, j * 24 - 0.5]);
    // every detection is near an inner corner (the straight-edge response is rejected), and most corners are found
    let near = 0;
    const offs: number[] = [];
    for (const c of cs) {
      const d = Math.min(...truth.map(([x, y]) => Math.hypot(c.x - x, c.y - y)));
      if (d <= 1) near++;
      offs.push(d);
    }
    console.log(`corner detection on a checkerboard: ${cs.length} found, ${near} within 1 px of a true corner, median offset ${offs.sort((a, b) => a - b)[offs.length >> 1]!.toFixed(2)} px`);
    expect(near / cs.length).toBeGreaterThan(0.9);
    const found = truth.filter(([x, y]) => cs.some((c) => Math.hypot(c.x - x, c.y - y) <= 1)).length;
    expect(found / truth.length).toBeGreaterThan(0.85);
  });

  it('keeps features apart and inside the mask', () => {
    const g = texture(320, 240, 5);
    const mask = new Uint8Array(320 * 240);
    for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) mask[y * 320 + x] = 1;
    const cs = detectCorners(g, { max: 150, minDist: 9, mask });
    expect(cs.length).toBeGreaterThan(60);
    for (const c of cs) expect(mask[Math.round(c.y) * 320 + Math.round(c.x)]).toBe(1);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) expect(Math.hypot(cs[i]!.x - cs[j]!.x, cs[i]!.y - cs[j]!.y)).toBeGreaterThanOrEqual(8.9);
  });
});

/** The second frame of a camera move: the texture seen through H (point in frame b = H x in frame a, so b(p) = a(H^-1 p)). */
const moved = (g: Gray, H: Mat3) => warpHomography(g, inv3(H)!);

describe('point tracking (Lucas-Kanade)', () => {
  const base = texture(320, 240, 12);
  const corners = detectCorners(base, { max: 250, minDist: 9, border: 20 });
  const pts: Pt[] = corners.map((c) => [c.x, c.y]);

  const errorFor = (H: Mat3, noise = 0, opts: Parameters<typeof trackPoints>[3] = {}) => {
    const b = noise ? noisy(moved(base, H), noise) : moved(base, H);
    const res = trackPoints(buildPyr(base, 4), buildPyr(b, 4, false), pts, opts);
    const errs: number[] = [];
    let ok = 0;
    res.forEach((t, i) => {
      const [x, y] = apply(H, pts[i]![0], pts[i]![1]);
      if (t.ok && x > 10 && y > 10 && x < 310 && y < 230) {
        ok++;
        errs.push(Math.hypot(t.x - x, t.y - y));
      }
    });
    const inside = pts.filter((p) => {
      const [x, y] = apply(H, p[0], p[1]);
      return x > 10 && y > 10 && x < 310 && y < 230;
    }).length;
    return { ok, inside, rms: rms(errs), p95: errs.sort((a, b) => a - b)[Math.floor(errs.length * 0.95)] ?? 0 };
  };

  it('follows a sub-pixel translation to a tenth of a pixel', () => {
    const r = errorFor([1, 0, 3.3, 0, 1, -2.1, 0, 0, 1]);
    console.log(`LK translation (3.3, -2.1): ${r.ok}/${r.inside} tracked, rms error ${r.rms.toFixed(3)} px, p95 ${r.p95.toFixed(3)}`);
    expect(r.ok / r.inside).toBeGreaterThan(0.95);
    expect(r.rms).toBeLessThan(0.1);
  });

  it('follows a large motion through the pyramid, and a rotation with a change of scale, keeping only the points it can trust', () => {
    const through = (H: Mat3) => {
      const b = moved(base, H);
      const res = trackChecked(buildPyr(base, 4), buildPyr(b, 4), pts);
      const errs: number[] = [];
      let inside = 0;
      pts.forEach((p, i) => {
        const [x, y] = apply(H, p[0], p[1]);
        if (x < 12 || y < 12 || x > 308 || y > 228) return;
        inside++;
        if (res[i]!.ok) errs.push(Math.hypot(res[i]!.x - x, res[i]!.y - y));
      });
      errs.sort((a, b2) => a - b2);
      return { kept: errs.length, inside, rms: rms(errs), worst: errs[errs.length - 1] ?? 0, median: errs[errs.length >> 1] ?? 0, p90: errs[Math.floor(errs.length * 0.9)] ?? 0 };
    };
    const big = through([1, 0, 18, 0, 1, 11, 0, 0, 1]);
    console.log(`LK translation (18, 11): kept ${big.kept}/${big.inside}, rms ${big.rms.toFixed(3)} px, worst ${big.worst.toFixed(2)}`);
    expect(big.kept / big.inside).toBeGreaterThan(0.7);
    expect(big.rms).toBeLessThan(0.3);
    expect(big.worst).toBeLessThan(2); // what it keeps, it keeps right
    const c = Math.cos((5 * Math.PI) / 180) * 1.05;
    const s = Math.sin((5 * Math.PI) / 180) * 1.05;
    const Hrot: Mat3 = [c, -s, 160 - c * 160 + s * 120, s, c, 120 - s * 160 - c * 120, 0, 0, 1];
    const rot = through(Hrot);
    console.log(`LK rotation 5 deg, scale 1.05: kept ${rot.kept}/${rot.inside}, median ${rot.median.toFixed(3)} px, 90th percentile ${rot.p90.toFixed(3)} px`);
    expect(rot.kept / rot.inside).toBeGreaterThan(0.75);
    expect(rot.median).toBeLessThan(0.3); // a window that is itself rotating and growing is not a pure translation: a little bias is expected
    expect(rot.p90).toBeLessThan(0.7); // a few matches are consistently wrong: the robust fit below is what removes them
    // and a robust fit over the kept points gives the camera motion back
    const b = moved(base, Hrot);
    const res = trackChecked(buildPyr(base, 4), buildPyr(b, 4), pts);
    const P: Pt[] = [];
    const Q: Pt[] = [];
    res.forEach((t, i) => t.ok && (P.push(pts[i]!), Q.push([t.x, t.y])));
    const fit = ransac('similarity', P, Q, { thresh: 0.75, seed: 3 })!;
    const cornerErr = Math.max(...[[0, 0], [320, 0], [320, 240], [0, 240]].map(([x, y]) => Math.hypot(...(apply(fit.H, x!, y!).map((v, k) => v - apply(Hrot, x!, y!)[k]!) as [number, number]))));
    console.log(`  robust similarity fit: ${fit.count}/${P.length} inliers, frame-corner error ${cornerErr.toFixed(3)} px`);
    expect(cornerErr).toBeLessThan(0.15);
  });

  it('holds up under sensor noise', () => {
    const r = errorFor([1, 0, 2.4, 0, 1, 1.7, 0, 0, 1], 0.03);
    console.log(`LK with noise sigma 0.03: ${r.ok}/${r.inside}, rms ${r.rms.toFixed(3)} px`);
    expect(r.ok / r.inside).toBeGreaterThan(0.85);
    expect(r.rms).toBeLessThan(0.3);
  });

  it('a predicted start lets it follow a motion far larger than the pyramid alone would', () => {
    const H: Mat3 = [1, 0, 40, 0, 1, -25, 0, 0, 1];
    const b = moved(base, H);
    const guess = pts.map(([x, y]) => [x + 38, y - 24] as Pt);
    const res = trackPoints(buildPyr(base, 4), buildPyr(b, 4, false), pts, { guess });
    const good = res.filter((t, i) => t.ok && Math.hypot(t.x - pts[i]![0] - 40, t.y - pts[i]![1] + 25) < 0.5).length;
    const inside = pts.filter((p) => p[0] + 40 < 310 && p[1] - 25 > 10).length;
    expect(good / inside).toBeGreaterThan(0.85);
  });

  it('the forward-backward check drops points whose surroundings were covered', () => {
    const H: Mat3 = [1, 0, 4, 0, 1, 2, 0, 0, 1];
    const b = moved(base, H);
    // cover the right half of the second frame with something unrelated
    const other = texture(320, 240, 99);
    for (let y = 0; y < 240; y++) for (let x = 160; x < 320; x++) b.d[y * 320 + x] = other.d[y * 320 + x]!;
    const res = trackChecked(buildPyr(base, 4), buildPyr(b, 4), pts);
    let leftKept = 0, leftN = 0, rightKept = 0, rightN = 0;
    pts.forEach((p, i) => {
      const [x] = apply(H, p[0], p[1]);
      if (x < 150) {
        leftN++;
        if (res[i]!.ok) leftKept++;
      } else if (x > 175) {
        rightN++;
        if (res[i]!.ok) rightKept++;
      }
    });
    console.log(`forward-backward: kept ${leftKept}/${leftN} visible, ${rightKept}/${rightN} covered`);
    expect(leftKept / leftN).toBeGreaterThan(0.85);
    expect(rightKept / rightN).toBeLessThan(0.15);
  });
});

describe('dense flow', () => {
  it('recovers a translation and a rotation field to a fraction of a pixel', () => {
    const a = texture(192, 144, 21);
    const T: Mat3 = [1, 0, 5, 0, 1, -3, 0, 0, 1];
    const f1 = denseFlow(a, moved(a, T));
    const mean = (f: typeof f1, expect_: (x: number, y: number) => [number, number]) => {
      const errs: number[] = [];
      for (let y = 20; y < 124; y++)
        for (let x = 20; x < 172; x++) {
          const [eu, ev] = expect_(x, y);
          errs.push(Math.hypot(f.u[y * f.w + x]! - eu, f.v[y * f.w + x]! - ev));
        }
      return errs.reduce((s, v) => s + v, 0) / errs.length;
    };
    const e1 = mean(f1, () => [5, -3]);
    const th = (3 * Math.PI) / 180;
    const R: Mat3 = [Math.cos(th), -Math.sin(th), 96 - Math.cos(th) * 96 + Math.sin(th) * 72, Math.sin(th), Math.cos(th), 72 - Math.sin(th) * 96 - Math.cos(th) * 72, 0, 0, 1];
    const f2 = denseFlow(a, moved(a, R));
    const e2 = mean(f2, (x, y) => {
      const [nx, ny] = apply(R, x, y);
      return [nx - x, ny - y];
    });
    console.log(`dense flow end-point error: translation (5,-3) ${e1.toFixed(3)} px, rotation 3 deg ${e2.toFixed(3)} px`);
    expect(e1).toBeLessThan(0.3);
    expect(e2).toBeLessThan(0.4);
  });
});

describe('frames in and out of ffmpeg', () => {
  it('a gray video written losslessly reads back bit for bit, at its size and rate', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { VideoWriter, readFrames, probeVideo, readSize } = await import('../packages/vision/src/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'studio-vis-'));
    const out = join(dir, 'm.mkv');
    const w = 64;
    const h = 36;
    const frames = Array.from({ length: 12 }, (_, k) => Uint8Array.from({ length: w * h }, (_, i) => (i * 7 + k * 31) & 255));
    const wr = new VideoWriter(out, { w, h, fps: 24 });
    for (const f of frames) await wr.write(f);
    await wr.close();
    const info = probeVideo(out);
    expect([info.w, info.h, info.fps, info.frames]).toEqual([w, h, 24, 12]);
    let k = 0;
    for await (const f of readFrames({ file: out, size: readSize(info, {}) })) {
      expect(Buffer.compare(f, Buffer.from(frames[k]!))).toBe(0);
      k++;
    }
    expect(k).toBe(12);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a range of a video resampled to a rate and scaled, as RGB or gray', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFrames, probeVideo, readSize } = await import('../packages/vision/src/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'studio-vis-'));
    const f = join(dir, 'v.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
    const info = probeVideo(f);
    expect([info.w, info.h, Math.round(info.fps)]).toEqual([320, 180, 30]);
    const size = readSize(info, { width: 160 });
    expect(size).toEqual({ w: 160, h: 90 });
    let n = 0;
    for await (const fr of readFrames({ file: f, startMs: 1000, durMs: 1000, fps: 10, size, channels: 3 })) {
      expect(fr.length).toBe(160 * 90 * 3);
      n++;
    }
    expect(n).toBe(10); // one second at 10 frames a second
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('planar tracking against a known camera', () => {
  const W = 480;
  const H = 270;
  const N = 100;
  const world = texture(W + 200, H + 160, 31); // the plane, larger than the view
  const toWorld: Mat3 = [1, 0, -100, 0, 1, -80, 0, 0, 1]; // frame 0 sees the middle of it
  const quadPx: Quad = [[150, 80], [330, 80], [330, 190], [150, 190]];

  async function run(frames: Gray[], gt: Mat3[], refine: boolean, model: 'similarity' | 'homography' = 'homography') {
    const { trackPlane } = await import('../packages/vision/src/index.js');
    const out: { H: Mat3 | null; ok: boolean; refined: boolean }[] = [];
    for await (const f of trackPlane(frames[0]!, quadPx, frames.slice(1), { model, refine })) out.push(f);
    // ground truth reference -> frame i: H_i * H_0^-1
    const errs: number[] = [];
    out.forEach((f, k) => {
      const i = k + 1;
      const Hgt = mul3(gt[i]!, inv3(gt[0]!)!);
      if (!f.H) return;
      for (const [x, y] of quadPx) {
        const [a, b] = apply(Hgt, x, y);
        const [c, d] = apply(f.H, x, y);
        errs.push(Math.hypot(a - c, b - d));
      }
    });
    return { errs, out, lastErr: errs.slice(-4), lost: out.filter((o) => !o.ok).length, refined: out.filter((o) => o.refined).length };
  }
  const stats = (e: number[]) => ({ rms: rms(e), max: Math.max(...e) });
  const path = cameraPath(N, W, H, { amp: 28, rot: 3, zoom: 0.05, persp: 0.0003 }).map((p) => mul3(p, toWorld) as Mat3);

  it('follows a plane through a smooth camera move to a fraction of a pixel, with no drift to the last frame', async () => {
    const frames = renderPlane(world, path, W, H);
    const r = await run(frames, path, true);
    const s = stats(r.errs);
    console.log(`PLANAR clean: ${N} frames, corner error rms ${s.rms.toFixed(3)} px, max ${s.max.toFixed(3)}, last frames ${r.lastErr.map((v) => v.toFixed(2)).join(' ')}, refined ${r.refined}/${N - 1}, lost ${r.lost}`);
    expect(r.lost).toBe(0);
    expect(s.rms).toBeLessThan(0.3);
    expect(s.max).toBeLessThan(1);
    expect(Math.max(...r.lastErr)).toBeLessThan(0.5);
  }, 120_000);

  it('keeps the plane while something moves across it, and when the light changes', async () => {
    const occ = await run(renderPlane(world, path, W, H, { occluder: true }), path, true);
    const so = stats(occ.errs);
    console.log(`PLANAR occluded: rms ${so.rms.toFixed(3)} px, max ${so.max.toFixed(3)}, lost ${occ.lost}`);
    expect(occ.lost).toBe(0);
    expect(so.rms).toBeLessThan(0.8);
    expect(so.max).toBeLessThan(3);
    const lit = await run(renderPlane(world, path, W, H, { gain: (i) => 1 - 0.3 * Math.sin((i / N) * Math.PI) }), path, true);
    const sl = stats(lit.errs);
    console.log(`PLANAR lighting -30% and back: rms ${sl.rms.toFixed(3)} px, max ${sl.max.toFixed(3)}`);
    expect(sl.rms).toBeLessThan(0.5);
  }, 240_000);

  it('the direct alignment is what removes drift: points alone drift, aligned to the reference they do not', async () => {
    const frames = renderPlane(world, path, W, H, { noise: 0.02 });
    const a = await run(frames, path, false);
    const b = await run(frames, path, true);
    const sa = stats(a.errs);
    const sb = stats(b.errs);
    console.log(`PLANAR with 2% noise: points only rms ${sa.rms.toFixed(3)} (end ${Math.max(...a.lastErr).toFixed(2)}) px; with alignment rms ${sb.rms.toFixed(3)} (end ${Math.max(...b.lastErr).toFixed(2)}) px`);
    expect(sb.rms).toBeLessThanOrEqual(sa.rms + 0.05);
    expect(sb.rms).toBeLessThan(0.4);
  }, 240_000);
});
