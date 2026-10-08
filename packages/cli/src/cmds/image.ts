import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, str } from './shared.js';

const IMG_OUT = (inv: Invocation) => join(inv.dir, 'renders', 'images');
const relOut = (inv: Invocation, p: string) =>
  p.startsWith(inv.dir) ? p.slice(inv.dir.length + 1) : p;

function resizeOptions(inv: Invocation) {
  const mode = str(inv, 'mode') as 'cover' | 'inside' | 'contain' | 'fill' | undefined;
  return {
    width: num(inv, 'width'),
    height: num(inv, 'height'),
    mode: mode ?? 'inside',
    background: str(inv, 'background'),
    allowEnlarge: !!inv.flags['allow-enlarge'],
    format: str(inv, 'format') as 'jpeg' | 'webp' | 'avif' | 'png' | undefined,
    quality: num(inv, 'quality'),
    sharpen: !!inv.flags['sharpen'],
    smart: str(inv, 'smart') as 'attention' | 'entropy' | undefined,
  };
}

async function batchRun(inv: Invocation, defaultSubdir: (hash: string) => string) {
  const E = await import('@studio/engines/images');
  if (!inv.positionals.length)
    throw new CliError(
      'INVALID_ARGS',
      'no input files or folders',
      2,
      `studio ${inv.meta.usage.replace('studio ', '')}`,
    );
  const o = resizeOptions(inv);
  const outDir = str(inv, 'out-dir')
    ? resolve(str(inv, 'out-dir')!)
    : join(IMG_OUT(inv), defaultSubdir(E.paramsHash(o)));
  let lastPct = -1;
  const report = await E.runBatch(inv.positionals, {
    ...o,
    outDir,
    projectDir: inv.dir,
    concurrency: num(inv, 'concurrency'),
    resume: !inv.flags['no-resume'],
    onProgress: (d, t) => {
      const pct = Math.floor((d / t) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        inv.log(`${d}/${t} images (${pct}%)`);
      }
    },
  });
  return { report, outDir, tag: E.paramsTag(o) };
}

function summarize(
  inv: Invocation,
  report: Awaited<ReturnType<typeof batchRun>>['report'],
  listOutputs: boolean,
) {
  const { outputs, ...rest } = report;
  const data = {
    ...rest,
    outDir: relOut(inv, report.outDir),
    compression:
      report.outBytes && report.inBytes
        ? Math.round((report.outBytes / report.inBytes) * 1000) / 10
        : null,
    ...(listOutputs ? { outputs: outputs.map((p) => relOut(inv, p)) } : { outputsListed: false }),
  };
  if (report.failed.length === report.total)
    throw new CliError(
      'UNSUPPORTED_INPUT',
      `every input failed; first: ${report.failed[0]!.reason}`,
      2,
      'check the files are intact images',
      data,
    );
  if (report.failed.length)
    throw new CliError(
      'PARTIAL_FAILURE',
      `${report.failed.length} of ${report.total} images failed; first: ${report.failed[0]!.reason}`,
      1,
      'the rest were written; see error.details.failed and rerun after fixing (finished outputs are skipped)',
      data,
    );
  return {
    data,
    warnings: report.warnings,
    artifacts: [{ kind: 'images', path: relOut(inv, report.outDir) }],
  };
}

export const resize: Handler = async (inv) => {
  if (inv.dryRun) return { data: { wouldProcess: inv.positionals, options: resizeOptions(inv) } };
  const { report } = await batchRun(inv, () => '');
  return summarize(inv, report, true);
};

export const batch: Handler = async (inv) => {
  if (inv.dryRun) return { data: { wouldProcess: inv.positionals, options: resizeOptions(inv) } };
  const { report } = await batchRun(inv, (h) => `batch-${h}`);
  return summarize(inv, report, false);
};

export const convert: Handler = async (inv) => {
  if (!str(inv, 'format'))
    throw new CliError(
      'INVALID_ARGS',
      'missing --format',
      2,
      'studio image convert <files...> --format webp',
    );
  if (inv.dryRun) return { data: { wouldProcess: inv.positionals } };
  const { report } = await batchRun(inv, () => '');
  return summarize(inv, report, true);
};

export const bgremove: Handler = async (inv) => {
  const E = await import('@studio/engines/images');
  const src = inv.positionals[0];
  if (!src)
    throw new CliError(
      'INVALID_ARGS',
      'missing image',
      2,
      'studio image bgremove <file> [--model u2net]',
    );
  const stem = basename(src, extname(src));
  const fmt = (str(inv, 'format') ?? 'png') as 'png' | 'webp';
  const out = join(IMG_OUT(inv), `${str(inv, 'out') ?? `${stem}-cutout`}.${fmt}`);
  if (existsSync(out) && !inv.force)
    throw new CliError(
      'WOULD_OVERWRITE',
      `${relOut(inv, out)} already exists`,
      5,
      'pass --out with another name, or --force',
    );
  if (inv.dryRun)
    return { data: { wouldWrite: relOut(inv, out), model: str(inv, 'model') ?? 'u2net' } };
  const { warnings: bgWarnings, ...r } = await E.removeBackground(src, out, {
    model: str(inv, 'model'),
    maskIn: str(inv, 'mask-in'),
    preview: !inv.flags['no-preview'],
    format: fmt,
  });
  return {
    data: {
      ...r,
      output: relOut(inv, r.output),
      ...(r.check ? { check: relOut(inv, r.check) } : {}),
      nextStep: r.check
        ? `look at it: studio inspect frame ${relOut(inv, r.check)} --at 0`
        : undefined,
    },
    warnings: bgWarnings,
    artifacts: [
      { kind: 'cutout', path: relOut(inv, r.output) },
      ...(r.check ? [{ kind: 'check-image', path: relOut(inv, r.check) }] : []),
    ],
  };
};

export const upscale: Handler = async (inv) => {
  const E = await import('@studio/engines/images');
  const src = inv.positionals[0];
  if (!src)
    throw new CliError(
      'INVALID_ARGS',
      'missing image',
      2,
      'studio image upscale <file> [--scale 4]',
    );
  const scale = (num(inv, 'scale') ?? 4) as 2 | 3 | 4;
  if (![2, 3, 4].includes(scale)) throw new CliError('INVALID_ARGS', '--scale must be 2, 3, or 4');
  const opts = {
    scale,
    model: str(inv, 'model') as
      'realesrgan-x4plus' | 'realesrgan-x4plus-anime' | 'realesr-animevideov3' | undefined,
    tile: num(inv, 'tile'),
    targetWidth: num(inv, 'width'),
  };
  if (inv.flags['estimate']) {
    inv.log('timing two small crops to predict the run');
    const e = await E.estimateUpscale(src, opts);
    return {
      data: {
        ...e,
        note: 'estimate from two small crops; large images can differ (memory, tiling)',
      },
      warnings: [`predicted ${(e.predictedMs / 1000).toFixed(1)} s for this image`],
    };
  }
  const out = join(
    IMG_OUT(inv),
    `${str(inv, 'out') ?? `${basename(src, extname(src))}-x${scale}`}.png`,
  );
  if (existsSync(out) && !inv.force)
    throw new CliError(
      'WOULD_OVERWRITE',
      `${relOut(inv, out)} already exists`,
      5,
      'pass --out with another name, or --force',
    );
  if (inv.dryRun) return { data: { wouldWrite: relOut(inv, out), ...opts } };
  inv.log('upscaling (this can be slow on a CPU Vulkan device; use --estimate first)');
  const r = await E.upscaleImage(src, out, opts);
  return {
    data: { ...r, output: relOut(inv, r.output) },
    warnings: r.warnings,
    artifacts: [{ kind: 'upscaled', path: relOut(inv, r.output) }],
  };
};

export const grade: Handler = async (inv) => {
  const E = await import('@studio/engines/images');
  if (!inv.positionals.length)
    throw new CliError(
      'INVALID_ARGS',
      'no input files',
      2,
      'studio image grade <files...> [--exposure 0.5 ...]',
    );
  const o = {
    exposure: num(inv, 'exposure'),
    temperature: num(inv, 'temperature'),
    tint: num(inv, 'tint'),
    contrast: num(inv, 'contrast'),
    highlights: num(inv, 'highlights'),
    shadows: num(inv, 'shadows'),
    saturation: num(inv, 'saturation'),
    vibrance: num(inv, 'vibrance'),
    lut: str(inv, 'lut'),
    lutSpace: str(inv, 'lut-space'),
    sharpen: num(inv, 'sharpen'),
    grain: num(inv, 'grain'),
    match: str(inv, 'match'),
    format: str(inv, 'format') as 'png' | 'jpeg' | 'webp' | undefined,
    quality: num(inv, 'quality'),
  };
  const outDir = str(inv, 'out-dir') ? resolve(str(inv, 'out-dir')!) : join(IMG_OUT(inv), 'graded');
  const results = [];
  const warnings: string[] = [];
  for (const f of inv.positionals) {
    const ext =
      o.format === 'jpeg'
        ? 'jpg'
        : (o.format ??
          (extname(f).toLowerCase() === '.jpg' || extname(f).toLowerCase() === '.jpeg'
            ? 'jpg'
            : 'png'));
    const out = join(outDir, `${basename(f, extname(f))}-graded.${ext}`);
    if (existsSync(out) && !inv.force)
      throw new CliError(
        'WOULD_OVERWRITE',
        `${relOut(inv, out)} already exists`,
        5,
        'pass --out-dir elsewhere, or --force',
      );
    if (inv.dryRun) {
      results.push({ input: f, wouldWrite: relOut(inv, out) });
      continue;
    }
    const ba = inv.flags['before-after']
      ? join(outDir, `${basename(f, extname(f))}-before-after.png`)
      : undefined;
    const r = await E.gradeImage(f, out, o, { beforeAfter: ba });
    results.push({
      input: f,
      ...r,
      output: relOut(inv, r.output),
      ...(r.beforeAfter ? { beforeAfter: relOut(inv, r.beforeAfter) } : {}),
    });
    warnings.push(...r.warnings.map((w) => `${basename(f)}: ${w}`));
  }
  return {
    data: { count: results.length, results },
    warnings,
    artifacts: results.flatMap((r: any) => (r.output ? [{ kind: 'graded', path: r.output }] : [])),
  };
};

function readPalette(inv: Invocation): { text?: string; scrim?: string } | undefined {
  const p = str(inv, 'palette') ?? join(inv.dir, 'brand', 'palette.json');
  if (!existsSync(p)) {
    if (str(inv, 'palette')) throw new CliError('INVALID_ARGS', `${p}: palette file not found`);
    return undefined;
  }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { text: j.colors?.text, scrim: j.colors?.scrim };
  } catch {
    throw new CliError(
      'INVALID_ARGS',
      `${p} is not valid JSON`,
      2,
      'expected {"colors": {"text": "#ffffff", "scrim": "#101018"}}',
    );
  }
}

export const thumbnail: Handler = async (inv) => {
  const E = await import('@studio/engines/images');
  const headline = str(inv, 'headline');
  if (!headline) throw new CliError('INVALID_ARGS', 'missing --headline');
  let image = str(inv, 'image');
  const video = str(inv, 'from-video');
  if (!image === !video)
    throw new CliError('INVALID_ARGS', 'give exactly one of --image or --from-video');
  let fontFile = str(inv, 'font');
  if (!fontFile) {
    const dir = join(inv.dir, 'brand', 'fonts');
    const found = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /\.(ttf|otf)$/i.test(f))
          .sort()[0]
      : undefined;
    if (!found)
      throw new CliError(
        'INVALID_ARGS',
        'no font: the headline cannot be rendered without one',
        2,
        'pass --font <file.ttf|otf>, or put a font in brand/fonts/ (a missing font fails instead of substituting another)',
      );
    fontFile = join(dir, found);
  }
  const size = inv.flags['vertical'] ? { w: 1080, h: 1920 } : { w: 1280, h: 720 };
  const out = join(
    IMG_OUT(inv),
    `${str(inv, 'out') ?? 'thumbnail'}.${str(inv, 'format') === 'png' ? 'png' : 'jpg'}`,
  );
  if (existsSync(out) && !inv.force)
    throw new CliError(
      'WOULD_OVERWRITE',
      `${relOut(inv, out)} already exists`,
      5,
      'pass --out with another name, or --force',
    );
  if (inv.dryRun) return { data: { wouldWrite: relOut(inv, out), size } };
  let tmp: string | undefined;
  try {
    if (video) {
      const at = num(inv, 'at');
      if (at === undefined)
        throw new CliError(
          'INVALID_ARGS',
          '--from-video needs --at <ms>',
          2,
          'pick a frame from `studio inspect sheet`',
        );
      tmp = mkdtempSync(join(tmpdir(), 'studio-thumb-'));
      const I = await import('@studio/inspect');
      const [f] = await I.frames(video, [at], tmp);
      image = f!.path;
    }
    const r = await E.makeThumbnail(out, {
      image: image!,
      headline,
      subject: str(inv, 'subject'),
      size,
      textSide: (str(inv, 'text-side') as 'left' | 'right') ?? 'left',
      font: fontFile,
      palette: readPalette(inv),
      smart: str(inv, 'smart') as 'attention' | 'entropy' | undefined,
      format: str(inv, 'format') as 'jpeg' | 'png' | undefined,
    });
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
    return {
      data: {
        ...r,
        output: relOut(inv, r.output),
        legibility: relOut(inv, r.legibility),
        failedChecks: failed,
        nextStep: `look at both: studio inspect frame ${relOut(inv, r.output)} --at 0 and ${relOut(inv, r.legibility)}`,
      },
      warnings: r.warnings,
      artifacts: [
        { kind: 'thumbnail', path: relOut(inv, r.output) },
        { kind: 'legibility-copy', path: relOut(inv, r.legibility) },
      ],
    };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
};
