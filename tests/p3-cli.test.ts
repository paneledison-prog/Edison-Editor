import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');

interface Out {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
}
const studio = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Out> =>
  new Promise((resolve) =>
    execFile(
      'node',
      [BIN, ...args],
      { env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let json: any;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
        resolve({ code: err ? ((err as any).code as number) : 0, json, stdout, stderr });
      },
    ),
  );
const proj = async () => {
  const dir = tmpDir('studio-p3-');
  await studio(['init', 'p3', '--project', dir]);
  return dir;
};
const noise = (w: number, h: number, seed = 0) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 90 + (seed % 90), g: 120, b: 150 },
      noise: { type: 'gaussian', mean: 128, sigma: 35 },
    },
  });
const decodes = async (f: string) => {
  try {
    await sharp(f).metadata();
    return true;
  } catch {
    return false;
  }
};
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );

const pythonOk =
  spawnSync('python3', ['-I', '-c', 'import onnxruntime,numpy,PIL'], { stdio: 'ignore' }).status ===
  0;
const haveModel = (n: string) => existsSync(join(ROOT, 'models', n));
const haveVulkanBin = existsSync(
  join(ROOT, 'models', 'engines', 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan'),
);
const fontFile = (() => {
  for (const f of [
    '/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ])
    if (existsSync(f)) return f;
  return undefined;
})();

beforeAll(async () => {
  // the CLI bundle is built once by tests/global-setup.ts
  ensureFixtures();
  // A public-domain portrait (NASA, via scikit-image) for background removal. The test is skipped, and says so, when it cannot be fetched.
  const f = fx('astronaut.png');
  if (!existsSync(f))
    spawnSync('curl', [
      '-sSL',
      '-m',
      '60',
      '-o',
      f,
      'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png',
    ]);
  if (existsSync(f) && !(await decodes(f))) spawnSync('rm', ['-f', f]);
}, 180_000);

describe('image resize, convert, and batch through the CLI', () => {
  it('resize lists outputs; sizes and formats are as asked; warnings carry the effective size', async () => {
    const dir = await proj();
    const src = tmpDir();
    await noise(1600, 1200).jpeg().toFile(join(src, 'a.jpg'));
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#c04020' } })
      .png()
      .toFile(join(src, 'tiny.png'));
    const r = await studio([
      'image',
      'resize',
      join(src, 'a.jpg'),
      join(src, 'tiny.png'),
      '--width',
      '640',
      '--format',
      'webp',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.outputs).toEqual([
      'renders/images/a-640xauto-inside.webp',
      'renders/images/tiny-640xauto-inside.webp',
    ]);
    expect(await sharp(join(dir, r.json.data.outputs[0])).metadata()).toMatchObject({
      width: 640,
      height: 480,
      format: 'webp',
    });
    expect((await sharp(join(dir, r.json.data.outputs[1])).metadata()).width).toBe(100); // not enlarged
    expect(r.json.warnings.join()).toMatch(/not enlarged \(effective size 100x80\)/);
    expect(r.json.data.inBytes).toBeGreaterThan(r.json.data.outBytes);
  }, 60_000);

  it('a bad file fails the command (exit 1) but the others are still written; all bad is exit 2; unknown flag values are exit 2', async () => {
    const dir = await proj();
    const src = tmpDir();
    for (let i = 0; i < 3; i++)
      await noise(300, 200, i)
        .jpeg()
        .toFile(join(src, `ok${i}.jpg`));
    writeFileSync(join(src, 'broken.jpg'), 'not an image');
    const r = await studio(['image', 'batch', src, '--width', '100', '--project', dir]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('PARTIAL_FAILURE');
    expect(r.json.error.details.processed).toBe(3);
    expect(r.json.error.details.failed[0].file).toMatch(/broken\.jpg$/);
    expect(walk(join(dir, 'renders/images')).filter((f) => f.endsWith('.jpg')).length).toBe(3);
    const allBad = tmpDir();
    writeFileSync(join(allBad, 'x.png'), 'nope');
    expect(
      (await studio(['image', 'resize', join(allBad, 'x.png'), '--width', '10', '--project', dir]))
        .code,
    ).toBe(2);
    expect(
      (
        await studio([
          'image',
          'resize',
          join(src, 'ok0.jpg'),
          '--width',
          '10',
          '--mode',
          'zoom',
          '--project',
          dir,
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await studio([
          'image',
          'resize',
          join(src, 'ok0.jpg'),
          '--width',
          '10',
          '--mode',
          'cover',
          '--project',
          dir,
        ])
      ).json.error.message,
    ).toMatch(/cover needs both/);
    expect(
      (await studio(['image', 'convert', join(src, 'ok0.jpg'), '--project', dir])).json.error
        .message,
    ).toMatch(/missing --format/);
  }, 60_000);

  it('dry run writes nothing', async () => {
    const dir = await proj();
    const src = tmpDir();
    await noise(100, 100).jpeg().toFile(join(src, 'a.jpg'));
    const r = await studio(['image', 'batch', src, '--width', '50', '--dry-run', '--project', dir]);
    expect(r.json.dryRun).toBe(true);
    expect(existsSync(join(dir, 'renders/images'))).toBe(false);
  });
});

describe('acceptance: 200-image batch resize with bounded memory', () => {
  const make = async (dir: string, n: number) => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i += 8) {
      await Promise.all(
        Array.from({ length: Math.min(8, n - i) }, (_, k) =>
          noise(2000, 1500, i + k)
            .jpeg({ quality: 88 })
            .toFile(join(dir, `img${String(i + k).padStart(3, '0')}.jpg`)),
        ),
      );
    }
  };

  it('processes 200 2000x1500 JPEGs, peak memory does not grow with the count, resume skips everything, a changed file is the only redo', async () => {
    const src = tmpDir('studio-200-');
    await make(src, 200);
    const small = tmpDir('studio-50-');
    for (const f of readdirSync(src).slice(0, 50)) copyFileSync(join(src, f), join(small, f));
    const inBytes = readdirSync(src).reduce((n, f) => n + statSync(join(src, f)).size, 0);

    const dir50 = await proj();
    const r50 = await studio([
      'image',
      'batch',
      small,
      '--width',
      '1280',
      '--format',
      'webp',
      '--project',
      dir50,
    ]);
    expect(r50.json.ok, r50.stdout).toBe(true);

    const dir = await proj();
    const t0 = performance.now();
    const r = await studio([
      'image',
      'batch',
      src,
      '--width',
      '1280',
      '--format',
      'webp',
      '--project',
      dir,
    ]);
    const wall = performance.now() - t0;
    expect(r.json.ok, r.stdout).toBe(true);
    const d = r.json.data;
    console.log(
      `P3 BATCH 200 x 2000x1500 JPEG (${(inBytes / 1048576).toFixed(0)} MB) -> 1280 px WebP: ${(d.elapsedMs / 1000).toFixed(1)} s, ${d.imagesPerSecond} img/s, concurrency ${d.concurrency}, peak RSS ${d.peakRssMb} MB (50 images: ${r50.json.data.peakRssMb} MB), out ${(d.outBytes / 1048576).toFixed(0)} MB (${d.compression}% of input), CLI wall ${(wall / 1000).toFixed(1)} s`,
    );
    expect(d).toMatchObject({ total: 200, processed: 200, skippedUpToDate: 0, failed: [] });
    expect(d.concurrency).toBeLessThanOrEqual(4);
    expect(d.peakRssMb).toBeLessThan(600);
    expect(d.peakRssMb).toBeLessThanOrEqual(r50.json.data.peakRssMb * 1.35); // bounded: 4x the images did not cost more memory
    const outs = readdirSync(join(dir, d.outDir)).filter((f) => f.endsWith('.webp'));
    expect(outs).toHaveLength(200);
    expect(await sharp(join(dir, d.outDir, outs[0]!)).metadata()).toMatchObject({
      width: 1280,
      height: 960,
    });
    expect(d.outputsListed).toBe(false); // a batch summarizes, it does not dump 200 paths

    const again = await studio([
      'image',
      'batch',
      src,
      '--width',
      '1280',
      '--format',
      'webp',
      '--project',
      dir,
    ]);
    expect(again.json.data).toMatchObject({ processed: 0, skippedUpToDate: 200 });
    await noise(2000, 1500, 999).jpeg().toFile(join(src, 'img007.jpg'));
    const one = await studio([
      'image',
      'batch',
      src,
      '--width',
      '1280',
      '--format',
      'webp',
      '--project',
      dir,
    ]);
    expect(one.json.data).toMatchObject({ processed: 1, skippedUpToDate: 199 });
  }, 600_000);

  it('a killed batch leaves no finished-looking corrupt outputs, stale partials are cleaned, and the rerun completes it', async () => {
    const src = tmpDir('studio-kill-');
    await make(src, 80);
    const dir = await proj();
    const outRoot = join(dir, 'renders/images');
    const args = [
      'image',
      'batch',
      src,
      '--width',
      '1000',
      '--format',
      'webp',
      '--concurrency',
      '1',
      '--project',
      dir,
    ];
    const child = spawn('node', [BIN, ...args], { stdio: 'ignore' });
    const count = () =>
      existsSync(outRoot) ? walk(outRoot).filter((f) => f.endsWith('.webp')).length : 0;
    for (let i = 0; i < 600 && count() < 12; i++) await new Promise((r) => setTimeout(r, 20));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    const finished = walk(outRoot).filter((f) => f.endsWith('.webp'));
    expect(finished.length, 'killed after some, before all').toBeGreaterThanOrEqual(12);
    expect(finished.length).toBeLessThan(80);
    for (const f of finished)
      expect(await decodes(f), `${f} is a finished-looking file that does not decode`).toBe(true);
    // a SIGKILL may land mid-write; plant that state so the cleanup is exercised every time
    const sub = readdirSync(outRoot).find((e) => statSync(join(outRoot, e)).isDirectory());
    const stale = join(sub ? join(outRoot, sub) : outRoot, 'img999-1000xauto-inside.webp.partial');
    writeFileSync(stale, 'half written');
    const r = await studio(args);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data).toMatchObject({ total: 80, failed: [] });
    expect(r.json.data.skippedUpToDate).toBeGreaterThanOrEqual(12); // resumed, not restarted
    expect(r.json.data.processed + r.json.data.skippedUpToDate).toBe(80);
    expect(r.json.warnings.join()).toMatch(/removed 1 unfinished file/);
    const all = walk(outRoot);
    expect(all.filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(all.filter((f) => f.endsWith('.webp'))).toHaveLength(80);
    console.log(
      `P3 KILL: ${finished.length} finished before SIGKILL; rerun reused ${r.json.data.skippedUpToDate} and made ${r.json.data.processed}; stale partial removed`,
    );
  }, 300_000);
});

describe.skipIf(!pythonOk || !haveModel('u2net.onnx') || !existsSync(fx('astronaut.png')))(
  'background removal',
  () => {
    it('cuts out a portrait: same size, alpha present, sane statistics, model and license recorded, check image inspectable', async () => {
      const dir = await proj();
      const r = await studio(['image', 'bgremove', fx('astronaut.png'), '--project', dir]);
      expect(r.json.ok, r.stdout).toBe(true);
      const d = r.json.data;
      expect(d.model).toMatchObject({ name: 'u2net', license: 'Apache-2.0' });
      expect([d.width, d.height]).toEqual([512, 512]);
      const m = await sharp(join(dir, d.output)).metadata();
      expect([m.width, m.height, m.hasAlpha, m.channels]).toEqual([512, 512, true, 4]);
      // independent measurement of the same alpha channel with Python, so the reported numbers are checked, not just echoed
      const py = JSON.parse(
        spawnSync(
          'python3',
          [
            '-I',
            '-c',
            `import json,sys,numpy as np;from PIL import Image;a=np.asarray(Image.open(sys.argv[1]))[:,:,3];print(json.dumps({"cov":round(100*float((a>10).mean()),1),"bottom":round(100*float(a[-5:,:].mean())/255,1)}))`,
            join(dir, d.output),
          ],
          { encoding: 'utf8' },
        ).stdout,
      );
      expect(d.alpha.coveragePct).toBe(py.cov);
      expect(d.alpha.borderOpacityPct.bottom).toBe(py.bottom);
      expect(d.alpha.coveragePct).toBeGreaterThan(30);
      expect(d.alpha.coveragePct).toBeLessThan(80);
      expect(d.alpha.borderOpacityPct.top).toBeLessThan(5); // the head does not touch the top edge
      expect(d.warnings).toBeUndefined();
      expect(r.json.warnings.join()).toMatch(/hair, fur, glass/);
      // the check image goes through `inspect frame` like any other frame
      const f = await studio(['inspect', 'frame', d.check, '--at', '0', '--project', dir]);
      expect(f.json.ok, f.stdout).toBe(true);
      const cm = await sharp(join(dir, f.json.data.frames[0].path)).metadata();
      expect(cm.width).toBe(512 * 2 + 8); // light and dark side by side
      // never overwrites without --force
      expect(
        (await studio(['image', 'bgremove', fx('astronaut.png'), '--project', dir])).code,
      ).toBe(5);
    }, 120_000);

    it('--mask-in applies your own mask exactly; a wrong-size mask and an unknown model are refused', async () => {
      const dir = await proj();
      const first = await studio([
        'image',
        'bgremove',
        fx('astronaut.png'),
        '--no-preview',
        '--project',
        dir,
      ]);
      // take the model's alpha, erase the left 100 px by hand, and feed it back as the refined mask
      const alpha = await sharp(join(dir, first.json.data.output))
        .extractChannel(3)
        .png()
        .toBuffer();
      const edited = await sharp(alpha)
        .composite([
          {
            input: { create: { width: 100, height: 512, channels: 3, background: '#000000' } },
            left: 0,
            top: 0,
          },
        ])
        .greyscale()
        .png()
        .toFile(join(dir, 'mask.png'));
      void edited;
      const r = await studio([
        'image',
        'bgremove',
        fx('astronaut.png'),
        '--mask-in',
        join(dir, 'mask.png'),
        '--out',
        'refined',
        '--project',
        dir,
      ]);
      expect(r.json.ok, r.stdout).toBe(true);
      expect(r.json.data.model).toMatchObject({ name: 'mask-in' });
      expect(r.json.data.alpha.borderOpacityPct.left).toBe(0); // the manual erase took effect
      expect(r.json.data.alpha.coveragePct).toBeLessThan(first.json.data.alpha.coveragePct);
      const wrong = join(dir, 'wrong.png');
      await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
        .png()
        .toFile(wrong);
      expect(
        (
          await studio([
            'image',
            'bgremove',
            fx('astronaut.png'),
            '--mask-in',
            wrong,
            '--out',
            'x',
            '--project',
            dir,
          ])
        ).json.error.message,
      ).toMatch(/mask is 100x100 but the image is 512x512/);
      expect(
        (
          await studio([
            'image',
            'bgremove',
            fx('astronaut.png'),
            '--model',
            'realesrgan-ncnn-vulkan',
            '--out',
            'y',
            '--project',
            dir,
          ])
        ).json.error.message,
      ).toMatch(/not a background-removal model/);
    }, 120_000);
  },
);

describe('engines that are missing fail with a fix, never with placeholder output', () => {
  it('no model files: bgremove and upscale exit 3 with the fetch command', async () => {
    const dir = await proj();
    const empty = tmpDir('studio-nomodels-');
    const env = { STUDIO_MODELS_DIR: empty };
    const a = await studio(['image', 'bgremove', fx('still.png'), '--project', dir], env);
    expect(a.code).toBe(3);
    expect(a.json.error.fix).toMatch(/studio models fetch u2net/);
    const b = await studio(['image', 'upscale', fx('still.png'), '--project', dir], env);
    expect(b.code).toBe(3);
    expect(b.json.error.fix).toMatch(/studio models fetch realesrgan-ncnn-vulkan/);
    expect(existsSync(join(dir, 'renders/images'))).toBe(false);
  });

  it('no python: bgremove exits 3 with the pip command', async () => {
    if (!haveModel('u2net.onnx')) return;
    const dir = await proj();
    const a = await studio(['image', 'bgremove', fx('still.png'), '--project', dir], {
      PATH: join(process.execPath, '..'),
    });
    expect(a.code).toBe(3);
    expect(a.json.error.fix).toMatch(/pip install -r tools\/requirements\.txt/);
  });

  it('a download that does not match the manifest is rejected and nothing is installed', async () => {
    const home = tmpDir('studio-home-');
    const models = tmpDir('studio-models-');
    mkdirSync(join(home, 'models'), { recursive: true });
    const m = JSON.parse(readFileSync(join(ROOT, 'models', 'manifest.json'), 'utf8'));
    m.models.u2netp.sha256 = '0'.repeat(64);
    writeFileSync(join(home, 'models', 'manifest.json'), JSON.stringify(m));
    const dir = await proj();
    const r = await studio(['models', 'fetch', 'u2netp', '--project', dir], {
      STUDIO_HOME: home,
      STUDIO_MODELS_DIR: models,
    });
    expect(r.code).not.toBe(0);
    expect(r.json.error.message).toMatch(/does not match the manifest/);
    expect(readdirSync(models)).toEqual([]);
  }, 120_000);

  it('models list reports status, license, and source; unknown names are rejected', async () => {
    const dir = await proj();
    const r = await studio(['models', 'list', '--project', dir]);
    const rows = r.json.data.models;
    expect(rows.map((x: any) => x.name)).toEqual([
      'u2net',
      'u2netp',
      'realesrgan-ncnn-vulkan',
      'whisper-tiny.en',
      'whisper-small',
      'whisper-medium',
    ]);
    expect(rows.every((x: any) => x.license && x.licenseSource.startsWith('https://'))).toBe(true);
    expect((await studio(['models', 'fetch', 'nope', '--project', dir])).code).toBe(2);
  });
});

describe.skipIf(!haveVulkanBin)('upscale', () => {
  it('upscales a tiny image 4x on whatever Vulkan device exists, says so, and --scale 2 downscales once from 4x', async () => {
    const dir = await proj();
    const img = join(dir, 'tiny.png');
    await noise(32, 32, 3).png().toFile(img);
    const e = await studio(['image', 'upscale', img, '--estimate', '--project', dir]);
    if (e.code === 3) {
      expect(e.json.error.fix).toMatch(/Vulkan|mesa/);
      return;
    } // no usable device: the failure is itself the correct behaviour
    // A 32 px image is smaller than both estimate crops: the prediction must still be a finite number, not null.
    expect(Number.isFinite(e.json.data.predictedMs), JSON.stringify(e.json.data)).toBe(true);
    expect(e.json.data.predictedMs).toBeGreaterThan(0);
    const r = await studio(['image', 'upscale', img, '--scale', '4', '--project', dir]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.outputSize).toEqual({ w: 128, h: 128 });
    expect(await sharp(join(dir, r.json.data.output)).metadata()).toMatchObject({
      width: 128,
      height: 128,
    });
    expect(r.json.warnings.join()).toMatch(/invents detail/);
    const r2 = await studio([
      'image',
      'upscale',
      img,
      '--scale',
      '2',
      '--out',
      'x2',
      '--project',
      dir,
    ]);
    expect(r2.json.data.outputSize).toEqual({ w: 64, h: 64 });
    expect(r2.json.warnings.join()).toMatch(/ran 4x, then downscaled once to 2x/);
    expect((await studio(['image', 'upscale', img, '--scale', '5', '--project', dir])).code).toBe(
      2,
    );
  }, 300_000);
});

describe('grade through the CLI', () => {
  it('grades several files, reports before/after, writes a before/after image; refuses bad values, existing outputs, and log LUTs', async () => {
    const dir = await proj();
    const src = tmpDir();
    for (const [n, c] of [
      ['a', '#808080'],
      ['b', '#c06030'],
    ] as const)
      await sharp({ create: { width: 64, height: 64, channels: 3, background: c } })
        .png()
        .toFile(join(src, `${n}.png`));
    const r = await studio([
      'image',
      'grade',
      join(src, 'a.png'),
      join(src, 'b.png'),
      '--exposure',
      '1',
      '--before-after',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.count).toBe(2);
    const a = r.json.data.results[0];
    expect(a.after.meanLuma).toBeGreaterThan(a.before.meanLuma);
    expect(a.order).toEqual(['exposure']);
    expect(existsSync(join(dir, a.beforeAfter))).toBe(true);
    expect(
      (await studio(['image', 'grade', join(src, 'a.png'), '--exposure', '1', '--project', dir]))
        .code,
    ).toBe(5);
    expect(
      (
        await studio([
          'image',
          'grade',
          join(src, 'a.png'),
          '--exposure',
          '9',
          '--force',
          '--project',
          dir,
        ])
      ).code,
    ).toBe(2);
    writeFileSync(join(src, 'x.cube'), 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8));
    const bad = await studio([
      'image',
      'grade',
      join(src, 'a.png'),
      '--lut',
      join(src, 'x.cube'),
      '--lut-space',
      'slog3',
      '--force',
      '--project',
      dir,
    ]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/expects slog3 input, but the image is sRGB/);
  }, 120_000);
});

describe.skipIf(!fontFile)('thumbnail', () => {
  it('the headline is set by the motion renderer: the longest allowed headline stays on at most 3 lines inside the margins, in both orientations', async () => {
    const dir = await proj();
    for (const [flag, W, H] of [
      [[], 1280, 720],
      [['--vertical'], 1080, 1920],
    ] as const) {
      const r = await studio([
        'image',
        'thumbnail',
        '--image',
        fx('still.png'),
        '--headline',
        'Extraordinarily unbelievable productivity improvements',
        '--font',
        fontFile!,
        ...flag,
        '--out',
        `long${W}`,
        '--project',
        dir,
      ]);
      expect(r.json.ok, r.stdout).toBe(true);
      const d = r.json.data;
      expect(d.layout.lines).toBeLessThanOrEqual(3);
      expect(d.layout.textBox.x).toBeGreaterThanOrEqual(d.layout.marginPx.x);
      expect(d.layout.textBox.x + d.layout.textBox.w).toBeLessThanOrEqual(W - d.layout.marginPx.x);
      expect(d.layout.textBox.y + d.layout.textBox.h).toBeLessThanOrEqual(H - d.layout.marginPx.y);
      expect(d.reasons.join(' ')).toMatch(/headline set at \d+ pt/);
    }
  }, 120_000);

  it('builds one from a video frame with a cutout: checks pass, the reasons are stated, and it stays under 2 MB', async () => {
    const dir = await proj();
    const vid = fx('clean.mp4');
    // a cutout with alpha: an ellipse cut from a noise image, cropped at the bottom edge like a portrait
    const ell = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><ellipse cx="200" cy="300" rx="190" ry="260" fill="#fff"/></svg>',
    );
    const subject = join(dir, 'subject.png');
    await sharp(await noise(400, 500, 20).png().toBuffer())
      .joinChannel(await sharp(ell).extractChannel(0).png().toBuffer())
      .png()
      .toFile(subject);
    const r = await studio([
      'image',
      'thumbnail',
      '--from-video',
      vid,
      '--at',
      '2000',
      '--headline',
      'Ship it faster',
      '--subject',
      subject,
      '--font',
      fontFile!,
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    const d = r.json.data;
    expect(d.failedChecks).toEqual([]);
    expect(d.checks.map((c: any) => c.id).sort()).toEqual([
      'file-size',
      'legible-at-168px',
      'safe-margins',
      'subject-not-covered',
      'text-contrast',
    ]);
    expect(d.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(d.reasons.length).toBeGreaterThanOrEqual(4);
    expect(await sharp(join(dir, d.output)).metadata()).toMatchObject({
      width: 1280,
      height: 720,
      format: 'jpeg',
    });
    expect((await sharp(join(dir, d.legibility)).metadata()).width).toBe(168);
    // geometry is measured, so check it again here from the report
    const { textBox, subjectBox, marginPx } = d.layout;
    expect(textBox.x).toBeGreaterThanOrEqual(marginPx.x);
    expect(textBox.x + textBox.w).toBeLessThanOrEqual(1280 - marginPx.x);
    expect(subjectBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.w); // no overlap
    const vert = await studio([
      'image',
      'thumbnail',
      '--image',
      fx('clean.mp4').replace('clean.mp4', 'still.png'),
      '--headline',
      'Quick tip',
      '--font',
      fontFile!,
      '--vertical',
      '--out',
      'vert',
      '--project',
      dir,
    ]);
    expect(vert.json.ok, vert.stdout).toBe(true);
    expect(await sharp(join(dir, vert.json.data.output)).metadata()).toMatchObject({
      width: 1080,
      height: 1920,
    });
  }, 120_000);

  it('refuses more than 5 words, a missing font, a missing frame time, and an existing output', async () => {
    const dir = await proj();
    const base = ['image', 'thumbnail', '--image', fx('still.png'), '--project', dir];
    const six = await studio([
      ...base,
      '--headline',
      'one two three four five six',
      '--font',
      fontFile!,
    ]);
    expect(six.code).toBe(2);
    expect(six.json.error.message).toMatch(/6 words; keep it to 5 or fewer/);
    const nofont = await studio([...base, '--headline', 'Hello']);
    expect(nofont.code).toBe(2);
    expect(nofont.json.error.fix).toMatch(/brand\/fonts/);
    expect(
      (
        await studio([
          'image',
          'thumbnail',
          '--from-video',
          fx('clean.mp4'),
          '--headline',
          'Hi',
          '--font',
          fontFile!,
          '--project',
          dir,
        ])
      ).json.error.message,
    ).toMatch(/needs --at/);
    expect(
      (await studio([...base, '--headline', 'Hello', '--font', '/nope/font.ttf'])).json.error
        .message,
    ).toMatch(/font file not found/);
    await studio([...base, '--headline', 'Hello', '--font', fontFile!]);
    expect((await studio([...base, '--headline', 'Hello', '--font', fontFile!])).code).toBe(5);
  }, 120_000);

  it('picks up brand/palette.json and brand/fonts automatically', async () => {
    const dir = await proj();
    mkdirSync(join(dir, 'brand', 'fonts'), { recursive: true });
    copyFileSync(fontFile!, join(dir, 'brand', 'fonts', 'Brand-Bold' + fontFile!.slice(-4)));
    writeFileSync(
      join(dir, 'brand', 'palette.json'),
      JSON.stringify({ colors: { text: '#ffe066', scrim: '#101040' } }),
    );
    const r = await studio([
      'image',
      'thumbnail',
      '--image',
      fx('still.png'),
      '--headline',
      'Brand test',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.layout.textColor).toBe('#ffe066');
  }, 60_000);
});

describe('startup cost stays small', () => {
  it('commands that do not touch images do not pay for loading sharp', async () => {
    const dir = await proj();
    const time = async (args: string[]) => {
      const ts: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        await studio([...args, '--project', dir]);
        ts.push(performance.now() - t);
      }
      return ts.sort((a, b) => a - b)[3]!;
    };
    const tools = await time(['tools']);
    const proc = await time(['project', 'show']);
    const models = await time(['models', 'list']);
    console.log(
      `P3 startup medians: tools ${tools.toFixed(0)} ms, project show ${proc.toFixed(0)} ms, models list ${models.toFixed(0)} ms`,
    );
    expect(tools).toBeLessThan(300);
    expect(proc).toBeLessThan(300);
  }, 120_000);
});

describe('tools registry after P3', () => {
  it('lists the image and models commands and no stubs for later phases', async () => {
    const r = await studio(['tools']);
    const names: string[] = r.json.data.commands.map((c: any) => c.name);
    for (const n of [
      'image resize',
      'image batch',
      'image convert',
      'image bgremove',
      'image upscale',
      'image grade',
      'image thumbnail',
      'models list',
      'models fetch',
    ])
      expect(names).toContain(n);
    for (const absent of ['captions transcribe', 'video broll'])
      expect(names).not.toContain(absent);
  });
});
