import { readFrames } from '@studio/vision';

/**
 * One analysed frame (RGB bytes at `size`) at a time in the source: the decoder is started a little before it, so a time at the
 * very end of the file still yields the last picture instead of nothing.
 */
export async function grabFrame(file: string, ms: number, fps: number, size: { w: number; h: number }): Promise<Buffer | undefined> {
  const step = 1000 / fps;
  const start = Math.max(0, ms - 2 * step);
  const want = Math.round((ms - start) / step);
  let last: Buffer | undefined;
  let i = 0;
  for await (const b of readFrames({ file, startMs: start, durMs: Math.ceil(4 * step), fps, size, channels: 3 })) {
    last = b;
    if (i++ >= want) break;
  }
  return last;
}
