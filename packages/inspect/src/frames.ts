import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { EngineError, ffmpeg, probeFile, run } from '@studio/engines';

export interface FrameResult {
  atMs: number;
  path: string;
  /** Mean colour of the whole frame (0-255). Cheap numeric check for colour shifts between source and render. */
  meanRgb: [number, number, number];
}

const stem = (f: string) => basename(f, extname(f)).replace(/[^\w.-]+/g, '_');

async function meanRgb(file: string, atMs: number): Promise<[number, number, number]> {
  const r = await new Promise<Buffer>((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-ss',
        (atMs / 1000).toFixed(3),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=1:1:flags=area,format=rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
      const chunks: Buffer[] = [];
      c.stdout.on('data', (d: Buffer) => chunks.push(d));
      c.on('error', reject);
      c.on('close', () => resolve(Buffer.concat(chunks)));
    });
  });
  if (r.length < 3) return [0, 0, 0];
  return [r[0]!, r[1]!, r[2]!];
}

/** Writes one PNG per requested time. Open and look at them (rules/09). */
export async function frames(
  file: string,
  atMs: number[],
  outDir: string,
  width?: number,
): Promise<FrameResult[]> {
  const pr = await probeFile(file);
  if (pr.kind === 'audio') throw new EngineError('INVALID_INPUT', `${file} has no video stream`);
  mkdirSync(outDir, { recursive: true });
  const out: FrameResult[] = [];
  for (const t of atMs) {
    if (pr.probe.durMs !== undefined && t > pr.probe.durMs) {
      throw new EngineError(
        'INVALID_INPUT',
        `--at ${t} ms is past the end of ${basename(file)} (${pr.probe.durMs} ms)`,
      );
    }
    const path = join(
      outDir,
      `frame-${stem(file)}-${String(Math.round(t)).padStart(7, '0')}ms${width ? `-w${width}` : ''}.png`,
    );
    await ffmpeg([
      '-ss',
      (t / 1000).toFixed(3),
      '-i',
      file,
      '-frames:v',
      '1',
      ...(width ? ['-vf', `scale=${width}:-2`] : []),
      '-f',
      'image2',
      path,
    ]);
    out.push({ atMs: t, path, meanRgb: await meanRgb(file, t) });
  }
  return out;
}

export interface Sheet {
  path: string;
  tiles: { index: number; tMs: number }[];
}

/** Contact sheets, at most 24 tiles each so details stay legible. Tile times are listed so you can map a tile to a moment. */
export async function sheets(
  file: string,
  opts: { fps?: number; cols?: number; width?: number; outDir: string },
): Promise<Sheet[]> {
  const fps = opts.fps ?? 1;
  const cols = opts.cols ?? 6;
  const width = opts.width ?? 320;
  if (cols < 1 || cols > 24)
    throw new EngineError('INVALID_INPUT', '--cols must be between 1 and 24');
  if (!(fps > 0)) throw new EngineError('INVALID_INPUT', '--fps must be positive');
  const pr = await probeFile(file);
  if (pr.kind !== 'video' || !pr.probe.durMs)
    throw new EngineError('INVALID_INPUT', `${file} has no video stream with a duration`);
  const rows = Math.max(1, Math.floor(24 / cols));
  const perSheet = cols * rows;
  const total = Math.max(1, Math.round((pr.probe.durMs / 1000) * fps));
  const nSheets = Math.ceil(total / perSheet);
  mkdirSync(opts.outDir, { recursive: true });
  const base = join(opts.outDir, `sheet-${stem(file)}`);
  await ffmpeg([
    '-i',
    file,
    '-vf',
    `fps=${fps},scale=${width}:-2,tile=${cols}x${rows}:padding=2`,
    '-vsync',
    'vfr',
    '-f',
    'image2',
    `${base}-%02d.png`,
  ]);
  const out: Sheet[] = [];
  for (let s = 0; s < nSheets; s++) {
    const count = Math.min(perSheet, total - s * perSheet);
    out.push({
      path: `${base}-${String(s + 1).padStart(2, '0')}.png`,
      tiles: Array.from({ length: count }, (_, i) => ({
        index: i,
        tMs: Math.round(((s * perSheet + i) / fps) * 1000),
      })),
    });
  }
  return out;
}

/** Waveform picture of the audio, for a quick look at levels and gaps. */
export async function waveform(
  file: string,
  outDir: string,
  width = 1200,
  height = 200,
): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `waveform-${stem(file)}.png`);
  await ffmpeg([
    '-i',
    file,
    '-filter_complex',
    `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=white`,
    '-frames:v',
    '1',
    '-f',
    'image2',
    path,
  ]);
  return path;
}

export { run };
