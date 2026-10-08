import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildCues,
  checkCues,
  safeZoneViolations,
  speedOf,
  type Clip,
  type Cue,
  type CueLimits,
  type CueViolation,
  type Project,
  type TWord,
} from '@studio/core';
import { motionMeasure, prepare } from './motion.js';
import { EngineError } from './run.js';
import type { DerivedTranscript } from './transcribe.js';

export type CaptionStyle = 'clean' | 'social' | 'karaoke';

export interface CueFile {
  schema: 1;
  kind: 'cues';
  fps: number;
  style: CaptionStyle;
  position: 'bottom' | 'center' | 'top';
  sizePct: number;
  /** social style relaxes cps and minimum duration only */
  relaxed: boolean;
  limits: CueLimits;
  source: {
    transcript: string;
    clip?: string;
    asset?: string;
    translation?: 'machine translation';
  };
  cues: Cue[];
}

const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'uhm']);

export function readJson<T>(file: string, what: string): T {
  if (!existsSync(file)) throw new EngineError('INVALID_INPUT', `${what} ${file} does not exist`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    throw new EngineError(
      'INVALID_INPUT',
      `${what} ${file} is not valid JSON: ${(e as Error).message}`,
    );
  }
}

export interface BuildOptions {
  transcript: DerivedTranscript;
  transcriptRel: string;
  fps: number;
  style: CaptionStyle;
  position?: 'bottom' | 'center' | 'top';
  sizePct?: number;
  /** words per cue for social style; also relaxes cps and min duration */
  wordsPerCue?: number;
  limits?: Partial<CueLimits>;
  /** remove filler words (um, uh...): clean-verbatim */
  clean?: boolean;
  /** Place the transcript's asset through this clip: source time -> timeline time. */
  clip?: Pick<Clip, 'id' | 'start' | 'dur' | 'srcIn'> & { speed: number };
}

export function buildCueFile(o: BuildOptions): {
  file: CueFile;
  dropped: { noSpeech: number; fillers: number; outsideClip: number };
} {
  const dropped = { noSpeech: 0, fillers: 0, outsideClip: 0 };
  let words: TWord[] = [];
  for (const w of o.transcript.words) {
    if (w.noSpeech) {
      dropped.noSpeech++;
      continue;
    }
    if (o.clean && FILLERS.has(w.w.toLowerCase().replace(/[^\p{L}]/gu, ''))) {
      dropped.fillers++;
      continue;
    }
    words.push({
      w: w.w,
      start: w.start,
      end: w.end,
      ...(w.p !== undefined ? { p: w.p } : {}),
      ...(w.review ? { review: true } : {}),
    });
  }
  if (o.clip) {
    const c = o.clip;
    const a = c.srcIn ?? 0;
    const b = a + Math.round(c.dur * c.speed);
    const mapped: TWord[] = [];
    for (const w of words) {
      if (w.start < a || w.end > b + 50) {
        dropped.outsideClip++;
        continue;
      }
      mapped.push({
        ...w,
        start: Math.round(c.start + (w.start - a) / c.speed),
        end: Math.round(c.start + (Math.min(w.end, b) - a) / c.speed),
      });
    }
    words = mapped;
  }
  if (!words.length)
    throw new EngineError(
      'INVALID_INPUT',
      'no words left to caption (all were outside the clip, flagged as no-speech, or removed)',
    );
  const social = o.style === 'social';
  const wpc = o.wordsPerCue ?? (social ? 3 : undefined);
  const limits = { ...(wpc ? { wordsPerCue: wpc } : {}), ...(o.limits ?? {}) };
  const cues = buildCues(words, o.fps, limits);
  const full: CueLimits = {
    maxLines: 2,
    maxChars: 42,
    maxCps: 17,
    minDurMs: 1000,
    maxDurMs: 7000,
    leadFrames: 1,
    tailMs: 250,
    minGapFrames: 2,
    ...limits,
  };
  return {
    file: {
      schema: 1,
      kind: 'cues',
      fps: o.fps,
      style: o.style,
      position: o.position ?? 'bottom',
      sizePct: o.sizePct ?? 0,
      relaxed: !!wpc,
      limits: full,
      source: {
        transcript: o.transcriptRel,
        ...(o.clip ? { clip: o.clip.id } : {}),
        ...(o.transcript.asset ? { asset: o.transcript.asset } : {}),
      },
      cues,
    },
    dropped,
  };
}

export function writeCueFile(projectDir: string, rel: string, f: CueFile): void {
  const out = resolve(projectDir, rel);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = out + '.partial';
  writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n');
  renameSync(tmp, out);
}

export interface CaptionCheck {
  cues: number;
  violations: CueViolation[];
  /** boxes were measured from the real layout in Chromium */
  measured: boolean;
  fontWarnings: string[];
}

/** Checks a cue file by script: line count, line length, cps, durations, gaps, and the safe zone (measured, not estimated). */
export async function checkCueFile(
  projectDir: string,
  doc: CueFile,
  canvas: { width: number; height: number },
  props?: Record<string, unknown>,
): Promise<CaptionCheck> {
  const violations = checkCues(doc.cues, doc.fps, { limits: doc.limits, relaxed: doc.relaxed });
  const prep = prepare({
    comp: 'captions',
    props: {
      style: doc.style,
      position: doc.position,
      sizePct: doc.sizePct,
      ...(props ?? {}),
      cues: doc.cues,
    },
    width: canvas.width,
    height: canvas.height,
    fps: doc.fps,
    durMs: Math.max(1000, doc.cues[doc.cues.length - 1]!.end + 100),
    projectDir,
  });
  const info = await motionMeasure(prep);
  if (info.captionBoxes)
    violations.push(...safeZoneViolations(info.captionBoxes, canvas.width, canvas.height));
  violations.sort((a, b) => a.cue - b.cue);
  return {
    cues: doc.cues.length,
    violations,
    measured: !!info.captionBoxes,
    fontWarnings: info.warnings,
  };
}

/** QC input: every caption clip of a project, checked against its cue file at the project canvas. */
export async function captionReports(
  project: Project,
  projectDir: string,
  canvas?: { width: number; height: number },
) {
  const out: { clip: string; cues: number; violations: CueViolation[]; measured: boolean }[] = [];
  const cv = canvas ?? { width: project.meta.width, height: project.meta.height };
  for (const c of project.clips) {
    if (c.comp !== 'captions' || typeof c.props?.['cues'] !== 'string') continue;
    const doc = readJson<CueFile>(resolve(projectDir, c.props['cues'] as string), 'cue file');
    const { cues: _drop, ...rest } = c.props;
    const r = await checkCueFile(projectDir, doc, cv, rest);
    out.push({ clip: c.id, cues: r.cues, violations: r.violations, measured: r.measured });
  }
  return out;
}
