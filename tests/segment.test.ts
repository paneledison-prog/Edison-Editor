/**
 * Cutting an object out of a picture from a few marks, and following it through a shot, against a shot whose true matte is known.
 */
import { describe, expect, it } from 'vitest';
import { components, followStep, segmentFrame, selectSubject, startFollowing, type Seeds } from '../packages/vision/src/index.js';
import { iou, mae, renderObjectShot } from './matte-helpers.js';

const W = 320;
const H = 180;

describe('one frame from marks', () => {
  const shot = renderObjectShot(1, W, H);
  const c = shot.where[0]!;
  const box: [number, number, number, number] = [(c.x - c.r * 1.4) / W, (c.y - c.r * 1.4) / H, (c.r * 2.8) / W, (c.r * 2.8) / H];

  it('a box and a dot on the object cut it out (inside against outside, learnt from the picture itself)', () => {
    const seeds: Seeds = { box, fg: [{ p: [[c.x / W, c.y / H]], r: 0.02 }] };
    const t0 = Date.now();
    const seg = segmentFrame(shot.frames[0]!, W, H, seeds);
    const ms = Date.now() - t0;
    const score = iou(seg.alpha, shot.gt[0]!);
    console.log(`SEGMENT box+dot: IoU ${score.toFixed(4)}, mean abs error ${mae(seg.alpha, shot.gt[0]!).toFixed(4)} (${W}x${H}, ${ms} ms)`);
    expect(score).toBeGreaterThan(0.97);
  });

  it('a box alone is enough when the object differs in colour from what surrounds it', () => {
    const seg = segmentFrame(shot.frames[0]!, W, H, { box });
    const score = iou(seg.alpha, shot.gt[0]!);
    console.log(`SEGMENT box only: IoU ${score.toFixed(4)}`);
    expect(score).toBeGreaterThan(0.95);
  });

  it('similar colours: strokes help but cannot separate what colour cannot; a rough outline can', () => {
    const hard = renderObjectShot(1, W, H, { similar: true });
    const h0 = hard.where[0]!;
    const hbox: [number, number, number, number] = [(h0.x - h0.r * 1.4) / W, (h0.y - h0.r * 1.4) / H, (h0.r * 2.8) / W, (h0.r * 2.8) / H];
    // the lower part of this object wears the background's colours, so colour cannot separate them
    const none = segmentFrame(hard.frames[0]!, W, H, { box: hbox, fg: [{ p: [[h0.x / W, (h0.y - h0.r * 0.4) / H]], r: 0.012 }] });
    const strokes = segmentFrame(hard.frames[0]!, W, H, { box: hbox, fg: [{ p: [[h0.x / W, (h0.y - h0.r * 0.4) / H], [h0.x / W, (h0.y + h0.r * 0.7) / H], [(h0.x + h0.r * 0.4) / W, (h0.y + h0.r * 0.4) / H], [(h0.x - h0.r * 0.4) / W, (h0.y + h0.r * 0.4) / H]], r: 0.014 }] });
    // an outline drawn by eye: the true boundary sampled every 15 degrees, each point a few pixels off
    const rng = (() => { let a = 3; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5; })();
    const poly: [number, number][] = [];
    const t = 0; // frame 0: no turning
    void t;
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * 2 * Math.PI;
      const rr = 1 + 0.18 * Math.sin(3 * ang + 0) + 0.1 * Math.sin(5 * ang);
      poly.push([(h0.x + Math.cos(ang) * rr * h0.r + rng() * 3) / W, (h0.y + Math.sin(ang) * rr * h0.r + rng() * 3) / H]);
    }
    const outlined = segmentFrame(hard.frames[0]!, W, H, { outline: { p: poly, band: 0.015 }, fg: [{ p: [[h0.x / W, h0.y / H]], r: 0.02 }] });
    const sc = (x: Float32Array) => iou(x, hard.gt[0]!);
    console.log(`SEGMENT similar colours: one dot ${sc(none.alpha).toFixed(3)}, four strokes ${sc(strokes.alpha).toFixed(3)}, an outline drawn by eye (points up to 1.5 px off, ring 4.8 px) ${sc(outlined.alpha).toFixed(3)}`);
    expect(sc(outlined.alpha)).toBeGreaterThan(0.9);
    expect(sc(outlined.alpha)).toBeGreaterThan(sc(none.alpha));
  });
});

describe('following it through the shot', () => {
  it('one keyframe, 60 frames of moving, turning, deforming object over a panning background', () => {
    const N = 60;
    const shot = renderObjectShot(N, W, H);
    const c = shot.where[0]!;
    const seeds: Seeds = { box: [(c.x - c.r * 1.5) / W, (c.y - c.r * 1.5) / H, (c.r * 3) / W, (c.r * 3) / H], fg: [{ p: [[c.x / W, c.y / H]], r: 0.02 }] };
    const seg = segmentFrame(shot.frames[0]!, W, H, seeds);
    const st = startFollowing(shot.frames[0]!, W, H, seg);
    const scores = [iou(seg.alpha, shot.gt[0]!)];
    const t0 = Date.now();
    for (let i = 1; i < N; i++) scores.push(iou(followStep(st, shot.frames[i]!).alpha, shot.gt[i]!));
    const ms = (Date.now() - t0) / (N - 1);
    const mean = scores.reduce((a, b) => a + b, 0) / N;
    console.log(`FOLLOW ${N} frames from one keyframe: IoU mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)}, last ${scores[N - 1]!.toFixed(4)}; ${ms.toFixed(0)} ms per frame at ${W}x${H}`);
    expect(mean).toBeGreaterThan(0.95);
    expect(Math.min(...scores)).toBeGreaterThan(0.9);
  }, 120_000);

  const follow = (name: string, N: number, o: Parameters<typeof renderObjectShot>[3]) => {
    const shot = renderObjectShot(N, W, H, o);
    const c = shot.where[0]!;
    const seeds: Seeds = { box: [(c.x - c.r * 1.5) / W, (c.y - c.r * 1.5) / H, (c.r * 3) / W, (c.r * 3) / H], fg: [{ p: [[c.x / W, c.y / H]], r: 0.02 }] };
    const seg = segmentFrame(shot.frames[0]!, W, H, seeds);
    const st = startFollowing(shot.frames[0]!, W, H, seg);
    const scores = [iou(seg.alpha, shot.gt[0]!)];
    for (let i = 1; i < N; i++) scores.push(iou(followStep(st, shot.frames[i]!).alpha, shot.gt[i]!));
    const mean = scores.reduce((a, b) => a + b, 0) / N;
    console.log(`FOLLOW ${name}: IoU mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)} at frame ${scores.indexOf(Math.min(...scores))}, last ${scores[N - 1]!.toFixed(4)}`);
    return { mean, min: Math.min(...scores) };
  };
  it('through noise (2%)', () => {
    const r = follow('2% noise', 40, { noise: 0.02 });
    expect(r.mean).toBeGreaterThan(0.93);
  }, 120_000);
  it('through twice the speed', () => {
    const r = follow('double speed', 40, { speed: 2 });
    expect(r.mean).toBeGreaterThan(0.93);
  }, 120_000);
  it('through something passing in front of the object', () => {
    // the truth takes the bar's opacity into account: the object is not there behind it
    const r = follow('a bar crossing in front', 60, { occluder: true });
    expect(r.mean).toBeGreaterThan(0.9);
  }, 120_000);
});

describe('a saliency model as the guide', () => {
  it('keeps the parts of the model mask that lie on the marked object, and drops other salient things', () => {
    const w = 60;
    const h = 40;
    const prior = new Float32Array(w * h);
    const ref = new Float32Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) ((prior[y * w + x] = 1), (ref[y * w + x] = 1)); // the object
    for (let y = 10; y < 30; y++) for (let x = 40; x < 55; x++) prior[y * w + x] = 1; // another salient thing
    expect(components(Uint8Array.from(prior, (v) => (v > 0.5 ? 1 : 0)), w, h).sizes.length).toBe(3);
    const sel = selectSubject(prior, ref, w, h);
    expect(sel[15 * w + 15]).toBeGreaterThan(0.9);
    expect(sel[20 * w + 47]).toBe(0);
  });

  it('follows with a model mask that agrees, and ignores one that floods the picture', () => {
    const shot = renderObjectShot(4, W, H);
    const c = shot.where[0]!;
    const seeds: Seeds = { box: [(c.x - c.r * 1.4) / W, (c.y - c.r * 1.4) / H, (c.r * 2.8) / W, (c.r * 2.8) / H], fg: [{ p: [[c.x / W, c.y / H]], r: 0.02 }] };
    const seg = segmentFrame(shot.frames[0]!, W, H, seeds);
    // the same picture again (no motion), so that only the model mask can change the answer
    const run = (prior?: Float32Array) => followStep(startFollowing(shot.frames[0]!, W, H, seg), shot.frames[0]!, prior ? { prior } : {}).alpha;
    const gt = shot.gt[0]!;
    const shifted = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 3; x < W; x++) shifted[y * W + x] = gt[y * W + x - 3]!;
    const plain = iou(run(), gt);
    const flooded = iou(run(new Float32Array(W * H).fill(1)), gt);
    const matching = iou(run(Float32Array.from(gt)), gt);
    const drives = iou(run(shifted), shifted) - iou(run(), shifted);
    console.log(`GUIDED follow: IoU colour+flow ${plain.toFixed(4)}, matching model mask ${matching.toFixed(4)}, flooding mask ${flooded.toFixed(4)}; a mask 3 px off moves the matte (IoU gain ${drives.toFixed(4)})`);
    expect(matching).toBeGreaterThan(0.97);
    expect(flooded).toBeGreaterThan(plain - 0.005); // a mask that floods the picture does not agree with the motion: ignored
    expect(drives).toBeGreaterThan(0.005); // an agreeing mask drives the boundary
  });
});
