import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { contrastRatio, speedOf, toAss, toSrt, toVtt, type Clip } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, runSpecs, store, str } from './shared.js';

const rel = (inv: Invocation, p: string) =>
  p.startsWith(inv.dir + '/') ? p.slice(inv.dir.length + 1) : p;
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, '-');

export const transcribe: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const target = inv.positionals[0];
  if (!target)
    throw new CliError(
      'INVALID_ARGS',
      'name an asset id (a_xxxx) or a media file',
      2,
      'studio transcribe <asset|file> [--model whisper-small]',
    );
  let src: string;
  let assetId: string | undefined;
  let cacheDir: string;
  if (/^a_[0-9a-z]{2,16}$/.test(target)) {
    const { project } = store(inv).load();
    const a = project.assets[target];
    if (!a)
      throw new CliError(
        'INVALID_ARGS',
        `asset ${target} not found`,
        2,
        'studio project show lists assets',
      );
    if (!a.probe.audio)
      throw new CliError(
        'UNSUPPORTED_INPUT',
        `asset ${target} has no audio stream`,
        2,
        'pick an asset with audio',
      );
    src = join(inv.dir, a.workingCopy?.path ?? a.path);
    assetId = target;
    cacheDir = E.cacheDir(inv.dir, a.hash.split(':')[1]!);
  } else {
    src = resolve(inv.dir, target);
    if (!existsSync(src)) throw new CliError('INVALID_ARGS', `file ${target} does not exist`);
    const h = await E.hashFile(src);
    assetId = undefined;
    cacheDir = E.cacheDir(inv.dir, h.hex);
  }
  const model = str(inv, 'model') ?? 'whisper-small';
  const derivedRel =
    str(inv, 'out') ??
    join('transcripts', `${assetId ?? slug(target.replace(/\.[^.]+$/, ''))}.${model}.json`);
  if (inv.dryRun) return { data: { wouldTranscribe: target, model, derived: derivedRel } };
  const r = await E.transcribe({
    projectDir: inv.dir,
    src,
    cacheDir,
    assetId,
    model,
    language: str(inv, 'language'),
    force: inv.force,
    derivedRel,
    log: inv.log,
  });
  const d = r.derived;
  const warnings: string[] = [];
  if (d.flags.review.length)
    warnings.push(
      `${d.flags.review.length} low-confidence word(s) flagged for review (probability < ${E.LOW_CONF}): a person should check names and numbers`,
    );
  if (d.flags.noSpeech.length)
    warnings.push(
      `${d.flags.noSpeech.length} segment(s) have no detected speech under them and were excluded from captions (likely hallucination)`,
    );
  if (d.glossary.fixes.length)
    warnings.push(`${d.glossary.fixes.length} glossary correction(s) applied`);
  return {
    data: {
      transcript: derivedRel,
      raw: r.rawRel,
      rawCached: r.cached,
      model: d.source.model,
      language: r.raw.language,
      languageProbability: r.raw.languageProbability,
      engine: d.source.engine,
      audioSeconds: d.source.audioSeconds,
      tookSeconds: d.source.tookSeconds,
      realtimeFactor: d.source.realtimeFactor,
      words: d.words.length,
      speechSpans: r.raw.vad.speech.length,
      review: d.flags.review.slice(0, 50),
      noSpeech: d.flags.noSpeech,
      glossaryFixes: d.glossary.fixes,
    },
    warnings,
    artifacts: [{ kind: 'transcript', path: derivedRel }],
  };
};

async function loadTranscript(inv: Invocation, p: string | undefined) {
  if (!p)
    throw new CliError(
      'INVALID_ARGS',
      'missing --transcript',
      2,
      'studio transcribe <asset> writes transcripts/<asset>.<model>.json',
    );
  const E = await import('@studio/engines');
  const t = E.readJson<import('@studio/engines').DerivedTranscript>(
    resolve(inv.dir, p),
    'transcript',
  );
  if (t.kind !== 'derived') throw new CliError('INVALID_ARGS', `${p} is not a derived transcript`);
  return t;
}

export const build: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const transcriptRel = str(inv, 'transcript');
  const t = await loadTranscript(inv, transcriptRel);
  const hasProject = existsSync(join(inv.dir, 'project.studio.json'));
  const project = hasProject ? store(inv).load().project : undefined;
  let clip: import('@studio/engines').BuildOptions['clip'];
  const clipId = str(inv, 'clip');
  let clips: Clip[] = [];
  if (project && t.asset) clips = project.clips.filter((c) => c.asset === t.asset);
  if (clipId) {
    const c = project?.clips.find((x) => x.id === clipId);
    if (!c?.asset) throw new CliError('INVALID_ARGS', `clip ${clipId} is not a media clip`);
    if (t.asset && c.asset !== t.asset)
      throw new CliError(
        'INVALID_ARGS',
        `clip ${clipId} uses ${c.asset}, but the transcript is for ${t.asset}`,
      );
    clip = { id: c.id, start: c.start, dur: c.dur, srcIn: c.srcIn, speed: speedOf(c) };
  } else if (clips.length === 1) {
    const c = clips[0]!;
    clip = { id: c.id, start: c.start, dur: c.dur, srcIn: c.srcIn, speed: speedOf(c) };
    inv.log(`placing captions through clip ${c.id} (the only clip of ${t.asset})`);
  } else if (clips.length > 1)
    throw new CliError(
      'INVALID_ARGS',
      `${t.asset} is used by ${clips.length} clips (${clips.map((c) => c.id).join(', ')}); pick one with --clip`,
      2,
      'studio captions build --transcript T --clip c_xx',
    );
  const fps = num(inv, 'fps') ?? project?.meta.fps ?? 30;
  const style = (str(inv, 'style') ?? 'clean') as import('@studio/engines').CaptionStyle;
  const limits: Partial<import('@studio/core').CueLimits> = {};
  if (num(inv, 'max-chars')) limits.maxChars = num(inv, 'max-chars')!;
  if (num(inv, 'max-cps')) limits.maxCps = num(inv, 'max-cps')!;
  const { file, dropped } = E.buildCueFile({
    transcript: t,
    transcriptRel: transcriptRel!,
    fps,
    style,
    position: str(inv, 'position') as 'bottom' | 'center' | 'top' | undefined,
    sizePct: num(inv, 'size-pct'),
    wordsPerCue: num(inv, 'words-per-cue'),
    limits,
    clean: !!inv.flags['clean'],
    clip,
  });
  const outRel =
    str(inv, 'out') ??
    join(
      'captions',
      `${slug(transcriptRel!.replace(/^.*\//, '').replace(/\.json$/, ''))}.${style}.cues.json`,
    );
  const out = resolve(inv.dir, outRel);
  if (existsSync(out) && !inv.force)
    throw new CliError('WOULD_OVERWRITE', `${outRel} exists`, 5, 'pass --force to rebuild it');
  const canvas = {
    width: num(inv, 'width') ?? project?.meta.width ?? 1920,
    height: num(inv, 'height') ?? project?.meta.height ?? 1080,
  };
  const check = await E.checkCueFile(inv.dir, file, canvas);
  if (!inv.dryRun) E.writeCueFile(inv.dir, outRel, file);
  const warnings = check.violations.map((v) => `cue ${v.cue}: ${v.rule}: ${v.detail}`);
  if (style === 'karaoke') {
    const { palette } = E.loadPalette(inv.dir);
    const c = palette.colors;
    const vsText = contrastRatio(c['captionHighlight']!, c['captionText']!);
    const vsBox = contrastRatio(c['captionHighlight']!, c['captionBox']!);
    if (vsText < 3 || vsBox < 3)
      warnings.push(
        `karaoke highlight contrast is ${vsText.toFixed(2)}:1 against the text and ${vsBox.toFixed(2)}:1 against the box (needs 3:1 on both): change captionHighlight in brand/palette.json`,
      );
  }
  const review = file.cues.filter((c) => c.review).map((c) => c.i);
  if (review.length)
    warnings.push(
      `cues ${review.join(', ')} contain low-confidence words: check names and numbers`,
    );
  if (dropped.noSpeech) warnings.push(`${dropped.noSpeech} word(s) excluded as no-speech`);
  const cps = file.cues.map((c) => [...c.lines.join(' ')].length / ((c.end - c.start) / 1000));
  return {
    data: {
      cues: outRel,
      count: file.cues.length,
      style,
      relaxed: file.relaxed,
      placedThrough: clip?.id ?? null,
      dropped,
      violations: check.violations.length,
      measuredLayout: check.measured,
      cps: {
        max: Math.round(Math.max(...cps) * 10) / 10,
        mean: Math.round((cps.reduce((a, b) => a + b, 0) / cps.length) * 10) / 10,
      },
      firstCue: {
        start: file.cues[0]!.start,
        end: file.cues[0]!.end,
        text: file.cues[0]!.lines.join(' / '),
      },
    },
    warnings: [...warnings, ...check.fontWarnings],
    artifacts: inv.dryRun ? [] : [{ kind: 'cues', path: outRel }],
  };
};

export const check: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const cuesRel = str(inv, 'cues');
  if (!cuesRel)
    throw new CliError(
      'INVALID_ARGS',
      'missing --cues',
      2,
      'studio captions build writes captions/*.cues.json',
    );
  const doc = E.readJson<import('@studio/engines').CueFile>(resolve(inv.dir, cuesRel), 'cue file');
  const hasProject = existsSync(join(inv.dir, 'project.studio.json'));
  const m = hasProject ? store(inv).load().project.meta : undefined;
  const r = await E.checkCueFile(inv.dir, doc, {
    width: num(inv, 'width') ?? m?.width ?? 1920,
    height: num(inv, 'height') ?? m?.height ?? 1080,
  });
  if (r.violations.length)
    throw new CliError(
      'VALIDATION',
      `${r.violations.length} caption violation(s); first: cue ${r.violations[0]!.cue} ${r.violations[0]!.rule}: ${r.violations[0]!.detail}`,
      4,
      'rebuild with different limits, edit the transcript, or choose a smaller font',
      { violations: r.violations },
    );
  return {
    data: { cues: r.cues, violations: 0, measuredLayout: r.measured, limits: doc.limits },
    warnings: r.fontWarnings,
  };
};

export const exportCmd: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const cuesRel = str(inv, 'cues');
  if (!cuesRel) throw new CliError('INVALID_ARGS', 'missing --cues');
  const doc = E.readJson<import('@studio/engines').CueFile>(resolve(inv.dir, cuesRel), 'cue file');
  const fmt = str(inv, 'format') ?? 'srt';
  if (!['srt', 'vtt', 'ass'].includes(fmt))
    throw new CliError('INVALID_ARGS', '--format must be srt, vtt, or ass');
  const outRel =
    str(inv, 'out') ??
    join('captions', cuesRel.replace(/^.*\//, '').replace(/\.cues\.json$/, '') + '.' + fmt);
  const out = resolve(inv.dir, outRel);
  if (existsSync(out) && !inv.force)
    throw new CliError('WOULD_OVERWRITE', `${outRel} exists`, 5, 'pass --force');
  const note = doc.source.translation ? 'machine translation' : undefined;
  let text: string;
  if (fmt === 'srt') text = toSrt(doc.cues);
  else if (fmt === 'vtt') text = toVtt(doc.cues, note);
  else {
    const { palette } = E.loadPalette(inv.dir);
    const hasProject = existsSync(join(inv.dir, 'project.studio.json'));
    const m = hasProject ? store(inv).load().project.meta : undefined;
    const w = num(inv, 'width') ?? m?.width ?? 1920;
    const h = num(inv, 'height') ?? m?.height ?? 1080;
    const size = ((doc.sizePct || (h > w ? 4.5 : 4)) / 100) * h;
    const z = h > w ? { v: 0.22, s: 0.08 } : { v: 0.05, s: 0.05 };
    const col = (k: string) => (palette.colors[k] ?? '#ffffff').slice(0, 7);
    text = toAss(
      doc.cues,
      {
        font: Object.values(palette.fonts)[0]!.family,
        sizePx: Math.round(size),
        text: col('captionText'),
        outline: col('captionOutline'),
        ...(doc.style === 'social' ? {} : { box: palette.colors['captionBox'] }),
        bold: true,
        marginV: Math.round(z.v * h),
        marginH: Math.round(z.s * w),
        align: doc.position === 'top' ? 8 : doc.position === 'center' ? 5 : 2,
      },
      { w, h },
      note ? 'Studio captions (machine translation)' : 'Studio captions',
    );
  }
  if (!inv.dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  return {
    data: { file: outRel, format: fmt, cues: doc.cues.length, bytes: Buffer.byteLength(text) },
    artifacts: inv.dryRun ? [] : [{ kind: 'captions', path: outRel }],
  };
};

export const add: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const cuesRel = str(inv, 'cues');
  if (!cuesRel)
    throw new CliError('INVALID_ARGS', 'missing --cues', 2, 'studio captions build ...');
  const doc = E.readJson<import('@studio/engines').CueFile>(resolve(inv.dir, cuesRel), 'cue file');
  const { project } = store(inv).load();
  let track = str(inv, 'track');
  const specs: import('@studio/core').OpSpec[] = [];
  if (!track) {
    const existing = project.tracks.find((t) => t.type === 'captions');
    if (existing) track = existing.id;
    else {
      track = 't_cap' + String(project.tracks.length + 1).padStart(1, '0');
      specs.push({ type: 'track.add', args: { type: 'captions', name: 'Captions', id: track } });
    }
  }
  const start = doc.cues[0]!.start;
  const end = doc.cues[doc.cues.length - 1]!.end;
  specs.push({
    type: 'clip.add',
    args: {
      clip: {
        track,
        start,
        dur: end - start,
        comp: 'captions',
        props: {
          cues: cuesRel,
          style: doc.style,
          position: doc.position,
          ...(doc.sizePct ? { sizePct: doc.sizePct } : {}),
        },
      },
    },
  });
  return runSpecs(inv, specs, 'captions.add');
};
