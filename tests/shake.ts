/** Measuring shake in a video, by a method that shares no code with the tracker: dense optical flow between frames. */
import { denseFlow, fromBytes, readFrames, type Gray } from '../packages/vision/src/index.js';

/** Frames of a video as gray images, half size. */
export async function grays(file: string, w = 320, h = 180): Promise<Gray[]> {
  const out: Gray[] = [];
  for await (const b of readFrames({ file, size: { w, h } })) out.push(fromBytes(b, w, h, 1));
  return out;
}
export const median = (a: ArrayLike<number>) => Float32Array.from(a).sort()[a.length >> 1]!;
/** Global translation between consecutive frames: the median of the dense flow over the middle of the picture. */
export function steps(frames: Gray[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    const f = denseFlow(frames[i]!, frames[i + 1]!);
    const u: number[] = [];
    const v: number[] = [];
    for (let y = f.h * 0.2; y < f.h * 0.8; y += 2) for (let x = f.w * 0.2; x < f.w * 0.8; x += 2) (u.push(f.u[Math.floor(y) * f.w + Math.floor(x)]!), v.push(f.v[Math.floor(y) * f.w + Math.floor(x)]!));
    out.push([median(u), median(v)]);
  }
  return out;
}
/** rms of the change of the step from one frame to the next: what a viewer sees as shake (px, at the measured width). */
export function shake(s: [number, number][]): number {
  let sq = 0;
  for (let i = 0; i + 1 < s.length; i++) sq += (s[i + 1]![0] - s[i]![0]) ** 2 + (s[i + 1]![1] - s[i]![1]) ** 2;
  return Math.sqrt(sq / Math.max(1, s.length - 1));
}
