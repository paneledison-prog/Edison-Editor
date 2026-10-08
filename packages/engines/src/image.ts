import { createHash } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { EngineError } from './run.js';

export type ImageFormat = 'jpeg' | 'webp' | 'avif' | 'png';
export type FitMode = 'cover' | 'inside' | 'contain' | 'fill';

export interface ResizeOptions {
  width?: number;
  height?: number;
  /** cover fills and crops, inside fits without cropping, contain letterboxes on `background`, fill stretches (only on request) */
  mode?: FitMode;
  background?: string;
  /** allow output larger than the source (default false: the result is never enlarged) */
  allowEnlarge?: boolean;
  /** output format; default keeps jpeg/png/webp and writes png for anything else */
  format?: ImageFormat;
  quality?: number;
  /** light unsharp after a downscale, for crisper web output */
  sharpen?: boolean;
  /** attention/entropy cropping for `cover`; center otherwise */
  smart?: 'attention' | 'entropy';
}

export const IMAGE_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.gif',
  '.heic',
  '.heif',
]);

const FORMAT_EXT: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  png: 'png',
};
/** Defaults from rules/04. AVIF effort stays at or below 5 so batches finish. */
const DEFAULT_Q: Record<ImageFormat, number> = { jpeg: 82, webp: 80, avif: 50, png: 100 };

export function formatFor(src: string, o: ResizeOptions): ImageFormat {
  if (o.format) return o.format;
  const e = extname(src).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'jpeg';
  if (e === '.webp') return 'webp';
  if (e === '.avif') return 'avif';
  return 'png';
}

/** Short tag for output names: the parameters that change the pixels. */
export function paramsTag(o: ResizeOptions): string {
  const dims = o.width || o.height ? `${o.width ?? 'auto'}x${o.height ?? 'auto'}` : 'orig';
  return `${dims}-${o.mode ?? 'inside'}${o.smart ? `-${o.smart}` : ''}${o.sharpen ? '-sharp' : ''}`;
}

export function paramsHash(o: ResizeOptions): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...o, mode: o.mode ?? 'inside', q: o.quality ?? null }))
    .digest('hex')
    .slice(0, 10);
}

export interface ImageResult {
  src: string;
  dest: string;
  inBytes: number;
  outBytes: number;
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  warnings: string[];
}

function validate(o: ResizeOptions) {
  if (o.width !== undefined && !(Number.isInteger(o.width) && o.width > 0))
    throw new EngineError('INVALID_INPUT', `width must be a positive integer, got ${o.width}`);
  if (o.height !== undefined && !(Number.isInteger(o.height) && o.height > 0))
    throw new EngineError('INVALID_INPUT', `height must be a positive integer, got ${o.height}`);
  if (o.mode === 'contain' && !(o.width && o.height))
    throw new EngineError('INVALID_INPUT', 'contain needs both width and height');
  if (o.mode === 'cover' && !(o.width && o.height))
    throw new EngineError('INVALID_INPUT', 'cover needs both width and height');
  if (o.mode === 'fill' && !(o.width && o.height))
    throw new EngineError('INVALID_INPUT', 'fill needs both width and height');
  if (o.quality !== undefined && !(o.quality >= 1 && o.quality <= 100))
    throw new EngineError('INVALID_INPUT', 'quality must be 1 to 100');
  if (o.smart && o.mode !== 'cover')
    throw new EngineError('INVALID_INPUT', '--smart only applies to cover mode');
}

/**
 * Orientation applied, converted to sRGB, metadata stripped (rules/04). The source is never written.
 * The output appears only after a complete write (`.partial`, then rename).
 */
export async function processImage(
  src: string,
  dest: string,
  o: ResizeOptions,
): Promise<ImageResult> {
  validate(o);
  const warnings: string[] = [];
  let meta: Metadata;
  try {
    meta = await sharp(src, { failOn: 'error' }).metadata();
  } catch (e) {
    throw new EngineError('UNSUPPORTED_INPUT', `${basename(src)}: ${(e as Error).message}`);
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  const inW = rotated ? meta.height! : meta.width!;
  const inH = rotated ? meta.width! : meta.height!;
  if (meta.icc)
    warnings.push(
      `${basename(src)}: had an embedded ICC profile; converted to sRGB and the profile was stripped`,
    );

  const mode = o.mode ?? 'inside';
  let img = sharp(src, { failOn: 'error' }).rotate().toColourspace('srgb');
  const wantsResize = !!(o.width || o.height);
  let outW = inW;
  let outH = inH;
  if (wantsResize) {
    const enlarge = !!o.allowEnlarge;
    if (mode === 'cover' || mode === 'contain' || mode === 'fill') {
      outW = o.width!;
      outH = o.height!;
    } else {
      const k = Math.min(o.width ? o.width / inW : Infinity, o.height ? o.height / inH : Infinity);
      const f = enlarge ? k : Math.min(1, k);
      outW = Math.max(1, Math.round(inW * f));
      outH = Math.max(1, Math.round(inH * f));
    }
    if (mode === 'inside') {
      const k = Math.min(o.width ? o.width / inW : Infinity, o.height ? o.height / inH : Infinity);
      if (k > 1 && !enlarge) {
        warnings.push(
          `${basename(src)}: source is ${inW}x${inH}, smaller than the target; not enlarged (effective size ${outW}x${outH}). Use upscaling or --allow-enlarge`,
        );
      }
    } else if ((o.width ?? 0) > inW || (o.height ?? 0) > inH) {
      // cover, contain, and fill give exactly width x height, so a larger target means interpolation.
      warnings.push(
        `${basename(src)}: ${mode} to ${o.width}x${o.height} enlarges a ${inW}x${inH} source; the effective resolution stays ${inW}x${inH}`,
      );
    }
    const strategy =
      o.smart === 'attention'
        ? sharp.strategy.attention
        : o.smart === 'entropy'
          ? sharp.strategy.entropy
          : 'centre';
    const bg = o.background ?? '#000000';
    img = img.resize({
      width: o.width,
      height: o.height,
      fit: mode,
      kernel: 'lanczos3',
      position: mode === 'cover' ? strategy : 'centre',
      background: bg,
      withoutEnlargement: !enlarge && mode === 'inside',
    });
    if (o.sharpen && (outW < inW || outH < inH)) img = img.sharpen({ sigma: 0.6 });
  }

  const fmt = formatFor(src, o);
  const q = o.quality ?? DEFAULT_Q[fmt];
  if (fmt === 'jpeg')
    img = img
      .flatten({ background: o.background ?? '#ffffff' })
      .jpeg({ quality: q, mozjpeg: true, progressive: true });
  else if (fmt === 'webp') img = img.webp({ quality: q });
  else if (fmt === 'avif') img = img.avif({ quality: q, effort: 4 });
  else img = img.png({ compressionLevel: 6 });

  mkdirSync(dirname(dest), { recursive: true });
  const partial = dest + '.partial';
  try {
    const info = await img.toFile(partial);
    renameSync(partial, dest);
    return {
      src,
      dest,
      inBytes: statSync(src).size,
      outBytes: info.size,
      inW,
      inH,
      outW: info.width,
      outH: info.height,
      warnings,
    };
  } catch (e) {
    rmSync(partial, { force: true });
    throw new EngineError('ENGINE_FAILED', `${basename(src)}: ${(e as Error).message}`);
  }
}

export function collectImages(inputs: string[]): {
  files: { path: string; rel: string }[];
  skipped: string[];
} {
  const files: { path: string; rel: string }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const add = (p: string, rel: string) => {
    const a = resolve(p);
    if (seen.has(a)) return;
    seen.add(a);
    files.push({ path: a, rel });
  };
  const walk = (dir: string, base: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, base);
      else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) add(p, relative(base, p));
      else skipped.push(p);
    }
  };
  for (const i of inputs) {
    if (!existsSync(i)) throw new EngineError('INVALID_INPUT', `${i}: not found`);
    if (statSync(i).isDirectory()) walk(resolve(i), resolve(i));
    else add(i, basename(i));
  }
  return { files, skipped };
}

async function hashStream(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((ok, bad) =>
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => ok())
      .on('error', bad),
  );
  return h.digest('hex');
}

export interface BatchOptions extends ResizeOptions {
  outDir: string;
  /** project directory, for the resume manifest under .studio/cache */
  projectDir: string;
  concurrency?: number;
  /** skip outputs that exist and were made from identical content with identical parameters (default true) */
  resume?: boolean;
  /** inputs are mapped under outDir keeping their relative folders */
  onProgress?: (done: number, total: number) => void;
}

export interface BatchReport {
  total: number;
  processed: number;
  skippedUpToDate: number;
  failed: { file: string; code: string; reason: string }[];
  inBytes: number;
  outBytes: number;
  elapsedMs: number;
  imagesPerSecond: number;
  concurrency: number;
  peakRssMb: number;
  warnings: string[];
  outDir: string;
  nonImageFilesIgnored: number;
  /** output files written or already up to date, capped at 200 entries */
  outputs: string[];
}

/** Output path for one input, deterministic from the file and the parameters. */
export function outputPath(outDir: string, rel: string, o: ResizeOptions): string {
  const e = extname(rel);
  const stem = rel.slice(0, rel.length - e.length);
  return join(outDir, `${stem}-${paramsTag(o)}.${FORMAT_EXT[formatFor(rel, o)]}`);
}

/**
 * Processes images with bounded concurrency (min(cores - 1, 4)) and bounded libvips caches, so memory does not grow
 * with the number of images. Progress is reported through `onProgress`. Re-running skips finished outputs.
 */
/** Removes `.partial` files that a killed run left behind. Finished outputs are only ever created by a rename, so these are never valid. */
function cleanPartials(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += cleanPartials(p);
    else if (e.name.endsWith('.partial')) {
      rmSync(p, { force: true });
      n++;
    }
  }
  return n;
}

export async function runBatch(inputs: string[], o: BatchOptions): Promise<BatchReport> {
  const t0 = performance.now();
  validate(o);
  const { files, skipped } = collectImages(inputs);
  if (!files.length)
    throw new EngineError(
      'INVALID_INPUT',
      'no images found in the inputs',
      `supported: ${[...IMAGE_EXT].join(' ')}`,
    );
  const outDir = resolve(o.outDir);
  if (
    outDir.split(sep).includes('assets') &&
    resolve(o.projectDir) &&
    outDir.startsWith(resolve(o.projectDir, 'assets'))
  ) {
    throw new EngineError(
      'INVALID_INPUT',
      'outputs must not be written into assets/ (originals are immutable)',
      'use the default renders/images',
    );
  }
  const jobs = files.map((f) => ({ ...f, dest: outputPath(outDir, f.rel, o) }));
  const dup = new Map<string, string>();
  for (const j of jobs) {
    const prev = dup.get(j.dest);
    if (prev)
      throw new EngineError(
        'INVALID_INPUT',
        `${prev} and ${j.path} would both write ${j.dest}`,
        'pass a folder so relative paths are kept, or rename one input',
      );
    dup.set(j.dest, j.path);
    if (resolve(j.dest) === j.path)
      throw new EngineError('INVALID_INPUT', `output would overwrite the source ${j.path}`);
  }

  const cores = (await import('node:os')).cpus().length;
  const conc = Math.max(1, Math.min(o.concurrency ?? Math.max(1, cores - 1), 4));
  sharp.concurrency(1); // one libvips thread per image; the pool provides the parallelism
  sharp.cache({ memory: 64, files: 0, items: 64 });

  const stale = cleanPartials(outDir);
  const key = paramsHash(o);
  // Resume log: one JSON line per finished image, appended as each one completes. A kill loses at most the image in
  // flight, and a torn last line is ignored. Later lines for the same output win.
  const mpath = join(o.projectDir, '.studio', 'cache', 'image-batches', `${key}.jsonl`);
  const manifest: { entries: Record<string, { inHash: string; outBytes: number }> } = {
    entries: {},
  };
  if (o.resume !== false && existsSync(mpath)) {
    for (const line of readFileSync(mpath, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line) as { o: string; h: string; b: number };
        manifest.entries[e.o] = { inHash: e.h, outBytes: e.b };
      } catch {
        /* blank or torn line */
      }
    }
  }
  mkdirSync(dirname(mpath), { recursive: true });

  const report: BatchReport = {
    total: jobs.length,
    processed: 0,
    skippedUpToDate: 0,
    failed: [],
    inBytes: 0,
    outBytes: 0,
    elapsedMs: 0,
    imagesPerSecond: 0,
    concurrency: conc,
    peakRssMb: 0,
    warnings: [],
    outDir,
    nonImageFilesIgnored: skipped.length,
    outputs: [],
  };
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const j = jobs[i]!;
      try {
        const inHash = await hashStream(j.path);
        const m = manifest.entries[j.dest];
        if (
          o.resume !== false &&
          m &&
          m.inHash === inHash &&
          existsSync(j.dest) &&
          statSync(j.dest).size === m.outBytes
        ) {
          report.skippedUpToDate++;
          report.inBytes += statSync(j.path).size;
          report.outBytes += m.outBytes;
        } else {
          const r = await processImage(j.path, j.dest, o);
          manifest.entries[j.dest] = { inHash, outBytes: r.outBytes };
          appendFileSync(mpath, JSON.stringify({ o: j.dest, h: inHash, b: r.outBytes }) + '\n');
          report.processed++;
          report.inBytes += r.inBytes;
          report.outBytes += r.outBytes;
          for (const w of r.warnings)
            if (report.warnings.length < 20 && !report.warnings.includes(w))
              report.warnings.push(w);
        }
      } catch (e) {
        report.failed.push({
          file: j.path,
          code: (e as { code?: string }).code ?? 'ENGINE_FAILED',
          reason: (e as Error).message,
        });
      }
      done++;
      report.peakRssMb = Math.max(report.peakRssMb, process.memoryUsage().rss / 1048576);
      o.onProgress?.(done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  // Deterministic order: input order, whatever order the workers finished in.
  const failedPaths = new Set(report.failed.map((f) => f.file));
  report.outputs = jobs
    .filter((j) => !failedPaths.has(j.path))
    .slice(0, 200)
    .map((j) => j.dest);
  const order = new Map(jobs.map((j, i) => [j.path, i]));
  report.failed.sort((x, y) => order.get(x.file)! - order.get(y.file)!);
  report.elapsedMs = Math.round(performance.now() - t0);
  report.imagesPerSecond = Math.round((jobs.length / (report.elapsedMs / 1000)) * 10) / 10;
  report.peakRssMb =
    Math.round(Math.max(report.peakRssMb, process.resourceUsage().maxRSS / 1024) * 10) / 10;
  if (stale)
    report.warnings.unshift(`removed ${stale} unfinished file(s) left by an interrupted run`);
  if (report.warnings.length >= 20) report.warnings.push('more warnings were suppressed');
  return report;
}
