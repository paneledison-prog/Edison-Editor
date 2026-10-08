import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { modelFile, requireModel } from './models.js';
import { EngineError, run } from './run.js';

export type UpscaleModel = 'realesrgan-x4plus' | 'realesrgan-x4plus-anime' | 'realesr-animevideov3';

export interface UpscaleOptions {
  /** 2, 3, or 4. x4plus models are 4x only: a 2x request runs 4x then downscales once. */
  scale?: 2 | 3 | 4;
  model?: UpscaleModel;
  /** tile size in px; lowered automatically if a run fails (VRAM / memory) */
  tile?: number;
  /** after upscaling, resize to this width once (Lanczos) */
  targetWidth?: number;
}

export interface UpscaleReport {
  output: string;
  model: string;
  scale: number;
  nativeScale: number;
  inputSize: { w: number; h: number };
  outputSize: { w: number; h: number };
  tileUsed: number;
  tilesTried: number[];
  device?: string;
  deviceIsCpu: boolean;
  ms: number;
  msPerInputMegapixel: number;
  warnings: string[];
}

const MODELS: Record<UpscaleModel, { native: number[]; license: string }> = {
  'realesrgan-x4plus': { native: [4], license: 'BSD-3-Clause' },
  'realesrgan-x4plus-anime': { native: [4], license: 'BSD-3-Clause' },
  'realesr-animevideov3': { native: [2, 3, 4], license: 'BSD-3-Clause' },
};

export function parseDevice(stderr: string): { device?: string; isCpu: boolean } {
  const m = /\[\d+ ([^\]]+)\]\s+queueC/.exec(stderr) ?? /\[\d+ ([^\]]+)\]/.exec(stderr);
  const device = m?.[1]?.trim();
  return { device, isCpu: !!device && /llvmpipe|lavapipe|swiftshader|software|cpu/i.test(device) };
}

async function runBinary(
  bin: string,
  input: string,
  output: string,
  model: string,
  scale: number,
  tile: number,
) {
  const dir = dirname(bin);
  const r = await run(
    bin,
    [
      '-i',
      input,
      '-o',
      output,
      '-n',
      model,
      '-s',
      String(scale),
      '-t',
      String(tile),
      '-m',
      join(dir, 'models'),
      '-f',
      'png',
    ],
    { timeoutMs: 3_600_000 },
  );
  return r;
}

/** Upscale once with Real-ESRGAN. Detail is synthesized, so the result is an enlargement, not a restoration. */
export async function upscaleImage(
  src: string,
  out: string,
  o: UpscaleOptions = {},
): Promise<UpscaleReport> {
  const t0 = performance.now();
  const bin = requireModel('realesrgan-ncnn-vulkan');
  const modelName = o.model ?? 'realesrgan-x4plus';
  const spec = MODELS[modelName];
  if (!spec)
    throw new EngineError(
      'INVALID_INPUT',
      `unknown upscale model ${modelName}; choose ${Object.keys(MODELS).join(', ')}`,
    );
  const wanted = o.scale ?? 4;
  const native = spec.native.includes(wanted) ? wanted : 4;
  if (
    !existsSync(
      join(
        dirname(bin),
        'models',
        `${modelName}${modelName === 'realesr-animevideov3' ? `-x${native}` : ''}.param`,
      ),
    )
  ) {
    throw new EngineError(
      'ENGINE_MISSING',
      `model files for ${modelName} are missing next to the binary`,
      'run `studio models fetch realesrgan-ncnn-vulkan --force`',
    );
  }
  if (!existsSync(src)) throw new EngineError('INVALID_INPUT', `${src}: not found`);

  const tmp = mkdtempSync(join(tmpdir(), 'studio-up-'));
  const warnings = [
    'upscaling invents detail: the result is plausible, not recovered. Do not use it on documents where text must be exact, or for evidence or identification',
  ];
  try {
    const meta = await sharp(src, { failOn: 'error' })
      .rotate()
      .metadata()
      .catch((e) => {
        throw new EngineError('UNSUPPORTED_INPUT', `${basename(src)}: ${(e as Error).message}`);
      });
    const rotated = (meta.orientation ?? 1) >= 5;
    const inW = rotated ? meta.height! : meta.width!;
    const inH = rotated ? meta.width! : meta.height!;
    const rgb = join(tmp, 'in.png');
    await sharp(src).rotate().toColourspace('srgb').removeAlpha().png().toFile(rgb);
    const hasAlpha = !!meta.hasAlpha;
    if (hasAlpha) warnings.push('the alpha channel is enlarged with Lanczos, not by the model');

    const tiles: number[] = [];
    let tile = o.tile ?? 256;
    let device: string | undefined;
    let isCpu = false;
    const rawOut = join(tmp, 'up.png');
    let ok = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      tiles.push(tile);
      const r = await runBinary(bin, rgb, rawOut, modelName, native, tile);
      const d = parseDevice(r.stderr);
      device ??= d.device;
      isCpu ||= d.isCpu;
      if (/vkCreateInstance failed|invalid gpu device/.test(r.stderr)) {
        throw new EngineError(
          'ENGINE_MISSING',
          'no usable Vulkan device for Real-ESRGAN',
          'install a GPU driver, or a software Vulkan (Debian/Ubuntu: apt install mesa-vulkan-drivers) for a slow CPU path; `studio doctor` shows what is found',
        );
      }
      ok = r.code === 0 && existsSync(rawOut);
      if (!ok) {
        lastErr = r.stderr.trim().split('\n').pop() ?? `exit ${r.code}`;
        tile = Math.max(32, Math.floor(tile / 2));
        if (attempt < 3) warnings.push(`run failed (${lastErr}); retrying with tile ${tile}`);
      }
    }
    if (!ok)
      throw new EngineError(
        'ENGINE_FAILED',
        `Real-ESRGAN failed after ${tiles.length} attempts: ${lastErr}`,
        'try a smaller --tile',
      );
    if (isCpu) warnings.push(`ran on a CPU-based Vulkan device (${device}): expect it to be slow`);

    let img = sharp(rawOut);
    const upMeta = await img.metadata();
    let outW = upMeta.width!;
    let outH = upMeta.height!;
    // One resize at the end: upscale once, then bring it to the requested size (rules/04).
    const finalW = o.targetWidth ?? (native !== wanted ? Math.round(inW * wanted) : undefined);
    if (finalW && finalW !== outW) {
      outW = finalW;
      outH = Math.round((upMeta.height! * finalW) / upMeta.width!);
      img = img.resize({ width: outW, height: outH, kernel: 'lanczos3' });
      if (native !== wanted)
        warnings.push(
          `${modelName} is ${native}x only: ran ${native}x, then downscaled once to ${wanted}x`,
        );
    }
    if (hasAlpha) {
      const alpha = await sharp(src)
        .rotate()
        .ensureAlpha()
        .extractChannel(3)
        .resize({ width: outW, height: outH, kernel: 'lanczos3' })
        .png()
        .toBuffer();
      img = sharp(await img.png().toBuffer()).joinChannel(alpha);
    }
    mkdirSync(dirname(out), { recursive: true });
    await img.png({ compressionLevel: 6 }).toFile(out + '.partial');
    renameSync(out + '.partial', out);
    const ms = Math.round(performance.now() - t0);
    return {
      output: out,
      model: modelName,
      scale: wanted,
      nativeScale: native,
      inputSize: { w: inW, h: inH },
      outputSize: { w: outW, h: outH },
      tileUsed: tiles[tiles.length - 1]!,
      tilesTried: tiles,
      device,
      deviceIsCpu: isCpu,
      ms,
      msPerInputMegapixel: Math.round(ms / ((inW * inH) / 1e6)),
      warnings,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Time a small crop to predict the full run before committing to a large one (rules/04).
 * The first call includes engine start-up, so the estimate is split into a fixed part and a per-megapixel part.
 */
export async function estimateUpscale(
  src: string,
  o: UpscaleOptions = {},
): Promise<{ fixedMs: number; msPerInputMegapixel: number; predictedMs: number; sample: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'studio-upest-'));
  try {
    const meta = await sharp(src).rotate().metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const W = rotated ? meta.height! : meta.width!;
    const H = rotated ? meta.width! : meta.height!;
    const crop = async (n: number, name: string) => {
      const w = Math.min(n, W),
        h = Math.min(n, H);
      const p = join(tmp, name);
      await sharp(src)
        .rotate()
        .extract({
          left: Math.floor((W - w) / 2),
          top: Math.floor((H - h) / 2),
          width: w,
          height: h,
        })
        .removeAlpha()
        .png()
        .toFile(p);
      return { p, mp: (w * h) / 1e6 };
    };
    const small = await crop(48, 's.png');
    const big = await crop(160, 'b.png');
    const t = async (c: { p: string }) => {
      const t0 = performance.now();
      const r = await runBinary(
        requireModel('realesrgan-ncnn-vulkan'),
        c.p,
        join(tmp, 'o.png'),
        o.model ?? 'realesrgan-x4plus',
        4,
        o.tile ?? 256,
      );
      if (r.code !== 0)
        throw new EngineError(
          'ENGINE_FAILED',
          `estimate run failed: ${r.stderr.trim().split('\n').pop()}`,
        );
      return performance.now() - t0;
    };
    const ts = await t(small);
    const tb = await t(big);
    const perMp = Math.max(0, (tb - ts) / (big.mp - small.mp));
    const fixed = Math.max(0, ts - perMp * small.mp);
    return {
      fixedMs: Math.round(fixed),
      msPerInputMegapixel: Math.round(perMp),
      predictedMs: Math.round(fixed + perMp * ((W * H) / 1e6)),
      sample: `${(small.mp * 1e6) | 0} px and ${(big.mp * 1e6) | 0} px crops`,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
export { modelFile };
