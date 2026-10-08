import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { TWord } from '@studio/core';
import { requireModel, studioRoot } from './models.js';
import { EngineError, run } from './run.js';

export interface RawTranscript {
  engine: string;
  engineVersion: string;
  ctranslate2: string;
  model: string;
  language: string;
  languageProbability: number;
  audioSeconds: number;
  tookSeconds: number;
  vad: { engine: string; speech: { start: number; end: number }[] };
  segments: {
    start: number;
    end: number;
    text: string;
    speechOverlap: number;
    words: { w: string; start: number; end: number; p: number }[];
  }[];
}

export interface DerivedTranscript {
  schema: 1;
  kind: 'derived';
  /** where the immutable recognizer output lives (relative to the project) */
  raw: string;
  asset?: string;
  source: {
    model: string;
    language: string;
    engine: string;
    engineVersion: string;
    audioSeconds: number;
    tookSeconds: number;
    realtimeFactor: number;
    vad: string;
  };
  glossary: { terms: string[]; fixes: { from: string; to: string; at: number }[] };
  words: (TWord & { noSpeech?: true })[];
  flags: {
    review: { index: number; word: string; p: number }[];
    noSpeech: { start: number; end: number; text: string; speechOverlap: number }[];
  };
  edits: string[];
}

export const LOW_CONF = 0.5;
/** Segments with less than this share of VAD speech under them are treated as likely hallucinations. */
export const MIN_SPEECH_OVERLAP = 0.3;

export function whisperPython(): string {
  const py = join(studioRoot(), 'tools', '.venv', 'bin', 'python');
  if (!existsSync(py))
    throw new EngineError(
      'ENGINE_MISSING',
      'the transcription environment is not installed',
      'python3 -m venv --system-site-packages tools/.venv && tools/.venv/bin/pip install -r tools/requirements-whisper.txt -r tools/requirements.txt',
    );
  return py;
}

export function readGlossary(projectDir: string): string[] {
  for (const base of [projectDir, studioRoot()]) {
    const f = join(base, 'brand', 'glossary.txt');
    if (existsSync(f))
      return readFileSync(f, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
  }
  return [];
}

const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Fixes spelling and case of glossary terms (names, products) in the word list; keeps punctuation around the match. */
export function applyGlossary(
  words: TWord[],
  terms: string[],
): { from: string; to: string; at: number }[] {
  const fixes: { from: string; to: string; at: number }[] = [];
  for (const term of terms) {
    const parts = term.split(/\s+/);
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (!parts.every((p, k) => letters(words[i + k]!.w) === letters(p))) continue;
      const before = words
        .slice(i, i + parts.length)
        .map((w) => w.w)
        .join(' ');
      parts.forEach((p, k) => {
        const w = words[i + k]!;
        const lead = /^[^\p{L}\p{N}]*/u.exec(w.w)![0];
        const trail = /[^\p{L}\p{N}]*$/u.exec(w.w)![0];
        w.w = lead + p + trail;
      });
      const after = words
        .slice(i, i + parts.length)
        .map((w) => w.w)
        .join(' ');
      if (before !== after) fixes.push({ from: before, to: after, at: words[i]!.start });
    }
  }
  return fixes;
}

export interface TranscribeOptions {
  projectDir: string;
  /** the media file to read */
  src: string;
  /** cache directory for this source (`.studio/cache/<hash>`) */
  cacheDir: string;
  assetId?: string;
  model: string;
  language?: string;
  force?: boolean;
  /** where the derived transcript is written (project-relative) */
  derivedRel: string;
  log?: (m: string) => void;
}
export interface TranscribeResult {
  raw: RawTranscript;
  rawRel: string;
  derived: DerivedTranscript;
  derivedRel: string;
  cached: boolean;
}

export async function transcribe(o: TranscribeOptions): Promise<TranscribeResult> {
  const log = o.log ?? (() => {});
  const modelDir = requireModel(o.model);
  const terms = readGlossary(o.projectDir);
  const prompt = terms.length ? `Glossary: ${terms.join(', ')}.` : '';
  const key = createHash('sha256')
    .update(JSON.stringify([o.model, o.language ?? 'auto', prompt]))
    .digest('hex')
    .slice(0, 10);
  const rawFile = join(o.cacheDir, `transcript.${o.model}.${key}.raw.json`);
  const rawRel = rawFile.startsWith(o.projectDir + '/')
    ? rawFile.slice(o.projectDir.length + 1)
    : rawFile;
  const derivedFile = join(o.projectDir, o.derivedRel);
  if (existsSync(derivedFile) && !o.force)
    throw new EngineError(
      'WOULD_OVERWRITE',
      `${o.derivedRel} exists and may hold edits`,
      'pass --force to replace it, or choose another --out',
    );
  let cached = false;
  if (existsSync(rawFile) && !o.force) cached = true;
  else {
    const py = whisperPython();
    mkdirSync(o.cacheDir, { recursive: true });
    const tmp = rawFile + '.partial';
    rmSync(tmp, { force: true });
    log(
      `transcribing with ${o.model}${o.language ? ` (${o.language})` : ''}; first run loads the model`,
    );
    const r = await run(
      py,
      [
        '-I',
        join(studioRoot(), 'tools', 'whisper.py'),
        '--audio',
        o.src,
        '--model-dir',
        modelDir,
        '--model-name',
        o.model,
        '--out',
        tmp,
        ...(o.language ? ['--language', o.language] : []),
        ...(prompt ? ['--prompt', prompt] : []),
      ],
      { timeoutMs: 4 * 3600_000 },
    );
    if (r.code !== 0) {
      rmSync(tmp, { force: true });
      throw new EngineError(
        'ENGINE_FAILED',
        `whisper failed: ${r.stderr.trim().split('\n').pop() ?? 'exit ' + r.code}`,
        'run `studio doctor`',
      );
    }
    if (existsSync(rawFile)) chmodSync(rawFile, 0o644);
    renameSync(tmp, rawFile);
    chmodSync(rawFile, 0o444); // the raw transcript is read-only; edits go to the derived file
  }
  const raw = JSON.parse(readFileSync(rawFile, 'utf8')) as RawTranscript;

  const words: DerivedTranscript['words'] = [];
  const noSpeech: DerivedTranscript['flags']['noSpeech'] = [];
  for (const s of raw.segments) {
    const hall = s.speechOverlap < MIN_SPEECH_OVERLAP;
    if (hall)
      noSpeech.push({
        start: Math.round(s.start * 1000),
        end: Math.round(s.end * 1000),
        text: s.text,
        speechOverlap: s.speechOverlap,
      });
    for (const w of s.words)
      words.push({
        w: w.w,
        start: Math.round(w.start * 1000),
        end: Math.round(w.end * 1000),
        p: w.p,
        ...(w.p < LOW_CONF ? { review: true as const } : {}),
        ...(hall ? { noSpeech: true as const, review: true as const } : {}),
      });
  }
  const fixes = applyGlossary(words, terms);
  const derived: DerivedTranscript = {
    schema: 1,
    kind: 'derived',
    raw: rawRel,
    ...(o.assetId ? { asset: o.assetId } : {}),
    source: {
      model: raw.model,
      language: raw.language,
      engine: `${raw.engine} ${raw.engineVersion} (ctranslate2 ${raw.ctranslate2})`,
      engineVersion: raw.engineVersion,
      audioSeconds: raw.audioSeconds,
      tookSeconds: raw.tookSeconds,
      realtimeFactor:
        Math.round((raw.tookSeconds / Math.max(0.001, raw.audioSeconds)) * 1000) / 1000,
      vad: raw.vad.engine,
    },
    glossary: { terms, fixes },
    words,
    flags: {
      review: words.flatMap((w, index) =>
        w.review && !w.noSpeech ? [{ index, word: w.w, p: w.p ?? 0 }] : [],
      ),
      noSpeech,
    },
    edits: [],
  };
  mkdirSync(dirname(derivedFile), { recursive: true });
  const tmp = derivedFile + '.partial';
  writeFileSync(tmp, JSON.stringify(derived, null, 2) + '\n');
  renameSync(tmp, derivedFile);
  return { raw, rawRel, derived, derivedRel: o.derivedRel, cached };
}
