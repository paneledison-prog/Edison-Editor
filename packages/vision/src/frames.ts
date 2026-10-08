/** Raw frames in and out of FFmpeg: decode a video range to gray or RGB buffers, write gray or RGB buffers to a video. */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface VideoInfo {
  w: number;
  h: number;
  fps: number;
  durMs: number;
  frames: number;
}

/** Size, frame rate and length of a video as it is displayed (rotation metadata applied). */
export function probeVideo(file: string): VideoInfo {
  const j = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:stream_side_data=rotation:format=duration', '-of', 'json', file], { encoding: 'utf8' }),
  );
  const s = j.streams?.[0];
  if (!s) throw new Error(`${file} has no video stream`);
  const rate = (r: string) => {
    const [a, b] = String(r).split('/').map(Number);
    return b ? a! / b : a!;
  };
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30;
  const rot = Math.abs(Number(s.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const durMs = Math.round(1000 * Number(s.duration ?? j.format?.duration ?? 0));
  const w = rot === 90 ? s.height : s.width;
  const h = rot === 90 ? s.width : s.height;
  return { w, h, fps, durMs, frames: Number(s.nb_frames) || Math.round((durMs / 1000) * fps) };
}

export interface ReadSpec {
  file: string;
  startMs?: number;
  durMs?: number;
  /** resample to this rate (frame i is then at startMs + i * 1000 / fps) */
  fps?: number;
  /** output width; the height follows the aspect unless `height` is given */
  width?: number;
  height?: number;
  channels?: 1 | 3;
  /** extra filters before the scale, e.g. a crop */
  pre?: string;
}

/** Size a read will produce for a video of w x h. */
export function readSize(info: { w: number; h: number }, spec: Pick<ReadSpec, 'width' | 'height'>): { w: number; h: number } {
  const w = spec.width ?? info.w;
  const h = spec.height ?? Math.max(2, Math.round((w * info.h) / info.w / 2) * 2);
  return { w, h };
}

/** Decodes frames one by one without holding the video in memory. */
export async function* readFrames(spec: ReadSpec & { size: { w: number; h: number } }): AsyncGenerator<Buffer> {
  const ch = spec.channels ?? 1;
  const { w, h } = spec.size;
  const vf = [spec.pre, spec.fps ? `fps=${spec.fps}` : '', `scale=${w}:${h}:flags=area`, ch === 1 ? 'format=gray' : 'format=rgb24'].filter(Boolean).join(',');
  const args = ['-v', 'error', ...(spec.startMs ? ['-ss', (spec.startMs / 1000).toFixed(3)] : []), ...(spec.durMs ? ['-t', (spec.durMs / 1000).toFixed(3)] : []), '-i', spec.file, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', ch === 1 ? 'gray' : 'rgb24', '-'];
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise<number | null>((r) => child.on('close', r));
  const size = w * h * ch;
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    while (buf.length >= size) {
      yield Buffer.from(buf.subarray(0, size));
      buf = buf.subarray(size);
    }
  }
  const code = await done;
  if (code !== 0 && code !== null) throw new Error(`ffmpeg could not decode ${spec.file}: ${err.trim().split('\n').pop()}`);
}

/** Writes raw frames to a video file. Gray masks default to lossless FFV1 (small for smooth masks). */
export class VideoWriter {
  private child: ChildProcessWithoutNullStreams;
  private err = '';
  private closed: Promise<number | null>;
  constructor(out: string, o: { w: number; h: number; fps: number; channels?: 1 | 3; codec?: string[]; inputOpts?: string[] }) {
    const ch = o.channels ?? 1;
    this.child = spawn(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', ch === 1 ? 'gray' : 'rgb24', '-s', `${o.w}x${o.h}`, '-r', String(o.fps), ...(o.inputOpts ?? []), '-i', '-', ...(o.codec ?? ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gray']), out],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr.on('data', (d) => (this.err += d));
    this.child.stdin.on('error', () => undefined);
    this.closed = new Promise((r) => this.child.on('close', r));
  }
  async write(frame: Uint8Array): Promise<void> {
    if (!this.child.stdin.write(frame)) await new Promise((r) => this.child.stdin.once('drain', r));
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const code = await this.closed;
    if (code !== 0) throw new Error(`ffmpeg could not write the video: ${this.err.trim().split('\n').pop()}`);
  }
}
