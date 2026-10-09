/**
 * The edge engine against composites whose true opacity and true object colour are known: hair-like strands and a soft edge
 * over a background of similar brightness.
 */
import { describe, expect, it } from 'vitest';
import { estimateForeground, refineEdge, resizePlane } from '../packages/vision/src/index.js';
import { hairComposite, roughMask } from './matting-helpers.js';

const W = 640;
const H = 360;

describe('edge: from a rough low-resolution mask to a matte', () => {
  const c = hairComposite(W, H);
  const { low, lw, lh } = roughMask(c);
  // the part of the picture that is neither clearly object nor clearly background (the edge, and the strands)
  const band = new Uint8Array(W * H);
  for (let i = 0; i < band.length; i++) if (c.alpha[i]! > 0.02 && c.alpha[i]! < 0.98) band[i] = 1;
  const mae = (a: Float32Array) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < band.length; i++)
      if (band[i]) {
        s += Math.abs(a[i]! - c.alpha[i]!);
        n++;
      }
    return s / n;
  };

  it('opacity in the edge band is closer to the truth than the mask brought up by bilinear', () => {
    const base = resizePlane(low, lw, lh, W, H);
    const t0 = Date.now();
    const refined = refineEdge(c.image, W, H, low, lw, lh, { hair: true });
    const ms = Date.now() - t0;
    const e0 = mae(base);
    const e1 = mae(refined);
    // the whole picture too: refining must not damage the inside or the outside
    let all0 = 0;
    let all1 = 0;
    for (let i = 0; i < W * H; i++) {
      all0 += Math.abs(base[i]! - c.alpha[i]!);
      all1 += Math.abs(refined[i]! - c.alpha[i]!);
    }
    console.log(`EDGE: error of the opacity in the edge band ${e0.toFixed(4)} (mask by bilinear) -> ${e1.toFixed(4)} (refined); over the whole picture ${(all0 / (W * H)).toFixed(5)} -> ${(all1 / (W * H)).toFixed(5)}; ${ms} ms at ${W}x${H}`);
    expect(e1).toBeLessThan(e0 * 0.85);
    expect(all1).toBeLessThan(all0);
  });

  it('the colour of the object at the edge has the background taken out', () => {
    const alpha = refineEdge(c.image, W, H, low, lw, lh, { hair: true });
    const t0 = Date.now();
    const f = estimateForeground(c.image, alpha, W, H, 1);
    const ms = Date.now() - t0;
    // error against the true object colour where the true opacity is partly transparent but visible (alpha 0.15..0.95)
    let e0 = 0;
    let e1 = 0;
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const a = c.alpha[i]!;
      if (a < 0.15 || a > 0.95) continue;
      for (let ch = 0; ch < 3; ch++) {
        const truth = c.fg[ch]![i]! * 255;
        e0 += Math.abs(c.image[3 * i + ch]! - truth);
        e1 += Math.abs(f[3 * i + ch]! - truth);
      }
      n += 3;
    }
    console.log(`DECONTAMINATE: mean colour error at the edge ${(e0 / n).toFixed(2)} levels (the picture as it is) -> ${(e1 / n).toFixed(2)} (foreground estimate); ${ms} ms at ${W}x${H}`);
    expect(e1).toBeLessThan(e0 * 0.8);
  });
});

describe('flicker: steadying a sequence of mattes', () => {
  it('removes jitter at the edge and one-frame glitches without moving the object', async () => {
    const { smoothMattes, flickerOf, rng } = await import('../packages/vision/src/index.js');
    const w = 320;
    const h = 180;
    const base = hairComposite(w, h, 9);
    const N = 14;
    const R = rng(21);
    const frames: Uint8Array[] = [];
    const truth: Float32Array[] = [];
    const noisy: Float32Array[] = [];
    for (let t = 0; t < N; t++) {
      const dx = 2 * t; // the whole picture moves 2 px a frame
      const img = new Uint8Array(w * h * 3);
      const a = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.min(w - 1, Math.max(0, x - dx));
          const i = y * w + x;
          const j = y * w + sx;
          a[i] = base.alpha[j]!;
          for (let c = 0; c < 3; c++) img[3 * i + c] = base.image[3 * j + c]!;
        }
      frames.push(img);
      truth.push(a);
      // what a model gives frame by frame: the boundary decided a little differently each time, and now and then a hole or a blob
      const m = new Float32Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = a[i]! + 0.35 * (R() - 0.5) > 0.5 ? 1 : 0;
      if (t === 6 || t === 10) {
        const gx = 140 + Math.round(R() * 30);
        const gy = 100;
        for (let y = gy; y < gy + 14; y++) for (let x = gx; x < gx + 14; x++) m[y * w + x] = 1 - m[y * w + x]!;
      }
      noisy.push(m);
    }
    const iou = (p: Float32Array, q: Float32Array) => {
      let i = 0;
      let u = 0;
      for (let k = 0; k < p.length; k++) {
        const a = p[k]! > 0.5;
        const b = q[k]! > 0.5;
        if (a && b) i++;
        if (a || b) u++;
      }
      return u ? i / u : 1;
    };
    const t0 = Date.now();
    const r = smoothMattes(noisy, frames, w, h, { strength: 0.8 });
    const ms = Date.now() - t0;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rawIoU = mean(noisy.map((a, t) => iou(a, truth[t]!)));
    const smIoU = mean(r.alphas.map((a, t) => iou(a, truth[t]!)));
    const glitchRaw = iou(noisy[6]!, truth[6]!);
    const glitchSm = iou(r.alphas[6]!, truth[6]!);
    // the same metric on the truth itself is the floor (what honest motion looks like to it)
    const floor = flickerOf(truth, frames, w, h);
    console.log(`FLICKER: raw ${r.before.flicker.toFixed(4)} -> steadied ${r.after.flicker.toFixed(4)}; jitter ${r.before.jitter.toFixed(4)} -> ${r.after.jitter.toFixed(4)} (the truth itself: flicker ${floor.flicker.toFixed(4)}, jitter ${floor.jitter.toFixed(4)}); IoU with the truth ${rawIoU.toFixed(4)} -> ${smIoU.toFixed(4)}; the glitch frame ${glitchRaw.toFixed(4)} -> ${glitchSm.toFixed(4)}; ${ms} ms for ${N} frames at ${w}x${h}`);
    expect(r.after.flicker).toBeLessThan(r.before.flicker * 0.8);
    expect(r.after.jitter).toBeLessThan(r.before.jitter * 0.8);
    expect(smIoU).toBeGreaterThanOrEqual(rawIoU - 0.002);
    expect(glitchSm).toBeGreaterThan(glitchRaw);
  }, 120_000);
});
