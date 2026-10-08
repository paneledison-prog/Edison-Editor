import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFilter, gradeImage, type GradeOptions } from '@studio/engines/images';
import { tmpDir } from './helpers.js';

let dir: string;
const P = (n: string) => join(dir, n);
const solid = (name: string, r: number, g: number, b: number, size = 32) =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
    .png()
    .toFile(P(name));
const rgb = async (f: string, x = 16, y = 16) => {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
};
const run = async (src: string, o: GradeOptions, name = 'out.png') => {
  const r = await gradeImage(P(src), P(name), o);
  return { r, px: await rgb(P(name)) };
};
const near = (a: number, b: number, tol = 2) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const chroma = (p: number[]) => Math.max(...p) - Math.min(...p);

beforeAll(async () => {
  dir = tmpDir('studio-grade-');
  await solid('g128.png', 128, 128, 128);
  await solid('g192.png', 192, 192, 192);
  await solid('g64.png', 64, 64, 64);
  await solid('g240.png', 240, 240, 240);
  await solid('black.png', 0, 0, 0);
  await solid('white.png', 255, 255, 255);
  await solid('orange.png', 230, 120, 40);
  await solid('muted.png', 150, 130, 120);
  await solid('vivid.png', 230, 60, 20);
});

describe('parametric adjustments match their documented formulas', () => {
  it('exposure is in stops of linear light (gamma 2.2 model)', async () => {
    const up = (await run('g128.png', { exposure: 1 })).px;
    const down = (await run('g128.png', { exposure: -1 })).px;
    console.log(`GRADE exposure +1: 128 -> ${up}, -1: 128 -> ${down} (expected about 176 and 94)`);
    near(up[0]!, 176);
    near(down[0]!, 94);
    expect(up[0]).toBe(up[1]);
  });

  it('contrast pivots on mid-gray; -100 flattens to 128', async () => {
    near((await run('g192.png', { contrast: 50 })).px[0]!, 224); // (0.753-0.5)*1.5+0.5 = 0.88
    near((await run('g64.png', { contrast: 50 })).px[0]!, 32); // (0.251-0.5)*1.5+0.5 = 0.127
    const flat = (await run('g192.png', { contrast: -100 })).px;
    near(flat[0]!, 128, 1);
  });

  it('temperature moves red and blue in opposite directions, tint moves green', async () => {
    const warm = (await run('g128.png', { temperature: 100 })).px;
    near(warm[0]!, 147);
    near(warm[2]!, 109);
    near(warm[1]!, 128, 1);
    const cool = (await run('g128.png', { temperature: -100 })).px;
    expect(cool[0]!).toBeLessThan(cool[2]!);
    near((await run('g128.png', { tint: 100 })).px[1]!, 115); // magenta: less green
    near((await run('g128.png', { tint: -100 })).px[1]!, 141);
  });

  it('shadows lift dark tones and highlights pull bright tones, and black and white never move', async () => {
    near((await run('g64.png', { shadows: 100 })).px[0]!, 125);
    near((await run('g192.png', { highlights: -100 })).px[0]!, 131);
    for (const o of [
      { shadows: 100 },
      { shadows: -100 },
      { highlights: 100 },
      { highlights: -100 },
      { contrast: 30, shadows: 60, highlights: -60 },
    ]) {
      near((await run('black.png', o)).px[0]!, 0, 1);
      near((await run('white.png', o)).px[0]!, 255, 1);
    }
  });

  it('saturation -100 is monochrome, +50 raises chroma; vibrance helps muted colours more than vivid ones', async () => {
    const mono = (await run('orange.png', { saturation: -100 })).px;
    expect(chroma(mono)).toBeLessThanOrEqual(3);
    const more = (await run('orange.png', { saturation: 50 })).px;
    expect(chroma(more)).toBeGreaterThan(chroma([230, 120, 40]));
    const m0 = chroma([150, 130, 120]),
      v0 = chroma([230, 60, 20]);
    const m1 = chroma((await run('muted.png', { vibrance: 100 })).px),
      v1 = chroma((await run('vivid.png', { vibrance: 100 })).px);
    console.log(
      `GRADE vibrance: muted chroma ${m0} -> ${m1} (x${(m1 / m0).toFixed(2)}), vivid ${v0} -> ${v1} (x${(v1 / v0).toFixed(2)})`,
    );
    expect(m1 / m0).toBeGreaterThan(v1 / v0);
  });

  it('runs operations in the documented order and reports it', async () => {
    const { r } = await run('orange.png', {
      exposure: 0.3,
      temperature: 10,
      contrast: 10,
      highlights: 5,
      saturation: 10,
      vibrance: 10,
      sharpen: 1,
      grain: 2,
    });
    expect(r.order).toEqual([
      'exposure',
      'white balance',
      'contrast',
      'highlights/shadows',
      'saturation',
      'vibrance',
      'sharpen',
      'grain',
    ]);
    const g = buildFilter({ exposure: 1, saturation: 20, sharpen: 1, grain: 3 }).graph;
    expect(g.indexOf('lutrgb')).toBeLessThan(g.indexOf('eq='));
    expect(g.indexOf('eq=')).toBeLessThan(g.indexOf('unsharp'));
    expect(g.indexOf('unsharp')).toBeLessThan(g.indexOf('noise'));
  });
});

describe('measurement and warnings', () => {
  it('reports luma and clipping before and after, and warns when highlights clip', async () => {
    const { r } = await run('g240.png', { exposure: 2 });
    expect(r.before.clippedHighlightsPct).toBe(0);
    expect(r.after.clippedHighlightsPct).toBe(100);
    expect(r.after.meanLuma).toBeGreaterThan(r.before.meanLuma);
    expect(r.warnings.join()).toMatch(/clipped highlights rose from 0% to 100%/);
    const dark = (await run('g64.png', { contrast: 100 })).r; // (0.25-0.5)*2+0.5 is about 0: shadows crushed
    expect(dark.after.clippedShadowsPct).toBe(100);
    expect(dark.warnings.join()).toMatch(/clipped shadows rose from 0% to 100%/);
  });

  it('rejects out-of-range values with the allowed range instead of clamping', async () => {
    await expect(gradeImage(P('g128.png'), P('x.png'), { exposure: 9 })).rejects.toThrow(
      /exposure must be between -5 and 5/,
    );
    await expect(gradeImage(P('g128.png'), P('x.png'), { contrast: 150 })).rejects.toThrow(
      /contrast must be between -100 and 100/,
    );
    await expect(gradeImage(P('g128.png'), P('x.png'), { grain: 100 })).rejects.toThrow(
      /grain must be between 0 and 40/,
    );
  });

  it('says so when nothing was requested, and writes a before/after image on request', async () => {
    const r = await gradeImage(P('orange.png'), P('n.png'), {}, { beforeAfter: P('ba.png') });
    expect(r.warnings.join()).toMatch(/no adjustment was requested/);
    const m = await sharp(P('ba.png')).metadata();
    expect(m.width).toBe(32 * 2 + 8);
  });
});

describe('LUTs, grain, sharpen, alpha, match', () => {
  const invertCube = () => {
    const lines = ['TITLE "invert"', 'LUT_3D_SIZE 2'];
    for (const b of [0, 1])
      for (const g of [0, 1]) for (const r of [0, 1]) lines.push(`${1 - r} ${1 - g} ${1 - b}`);
    writeFileSync(P('invert.cube'), lines.join('\n') + '\n');
    return P('invert.cube');
  };

  it('applies a 3D LUT; requires a declared input space; refuses a log LUT on an sRGB image', async () => {
    const lut = invertCube();
    await solid('c.png', 200, 50, 100);
    const px = (await run('c.png', { lut, lutSpace: 'srgb' })).px;
    near(px[0]!, 55, 3);
    near(px[1]!, 205, 3);
    near(px[2]!, 155, 3);
    await expect(gradeImage(P('c.png'), P('x.png'), { lut })).rejects.toThrow(
      /must declare the colour space/,
    );
    await expect(gradeImage(P('c.png'), P('x.png'), { lut, lutSpace: 'slog3' })).rejects.toThrow(
      /expects slog3 input, but the image is sRGB/,
    );
    writeFileSync(P('Rec709_to_LogC.cube'), readFileSync(lut));
    await expect(
      gradeImage(P('c.png'), P('x.png'), { lut: P('Rec709_to_LogC.cube'), lutSpace: 'rec709' }),
    ).rejects.toThrow(/log space \(from its name\)/);
    writeFileSync(P('bad.cube'), 'not a lut');
    await expect(
      gradeImage(P('c.png'), P('x.png'), { lut: P('bad.cube'), lutSpace: 'srgb' }),
    ).rejects.toThrow(/not a 3D .cube LUT/);
    expect(
      (await gradeImage(P('c.png'), P('x.png'), { lut, lutSpace: 'rec709' })).warnings.join(),
    ).toMatch(/Rec\.709 LUT applied to an sRGB image/);
  });

  it('grain is seeded: identical bytes on repeat, and it really changes pixels', async () => {
    await gradeImage(P('g128.png'), P('gr1.png'), { grain: 10 });
    await gradeImage(P('g128.png'), P('gr2.png'), { grain: 10 });
    const h = (f: string) =>
      createHash('sha256')
        .update(readFileSync(P(f)))
        .digest('hex');
    expect(h('gr1.png')).toBe(h('gr2.png'));
    const s = (await sharp(P('gr1.png')).stats()).channels[0]!;
    expect(s.stdev).toBeGreaterThan(2);
    await gradeImage(P('g128.png'), P('flat1.png'), { exposure: 0.2 });
    await gradeImage(P('g128.png'), P('flat2.png'), { exposure: 0.2 });
    expect(h('flat1.png')).toBe(h('flat2.png')); // no grain: deterministic too
  });

  it('sharpen raises local contrast at an edge', async () => {
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#404040' } })
      .composite([
        {
          input: { create: { width: 32, height: 64, channels: 3, background: '#c0c0c0' } },
          left: 32,
          top: 0,
        },
      ])
      .png()
      .toFile(P('edge.png'));
    await gradeImage(P('edge.png'), P('edge-s.png'), { sharpen: 2 });
    const before = await rgb(P('edge.png'), 30, 10);
    const after = await rgb(P('edge-s.png'), 30, 10);
    const afterR = await rgb(P('edge-s.png'), 33, 10);
    expect(after[0]!).toBeLessThan(before[0]!); // overshoot on the dark side of the edge
    expect(afterR[0]!).toBeGreaterThan(0xc0);
  });

  it('keeps the alpha channel through grading', async () => {
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 100, g: 100, b: 100, alpha: 0.5 },
      },
    })
      .png()
      .toFile(P('a.png'));
    await gradeImage(P('a.png'), P('a-out.png'), { exposure: 1 });
    const m = await sharp(P('a-out.png')).metadata();
    expect(m.hasAlpha).toBe(true);
    const { data } = await sharp(P('a-out.png')).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[3]! - 128)).toBeLessThanOrEqual(1);
  });

  it('match moves channel means toward a reference and reports the remaining difference', async () => {
    await solid('in.png', 120, 100, 80);
    await solid('ref.png', 100, 120, 140);
    const r = await gradeImage(P('in.png'), P('m.png'), { match: P('ref.png') });
    const [mr, mg, mb] = (await rgb(P('m.png'))).map(Number);
    console.log(
      `GRADE match: input 120,100,80 -> ${mr},${mg},${mb} (reference 100,120,140); delta before ${r.match!.delta.before} after ${r.match!.delta.after}`,
    );
    near(mr!, 100, 3);
    near(mg!, 120, 3);
    near(mb!, 140, 3);
    expect(r.order).toContain('match');
    expect(Math.max(...r.match!.delta.after.map(Math.abs))).toBeLessThan(
      Math.max(...r.match!.delta.before.map(Math.abs)),
    );
    expect(r.warnings.join()).toMatch(/one gain per channel so the channel means line up/);
  });
});
