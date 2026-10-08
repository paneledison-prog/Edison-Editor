import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectImages, outputPath, processImage, runBatch } from '@studio/engines/images';
import { tmpDir } from './helpers.js';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const noise = (w: number, h: number, seed = 0) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 90 + seed, g: 120, b: 150 },
      noise: { type: 'gaussian', mean: 128, sigma: 35 },
    },
  });

let dir: string;
const F = (n: string) => join(dir, n);
beforeAll(async () => {
  dir = tmpDir('studio-img-');
  await noise(1600, 1200).jpeg({ quality: 90 }).toFile(F('photo.jpg'));
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#2060c0' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(F('rot.jpg'));
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#c04020' } })
    .png()
    .toFile(F('small.png'));
  await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toFile(F('alpha.png'));
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 128, b: 0 } },
  })
    .jpeg({ quality: 100 })
    .withIccProfile('p3')
    .toFile(F('p3.jpg'));
  writeFileSync(F('corrupt.jpg'), Buffer.from('definitely not a jpeg'));
  writeFileSync(F('notes.txt'), 'hi');
});

const dims = async (p: string) => {
  const m = await sharp(p).metadata();
  return [m.width, m.height, m.format] as const;
};
const px = async (p: string, x: number, y: number) => {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
};

describe('resize modes', () => {
  it('inside keeps the aspect, cover fills and crops, contain letterboxes on the given background, fill stretches', async () => {
    const out = tmpDir();
    expect(
      (
        await processImage(F('photo.jpg'), join(out, 'a.jpg'), {
          width: 800,
          height: 800,
          mode: 'inside',
        })
      ).outH,
    ).toBe(600);
    expect(await dims(join(out, 'a.jpg'))).toEqual([800, 600, 'jpeg']);
    await processImage(F('photo.jpg'), join(out, 'b.jpg'), {
      width: 500,
      height: 500,
      mode: 'cover',
    });
    expect(await dims(join(out, 'b.jpg'))).toEqual([500, 500, 'jpeg']);
    await processImage(F('photo.jpg'), join(out, 'c.png'), {
      width: 400,
      height: 400,
      mode: 'contain',
      background: '#ff00ff',
      format: 'png',
    });
    expect(await dims(join(out, 'c.png'))).toEqual([400, 400, 'png']);
    expect(await px(join(out, 'c.png'), 5, 2)).toEqual([255, 0, 255]); // letterbox bar is the background colour
    await processImage(F('photo.jpg'), join(out, 'd.jpg'), {
      width: 300,
      height: 300,
      mode: 'fill',
    });
    expect(await dims(join(out, 'd.jpg'))).toEqual([300, 300, 'jpeg']);
    await processImage(F('photo.jpg'), join(out, 'e.jpg'), { width: 400 });
    expect(await dims(join(out, 'e.jpg'))).toEqual([400, 300, 'jpeg']); // width only: height follows
  });

  it('rejects impossible requests with a reason', async () => {
    const out = tmpDir();
    await expect(
      processImage(F('photo.jpg'), join(out, 'x.jpg'), { width: 400, mode: 'cover' }),
    ).rejects.toThrow(/cover needs both width and height/);
    await expect(
      processImage(F('photo.jpg'), join(out, 'x.jpg'), { width: 400, mode: 'contain' }),
    ).rejects.toThrow(/contain needs both/);
    await expect(processImage(F('photo.jpg'), join(out, 'x.jpg'), { width: 0 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      processImage(F('photo.jpg'), join(out, 'x.jpg'), {
        width: 200,
        height: 200,
        mode: 'inside',
        smart: 'attention',
      }),
    ).rejects.toThrow(/only applies to cover/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('never enlarges by default, says the effective size, and enlarges only on request', async () => {
    const out = tmpDir();
    const r = await processImage(F('small.png'), join(out, 'a.png'), {
      width: 400,
      mode: 'inside',
    });
    expect([r.outW, r.outH]).toEqual([100, 80]);
    expect(r.warnings.join()).toMatch(/not enlarged \(effective size 100x80\)/);
    const r2 = await processImage(F('small.png'), join(out, 'b.png'), {
      width: 400,
      mode: 'inside',
      allowEnlarge: true,
    });
    expect([r2.outW, r2.outH]).toEqual([400, 320]);
    // a source wider than the width box but shorter than the height box is a downscale, not an enlargement
    const r3 = await processImage(F('photo.jpg'), join(out, 'c.jpg'), {
      width: 800,
      height: 2000,
      mode: 'inside',
    });
    expect([r3.outW, r3.outH]).toEqual([800, 600]);
    expect(r3.warnings).toEqual([]);
    const r4 = await processImage(F('small.png'), join(out, 'd.png'), {
      width: 200,
      height: 200,
      mode: 'cover',
    });
    expect(r4.warnings.join()).toMatch(/effective resolution stays 100x80/);
  });
});

describe('colour, orientation, metadata', () => {
  it('applies EXIF orientation and drops the orientation tag', async () => {
    const out = tmpDir();
    const r = await processImage(F('rot.jpg'), join(out, 'a.jpg'), {});
    expect([r.inW, r.inH, r.outW, r.outH]).toEqual([200, 400, 200, 400]); // 400x200 stored, rotated by tag 6
    const m = await sharp(join(out, 'a.jpg')).metadata();
    expect([m.width, m.height, m.orientation]).toEqual([200, 400, undefined]);
  });

  it('converts an embedded profile to sRGB, strips it, and warns', async () => {
    const out = tmpDir();
    const r = await processImage(F('p3.jpg'), join(out, 'a.jpg'), { quality: 100 });
    expect(r.warnings.join()).toMatch(/embedded ICC profile; converted to sRGB/);
    const m = await sharp(join(out, 'a.jpg')).metadata();
    expect(m.icc).toBeUndefined();
    // Read the stored pixel with a decoder that ignores ICC profiles (Pillow): that is the P3-encoded value.
    const rawPx = (f: string) =>
      JSON.parse(
        spawnSync(
          'python3',
          [
            '-I',
            '-c',
            `import json,sys;from PIL import Image;print(json.dumps(Image.open(sys.argv[1]).convert('RGB').getpixel((10,10))))`,
            f,
          ],
          { encoding: 'utf8' },
        ).stdout,
      ) as number[];
    const stored = rawPx(F('p3.jpg'));
    const converted = rawPx(join(out, 'a.jpg'));
    console.log(
      `ICC stored P3 value ${stored} -> output sRGB value ${converted} (the image was made from sRGB 255,128,0)`,
    );
    // The file stores P3 numbers for what was sRGB (255,128,0); after conversion the numbers are sRGB again.
    expect(
      Math.abs(converted[0]! - 255) + Math.abs(converted[1]! - 128) + Math.abs(converted[2]! - 0),
    ).toBeLessThanOrEqual(8);
    expect(
      Math.abs(stored[0]! - converted[0]!) +
        Math.abs(stored[1]! - converted[1]!) +
        Math.abs(stored[2]! - converted[2]!),
    ).toBeGreaterThan(8);
  });

  it('flattens alpha onto white for JPEG and keeps it for PNG and WebP', async () => {
    const out = tmpDir();
    await processImage(F('alpha.png'), join(out, 'a.jpg'), { format: 'jpeg' });
    const [r, g] = await px(join(out, 'a.jpg'), 10, 10);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(110); // 50% red over white: green about 128
    expect(g).toBeLessThan(145);
    await processImage(F('alpha.png'), join(out, 'a.png'), {});
    expect((await sharp(join(out, 'a.png')).metadata()).hasAlpha).toBe(true);
    await processImage(F('alpha.png'), join(out, 'a.webp'), { format: 'webp' });
    expect((await sharp(join(out, 'a.webp')).metadata()).hasAlpha).toBe(true);
  });
});

describe('formats', () => {
  it('writes jpeg, webp, avif, and png, and smaller files for lower quality', async () => {
    const out = tmpDir();
    for (const f of ['jpeg', 'webp', 'avif', 'png'] as const) {
      const r = await processImage(F('photo.jpg'), join(out, `o.${f}`), { width: 400, format: f });
      expect((await sharp(join(out, `o.${f}`)).metadata()).format).toBe(f === 'avif' ? 'heif' : f);
      expect(r.outBytes).toBeGreaterThan(500);
    }
    const hi = await processImage(F('photo.jpg'), join(out, 'q95.jpg'), {
      width: 600,
      quality: 95,
    });
    const lo = await processImage(F('photo.jpg'), join(out, 'q40.jpg'), {
      width: 600,
      quality: 40,
    });
    expect(lo.outBytes).toBeLessThan(hi.outBytes);
  });

  it('is deterministic: the same input and parameters give identical bytes', async () => {
    const out = tmpDir();
    await processImage(F('photo.jpg'), join(out, 'a.jpg'), { width: 640, sharpen: true });
    await processImage(F('photo.jpg'), join(out, 'b.jpg'), { width: 640, sharpen: true });
    expect(sha(join(out, 'a.jpg'))).toBe(sha(join(out, 'b.jpg')));
  });
});

describe('safety', () => {
  it('leaves the source untouched, no partial files, and a clear error for corrupt input', async () => {
    const before = sha(F('photo.jpg'));
    const out = tmpDir();
    await processImage(F('photo.jpg'), join(out, 'a.jpg'), { width: 100 });
    expect(sha(F('photo.jpg'))).toBe(before);
    await expect(
      processImage(F('corrupt.jpg'), join(out, 'bad.jpg'), { width: 100 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    expect(readdirSync(out)).toEqual(['a.jpg']);
  });

  it('batch refuses to write into assets/ and refuses to overwrite a source', async () => {
    const proj = tmpDir();
    mkdirSync(join(proj, 'assets'), { recursive: true });
    await expect(
      runBatch([F('photo.jpg')], {
        outDir: join(proj, 'assets', 'x'),
        projectDir: proj,
        width: 100,
      }),
    ).rejects.toThrow(/must not be written into assets/);
  });
});

describe('batch', () => {
  it('collects folders recursively in sorted order and counts what it ignores', () => {
    const root = tmpDir();
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'b.png'), 'x');
    writeFileSync(join(root, 'a.jpg'), 'x');
    writeFileSync(join(root, 'sub', 'c.webp'), 'x');
    writeFileSync(join(root, 'readme.md'), 'x');
    writeFileSync(join(root, '.hidden.png'), 'x');
    const r = collectImages([root]);
    expect(r.files.map((f) => f.rel)).toEqual(['a.jpg', 'b.png', join('sub', 'c.webp')]);
    expect(r.skipped).toHaveLength(1);
  });

  it('keeps going past a bad file, reports the reason, then resumes: unchanged inputs are skipped, a changed one is redone', async () => {
    const root = tmpDir();
    const proj = tmpDir();
    mkdirSync(join(root, 'sub'), { recursive: true });
    for (let i = 0; i < 12; i++)
      await noise(400, 300, i)
        .jpeg()
        .toFile(join(root, i % 3 ? 'sub' : '.', `img${i}.jpg`));
    writeFileSync(join(root, 'broken.jpg'), 'nope');
    const opts = { outDir: join(proj, 'renders', 'images', 't'), projectDir: proj, width: 100 };
    const a = await runBatch([root], opts);
    expect(a).toMatchObject({ total: 13, processed: 12, skippedUpToDate: 0 });
    expect(a.failed).toHaveLength(1);
    expect(a.failed[0]!.file).toMatch(/broken\.jpg$/);
    expect(a.failed[0]!.code).toBe('UNSUPPORTED_INPUT');
    expect(existsSync(outputPath(opts.outDir, join('sub', 'img1.jpg'), { width: 100 }))).toBe(true); // folders kept
    const b = await runBatch([root], opts);
    expect(b).toMatchObject({ processed: 0, skippedUpToDate: 12 });
    await noise(400, 300, 99).jpeg().toFile(join(root, 'img0.jpg'));
    const c = await runBatch([root], opts);
    expect(c).toMatchObject({ processed: 1, skippedUpToDate: 11 });
    const d = await runBatch([root], { ...opts, width: 50 }); // different parameters: nothing is reused
    expect(d.processed).toBe(12);
    expect(readdirSync(join(opts.outDir)).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('refuses two inputs that would write the same output', async () => {
    const a = tmpDir();
    const b = tmpDir();
    await noise(50, 50).jpeg().toFile(join(a, 'same.jpg'));
    await noise(50, 50, 5).jpeg().toFile(join(b, 'same.jpg'));
    await expect(
      runBatch([join(a, 'same.jpg'), join(b, 'same.jpg')], {
        outDir: tmpDir(),
        projectDir: tmpDir(),
        width: 20,
      }),
    ).rejects.toThrow(/would both write/);
  });

  it('a corrupted output is detected and redone on resume', async () => {
    const root = tmpDir();
    const proj = tmpDir();
    await noise(300, 200).jpeg().toFile(join(root, 'a.jpg'));
    const opts = { outDir: join(proj, 'out'), projectDir: proj, width: 80 };
    await runBatch([root], opts);
    const out = outputPath(opts.outDir, 'a.jpg', { width: 80 });
    writeFileSync(out, 'truncated'); // size no longer matches the manifest
    const r = await runBatch([root], opts);
    expect(r.processed).toBe(1);
    expect((await sharp(out).metadata()).width).toBe(80);
  });
});
