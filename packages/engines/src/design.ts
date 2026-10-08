/**
 * Design export: a design project to MP4, WebM (alpha optional), ProRes 4444 (alpha), GIF, a PNG sequence, or one PNG.
 * It draws with the same Scene the editor uses, in headless Chromium, one frame at a time, then encodes with FFmpeg.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { DesignStore } from '@studio/design/store';
import { resolve as resolveLayer, type Layer } from '@studio/design';
import { defaultConcurrency, launch, loadFonts, loadPalette, shooter } from './motion.js';
import { EngineError, ffmpeg } from './run.js';
import { studioRoot } from './models.js';

export type DesignFormat = 'mp4' | 'webm' | 'mov' | 'gif' | 'png-seq' | 'png';
const EXT: Record<DesignFormat, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov', gif: '.gif', 'png-seq': '', png: '.png' };
const ALPHA_OK: DesignFormat[] = ['webm', 'mov', 'png-seq', 'png', 'gif'];
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

export interface DesignExportOptions {
  dir: string;
  format: DesignFormat;
  /** output path relative to dir; default renders/<name>.<ext> */
  out?: string;
  /** time of the one frame for `png` (ms) */
  at?: number;
  /** render only this part of the scene, ms */
  range?: [number, number];
  /** pixel scale: 2 renders at twice the scene size */
  scale?: number;
  alpha?: boolean;
  force?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface DesignExportResult {
  output: string;
  format: DesignFormat;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
  audio: boolean;
  bytes: number;
  renderMs: number;
  renderFps: number;
  concurrency: number;
  warnings: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';

function pageBundle(): string {
  const p = join(studioRoot(), 'packages', 'design', 'dist-page', 'page.js');
  if (!existsSync(p)) throw new EngineError('ENGINE_MISSING', 'the design page bundle is not built', 'run `pnpm build`');
  return p;
}

/** Volume (0..2) over the layer's own clock as an ffmpeg expression of `t`, sampled so easing is honoured. */
export function volumeExpr(l: Extract<Layer, { type: 'audio' }>, lenMs: number, sceneMs: number): string {
  const kfs = l.anim?.['volume'];
  if (!kfs?.length) return String(l.volume ?? 1);
  const start = l.start ?? 0;
  const step = Math.max(50, Math.ceil(lenMs / 60 / 10) * 10);
  const pts: [number, number][] = [];
  for (let ms = 0; ms <= lenMs; ms += step) pts.push([ms / 1000, resolveLayer(l, start + ms, sceneMs).volume]);
  pts.push([lenMs / 1000, resolveLayer(l, start + lenMs, sceneMs).volume]);
  let e = String(pts[pts.length - 1]![1]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, v0] = pts[i]!;
    const [t1, v1] = pts[i + 1]!;
    if (t1 <= t0) continue;
    e = `if(lt(t,${t1.toFixed(3)}),${v0.toFixed(4)}+(${(v1 - v0).toFixed(4)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)},${e})`;
  }
  return e;
}

export async function exportDesign(o: DesignExportOptions): Promise<DesignExportResult> {
  const store = new DesignStore(o.dir);
  const { design } = store.load();
  const { width, height, fps, duration } = design.meta;
  const scale = o.scale ?? 1;
  if (!(scale >= 0.25 && scale <= 4)) throw new EngineError('INVALID_INPUT', `--scale must be between 0.25 and 4, got ${scale}`);
  const W = Math.round(width * scale);
  const H = Math.round(height * scale);
  if (o.format !== 'png-seq' && o.format !== 'png' && (W % 2 || H % 2))
    throw new EngineError('INVALID_INPUT', `${W}x${H} has an odd side; video needs even sizes`, 'change the scene size or --scale');
  const wantAlpha = !!o.alpha || design.meta.background === 'transparent';
  if (wantAlpha && !ALPHA_OK.includes(o.format))
    throw new EngineError('INVALID_INPUT', `${o.format} has no transparency`, 'use --format mov (ProRes 4444), webm, png-seq or png');

  const name = slug(design.meta.name);
  const outRel = o.out ?? join('renders', name + EXT[o.format]);
  const out = resolve(o.dir, outRel);
  if (existsSync(out) && !o.force) throw new EngineError('WOULD_OVERWRITE', `${outRel} exists`, 'pass --force or choose another --out');

  // frames to draw
  const total = Math.max(1, Math.round((duration * fps) / 1000));
  let first = 0;
  let last = total - 1;
  if (o.format === 'png') {
    first = last = Math.min(total - 1, Math.max(0, Math.round(((o.at ?? 0) * fps) / 1000)));
  } else if (o.range) {
    first = Math.max(0, Math.round((o.range[0] * fps) / 1000));
    last = Math.min(total - 1, Math.round((o.range[1] * fps) / 1000) - 1);
    if (last < first) throw new EngineError('INVALID_INPUT', `--range ${o.range[0]}:${o.range[1]} holds no frame at ${fps} fps`);
  }
  const count = last - first + 1;

  // assets: the page is offline, so images arrive as data URLs
  const assets: Record<string, string> = {};
  let bytes = 0;
  for (const l of design.layers) {
    if (l.type !== 'image' || l.src.startsWith('data:') || assets[l.src]) continue;
    const f = resolve(o.dir, l.src);
    if (!existsSync(f)) throw new EngineError('INVALID_INPUT', `${l.id} (${l.name}): ${l.src} does not exist`, 'put the file under assets/');
    const mime = MIME[extname(f).toLowerCase()];
    if (!mime) throw new EngineError('INVALID_INPUT', `${l.src}: unsupported image type`, 'use png, jpg, webp, gif or svg');
    const buf = readFileSync(f);
    bytes += buf.length;
    if (bytes > 96 * 1024 * 1024) throw new EngineError('INVALID_INPUT', 'images total more than 96 MB', 'resize them first');
    assets[l.src] = `data:${mime};base64,${buf.toString('base64')}`;
  }

  // audio
  const audioLayers = o.format === 'png' || o.format === 'png-seq' || o.format === 'gif' ? [] : design.layers.filter((l): l is Extract<Layer, { type: 'audio' }> => l.type === 'audio' && l.visible !== false);
  for (const a of audioLayers) if (!existsSync(resolve(o.dir, a.src))) throw new EngineError('INVALID_INPUT', `${a.id} (${a.name}): ${a.src} does not exist`);

  const { palette, root } = loadPalette(o.dir);
  const fonts = loadFonts(palette, root);
  const family = Object.values(palette.fonts)[0]!.family;
  const key = createHash('sha256').update(JSON.stringify([design, o.format, scale, wantAlpha, first, last])).digest('hex').slice(0, 12);
  const tmp = join(o.dir, '.studio', 'cache', 'design', key + '.partial');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const t0 = Date.now();
  const n = Math.max(1, Math.min(o.concurrency ?? defaultConcurrency(), count));
  const browser = await launch();
  let done = 0;
  try {
    await Promise.all(
      Array.from({ length: n }, async (_, w) => {
        const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        await page.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: readFileSync(pageBundle(), 'utf8') });
        await page
          .evaluate((a) => (window as any).designPage.init(a), {
            design,
            fonts: fonts.map(({ family: f, weight, data }) => ({ family: f, weight, data })),
            family,
            assets,
            transparent: wantAlpha,
            scale,
          })
          .catch((e: Error) => {
            throw new EngineError('ENGINE_FAILED', `the design failed to start: ${e.message.split('\n')[0]}`);
          });
        const shoot = await shooter(page, wantAlpha || design.meta.background === 'transparent');
        for (let f = first + w; f <= last; f += n) {
          await page.evaluate((ms) => (window as any).designPage.render(ms), (f * 1000) / fps);
          await shoot(join(tmp, String(f - first).padStart(6, '0') + '.png'));
          o.onProgress?.(++done, count);
        }
        await page.close();
      }),
    );
  } finally {
    await browser.close();
  }
  const renderMs = Date.now() - t0;

  mkdirSync(dirname(out), { recursive: true });
  const partial = o.format === 'png-seq' ? out + '.partial' : out + '.partial' + EXT[o.format];
  rmSync(partial, { recursive: true, force: true });
  const warnings: string[] = [];
  const input = ['-framerate', String(fps), '-i', join(tmp, '%06d.png')];
  const sceneMs = duration;
  if (o.format === 'png') {
    renameSync(join(tmp, '000000.png'), out);
  } else if (o.format === 'png-seq') {
    renameSync(tmp, partial);
    renameSync(partial, out);
  } else {
    const audioIn: string[] = [];
    const filters: string[] = [];
    audioLayers.forEach((a, i) => {
      const start = a.start ?? 0;
      const end = Math.min(a.end ?? sceneMs, sceneMs);
      const len = Math.max(50, end - start);
      audioIn.push('-i', resolve(o.dir, a.src));
      filters.push(
        `[${i + 1}:a]atrim=start=${((a.trimIn ?? 0) / 1000).toFixed(3)}:duration=${(len / 1000).toFixed(3)},asetpts=PTS-STARTPTS,volume='${volumeExpr(a, len, sceneMs)}':eval=frame,adelay=${start}|${start}[a${i}]`,
      );
    });
    let args: string[];
    const mix = audioLayers.length
      ? [...audioIn, '-filter_complex', `${filters.join(';')};${audioLayers.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audioLayers.length}:normalize=0:duration=longest[aout]`, '-map', '0:v', '-map', '[aout]', '-t', ((count / fps)).toFixed(3)]
      : [];
    if (o.format === 'mp4')
      args = [...input, ...mix, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(audioLayers.length ? ['-c:a', 'aac', '-b:a', '192k'] : [])];
    else if (o.format === 'webm')
      args = [...input, ...mix, '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-pix_fmt', wantAlpha ? 'yuva420p' : 'yuv420p', ...(wantAlpha ? ['-auto-alt-ref', '0'] : []), ...(audioLayers.length ? ['-c:a', 'libopus', '-b:a', '160k'] : [])];
    else if (o.format === 'mov')
      args = [...input, ...mix, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', ...(audioLayers.length ? ['-c:a', 'pcm_s16le'] : [])];
    else {
      const fl = Math.min(fps, 20);
      args = [...input, '-vf', `fps=${fl},split[a][b];[a]palettegen=reserve_transparent=${wantAlpha ? 1 : 0}[p];[b][p]paletteuse=dither=bayer:bayer_scale=4${wantAlpha ? ':alpha_threshold=64' : ''}`, '-loop', '0'];
      if (fl < fps) warnings.push(`GIF is written at ${fl} fps (the scene is ${fps} fps)`);
    }
    await ffmpeg(['-hide_banner', '-y', ...args, partial]);
    renameSync(partial, out);
    rmSync(tmp, { recursive: true, force: true });
  }
  const size = (() => {
    try {
      const st = statSync(out);
      return st.isDirectory() ? 0 : st.size;
    } catch {
      return 0;
    }
  })();
  return {
    output: outRel,
    format: o.format,
    width: W,
    height: H,
    fps,
    frames: count,
    durationMs: Math.round((count * 1000) / fps),
    audio: audioLayers.length > 0,
    bytes: size,
    renderMs,
    renderFps: Math.round((count / (renderMs / 1000)) * 10) / 10,
    concurrency: n,
    warnings,
  };
}

