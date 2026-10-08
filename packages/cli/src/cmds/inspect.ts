import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, str } from './shared.js';

function target(inv: Invocation): string {
  const p = inv.positionals[0];
  if (!p)
    throw new CliError(
      'INVALID_ARGS',
      'missing file',
      2,
      `studio ${inv.meta.usage.replace('studio ', '')}`,
    );
  const cands = isAbsolute(p) ? [p] : [resolve(p), join(inv.dir, p)];
  const f = cands.find(existsSync);
  if (!f)
    throw new CliError(
      'INVALID_ARGS',
      `${p}: file not found`,
      2,
      `looked in ${cands.join(' and ')}`,
    );
  return f;
}
const outDir = (inv: Invocation) => join(inv.dir, 'renders', 'inspect');
const rel = (inv: Invocation, p: string) =>
  p.startsWith(inv.dir) ? p.slice(inv.dir.length + 1) : p;

export const frame: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  const at = String(str(inv, 'at'))
    .split(',')
    .map((s) => Number(s.trim()));
  if (at.some((n) => !Number.isFinite(n) || n < 0))
    throw new CliError('INVALID_ARGS', '--at must be comma-separated non-negative ms values');
  if (inv.dryRun) return { data: { wouldWrite: at.length } };
  const res = await I.frames(target(inv), at, outDir(inv), num(inv, 'width'));
  return {
    data: { frames: res.map((f) => ({ ...f, path: rel(inv, f.path) })) },
    artifacts: res.map((f) => ({ kind: 'frame', path: rel(inv, f.path) })),
  };
};

export const sheet: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  if (inv.dryRun) return { data: { wouldWrite: 'contact sheets' } };
  const res = await I.sheets(target(inv), {
    fps: num(inv, 'fps'),
    cols: num(inv, 'cols'),
    width: num(inv, 'width'),
    outDir: outDir(inv),
  });
  return {
    data: { sheets: res.map((s) => ({ ...s, path: rel(inv, s.path) })), tilesPerSheetMax: 24 },
    artifacts: res.map((s) => ({ kind: 'contact-sheet', path: rel(inv, s.path) })),
  };
};

export const waveform: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  if (inv.dryRun) return { data: { wouldWrite: 'waveform png' } };
  const p = await I.waveform(target(inv), outDir(inv));
  return { data: { path: rel(inv, p) }, artifacts: [{ kind: 'waveform', path: rel(inv, p) }] };
};

export const loudness: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  const from = num(inv, 'from');
  const to = num(inv, 'to');
  const L = await I.loudness(target(inv), { fromMs: from, toMs: to });
  return {
    data: {
      ...L,
      ...(from !== undefined || to !== undefined
        ? { range: { fromMs: from ?? 0, toMs: to ?? null } }
        : {}),
    },
  };
};

export const silence: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  const f = target(inv);
  const warnings: string[] = [];
  let noise = num(inv, 'noise-db');
  if (noise === undefined) {
    const L = await I.loudness(f);
    if (!L.hasAudio) throw new CliError('INVALID_ARGS', `${basename(f)} has no audio stream`);
    noise = Math.min(-20, Math.max(-50, Math.round((L.noiseFloorDbfs ?? -42) + 8)));
    warnings.push(
      `threshold ${noise} dB = measured noise floor ${L.noiseFloorDbfs} dBFS + 8 dB, clamped to -50..-20`,
    );
  }
  const minS = num(inv, 'min-s') ?? 0.4;
  const r = await I.silenceRms(f, noise, minS);
  return {
    data: { noiseDb: noise, minS, spans: r.spans, removableMs: r.totalMs, count: r.spans.length },
    warnings,
  };
};

export const black: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  const E = await import('@studio/engines');
  const f = target(inv);
  const pr = await E.probeFile(f);
  if (pr.kind !== 'video') throw new CliError('INVALID_ARGS', `${basename(f)} has no video stream`);
  const fps = pr.probe.rFps ?? pr.probe.fps ?? 30;
  return { data: { fps, black: await I.blackFrames(f, fps), frozen: await I.frozenFrames(f, 1) } };
};

const ranges = (s: string | undefined): [number, number][] | undefined =>
  s
    ? s.split(',').map((r) => {
        const [a, b] = r.split(':').map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b))
          throw new CliError('INVALID_ARGS', `bad range "${r}", expected A:B in ms`);
        return [a!, b!] as [number, number];
      })
    : undefined;

export const qc: Handler = async (inv) => {
  const I = await import('@studio/inspect');
  const f = target(inv);
  // The render writes <name>.report.json next to the project snapshot: use it as the expectation, flags override.
  const reportPath = join(dirname(f), `render-${basename(f, extname(f))}.report.json`);
  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined;
  const ea = str(inv, 'expect-audio');
  const joins = str(inv, 'joins');
  const opts = {
    width: num(inv, 'width') ?? rep?.width,
    height: num(inv, 'height') ?? rep?.height,
    fps: num(inv, 'fps') ?? rep?.fps,
    durationMs: num(inv, 'duration-ms') ?? rep?.durationMs,
    expectAudio: ea !== undefined ? ea === 'true' : rep ? !!rep.hasAudio : undefined,
    targetLufs: num(inv, 'target-lufs') ?? rep?.loudness?.targetI,
    truePeakMax: num(inv, 'true-peak-max') ?? rep?.loudness?.targetTP,
    h264Delivery: inv.flags['h264'] ? true : rep ? rep.vcodec === 'h264' : false,
    joinsMs: joins ? joins.split(',').map(Number) : rep?.joinsMs,
    plannedBlack: ranges(str(inv, 'planned-black')),
    maxSizeMb: num(inv, 'max-size-mb'),
  };
  let captions:
    Awaited<ReturnType<(typeof import('@studio/engines'))['captionReports']>> | undefined;
  const snap = join(dirname(f), `render-${basename(f, extname(f))}.project.json`);
  if (existsSync(snap)) {
    const E = await import('@studio/engines');
    captions = await E.captionReports(
      JSON.parse(readFileSync(snap, 'utf8')),
      inv.dir,
      opts.width && opts.height ? { width: opts.width, height: opts.height } : undefined,
    );
  }
  const res = await I.qc(f, { ...opts, captions });
  const warnings = [
    rep
      ? `expectations read from ${basename(reportPath)}`
      : 'no render report found; only the flags you passed set expectations',
    ...res.checks.filter((c) => c.status === 'skipped').map((c) => `skipped ${c.id}: ${c.detail}`),
  ];
  if (!res.passed) {
    const failed = res.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    throw new CliError(
      'QC_FAILED',
      `QC failed: ${failed.join(', ')}`,
      4,
      'see error.details.checks for measured values',
      { ...res, warnings },
    );
  }
  return { data: res, warnings };
};
