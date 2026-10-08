import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Clip, Cue } from '@studio/core';
import { resolveProps, TEMPLATES, type Palette } from '@studio/motion';
import { ffmpeg } from './run.js';
import { EngineError } from './run.js';
import { studioRoot } from './models.js';

/** Where brand/palette.json lives: the project's own, else the Studio checkout's. */
export function brandRoot(projectDir?: string): string {
  if (projectDir && existsSync(join(projectDir, 'brand', 'palette.json'))) return projectDir;
  return studioRoot();
}
export function loadPalette(projectDir?: string): { palette: Palette; root: string } {
  const root = brandRoot(projectDir);
  const palette = JSON.parse(readFileSync(join(root, 'brand', 'palette.json'), 'utf8')) as Palette;
  return { palette, root };
}

export function chromiumPath(): string {
  const env = process.env['STUDIO_CHROMIUM'];
  if (env) {
    if (!existsSync(env))
      throw new EngineError(
        'ENGINE_MISSING',
        `STUDIO_CHROMIUM points at ${env}, which does not exist`,
      );
    return env;
  }
  const bases = [
    process.env['PLAYWRIGHT_BROWSERS_PATH'],
    '/opt/pw-browsers',
    join(process.env['HOME'] ?? '', '.cache', 'ms-playwright'),
  ].filter(Boolean) as string[];
  for (const b of bases) {
    if (!existsSync(b)) continue;
    const d = readdirSync(b)
      .filter((x) => /^chromium-\d+$/.test(x))
      .sort()
      .pop();
    const p = d && join(b, d, 'chrome-linux', 'chrome');
    if (p && existsSync(p)) return p;
  }
  throw new EngineError(
    'ENGINE_MISSING',
    'no Chromium found for the motion renderer',
    'set STUDIO_CHROMIUM to a Chromium/Chrome binary, or install one with Playwright',
  );
}

function pageBundle(): string {
  const p = join(studioRoot(), 'motion', 'dist', 'page.js');
  if (!existsSync(p))
    throw new EngineError(
      'ENGINE_MISSING',
      'the motion page bundle is not built',
      'run `pnpm build`',
    );
  return p;
}

interface FontFile {
  family: string;
  weight: string;
  data: string;
  sha: string;
}
function loadFonts(palette: Palette, root: string): FontFile[] {
  const out: FontFile[] = [];
  for (const f of Object.values(palette.fonts)) {
    for (const [weight, rel] of Object.entries(f.files)) {
      const p = resolve(root, rel);
      if (!existsSync(p))
        throw new EngineError(
          'ENGINE_MISSING',
          `font file ${rel} (${f.family} ${weight}) is missing; the render stops instead of substituting another font`,
          'restore the file under brand/fonts or fix brand/palette.json',
        );
      const buf = readFileSync(p);
      out.push({
        family: f.family,
        weight,
        data: buf.toString('base64'),
        sha: createHash('sha256').update(buf).digest('hex'),
      });
    }
  }
  return out;
}

/** Identifies the template code and fonts, so a changed template or font invalidates cached frames. */
export function codeVersion(palette: Palette, root: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(pageBundle()));
  for (const f of loadFonts(palette, root)) h.update(f.sha);
  return h.digest('hex').slice(0, 12);
}

export interface MotionSpec {
  comp: string;
  /** raw props as written in the project or props file; defaults and tokens are applied here */
  props?: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durMs: number;
  projectDir?: string;
}

export interface Prepared {
  comp: string;
  props: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durMs: number;
  frames: number;
  key: string;
  codeVersion: string;
  palette: Palette;
  root: string;
}

export function prepare(s: MotionSpec): Prepared {
  if (!TEMPLATES[s.comp])
    throw new EngineError(
      'INVALID_INPUT',
      `unknown template "${s.comp}"; available: ${Object.keys(TEMPLATES).join(', ')}`,
    );
  const { palette, root } = loadPalette(s.projectDir);
  let props: Record<string, unknown>;
  try {
    props = resolveProps(s.comp, s.props, palette);
  } catch (e) {
    throw new EngineError(
      'INVALID_INPUT',
      (e as Error).message,
      `run \`studio motion templates --comp ${s.comp}\` for the props`,
    );
  }
  if (!(s.durMs > 0)) throw new EngineError('INVALID_INPUT', 'duration must be positive');
  const frames = Math.max(1, Math.round((s.durMs * s.fps) / 1000));
  const cv = codeVersion(palette, root);
  const key = createHash('sha256')
    .update(JSON.stringify([s.comp, props, cv, s.fps, s.width, s.height, frames]))
    .digest('hex')
    .slice(0, 16);
  return {
    comp: s.comp,
    props,
    width: s.width,
    height: s.height,
    fps: s.fps,
    durMs: s.durMs,
    frames,
    key,
    codeVersion: cv,
    palette,
    root,
  };
}

export const defaultConcurrency = () => Math.max(1, Math.floor(cpus().length / 2));

type PW = typeof import('playwright-core');
async function launch() {
  let pw: PW;
  try {
    pw = await import('playwright-core');
  } catch {
    throw new EngineError(
      'ENGINE_MISSING',
      'playwright-core is not installed',
      'run `pnpm install`',
    );
  }
  try {
    return await pw.chromium.launch({
      executablePath: chromiumPath(),
      args: [
        '--no-sandbox',
        '--font-render-hinting=none',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--disable-gpu',
      ],
    });
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(
      'ENGINE_FAILED',
      `could not start Chromium: ${(e as Error).message.split('\n')[0]}`,
      'run `studio doctor`',
    );
  }
}

/** Fast PNG capture through the DevTools protocol (about 2x quicker than page.screenshot), transparent unless a checkerboard is wanted. */
async function shooter(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>,
  transparent: boolean,
) {
  const cdp = await page.context().newCDPSession(page);
  if (transparent)
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
  return async (file: string) => {
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      optimizeForSpeed: true,
      fromSurface: true,
    });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
}

async function openPage(
  browser: Awaited<ReturnType<typeof launch>>,
  p: Prepared,
  checker: boolean,
) {
  const page = await browser.newPage({
    viewport: { width: p.width, height: p.height },
    deviceScaleFactor: 1,
  });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: readFileSync(pageBundle(), 'utf8') });
  const fam = Object.values(p.palette.fonts)[0]!.family;
  const info = (await page
    .evaluate((a) => (window as any).studio.init(a), {
      comp: p.comp,
      props: p.props,
      width: p.width,
      height: p.height,
      fps: p.fps,
      durMs: p.durMs,
      fonts: loadFonts(p.palette, p.root).map(({ family, weight, data }) => ({
        family,
        weight,
        data,
      })),
      family: fam,
      checker: checker
        ? [p.palette.colors['checkerLight'] ?? '', p.palette.colors['checkerDark'] ?? '']
        : undefined,
    })
    .catch((e: Error) => {
      throw new EngineError(
        'ENGINE_FAILED',
        `template ${p.comp} failed to start: ${e.message.split('\n')[0]}`,
      );
    })) as {
    warnings: string[];
    captionBoxes: { cue: number; x: number; y: number; w: number; h: number }[] | null;
  };
  return { page, info };
}

export interface StillResult {
  file: string;
  frame: number;
  width: number;
  height: number;
  warnings: string[];
  ms: number;
}
export async function motionStill(
  p: Prepared,
  frame: number,
  out: string,
  o: { checker?: boolean } = {},
): Promise<StillResult> {
  const t0 = Date.now();
  if (frame < 0 || frame >= p.frames)
    throw new EngineError(
      'INVALID_INPUT',
      `frame ${frame} is outside 0..${p.frames - 1} (${p.frames} frames at ${p.fps} fps)`,
    );
  const browser = await launch();
  try {
    const { page, info } = await openPage(browser, p, !!o.checker);
    await page.evaluate((f) => (window as any).studio.render(f), frame);
    mkdirSync(dirname(out), { recursive: true });
    const tmp = out + '.partial';
    await (
      await shooter(page, !o.checker)
    )(tmp);
    renameSync(tmp, out);
    return {
      file: out,
      frame,
      width: p.width,
      height: p.height,
      warnings: info.warnings,
      ms: Date.now() - t0,
    };
  } finally {
    await browser.close();
  }
}

export interface FramesResult {
  dir: string;
  frames: number;
  cached: boolean;
  ms: number;
  /** frames rendered per second of wall time (0 when cached) */
  renderFps: number;
  concurrency: number;
  warnings: string[];
  key: string;
  captionBoxes: { cue: number; x: number; y: number; w: number; h: number }[] | null;
}
export const framePattern = '%06d.png';

/** Renders every frame as a transparent PNG into a cache directory keyed by (template, props, code, fps, size). */
export async function motionFrames(
  p: Prepared,
  cacheRoot: string,
  o: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<FramesResult> {
  const dir = join(cacheRoot, 'motion', p.key);
  const metaFile = join(dir, 'meta.json');
  if (existsSync(metaFile)) {
    const m = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (m.frames === p.frames)
      return {
        dir,
        frames: p.frames,
        cached: true,
        ms: 0,
        renderFps: 0,
        concurrency: 0,
        warnings: m.warnings,
        key: p.key,
        captionBoxes: m.captionBoxes ?? null,
      };
  }
  const t0 = Date.now();
  const tmp = dir + '.partial';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const n = Math.max(1, Math.min(o.concurrency ?? defaultConcurrency(), p.frames));
  const browser = await launch();
  let done = 0;
  let warnings: string[] = [];
  let boxes: FramesResult['captionBoxes'] = null;
  try {
    await Promise.all(
      Array.from({ length: n }, async (_, w) => {
        const { page, info } = await openPage(browser, p, false);
        const shoot = await shooter(page, true);
        if (w === 0) {
          warnings = info.warnings;
          boxes = info.captionBoxes;
        }
        for (let f = w; f < p.frames; f += n) {
          await page.evaluate((fr) => (window as any).studio.render(fr), f);
          await shoot(join(tmp, String(f).padStart(6, '0') + '.png'));
          o.onProgress?.(++done, p.frames);
        }
        await page.close();
      }),
    );
  } finally {
    await browser.close();
  }
  writeFileSync(
    join(tmp, 'meta.json'),
    JSON.stringify({
      comp: p.comp,
      frames: p.frames,
      fps: p.fps,
      width: p.width,
      height: p.height,
      warnings,
      captionBoxes: boxes,
      codeVersion: p.codeVersion,
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  const ms = Date.now() - t0;
  return {
    dir,
    frames: p.frames,
    cached: false,
    ms,
    renderFps: Math.round((p.frames / (ms / 1000)) * 10) / 10,
    concurrency: n,
    warnings,
    key: p.key,
    captionBoxes: boxes,
  };
}

export type OverlayFormat = 'prores4444' | 'webm' | 'png';
/** Encodes a frame directory to a single alpha overlay file (or copies the PNG sequence). */
export async function exportOverlay(
  framesDir: string,
  fps: number,
  out: string,
  format: OverlayFormat,
): Promise<{ file: string; format: OverlayFormat; bytes?: number }> {
  mkdirSync(dirname(out), { recursive: true });
  const src = [
    '-framerate',
    String(fps),
    '-start_number',
    '0',
    '-i',
    join(framesDir, framePattern),
  ];
  const tmp = out + '.partial' + (format === 'png' ? '' : out.slice(out.lastIndexOf('.')));
  rmSync(tmp, { force: true });
  if (format === 'prores4444')
    await ffmpeg([
      ...src,
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4444',
      '-pix_fmt',
      'yuva444p10le',
      '-vendor',
      'apl0',
      '-an',
      tmp,
    ]);
  else if (format === 'webm')
    await ffmpeg([
      ...src,
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      '0',
      '-crf',
      '24',
      '-auto-alt-ref',
      '0',
      '-an',
      tmp,
    ]);
  else {
    mkdirSync(out, { recursive: true });
    const { copyFileSync } = await import('node:fs');
    for (const f of readdirSync(framesDir).filter((x) => x.endsWith('.png')))
      copyFileSync(join(framesDir, f), join(out, f));
    return { file: out, format };
  }
  renameSync(tmp, out);
  return { file: out, format, bytes: (await import('node:fs')).statSync(out).size };
}

/** The motion spec for a composition clip. Caption clips point at a cue file; its times are timeline-absolute, so shift them to the clip. */
export function clipSpec(
  clip: Clip,
  projectDir: string,
  canvas: { width: number; height: number; fps: number },
): MotionSpec {
  const props = { ...(clip.props ?? {}) } as Record<string, unknown>;
  if (clip.comp === 'captions' && typeof props['cues'] === 'string') {
    const f = resolve(projectDir, props['cues'] as string);
    if (!existsSync(f))
      throw new EngineError(
        'INVALID_INPUT',
        `${clip.id}: cue file ${props['cues']} does not exist`,
        'run `studio captions build`',
      );
    const doc = JSON.parse(readFileSync(f, 'utf8')) as { cues: Cue[] };
    props['cues'] = doc.cues.map((c) => ({
      ...c,
      start: c.start - clip.start,
      end: c.end - clip.start,
      words: c.words.map((w) => ({ ...w, start: w.start - clip.start, end: w.end - clip.start })),
    }));
  }
  return { comp: clip.comp!, props, ...canvas, durMs: clip.dur, projectDir };
}

/** Lays the template out once (no frames) and returns overflow warnings and, for captions, each cue's box. */
export async function motionMeasure(p: Prepared) {
  const browser = await launch();
  try {
    const { info } = await openPage(browser, p, false);
    return info;
  } finally {
    await browser.close();
  }
}

/** Rejects an unknown template or ill-typed props when a composition clip is added, not at render time. */
export function validateComp(
  comp: string,
  props: Record<string, unknown> | undefined,
  projectDir: string,
): void {
  const { palette } = loadPalette(projectDir);
  const p = { ...(props ?? {}) };
  if (comp === 'captions' && typeof p['cues'] === 'string') p['cues'] = [{}];
  try {
    resolveProps(comp, p, palette);
  } catch (e) {
    throw new EngineError(
      'INVALID_INPUT',
      (e as Error).message,
      `run \`studio motion templates --comp ${comp}\` for the props`,
    );
  }
}
