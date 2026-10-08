import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { loadManifest, requireModel, studioRoot } from './models.js';
import { EngineError, run } from './run.js';

export interface BgRemoveOptions {
  /** model name from models/manifest.json */
  model?: string;
  /** use this grayscale mask instead of running a model */
  maskIn?: string;
  /** write the light/dark side-by-side check image next to the output (default true) */
  preview?: boolean;
  /** output format; png keeps alpha everywhere, webp is smaller */
  format?: 'png' | 'webp';
}

export interface BgRemoveReport {
  output: string;
  check?: string;
  width: number;
  height: number;
  model: { name: string; license: string; source: string } | { name: 'mask-in'; file: string };
  inferenceMs?: number;
  totalMs: number;
  alpha: {
    /** share of pixels with alpha above 10 (kept) */
    coveragePct: number;
    /** share of pixels with alpha strictly between 10 and 245 (soft edge or uncertain) */
    softPct: number;
    /** mean alpha along each border strip, 0 to 100: a subject touching an edge shows here */
    borderOpacityPct: { top: number; bottom: number; left: number; right: number };
    /** bounding box of alpha above 50%, as percent of the frame */
    bbox?: { left: number; top: number; width: number; height: number };
  };
  warnings: string[];
}

export async function pythonReady(): Promise<{
  ok: boolean;
  detail: string;
  onnxruntime?: string;
}> {
  const r = await run(
    'python3',
    ['-I', '-c', 'import onnxruntime,numpy,PIL;print(onnxruntime.__version__)'],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  if (!r) return { ok: false, detail: 'python3 not found' };
  if (r.code !== 0)
    return { ok: false, detail: r.stderr.trim().split('\n').pop() ?? 'import failed' };
  return { ok: true, detail: 'ok', onnxruntime: r.stdout.trim() };
}

const pct = (n: number) => Math.round(n * 1000) / 10;

/**
 * Alpha statistics. sharp's stats() reads the input image and ignores any operations chained before it, so each
 * derived image (threshold, crop) is rendered to a single-channel buffer first and measured from that.
 */
async function alphaStats(rgbaPath: string) {
  const alpha = () => sharp(rgbaPath).extractChannel(3);
  const meanOf = async (img: Sharp) =>
    (await sharp(await img.png().toBuffer()).stats()).channels[0]!.mean / 255;
  const cov = await meanOf(alpha().threshold(10));
  const hi = await meanOf(alpha().threshold(245));
  const meta = await sharp(rgbaPath).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  const strip = async (left: number, top: number, width: number, height: number) =>
    pct(await meanOf(alpha().extract({ left, top, width, height })));
  let bbox: BgRemoveReport['alpha']['bbox'];
  try {
    // trim runs on the input stage of a pipeline, so give it the finished binary mask, not the RGBA image
    const binary = await alpha().threshold(128).png().toBuffer();
    const { info } = await sharp(binary)
      .trim({ background: '#000000', threshold: 10 })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = -(info.trimOffsetLeft ?? 0);
    const top = -(info.trimOffsetTop ?? 0);
    bbox = {
      left: pct(left / w),
      top: pct(top / h),
      width: pct(info.width / w),
      height: pct(info.height / h),
    };
  } catch {
    bbox = undefined; // nothing above 50%: an empty cutout
  }
  return {
    coveragePct: pct(cov),
    softPct: pct(Math.max(0, cov - hi)),
    borderOpacityPct: {
      top: await strip(0, 0, w, t),
      bottom: await strip(0, h - t, w, t),
      left: await strip(0, 0, t, h),
      right: await strip(w - t, 0, t, h),
    },
    bbox,
  };
}

/** Light and dark backgrounds side by side. Edges, hair, glass, and thin parts show up against one or the other. */
async function checkImage(rgbaPath: string, out: string): Promise<void> {
  const meta = await sharp(rgbaPath).metadata();
  const w = Math.min(meta.width!, 800);
  const fg = await sharp(rgbaPath).resize({ width: w }).png().toBuffer();
  const fm = await sharp(fg).metadata();
  const h = fm.height!;
  const tile = (bg: string) =>
    sharp({ create: { width: w, height: h, channels: 3, background: bg } })
      .composite([{ input: fg }])
      .png()
      .toBuffer();
  const [light, dark] = [await tile('#f2f2f2'), await tile('#1a1a1a')];
  await sharp({ create: { width: w * 2 + 8, height: h, channels: 3, background: '#808080' } })
    .composite([
      { input: light, left: 0, top: 0 },
      { input: dark, left: w + 8, top: 0 },
    ])
    .png()
    .toFile(out + '.partial');
  renameSync(out + '.partial', out);
}

/**
 * Cutout with alpha, same size as the input. The result is a candidate: look at the check image before using it.
 * Optional alpha matting for edges is not implemented.
 */
export async function removeBackground(
  src: string,
  out: string,
  o: BgRemoveOptions = {},
): Promise<BgRemoveReport> {
  const t0 = performance.now();
  if (!existsSync(src)) throw new EngineError('INVALID_INPUT', `${src}: not found`);
  const tmp = mkdtempSync(join(tmpdir(), 'studio-bg-'));
  const warnings: string[] = [];
  try {
    const rgb = join(tmp, 'rgb.png');
    // orientation applied, colour converted to sRGB, alpha dropped (the new alpha comes from the mask)
    try {
      await sharp(src, { failOn: 'error' })
        .rotate()
        .toColourspace('srgb')
        .removeAlpha()
        .png()
        .toFile(rgb);
    } catch (e) {
      throw new EngineError('UNSUPPORTED_INPUT', `${basename(src)}: ${(e as Error).message}`);
    }
    const meta = await sharp(rgb).metadata();
    const mask = join(tmp, 'mask.png');
    let model: BgRemoveReport['model'];
    let inferenceMs: number | undefined;
    if (o.maskIn) {
      if (!existsSync(o.maskIn))
        throw new EngineError('INVALID_INPUT', `${o.maskIn}: mask not found`);
      const mm = await sharp(o.maskIn).metadata();
      if (mm.width !== meta.width || mm.height !== meta.height) {
        throw new EngineError(
          'INVALID_INPUT',
          `mask is ${mm.width}x${mm.height} but the image is ${meta.width}x${meta.height}`,
          'export the mask at the exact size of the image (after rotation)',
        );
      }
      await sharp(o.maskIn).rotate().extractChannel(0).png().toFile(mask);
      model = { name: 'mask-in', file: o.maskIn };
    } else {
      const name = o.model ?? 'u2net';
      const e = loadManifest().models[name];
      if (!e || e.task !== 'bgremove')
        throw new EngineError(
          'INVALID_INPUT',
          `${name} is not a background-removal model; choose from: ${Object.entries(
            loadManifest().models,
          )
            .filter(([, m]) => m.task === 'bgremove')
            .map(([n]) => n)
            .join(', ')}`,
        );
      const modelPath = requireModel(name);
      const py = await pythonReady();
      if (!py.ok)
        throw new EngineError(
          'ENGINE_MISSING',
          `python environment for background removal is not ready: ${py.detail}`,
          'python3 -m pip install -r tools/requirements.txt',
        );
      const jobs = join(tmp, 'jobs.json');
      writeFileSync(jobs, JSON.stringify([{ in: rgb, out: mask }]));
      const r = await run(
        'python3',
        ['-I', join(studioRoot(), 'tools', 'bgremove.py'), '--model', modelPath, '--jobs', jobs],
        { timeoutMs: 600_000 },
      );
      if (r.code !== 0) {
        let msg = r.stderr.trim().split('\n').pop() ?? '';
        try {
          msg = JSON.parse(msg).message;
        } catch {
          /* keep raw */
        }
        throw new EngineError('ENGINE_FAILED', `background removal failed: ${msg}`);
      }
      inferenceMs = JSON.parse(r.stdout.trim().split('\n').pop()!).ms;
      model = { name, license: e.license, source: e.licenseSource };
      warnings.push(
        `model ${name} (${e.license}): hair, fur, glass, smoke, motion blur, and low-contrast edges come out soft or wrong, and soft shadows are removed with the background. Look at the check image`,
      );
    }
    const format = o.format ?? 'png';
    mkdirSync(dirname(out), { recursive: true });
    const partial = out + '.partial';
    const rgba = join(tmp, 'rgba.png');
    await sharp(rgb).joinChannel(mask).png().toFile(rgba); // same size by construction
    await (
      format === 'webp'
        ? sharp(rgba).webp({ quality: 90, alphaQuality: 100 })
        : sharp(rgba).png({ compressionLevel: 6 })
    ).toFile(partial);
    renameSync(partial, out);
    const alpha = await alphaStats(rgba);
    let check: string | undefined;
    if (o.preview !== false) {
      check = out.slice(0, out.length - extname(out).length) + '.check.png';
      await checkImage(rgba, check);
    }
    if (alpha.coveragePct < 1)
      warnings.push(
        'almost nothing was kept (under 1% of pixels): the subject was probably not found',
      );
    if (alpha.coveragePct > 97)
      warnings.push(
        'almost everything was kept (over 97%): the background was probably not separated',
      );
    const edges = Object.entries(alpha.borderOpacityPct)
      .filter(([, v]) => v > 50)
      .map(([k]) => k);
    if (edges.length)
      warnings.push(
        `the cutout is more than 50% opaque along the ${edges.join(', ')} edge: the subject touches the frame there, or the mask leaked`,
      );
    return {
      output: out,
      check,
      width: meta.width!,
      height: meta.height!,
      model,
      inferenceMs,
      totalMs: Math.round(performance.now() - t0),
      alpha,
      warnings,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
