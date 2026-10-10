/**
 * Following by consensus of the segmenter's proposals (packages/vision/src/consensus.ts): a moving object that touches a still
 * neighbour with the very same colours. Colour cannot tell them apart; the segmenter's masks (stood in for here by the true
 * shapes, as the model would find them), the object's position and the layered motion can.
 */
import { describe, expect, it } from 'vitest';
import { consensusMask, denseFlow, grayOf, proposalPrompts, warpByFlow, type Proposal } from '../packages/vision/src/index.js';
import { iou } from './matte-helpers.js';
import { texture } from './vision-helpers.js';

const W = 320;
const H = 180;

/** disc masks and a frame where a textured disc (the object) at x and a still disc (the neighbour) touching it share one texture */
function scene(objX: number) {
  const bg = texture(W, H, 11);
  const fg = texture(W, H, 23);
  const obj = new Float32Array(W * H);
  const nb = new Float32Array(W * H);
  const rgb = new Uint8Array(W * H * 3);
  const NB = { x: 190, y: 90, r: 34 };
  const OB = { x: objX, y: 90, r: 38 };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inO = (x - OB.x) ** 2 + (y - OB.y) ** 2 <= OB.r ** 2;
      const inN = (x - NB.x) ** 2 + (y - NB.y) ** 2 <= NB.r ** 2;
      // the object's texture moves with it, the neighbour's does not
      const tO = fg.d[y * W + ((x - Math.round(OB.x) + 160 + W) % W)]!;
      const tN = fg.d[y * W + ((x - NB.x + 160 + W) % W)]!;
      const t = inO ? tO : inN ? tN : bg.d[i]!;
      const v = inO || inN ? 90 + 130 * t : 40 + 60 * t;
      rgb[3 * i] = v;
      rgb[3 * i + 1] = v * 0.8;
      rgb[3 * i + 2] = v * 0.6;
      if (inO) obj[i] = 1;
      else if (inN) nb[i] = 1;
    }
  return { rgb, obj, nb };
}

describe('consensus of proposals', () => {
  it('keeps out a still neighbour with the same colours, which the segmenter joined to the moving object', () => {
    const prev = scene(140);
    const cur = scene(148); // moves 8 px a frame; the neighbour stays
    const gp = grayOf(prev.rgb, W, H);
    const gc = grayOf(cur.rgb, W, H);
    const flow = denseFlow(gc, gp, { levels: 4, iters: 3, radius: 5 });
    const predicted = warpByFlow(prev.obj, W, H, flow.u, flow.v);
    // what the segmenter finds on the current frame: the object, the neighbour, and the two joined (it does that where they touch)
    const joined = Float32Array.from(cur.obj, (v, i) => Math.max(v, cur.nb[i]!));
    const props: Proposal[] = [
      { prob: cur.obj, iou: 0.9 },
      { prob: cur.nb, iou: 0.9 },
      { prob: joined, iou: 0.85 },
      { prob: joined, iou: 0.8 },
    ];
    const evidence = new Float32Array(W * H).fill(0.8); // colours say nothing: they are the same
    const c = consensusMask(predicted, props, W, H, { flow, frames: { prev: gp, cur: gc }, evidence });
    const score = iou(c.alpha, cur.obj);
    const joinedScore = iou(joined, cur.obj);
    console.log(`CONSENSUS still neighbour joined to a moving object: IoU ${score.toFixed(4)} (the joined proposal alone ${joinedScore.toFixed(4)}); ${c.accepted} accepted, ${c.foreign} foreign, ${c.how}, motion separation ${c.motionSeparation?.toFixed(1)} px`);
    expect(c.how).toBe('consensus');
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeGreaterThan(joinedScore + 0.05);
  });

  it('a neighbour that is not still (it moves with the object) cannot be told apart: nothing is pretended', () => {
    const prev = scene(140);
    const cur = scene(148);
    const gp = grayOf(prev.rgb, W, H);
    const gc = grayOf(cur.rgb, W, H);
    const flow = denseFlow(gc, gp, { levels: 4, iters: 3, radius: 5 });
    const joinedPrev = Float32Array.from(prev.obj, (v, i) => Math.max(v, prev.nb[i]!));
    const predicted = warpByFlow(joinedPrev, W, H, flow.u, flow.v);
    const joined = Float32Array.from(cur.obj, (v, i) => Math.max(v, cur.nb[i]!));
    const c = consensusMask(predicted, [{ prob: joined, iou: 0.9 }], W, H, { flow, frames: { prev: gp, cur: gc }, evidence: new Float32Array(W * H).fill(0.8) });
    // the matte before was the two together, and stays the two together: following keeps what it was told
    expect(iou(c.alpha, joined)).toBeGreaterThan(0.9);
  });

  it('with no proposal that fits, the carried matte stands', () => {
    const cur = scene(148);
    const far = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 40; x++) far[y * W + x] = 1;
    const c = consensusMask(cur.obj, [{ prob: far, iou: 0.9 }], W, H);
    expect(c.how).toBe('prediction');
    expect(iou(c.alpha, cur.obj)).toBe(1);
  });

  it('asks the segmenter about every part of the object, and about the whole of it', () => {
    const cur = scene(148);
    const prompts = proposalPrompts(cur.obj, W, H);
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    const points = prompts.filter((p) => p.points?.length === 1);
    for (const p of points) {
      const [x, y] = p.points![0]!;
      expect(cur.obj[Math.round(y) * W + Math.round(x)]).toBe(1); // every point lies on the object
    }
    expect(prompts.some((p) => p.box)).toBe(true);
  });
});
