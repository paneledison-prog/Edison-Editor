import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIX } from './fixtures.js';
import { tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
const URL_ = 'https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac';
const CLIP = join(FIX, 'real', 'jfk.flac');
const ready = (m: string) =>
  existsSync(join(ROOT, 'models', m, 'model.bin')) &&
  existsSync(join(ROOT, 'tools', '.venv', 'bin', 'python'));
const studio = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 28 }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );

function fetchClip(): boolean {
  if (existsSync(CLIP) && statSync(CLIP).size > 1e6) return true;
  mkdirSync(join(FIX, 'real'), { recursive: true });
  try {
    execFileSync('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '15', '-o', CLIP, URL_], {
      stdio: 'pipe',
    });
    return statSync(CLIP).size > 1e6;
  } catch {
    return false;
  }
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** 10 ms log-RMS frames from the clip, for the onset proxy. */
function onsetCurve(): { t: number; flux: number }[] {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', CLIP, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
    { maxBuffer: 1 << 28 },
  );
  const x = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const win = 160;
  const db: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) s += (x[i + j]! / 32768) ** 2;
    db.push(10 * Math.log10(s / win + 1e-10));
  }
  return db.map((v, i) => ({ t: i * 10, flux: i ? Math.max(0, v - db[i - 1]!) : 0 }));
}

describe('real speech (a public clip): word timing is measured, not assumed', () => {
  it('three models, one clip: word-start disagreement and distance to the nearest loudness onset (proxies, not truth)', async () => {
    const have = ['whisper-tiny.en', 'whisper-small', 'whisper-medium'].filter(ready);
    if (!have.length || !fetchClip()) {
      console.log(
        `real-speech check skipped: models ${have.length}/3 installed, clip ${existsSync(CLIP) ? 'present' : 'not downloadable'}`,
      );
      return;
    }
    const dir = tmpDir('studio-real-');
    await studio(['init', 'real', '--project', dir]);
    const words: Record<string, { w: string; start: number }[]> = {};
    for (const m of have) {
      const r = await studio([
        'transcribe',
        CLIP,
        '--model',
        m,
        '--language',
        'en',
        '--force',
        '--project',
        dir,
      ]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      const t = JSON.parse(readFileSync(join(dir, r.json.data.transcript), 'utf8'));
      words[m] = t.words.map((x: any) => ({ w: norm(x.w), start: x.start }));
    }
    // common words, matched in order across models
    const ref = words[have[have.length - 1]!]!;
    const rows = ref.map((rw, i) => ({
      w: rw.w,
      i,
      starts: have.map(
        (m) => words[m]!.find((x, k) => x.w === rw.w && Math.abs(k - i) <= 2)?.start ?? NaN,
      ),
    }));
    const full = rows.filter((r) => r.starts.every(Number.isFinite));
    const spread = full.map((r) => Math.max(...r.starts) - Math.min(...r.starts));
    const flux = onsetCurve();
    const toOnset = full.map((r) => {
      const s = r.starts[have.length - 1]!;
      const near = flux.filter((f) => Math.abs(f.t - s) <= 250);
      const best = near.reduce((a, b) => (b.flux > a.flux ? b : a), near[0]!);
      return best.t - s;
    });
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    const abs = (a: number[]) => a.map(Math.abs);
    const report = {
      clip: 'openai/whisper tests/jfk.flac, 11 s',
      models: have,
      commonWords: full.length,
      modelSpreadMs: {
        median: med(spread),
        max: Math.max(...spread),
        within34ms: spread.filter((s) => s <= 34).length,
      },
      toNearestOnsetMs: {
        medianAbs: med(abs(toOnset)),
        maxAbs: Math.max(...abs(toOnset)),
        within34ms: abs(toOnset).filter((s) => s <= 34).length,
      },
      rows: full.map((r, k) => ({
        word: r.w,
        startsMs: r.starts,
        spreadMs: spread[k],
        toOnsetMs: toOnset[k],
      })),
    };
    writeFileSync(join(FIX, 'real', 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      `P8 real speech (${have.join(', ')}): ${full.length} common words; models disagree on a word start by median ${report.modelSpreadMs.median} ms, max ${report.modelSpreadMs.max} ms (${report.modelSpreadMs.within34ms} within one frame); ${have[have.length - 1]} start is ${report.toNearestOnsetMs.medianAbs} ms median from the nearest loudness onset, max ${report.toNearestOnsetMs.maxAbs} ms (${report.toNearestOnsetMs.within34ms} within one frame)`,
    );
    expect(full.length).toBeGreaterThanOrEqual(10);
  }, 600_000);
});
