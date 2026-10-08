import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { EngineError, ffmpeg } from './run.js';

export interface GradeOptions {
  /** stops, linear light (gamma 2.2 model) */
  exposure?: number;
  /** -100 cool to +100 warm */
  temperature?: number;
  /** -100 green to +100 magenta */
  tint?: number;
  /** -100 to +100 */
  contrast?: number;
  /** -100 darkens highlights, +100 brightens them */
  highlights?: number;
  /** -100 darkens shadows, +100 lifts them */
  shadows?: number;
  /** -100 to +100; -100 is monochrome */
  saturation?: number;
  /** -100 to +100: saturates muted colours more than saturated ones */
  vibrance?: number;
  /** a .cube 3D LUT */
  lut?: string;
  /** the colour space the LUT expects; sRGB images need srgb or rec709 */
  lutSpace?: 'srgb' | 'rec709' | string;
  /** unsharp amount, 0 to 3 */
  sharpen?: number;
  /** grain amount 0 to 40, seeded: the same input gives the same output */
  grain?: number;
  /** adjust channel means toward this reference image with one gain per channel (applied first) */
  match?: string;
  /** internal: per-channel gains on encoded values, set by `match` */
  channelGain?: [number, number, number];
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

export interface Tone {
  meanLuma: number;
  /** share of pixels with luma at or above 254 */
  clippedHighlightsPct: number;
  /** share of pixels with luma at or below 1 */
  clippedShadowsPct: number;
  meanRgb: [number, number, number];
}

export interface GradeReport {
  output: string;
  before: Tone;
  after: Tone;
  filtergraph: string;
  /** the order the operations ran in (rules/04) */
  order: string[];
  match?: { reference: Tone; delta: { before: number[]; after: number[] } };
  warnings: string[];
  beforeAfter?: string;
}

const LUT_LOG = /log|slog|clog|vlog|logc|arri|s-?gamut|raw/i;
const f = (n: number) => String(Math.round(n * 10000) / 10000);

/** Rejects out-of-range values with the allowed range, rather than clamping silently. */
function range(name: string, v: number | undefined, lo: number, hi: number) {
  if (v !== undefined && !(v >= lo && v <= hi))
    throw new EngineError('INVALID_INPUT', `${name} must be between ${lo} and ${hi}, got ${v}`);
}

/**
 * Per-channel curve as one lutrgb expression, x in 0..1. Order: exposure, white balance, contrast, highlights/shadows.
 * Approximations, stated: exposure assumes gamma 2.2; white balance and the tone curves work on encoded values.
 */
export function curveExpr(o: GradeOptions, channel: 'r' | 'g' | 'b'): string {
  let x = 'val/maxval';
  if (o.channelGain)
    x = `clip(${x}*${f(o.channelGain[channel === 'r' ? 0 : channel === 'g' ? 1 : 2])},0,1)`;
  if (o.exposure) x = `pow(clip(pow(${x},2.2)*${f(Math.pow(2, o.exposure))},0,1),1/2.2)`;
  const gain =
    channel === 'r'
      ? 1 + (0.15 * (o.temperature ?? 0)) / 100
      : channel === 'b'
        ? 1 - (0.15 * (o.temperature ?? 0)) / 100
        : 1 - (0.1 * (o.tint ?? 0)) / 100;
  if (Math.abs(gain - 1) > 1e-9) x = `clip(${x}*${f(gain)},0,1)`;
  if (o.contrast) x = `clip((${x}-0.5)*${f(1 + o.contrast / 100)}+0.5,0,1)`;
  if (o.highlights || o.shadows) {
    // x(1-x)^2 peaks in the shadows and x^2(1-x) in the highlights; both are zero at black and white, so the ends stay put.
    const h = f(1.7 * ((o.highlights ?? 0) / 100));
    const s = f(1.7 * ((o.shadows ?? 0) / 100));
    x = `clip(${x}+${s}*${x}*pow(1-${x},2)+${h}*pow(${x},2)*(1-${x}),0,1)`;
  }
  return `clip(${x},0,1)*maxval`;
}

export function buildFilter(o: GradeOptions): { graph: string; order: string[] } {
  const parts: string[] = ['format=rgb24'];
  const order: string[] = [];
  if (
    o.channelGain ||
    o.exposure ||
    o.temperature ||
    o.tint ||
    o.contrast ||
    o.highlights ||
    o.shadows
  ) {
    parts.push(`lutrgb=r='${curveExpr(o, 'r')}':g='${curveExpr(o, 'g')}':b='${curveExpr(o, 'b')}'`);
    if (o.channelGain) order.push('match');
    for (const [k, v] of [
      ['exposure', o.exposure],
      ['white balance', o.temperature || o.tint],
      ['contrast', o.contrast],
      ['highlights/shadows', o.highlights || o.shadows],
    ] as const)
      if (v) order.push(k);
  }
  if (o.saturation) {
    parts.push(`eq=saturation=${f(1 + o.saturation / 100)}`, 'format=rgb24');
    order.push('saturation');
  }
  if (o.vibrance) {
    parts.push(`vibrance=intensity=${f((o.vibrance / 100) * 2)}`);
    order.push('vibrance');
  }
  if (o.lut) {
    parts.push(`lut3d=file='${o.lut.replace(/'/g, "\\'")}':interp=tetrahedral`);
    order.push('lut');
  }
  if (o.sharpen) {
    parts.push(`unsharp=5:5:${f(o.sharpen)}:5:5:0`, 'format=rgb24');
    order.push('sharpen');
  }
  if (o.grain) {
    parts.push(`noise=alls=${f(o.grain)}:allf=u:all_seed=1234`, 'format=rgb24');
    order.push('grain');
  }
  return { graph: parts.join(','), order };
}

/** Luma and clipping, measured on the finished pixels (each derived image is rendered first: sharp stats() ignores chained operations). */
export async function toneOf(file: string): Promise<Tone> {
  const mean = async (img: ReturnType<typeof sharp>) =>
    (await sharp(await img.png().toBuffer()).stats()).channels[0]!.mean;
  const grey = () => sharp(file).removeAlpha().greyscale();
  const luma = await mean(grey());
  const hi = (await mean(grey().threshold(254))) / 255;
  // sharp runs threshold before negate whatever the chain order, so measure shadows as 1 - (share of pixels at or above 2)
  const lo = 1 - (await mean(grey().threshold(2))) / 255;
  const rgb = (await sharp(file).removeAlpha().stats()).channels.map((c) => c.mean) as [
    number,
    number,
    number,
  ];
  return {
    meanLuma: Math.round(luma * 10) / 10,
    clippedHighlightsPct: Math.round(hi * 1000) / 10,
    clippedShadowsPct: Math.round(lo * 1000) / 10,
    meanRgb: rgb.map((v) => Math.round(v * 10) / 10) as [number, number, number],
  };
}

/** Grade one image. Order of operations: exposure, white balance, contrast, highlights/shadows, saturation, vibrance, LUT, sharpen, grain. */
export async function gradeImage(
  src: string,
  out: string,
  o: GradeOptions,
  opts: { beforeAfter?: string } = {},
): Promise<GradeReport> {
  range('exposure', o.exposure, -5, 5);
  for (const k of [
    'temperature',
    'tint',
    'contrast',
    'highlights',
    'shadows',
    'saturation',
    'vibrance',
  ] as const)
    range(k, o[k], -100, 100);
  range('sharpen', o.sharpen, 0, 3);
  range('grain', o.grain, 0, 40);
  const warnings: string[] = [];
  if (o.lut) {
    if (!existsSync(o.lut)) throw new EngineError('INVALID_INPUT', `${o.lut}: LUT not found`);
    if (!o.lutSpace)
      throw new EngineError(
        'INVALID_INPUT',
        'a LUT must declare the colour space it expects',
        'pass --lut-space srgb|rec709 (the image is sRGB). A log LUT on an sRGB image looks wrong and is refused',
      );
    if (LUT_LOG.test(o.lutSpace) || LUT_LOG.test(basename(o.lut))) {
      throw new EngineError(
        'INVALID_INPUT',
        `the LUT expects ${LUT_LOG.test(o.lutSpace) ? o.lutSpace : 'a log space (from its name)'} input, but the image is sRGB`,
        "convert the image to the LUT's input space first, or use a Rec.709/sRGB LUT",
      );
    }
    if (o.lutSpace === 'rec709')
      warnings.push(
        'Rec.709 LUT applied to an sRGB image: the transfer curves differ slightly; check shadows',
      );
    if (!/^LUT_3D_SIZE\s+\d+/m.test(readFileSync(o.lut, 'utf8').slice(0, 20000)))
      throw new EngineError(
        'INVALID_INPUT',
        `${basename(o.lut)} is not a 3D .cube LUT (no LUT_3D_SIZE)`,
      );
  }
  if (!existsSync(src)) throw new EngineError('INVALID_INPUT', `${src}: not found`);

  const tmp = mkdtempSync(join(tmpdir(), 'studio-grade-'));
  try {
    const meta = await sharp(src, { failOn: 'error' })
      .metadata()
      .catch((e) => {
        throw new EngineError('UNSUPPORTED_INPUT', `${basename(src)}: ${(e as Error).message}`);
      });
    if (meta.icc)
      warnings.push(`${basename(src)}: embedded ICC profile converted to sRGB before grading`);
    const base = join(tmp, 'in.png');
    await sharp(src).rotate().toColourspace('srgb').png().toFile(base);
    const hasAlpha = !!meta.hasAlpha;
    const rgbIn = join(tmp, 'rgb.png');
    await sharp(base).removeAlpha().png().toFile(rgbIn);
    const before = await toneOf(rgbIn);

    let opt = { ...o };
    let matchInfo: GradeReport['match'];
    if (o.match) {
      if (!existsSync(o.match))
        throw new EngineError('INVALID_INPUT', `${o.match}: reference not found`);
      const refPng = join(tmp, 'ref.png');
      await sharp(o.match).rotate().toColourspace('srgb').removeAlpha().png().toFile(refPng);
      const ref = await toneOf(refPng);
      // Per-channel gain on encoded values so that each channel mean lands on the reference mean.
      const g = ref.meanRgb.map((m, i) => m / Math.max(before.meanRgb[i]!, 1));
      opt = { ...opt, channelGain: g as [number, number, number] };
      matchInfo = {
        reference: ref,
        delta: {
          before: ref.meanRgb.map((m, i) => Math.round((m - before.meanRgb[i]!) * 10) / 10),
          after: [],
        },
      };
      warnings.push(
        'match applies one gain per channel so the channel means line up; it does not match contrast, or shadows and highlights separately, and clipped channels cannot reach the reference',
      );
    }
    const { graph, order } = buildFilter(opt);
    const graded = join(tmp, 'graded.png');
    await ffmpeg([
      '-i',
      rgbIn,
      '-vf',
      graph,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-update',
      '1',
      graded,
    ]);
    let img = sharp(graded);
    if (hasAlpha)
      img = sharp(await img.png().toBuffer()).joinChannel(
        await sharp(base).extractChannel(3).png().toBuffer(),
      );
    const after = await toneOf(graded);
    if (matchInfo)
      matchInfo.delta.after = matchInfo.reference.meanRgb.map(
        (m, i) => Math.round((m - after.meanRgb[i]!) * 10) / 10,
      );
    if (after.clippedHighlightsPct > before.clippedHighlightsPct + 1)
      warnings.push(
        `clipped highlights rose from ${before.clippedHighlightsPct}% to ${after.clippedHighlightsPct}%`,
      );
    if (after.clippedShadowsPct > before.clippedShadowsPct + 1)
      warnings.push(
        `clipped shadows rose from ${before.clippedShadowsPct}% to ${after.clippedShadowsPct}%`,
      );
    if (!order.length)
      warnings.push('no adjustment was requested; the output is the sRGB-normalized input');

    const fmt =
      o.format ?? (/\.jpe?g$/i.test(out) ? 'jpeg' : /\.webp$/i.test(out) ? 'webp' : 'png');
    mkdirSync(dirname(out), { recursive: true });
    const q = o.quality ?? (fmt === 'jpeg' ? 92 : 85);
    await (
      fmt === 'jpeg'
        ? img.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true })
        : fmt === 'webp'
          ? img.webp({ quality: q })
          : img.png({ compressionLevel: 6 })
    ).toFile(out + '.partial');
    renameSync(out + '.partial', out);

    let ba: string | undefined;
    if (opts.beforeAfter) {
      const w = Math.min(meta.width ?? 800, 800);
      const L = await sharp(rgbIn).resize({ width: w }).png().toBuffer();
      const R = await sharp(graded).resize({ width: w }).png().toBuffer();
      const h = (await sharp(L).metadata()).height!;
      await sharp({ create: { width: w * 2 + 8, height: h, channels: 3, background: '#808080' } })
        .composite([
          { input: L, left: 0, top: 0 },
          { input: R, left: w + 8, top: 0 },
        ])
        .png()
        .toFile(opts.beforeAfter + '.partial');
      renameSync(opts.beforeAfter + '.partial', opts.beforeAfter);
      ba = opts.beforeAfter;
    }
    return {
      output: out,
      before,
      after,
      filtergraph: graph,
      order,
      ...(matchInfo ? { match: matchInfo } : {}),
      warnings,
      ...(ba ? { beforeAfter: ba } : {}),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
