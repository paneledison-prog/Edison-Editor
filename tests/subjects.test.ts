/**
 * Finding subjects (packages/vision/src/subjects.ts): one list from many masks, parts told from wholes, movers found by their motion
 * against the background's, masks stored exactly, numbers drawn where they belong.
 */
import { describe, expect, it } from 'vitest';
import { colourName, drawText, maskToRle, movingBlobs, rankSubjects, rleToMask, type Candidate } from '../packages/vision/src/index.js';

const W = 120;
const H = 80;
const rect = (x0: number, y0: number, x1: number, y1: number): Uint8Array => {
  const m = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
};
const cand = (mask: Uint8Array, quality = 0.9, o: Partial<Candidate> = {}): Candidate => ({ mask, quality, prompt: 0, candidate: 0, ...o });

describe('rankSubjects', () => {
  it('drops duplicates, weak, tiny and huge masks, and marks parts of things', () => {
    const person = rect(10, 10, 50, 70);
    const almostPerson = rect(10, 10, 50, 68); // the same thing again (IoU 0.97)
    const face = rect(20, 12, 40, 30); // inside the person
    const lamp = rect(70, 20, 90, 60);
    const speck = rect(100, 5, 102, 7); // 4 px: too small to be a thing
    const mover = rect(100, 60, 103, 66); // 18 px, but found by its motion: kept
    const weak = rect(60, 65, 100, 78);
    const all = rect(0, 0, W, H);
    const r = rankSubjects([cand(person, 0.95), cand(almostPerson, 0.9), cand(face), cand(lamp), cand(speck), cand(mover, 0.9, { small: true }), cand(weak, 0.5), cand(all)], W, H);
    const sizes = r.map((s) => s.area);
    expect(r).toHaveLength(4); // person, lamp, face, mover
    expect(sizes).toContain(40 * 60);
    expect(sizes).not.toContain(40 * 58); // the duplicate went, the better one stayed
    const faceRow = r.find((s) => s.area === 20 * 18)!;
    expect(r[faceRow.parent]!.area).toBe(40 * 60);
    expect(r.find((s) => s.area === 20 * 40)!.parent).toBe(-1);
    expect(r.find((s) => s.area === 18)!.parent).toBe(-1);
  });
});

describe('exact masks in the project', () => {
  it('run-length coding gives back the same mask, and scales to another size', () => {
    const m = rect(7, 3, 61, 49);
    m[0] = 1; // a run at the very start
    m[W * H - 1] = 1; // and at the very end
    const r = maskToRle(m, W, H);
    const back = rleToMask(r, W, H);
    for (let i = 0; i < m.length; i++) expect(back[i]).toBe(m[i]);
    const big = rleToMask(r, W * 2, H * 2);
    expect(big[(20 * 2) * W * 2 + 30 * 2]).toBe(1);
    expect(big[(60 * 2) * W * 2 + 100 * 2]).toBe(0);
    expect(r.rle.length).toBeLessThan(200);
  });
});

describe('movers', () => {
  it('finds what moves against a panning, slightly turning background, and nothing else', () => {
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        // the camera: a pan and a small turn
        u[y * W + x] = 2 + 0.01 * (y - H / 2);
        v[y * W + x] = -1 - 0.01 * (x - W / 2);
      }
    for (let y = 30; y < 50; y++) for (let x = 80; x < 88; x++) (u[y * W + x] = -3), (v[y * W + x] = 0.5);
    const b = movingBlobs({ u, v }, W, H);
    expect(b.length).toBeGreaterThanOrEqual(1);
    const [x, y] = b[0]!.point;
    expect(x).toBeGreaterThanOrEqual(80);
    expect(x).toBeLessThan(88);
    expect(y).toBeGreaterThanOrEqual(30);
    expect(y).toBeLessThan(50);
    expect(b[0]!.size).toBeGreaterThanOrEqual(120);
    // a still picture (the camera alone) has no movers
    const still = movingBlobs({ u: new Float32Array(W * H).fill(2), v: new Float32Array(W * H).fill(-1) }, W, H);
    expect(still).toHaveLength(0);
  });
});

describe('the numbered sheet', () => {
  it('numbers land where they are asked to, also from fractional positions', () => {
    const buf = new Uint8Array(W * H * 3);
    drawText(buf, W, H, 30.5, 20.5, 's1', [255, 255, 255], 2);
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (let i = 0; i < W * H; i++)
      if (buf[3 * i] === 255) {
        const x = i % W, y = Math.floor(i / W);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    expect(minX).toBeGreaterThanOrEqual(30);
    expect(maxX).toBeLessThan(30 + 16);
    expect(minY).toBeGreaterThanOrEqual(20);
    expect(maxY).toBeLessThan(20 + 11);
  });
  it('names colours plainly', () => {
    expect(colourName(30, 40, 110)).toBe('navy');
    expect(colourName(235, 90, 160)).toBe('pink');
    expect(colourName(245, 245, 245)).toBe('white');
  });
});
