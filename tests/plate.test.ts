/**
 * Clean plate: an object removed from a shot and the background rebuilt from the other frames, against the true background.
 */
import { describe, expect, it } from 'vitest';
import { cleanPlate, morph, registerBackground, type Gray } from '../packages/vision/src/index.js';
import { renderObjectShot } from './matte-helpers.js';
import { cameraPath, renderPlane, texture, toBytes } from './vision-helpers.js';

const W = 320;
const H = 180;
const N = 24;

const grayOf = (rgb: Uint8Array): Gray => {
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = (0.299 * rgb[3 * i]! + 0.587 * rgb[3 * i + 1]! + 0.114 * rgb[3 * i + 2]!) / 255;
  return { w: W, h: H, d };
};

describe('clean plate', () => {
  it('rebuilds what was behind the object from the frames where it was elsewhere, and says what it could not', async () => {
    // the background pans a little (the helper's background shifts by up to 14 px) and the object moves over it
    const shot = renderObjectShot(N, W, H, { speed: 1 });
    const truth = renderObjectShot(N, W, H, { speed: 1, noObject: true });
    const holes = shot.gt.map((a) => {
      const m = new Uint8Array(W * H);
      for (let i = 0; i < m.length; i++) m[i] = a[i]! > 0.02 ? 1 : 0;
      return morph(m, W, H, 3, true);
    });
    const t0 = Date.now();
    const reg = await registerBackground(shot.frames.map(grayOf), holes);
    const t1 = Date.now();
    const plate = cleanPlate(shot.frames, holes, W, H, reg.H);
    const t2 = Date.now();
    let err = 0;
    let n = 0;
    let errSpread = 0;
    let nSpread = 0;
    for (let t = 0; t < N; t++)
      for (let i = 0; i < W * H; i++)
        if (holes[t]![i]) {
          for (let c = 0; c < 3; c++) err += Math.abs(plate.frames[t]![3 * i + c]! - truth.frames[t]![3 * i + c]!);
          n += 3;
        }
    // what the picture would have been with the hole left as the object (no fill): the baseline for "how much did the fill help"
    let base = 0;
    for (let t = 0; t < N; t++) for (let i = 0; i < W * H; i++) if (holes[t]![i]) for (let c = 0; c < 3; c++) base += Math.abs(shot.frames[t]![3 * i + c]! - truth.frames[t]![3 * i + c]!);
    void errSpread; void nSpread;
    const meanFilled = plate.filled.reduce((a, b) => a + b, 0) / N;
    console.log(`PLATE: mean error in the removed area ${(err / n).toFixed(2)} levels (with the object left in: ${(base / n).toFixed(2)}); ${(meanFilled * 100).toFixed(1)}% of the removed pixels filled from other frames, the rest spread in; registration: ${reg.lost.length} frames lost, ${reg.meanInliers.toFixed(0)} matches on average, worst rms ${reg.maxRms.toFixed(2)} px; ${t1 - t0} ms to follow the camera, ${t2 - t1} ms to fill ${N} frames at ${W}x${H}`);
    expect(err / n).toBeLessThan((base / n) * 0.35);
    expect(meanFilled).toBeGreaterThan(0.8);
  }, 300_000);

  it('follows a camera that pans, rotates and zooms (a homography per frame) and still rebuilds the background', async () => {
    const world = texture(W + 200, H + 140, 11);
    const path = cameraPath(N, W, H, { amp: 28, rot: 2.5, zoom: 0.05 });
    // the world is drawn shifted into the frame the way the camera sees it (the helper wants a frame-sized texture: use a crop)
    const crop: Gray = { w: W, h: H, d: new Float32Array(W * H) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) crop.d[y * W + x] = world.d[(y + 70) * world.w + x + 100]!;
    const bgFrames = renderPlane(crop, path, W, H);
    const rgb = (g: Gray) => {
      const b = toBytes(g);
      const o = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) (o[3 * i] = b[i]!, (o[3 * i + 1] = Math.round(b[i]! * 0.8)), (o[3 * i + 2] = Math.round(b[i]! * 0.6)));
      return o;
    };
    const truth = bgFrames.map(rgb);
    const shot = truth.map((f) => f.slice());
    const holes: Uint8Array[] = [];
    for (let t = 0; t < N; t++) {
      // a disc of 30 px radius that moves across the picture, in front of the world
      const cx = 60 + (t / (N - 1)) * 200;
      const cy = 90 + 25 * Math.sin(t / 3);
      const m = new Uint8Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (Math.hypot(x - cx, y - cy) < 30) {
            m[y * W + x] = 1;
            shot[t]![3 * (y * W + x)] = 200;
            shot[t]![3 * (y * W + x) + 1] = 40;
            shot[t]![3 * (y * W + x) + 2] = 40;
          }
      holes.push(morph(m, W, H, 3, true));
    }
    const reg = await registerBackground(shot.map(grayOf), holes);
    const plate = cleanPlate(shot, holes, W, H, reg.H);
    let err = 0;
    let base = 0;
    let n = 0;
    for (let t = 0; t < N; t++)
      for (let i = 0; i < W * H; i++)
        if (holes[t]![i]) {
          for (let c = 0; c < 3; c++) {
            err += Math.abs(plate.frames[t]![3 * i + c]! - truth[t]![3 * i + c]!);
            base += Math.abs(shot[t]![3 * i + c]! - truth[t]![3 * i + c]!);
          }
          n += 3;
        }
    const meanFilled = plate.filled.reduce((a, b) => a + b, 0) / N;
    console.log(`PLATE (camera pans, rotates, zooms): mean error in the removed area ${(err / n).toFixed(2)} levels (object left in: ${(base / n).toFixed(2)}); ${(meanFilled * 100).toFixed(1)}% filled from other frames; ${reg.lost.length} frames lost, ${reg.meanInliers.toFixed(0)} matches on average, worst rms ${reg.maxRms.toFixed(2)} px`);
    expect(err / n).toBeLessThan((base / n) * 0.35);
  }, 300_000);
});
