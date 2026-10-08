import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Interval } from './cuts.js';
import { ffmpeg, run } from './run.js';

/** Mean absolute frame-to-frame difference (0..255 luma) at 5 fps: how much of the screen changes. */
export async function activityProfile(
  src: string,
  fromMs = 0,
  spanMs?: number,
): Promise<{ stepMs: number; act: number[] }> {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      ...(fromMs ? ['-ss', (fromMs / 1000).toFixed(3)] : []),
      ...(spanMs ? ['-t', (spanMs / 1000).toFixed(3)] : []),
      '-i',
      src,
      '-an',
      '-vf',
      'fps=5,scale=256:-2:flags=area,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:file=-:key=lavfi.signalstats.YAVG',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 1_800_000 },
  );
  const act = [...r.stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return { stepMs: 200, act };
}

export interface ActivitySpans {
  /** nothing on screen changes */
  still: Interval[];
  /** small changes only (a spinner, a progress bar, typing): candidates for a speed ramp */
  low: Interval[];
}

/** Classifies the profile. Spans shorter than `minMs` are ignored. Thresholds are mean luma differences. */
export function activitySpans(
  p: { stepMs: number; act: number[] },
  o: { stillBelow?: number; lowBelow?: number; minMs?: number } = {},
): ActivitySpans {
  const stillBelow = o.stillBelow ?? 0.05;
  const lowBelow = o.lowBelow ?? 1.0;
  const minMs = o.minMs ?? 1000;
  const runs = (pred: (v: number) => boolean): Interval[] => {
    const out: Interval[] = [];
    let a = -1;
    p.act.forEach((v, i) => {
      if (pred(v) && a < 0) a = i;
      if ((!pred(v) || i === p.act.length - 1) && a >= 0) {
        const b = pred(v) && i === p.act.length - 1 ? i + 1 : i;
        // the first frame of a profile has no predecessor: its difference is the frame against nothing
        if ((b - a) * p.stepMs >= minMs) out.push({ startMs: a * p.stepMs, endMs: b * p.stepMs });
        a = -1;
      }
    });
    return out;
  };
  const still = runs((v) => v < stillBelow);
  const low = runs((v) => v >= stillBelow && v < lowBelow);
  return { still, low };
}

export interface PrivacyFinding {
  kind: 'email' | 'token' | 'internal-url' | 'ip-address';
  where: string;
  text: string;
}

const PATTERNS: { kind: PrivacyFinding['kind']; re: RegExp }[] = [
  { kind: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: 'token', re: /\b(?:sk|pk|ghp|gho|xox[bap]|AKIA)[-_A-Za-z0-9]{12,}\b/g },
  { kind: 'token', re: /\b[A-Za-z0-9_-]{32,}\b/g },
  {
    kind: 'internal-url',
    re: /https?:\/\/(?:localhost|127\.0\.0\.1|[\w-]+\.(?:internal|corp|local|lan))\S*/g,
  },
  {
    kind: 'ip-address',
    re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g,
  },
];

/** Regex scan of text we have (event target labels, transcripts). Pixels are not scanned: no OCR is installed. */
export function scanText(sources: { where: string; text: string }[]): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  for (const s of sources)
    for (const { kind, re } of PATTERNS)
      for (const m of s.text.matchAll(re))
        out.push({ kind, where: s.where, text: m[0].slice(0, 80) });
  return out;
}

/**
 * Contact sheets at 1 fps for a person (or the agent) to look at: 5 columns x 6 rows = 30 seconds per sheet.
 * Sheet N covers seconds [30N, 30N+30), left to right, top to bottom.
 */
export async function contactSheets(src: string, outDir: string, durMs: number): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const tmp = outDir + '.partial';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await ffmpeg([
    '-i',
    src,
    '-an',
    '-vf',
    'fps=1,scale=384:-2:flags=area,tile=5x6:padding=4:margin=4:color=gray',
    '-fps_mode',
    'passthrough',
    join(tmp, 'sheet-%02d.jpg'),
  ]);
  rmSync(outDir, { recursive: true, force: true });
  renameSync(tmp, outDir);
  void durMs;
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => join(outDir, f));
}

export function writeJson(file: string, v: unknown): void {
  writeFileSync(file + '.partial', JSON.stringify(v, null, 2) + '\n');
  renameSync(file + '.partial', file);
}
