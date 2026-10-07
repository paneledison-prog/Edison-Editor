import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { run } from '@studio/engines';
import { joinClicks, loudness } from './audio.js';
import { blackFrames, frozenFrames } from './video.js';

export type Status = 'pass' | 'fail' | 'warn' | 'skipped';
export interface Check {
  id: string;
  status: Status;
  value?: unknown;
  expected?: unknown;
  detail?: string;
}

export interface QcOptions {
  /** Expected canvas, fps, duration, audio presence: from the render report or flags. */
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  expectAudio?: boolean;
  targetLufs?: number;
  /** dBTP ceiling */
  truePeakMax?: number;
  /** H.264 delivery targets: High, yuv420p, AAC-LC, even dimensions, moov at start */
  h264Delivery?: boolean;
  joinsMs?: number[];
  /** [startMs, endMs] ranges where black or frozen frames are intended */
  plannedBlack?: [number, number][];
  maxSizeMb?: number;
  lufsTolerance?: number;
}

export interface QcResult {
  file: string;
  passed: boolean;
  summary: Record<Status, number>;
  checks: Check[];
  measured: Record<string, unknown>;
}

/** moov must come before mdat for progressive playback. Reads top-level MP4 atoms only. */
function moovAtStart(file: string): boolean | null {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    let pos = 0;
    const hdr = Buffer.alloc(16);
    for (let i = 0; i < 64 && pos < size; i++) {
      if (readSync(fd, hdr, 0, 16, pos) < 8) return null;
      let len = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(hdr.readBigUInt64BE(8));
      if (len < 8) return null;
      pos += len;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

const within = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export async function qc(file: string, o: QcOptions): Promise<QcResult> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const measured: Record<string, unknown> = {};

  const pr = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 60_000 },
  );
  if (pr.code !== 0) {
    add({
      id: 'container',
      status: 'fail',
      detail: `ffprobe cannot open the file: ${pr.stderr.trim().split('\n').pop()}`,
    });
    return finish(file, checks, measured);
  }
  const j = JSON.parse(pr.stdout);
  const v = (j.streams as any[]).find((s) => s.codec_type === 'video');
  const a = (j.streams as any[]).find((s) => s.codec_type === 'audio');
  const isMp4 = /mp4|mov/.test(j.format.format_name);

  if (isMp4 && o.h264Delivery) {
    const m = moovAtStart(file);
    add({
      id: 'container',
      status: m === true ? 'pass' : m === false ? 'fail' : 'warn',
      value: { format: j.format.format_name, moovAtStart: m },
      detail: m === false ? 'moov is after mdat: not faststart, will not stream' : undefined,
    });
  } else add({ id: 'container', status: 'pass', value: { format: j.format.format_name } });

  // streams
  const hasV = !!v,
    hasA = !!a;
  const sOk = hasV && (o.expectAudio === undefined || o.expectAudio === hasA);
  add({
    id: 'streams',
    status: o.expectAudio === undefined && hasV ? 'pass' : sOk ? 'pass' : 'fail',
    value: { video: hasV, audio: hasA },
    expected: { video: true, audio: o.expectAudio ?? 'any' },
  });

  const fps = v
    ? (() => {
        const [n, d] = String(v.r_frame_rate).split('/').map(Number);
        return n! / (d || 1);
      })()
    : undefined;
  measured.video = v
    ? { w: v.width, h: v.height, fps, codec: v.codec_name, profile: v.profile, pixFmt: v.pix_fmt }
    : null;
  measured.audio = a
    ? { codec: a.codec_name, profile: a.profile, sr: Number(a.sample_rate), ch: a.channels }
    : null;

  // resolution and fps
  if (v && o.width && o.height)
    add({
      id: 'resolution',
      status: v.width === o.width && v.height === o.height ? 'pass' : 'fail',
      value: `${v.width}x${v.height}`,
      expected: `${o.width}x${o.height}`,
    });
  else add({ id: 'resolution', status: 'skipped', detail: 'no expected resolution given' });
  if (v && o.fps)
    add({
      id: 'fps',
      status: within(fps!, o.fps, 0.01) ? 'pass' : 'fail',
      value: fps,
      expected: o.fps,
    });
  else add({ id: 'fps', status: 'skipped', detail: 'no expected fps given' });

  // duration: within 1 frame of the timeline
  const frameMs = 1000 / (o.fps ?? fps ?? 30);
  const durMs = Number(j.format.duration) * 1000;
  measured.durationMs = Math.round(durMs);
  if (o.durationMs !== undefined)
    add({
      id: 'duration',
      status: within(durMs, o.durationMs, frameMs) ? 'pass' : 'fail',
      value: Math.round(durMs),
      expected: o.durationMs,
      detail: `tolerance 1 frame (${frameMs.toFixed(1)} ms)`,
    });
  else add({ id: 'duration', status: 'skipped', detail: 'no expected duration given' });

  // codec compatibility
  if (o.h264Delivery && v) {
    const probs: string[] = [];
    if (v.codec_name !== 'h264') probs.push(`video codec ${v.codec_name}`);
    if (v.profile !== 'High') probs.push(`profile ${v.profile}`);
    if (v.pix_fmt !== 'yuv420p') probs.push(`pix_fmt ${v.pix_fmt}`);
    if (v.width % 2 || v.height % 2) probs.push('odd dimensions');
    if (a && (a.codec_name !== 'aac' || a.profile !== 'LC'))
      probs.push(`audio ${a.codec_name}/${a.profile}`);
    add({
      id: 'codec',
      status: probs.length ? 'fail' : 'pass',
      value: probs.length ? probs : 'H.264 High, yuv420p, AAC-LC, even dimensions',
    });
  } else add({ id: 'codec', status: 'skipped', detail: 'no H.264 delivery target' });

  // loudness + clipping
  if (hasA) {
    const L = await loudness(file);
    measured.loudness = L;
    const tol = o.lufsTolerance ?? 1;
    if (o.targetLufs !== undefined && L.integratedLufs !== null && L.integratedLufs !== undefined) {
      const okI = within(L.integratedLufs, o.targetLufs, tol);
      const okTp = o.truePeakMax === undefined || (L.truePeakDbtp ?? -Infinity) <= o.truePeakMax;
      add({
        id: 'loudness',
        status: okI && okTp ? 'pass' : 'fail',
        value: { integratedLufs: L.integratedLufs, truePeakDbtp: L.truePeakDbtp, lra: L.lra },
        expected: {
          integratedLufs: `${o.targetLufs} ±${tol}`,
          truePeakDbtp: `≤ ${o.truePeakMax ?? 'n/a'}`,
        },
      });
    } else
      add({
        id: 'loudness',
        status: 'skipped',
        detail:
          o.targetLufs === undefined
            ? 'no loudness target given'
            : 'audio is silent; loudness is undefined',
      });
    add({
      id: 'clipping',
      status: (L.clippingRuns ?? 0) === 0 ? 'pass' : 'fail',
      value: { runs: L.clippingRuns, samples: L.clippedSamples, samplePeakDbfs: L.samplePeakDbfs },
    });
  } else {
    add({ id: 'loudness', status: 'skipped', detail: 'no audio stream' });
    add({ id: 'clipping', status: 'skipped', detail: 'no audio stream' });
  }

  // black and frozen frames
  const planned = (s: number, e: number) =>
    (o.plannedBlack ?? []).some(([a0, b0]) => s >= a0 - frameMs && e <= b0 + frameMs);
  if (v) {
    const black = await blackFrames(file, fps ?? 30);
    measured.blackSpans = black;
    const bad = black.filter((b) => b.frames > 2 && !planned(b.startMs, b.endMs));
    add({
      id: 'black-frames',
      status: bad.length ? 'fail' : 'pass',
      value: bad.length ? bad : `${black.length} span(s), none over 2 frames unplanned`,
      expected: 'no span over 2 frames unless planned',
    });
    const frozen = await frozenFrames(file, 1);
    measured.frozenSpans = frozen;
    const badF = frozen.filter((f) => !planned(f.startMs, f.endMs));
    add({
      id: 'frozen-frames',
      status: badF.length ? 'fail' : 'pass',
      value: badF.length ? badF : 'none over 1 s',
    });
  } else {
    add({ id: 'black-frames', status: 'skipped', detail: 'no video stream' });
    add({ id: 'frozen-frames', status: 'skipped', detail: 'no video stream' });
  }

  // A/V sync: stream durations. A clap/beep spot check is not done.
  if (v && a) {
    const dv = Number(v.duration) * 1000,
      da = Number(a.duration) * 1000;
    add({
      id: 'av-sync',
      status: within(dv, da, frameMs) ? 'pass' : 'fail',
      value: {
        videoMs: Math.round(dv),
        audioMs: Math.round(da),
        driftMs: Math.round(Math.abs(dv - da)),
      },
      expected: `within 1 frame (${frameMs.toFixed(1)} ms)`,
      detail: 'stream durations only; no clap/beep spot check',
    });
  } else add({ id: 'av-sync', status: 'skipped', detail: 'needs both video and audio' });

  add({ id: 'captions', status: 'skipped', detail: 'no caption support before Phase 4' });

  // joins
  if (hasA && o.joinsMs?.length) {
    const clicks = await joinClicks(file, o.joinsMs);
    measured.joins = clicks;
    add({ id: 'joins', status: clicks.some((c) => c.click) ? 'fail' : 'pass', value: clicks });
  } else
    add({
      id: 'joins',
      status: 'skipped',
      detail: o.joinsMs?.length ? 'no audio' : 'no join times given',
    });

  // file size
  const mb = statSync(file).size / 1024 / 1024;
  measured.sizeMb = Math.round(mb * 100) / 100;
  if (o.maxSizeMb !== undefined)
    add({
      id: 'file-size',
      status: mb <= o.maxSizeMb ? 'pass' : 'fail',
      value: measured.sizeMb,
      expected: `≤ ${o.maxSizeMb} MB`,
    });
  else add({ id: 'file-size', status: 'skipped', detail: 'no size budget given' });

  return finish(file, checks, measured);
}

function finish(file: string, checks: Check[], measured: Record<string, unknown>): QcResult {
  const summary: Record<Status, number> = { pass: 0, fail: 0, warn: 0, skipped: 0 };
  for (const c of checks) summary[c.status]++;
  return { file, passed: summary.fail === 0, summary, checks, measured };
}
