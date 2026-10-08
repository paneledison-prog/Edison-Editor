import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { EngineError } from './run.js';

export interface ThumbnailOptions {
  /** the picture behind everything: a video frame or a photo */
  image: string;
  headline: string;
  /** a cutout PNG with alpha (see `studio image bgremove`) */
  subject?: string;
  size?: { w: number; h: number };
  /** where the headline goes; the subject takes the other side */
  textSide?: 'left' | 'right';
  /** font file (OTF or TTF); a missing font fails the render rather than substituting another */
  font: string;
  palette?: { text?: string; scrim?: string };
  smart?: 'attention' | 'entropy';
  format?: 'jpeg' | 'png';
  /** size budget in bytes (default 2 MB, the YouTube limit for custom thumbnails) */
  maxBytes?: number;
}

export interface ThumbnailReport {
  output: string;
  legibility: string;
  width: number;
  height: number;
  bytes: number;
  quality?: number;
  layout: {
    marginPx: { x: number; y: number };
    textBox: { x: number; y: number; w: number; h: number };
    subjectBox?: { x: number; y: number; w: number; h: number };
    fontSizePt: number;
    lines: number;
    textColor: string;
    scrimOpacity: number;
  };
  checks: { id: string; pass: boolean; value: string; expected: string }[];
  /** why the layout is what it is, in one place (rules/04: one variant, with the reasons) */
  reasons: string[];
  warnings: string[];
}

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) throw new EngineError('INVALID_INPUT', `colour must be #rrggbb, got "${h}"`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as [number, number, number];
};
const lum = ([r, g, b]: number[]) => {
  const c = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!);
};
export const contrastRatio = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const escapeMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fontFace(file: string): { family: string; style: string } {
  if (!existsSync(file))
    throw new EngineError(
      'INVALID_INPUT',
      `font file not found: ${file}`,
      'pass --font <file.ttf|otf>, or put a font in brand/fonts/',
    );
  try {
    const out = execFileSync('fc-scan', ['--format', '%{family[0]}|%{style[0]}\n', file], {
      encoding: 'utf8',
    }).split('\n')[0]!;
    const [family, style] = out.split('|');
    if (!family) throw new Error('no family');
    return { family, style: style ?? 'Regular' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new EngineError(
        'ENGINE_MISSING',
        'fc-scan (fontconfig) is needed to read font names',
        'install fontconfig',
      );
    throw new EngineError('INVALID_INPUT', `${basename(file)} is not a readable font file`);
  }
}

/**
 * Worst-case contrast of `text` over a region: the region is averaged into a 4x4 grid, each cell is blended with the scrim,
 * and the lowest ratio wins. A mean over the whole region would hide a bright patch behind part of the headline.
 */
async function worstContrast(
  region: Buffer,
  text: number[],
  scrim: number[],
  alpha: number,
): Promise<number> {
  const { data } = await sharp(region)
    .resize(4, 4, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let worst = Infinity;
  for (let i = 0; i < 16; i++) {
    const cell = [0, 1, 2].map((k) => data[i * 3 + k]! * (1 - alpha) + scrim[k]! * alpha);
    worst = Math.min(worst, contrastRatio(text, cell));
  }
  return worst;
}

/**
 * One thumbnail with the reasons for its layout. The headline is rendered with sharp's text engine until Phase 4's motion
 * engine (Remotion stills) takes over text, so fonts and tokens will then be shared with video.
 */
export async function makeThumbnail(out: string, o: ThumbnailOptions): Promise<ThumbnailReport> {
  const { w: W, h: H } = o.size ?? { w: 1280, h: 720 };
  const words = o.headline.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new EngineError('INVALID_INPUT', 'the headline is empty');
  if (words.length > 5)
    throw new EngineError(
      'INVALID_INPUT',
      `the headline is ${words.length} words; keep it to 5 or fewer so it reads at small sizes`,
      'shorten it, e.g. to the one idea the viewer should remember',
    );
  if (!existsSync(o.image)) throw new EngineError('INVALID_INPUT', `${o.image}: not found`);
  const face = fontFace(o.font);
  const side = o.textSide ?? 'left';
  const reasons: string[] = [];
  const warnings: string[] = [];
  const checks: ThumbnailReport['checks'] = [];

  const mx = Math.ceil(W * 0.05);
  const my = Math.ceil(H * 0.05);
  const gap = Math.round(W * 0.02);

  const base = await sharp(o.image, { failOn: 'error' })
    .rotate()
    .toColourspace('srgb')
    .removeAlpha()
    .resize(W, H, {
      fit: 'cover',
      kernel: 'lanczos3',
      position:
        o.smart === 'attention'
          ? sharp.strategy.attention
          : o.smart === 'entropy'
            ? sharp.strategy.entropy
            : 'centre',
    })
    .png()
    .toBuffer()
    .catch((e) => {
      throw new EngineError('UNSUPPORTED_INPUT', `${basename(o.image)}: ${(e as Error).message}`);
    });
  reasons.push(
    o.smart
      ? `background cropped with ${o.smart} cropping because you asked for it`
      : 'background cropped from the center (no smart cropping unless asked)',
  );

  const textW = Math.round(o.subject ? W * 0.5 - mx : W * 0.7 - mx);
  const textX = side === 'left' ? mx : W - mx - textW;
  const maxTextH = H - 2 * my;
  const pad = Math.round(H * 0.035);

  // Largest font size whose rendered headline fits the box in at most 3 lines.
  const textColor0 = hexToRgb(o.palette?.text ?? '#ffffff');
  const render = async (size: number, color: string) =>
    sharp({
      text: {
        text: `<span foreground="${color}">${escapeMarkup(words.join(' '))}</span>`,
        font: `${face.family} ${face.style} ${size}`,
        fontfile: o.font,
        width: textW - 2 * pad,
        rgba: true,
        wrap: 'word',
        align: side === 'left' ? 'left' : 'right',
        spacing: 0,
      },
    })
      .png()
      .toBuffer();
  let size = Math.round(H * 0.22);
  let textImg = await render(size, o.palette?.text ?? '#ffffff');
  let tm = await sharp(textImg).metadata();
  const lineH = () => Math.round(size * 1.25);
  while (
    (tm.height! > maxTextH - 2 * pad ||
      tm.width! > textW - 2 * pad ||
      Math.round(tm.height! / lineH()) > 3) &&
    size > 12
  ) {
    size = Math.floor(size * 0.92);
    textImg = await render(size, o.palette?.text ?? '#ffffff');
    tm = await sharp(textImg).metadata();
  }
  const lines = Math.max(1, Math.round(tm.height! / lineH()));
  reasons.push(
    `headline set at ${size} pt on ${lines} line(s): the largest size that fits ${textW - 2 * pad}x${maxTextH - 2 * pad} px in at most 3 lines`,
  );

  const boxW = tm.width! + 2 * pad;
  const boxH = tm.height! + 2 * pad;
  const boxX = side === 'left' ? textX : W - mx - boxW;
  const boxY = Math.round((H - boxH) / 2);

  // Subject: bottom-aligned inside the margins, on the side opposite the text, never overlapping the text box.
  let subjectBox: ThumbnailReport['layout']['subjectBox'];
  let subjectBuf: Buffer | undefined;
  let subjectBleeds = false;
  if (o.subject) {
    if (!existsSync(o.subject)) throw new EngineError('INVALID_INPUT', `${o.subject}: not found`);
    const sm = await sharp(o.subject).metadata();
    if (!sm.hasAlpha)
      warnings.push(
        'the subject image has no alpha channel; it will be placed as a rectangle (cut it out with `studio image bgremove` first)',
      );
    // A cutout that was cropped by its source frame at the bottom (opaque along the bottom edge) is a portrait crop:
    // it runs off the bottom of the thumbnail. Floating it above the edge would look like a hovering torso.
    let bleedBottom = false;
    if (sm.hasAlpha) {
      const a = await sharp(o.subject).rotate().extractChannel(3).png().toBuffer();
      const am = await sharp(a).metadata();
      const t = Math.max(2, Math.round(am.height! * 0.01));
      const bottom = await sharp(a)
        .extract({ left: 0, top: am.height! - t, width: am.width!, height: t })
        .png()
        .toBuffer();
      bleedBottom = (await sharp(bottom).stats()).channels[0]!.mean / 255 > 0.5;
    }
    const availW = W - 2 * mx - boxW - gap;
    const availH = H - my - (bleedBottom ? 0 : my);
    const k = Math.min(availW / sm.width!, availH / sm.height!);
    const sw = Math.max(1, Math.round(sm.width! * k));
    const sh = Math.max(1, Math.round(sm.height! * k));
    subjectBuf = await sharp(o.subject)
      .rotate()
      .toColourspace('srgb')
      .resize(sw, sh, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const sx = side === 'left' ? W - mx - sw : mx;
    subjectBox = { x: sx, y: bleedBottom ? H - sh : H - my - sh, w: sw, h: sh };
    subjectBleeds = bleedBottom;
    reasons.push(
      `subject placed on the ${side === 'left' ? 'right' : 'left'}, scaled to fit beside the headline without overlap (${sw}x${sh} px)` +
        (bleedBottom
          ? '; it is cut off at its bottom edge, so it runs off the bottom of the frame instead of floating above it'
          : '; bottom-aligned inside the margin'),
    );
  }

  // Scrim opacity: raise until the worst cell behind the headline has at least 4.5:1, else switch text colour.
  const region = await sharp(base)
    .extract({ left: boxX, top: boxY, width: boxW, height: boxH })
    .png()
    .toBuffer();
  const scrimRgb = hexToRgb(o.palette?.scrim ?? '#000000');
  let alpha = 0.4;
  let textRgb = textColor0;
  let ratio = await worstContrast(region, textRgb, scrimRgb, alpha);
  while (ratio < 4.5 && alpha < 0.9) {
    alpha = Math.round((alpha + 0.05) * 100) / 100;
    ratio = await worstContrast(region, textRgb, scrimRgb, alpha);
  }
  let textHex = o.palette?.text ?? '#ffffff';
  if (ratio < 4.5) {
    for (const alt of ['#ffffff', '#000000']) {
      const r = await worstContrast(region, hexToRgb(alt), scrimRgb, alpha);
      if (r > ratio) {
        ratio = r;
        textHex = alt;
        textRgb = hexToRgb(alt);
      }
    }
    if (textHex !== (o.palette?.text ?? '#ffffff')) {
      textImg = await render(size, textHex);
      reasons.push(
        `text colour switched to ${textHex}: the palette colour could not reach 4.5:1 even at 90% scrim`,
      );
    }
  }
  reasons.push(
    `scrim at ${Math.round(alpha * 100)}% opacity: worst-case contrast ${ratio.toFixed(2)}:1 over a 4x4 grid of the area behind the text`,
  );
  checks.push({
    id: 'text-contrast',
    pass: ratio >= 4.5,
    value: `${ratio.toFixed(2)}:1 (worst of 16 cells)`,
    expected: '>= 4.5:1',
  });
  if (ratio < 4.5)
    warnings.push(
      `the headline reaches only ${ratio.toFixed(2)}:1 contrast; choose a calmer part of the picture (--smart, another frame) or a shorter headline`,
    );

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}"><rect width="${boxW}" height="${boxH}" rx="${Math.round(pad * 0.6)}" fill="rgb(${scrimRgb.join(',')})" fill-opacity="${alpha}"/></svg>`,
  );
  const layers: OverlayOptions[] = [];
  if (subjectBuf) layers.push({ input: subjectBuf, left: subjectBox!.x, top: subjectBox!.y });
  layers.push(
    { input: svg, left: boxX, top: boxY },
    { input: textImg, left: boxX + pad, top: boxY + pad },
  );

  // Geometry checks: margins and overlap are measured, not assumed.
  const inside = (b: { x: number; y: number; w: number; h: number }, bleedBottom = false) =>
    b.x >= mx && b.y >= my && b.x + b.w <= W - mx && b.y + b.h <= (bleedBottom ? H : H - my);
  const textBox = { x: boxX, y: boxY, w: boxW, h: boxH };
  checks.push({
    id: 'safe-margins',
    pass: inside(textBox) && (!subjectBox || inside(subjectBox, subjectBleeds)),
    value: `text box ${boxW}x${boxH} at ${boxX},${boxY}`,
    expected: `inside ${mx}px (5% of width) and ${my}px (5% of height) margins${subjectBleeds ? ' (the cropped subject may run off the bottom)' : ''}`,
  });
  if (subjectBox) {
    const overlap = !(
      subjectBox.x >= boxX + boxW ||
      subjectBox.x + subjectBox.w <= boxX ||
      subjectBox.y >= boxY + boxH ||
      subjectBox.y + subjectBox.h <= boxY
    );
    checks.push({
      id: 'subject-not-covered',
      pass: !overlap,
      value: overlap ? 'text box overlaps the subject' : 'no overlap',
      expected: 'no overlap',
    });
  }

  mkdirSync(dirname(out), { recursive: true });
  const comp = sharp(base).composite(layers);
  const maxBytes = o.maxBytes ?? 2 * 1024 * 1024;
  const fmt = o.format ?? (/\.png$/i.test(out) ? 'png' : 'jpeg');
  let bytes = 0;
  let quality: number | undefined;
  const partial = out + '.partial';
  if (fmt === 'png') {
    bytes = (await comp.png({ compressionLevel: 9 }).toFile(partial)).size;
  } else {
    const flat = await comp.png().toBuffer();
    for (quality = 92; quality >= 60; quality -= 8) {
      bytes = (await sharp(flat).jpeg({ quality, mozjpeg: true }).toFile(partial)).size;
      if (bytes <= maxBytes) break;
    }
  }
  renameSync(partial, out);
  checks.push({
    id: 'file-size',
    pass: bytes <= maxBytes,
    value: `${(bytes / 1024).toFixed(0)} KB`,
    expected: `<= ${(maxBytes / 1024).toFixed(0)} KB`,
  });
  if (bytes > maxBytes)
    warnings.push(
      `file is ${(bytes / 1048576).toFixed(2)} MB, over the ${(maxBytes / 1048576).toFixed(1)} MB budget even at quality ${quality}`,
    );

  // Legibility at 168 px wide, the size of a small suggested-video thumbnail.
  const lw = 168;
  const legPath = out.replace(/\.[a-z]+$/i, '') + '.legibility.png';
  await sharp(out)
    .resize({ width: lw })
    .png()
    .toFile(legPath + '.partial');
  renameSync(legPath + '.partial', legPath);
  const capPx = size * 0.72 * (lw / W); // sharp text renders at 72 dpi, so 1 pt = 1 px; capital height is about 0.72 em
  const xPx = Math.round(capPx * 10) / 10;
  checks.push({
    id: 'legible-at-168px',
    pass: xPx >= 6,
    value: `cap height about ${xPx} px at ${lw} px wide`,
    expected: '>= 6 px, and the contrast above',
  });
  if (xPx < 6)
    warnings.push(
      `at 168 px wide the capitals are about ${xPx} px tall: too small to read; use fewer or shorter words so the type can be larger`,
    );
  reasons.push(
    `legibility copy at ${lw}x${Math.round((H * lw) / W)} written to ${basename(legPath)}: look at it`,
  );

  return {
    output: out,
    legibility: legPath,
    width: W,
    height: H,
    bytes,
    ...(quality !== undefined && fmt === 'jpeg' ? { quality } : {}),
    layout: {
      marginPx: { x: mx, y: my },
      textBox,
      ...(subjectBox ? { subjectBox } : {}),
      fontSizePt: size,
      lines,
      textColor: textHex,
      scrimOpacity: alpha,
    },
    checks,
    reasons,
    warnings,
  };
}
