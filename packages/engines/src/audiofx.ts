import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Fx } from '@studio/core';
import { EngineError, ffmpeg } from './run.js';

export const dbToLin = (db: number) => Math.pow(10, db / 20);
const f4 = (n: number) => String(Math.round(n * 10000) / 10000);

/** atempo accepts 0.5 to 2.0 per instance: chain them for anything outside that. */
export function atempoChain(factor: number): string[] {
  const out: string[] = [];
  let f = factor;
  while (f > 2) {
    out.push('atempo=2');
    f /= 2;
  }
  while (f < 0.5) {
    out.push('atempo=0.5');
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-9 || !out.length) out.push(`atempo=${f4(f)}`);
  return out;
}

/** Above this factor, audio is dropped rather than time-stretched into noise (rules/02). */
export const MAX_AUDIO_SPEED = 8;

/**
 * Filters for the audio effects of a clip, in array order. Speed and duck are not here:
 * speed is applied first by the caller, and duck needs a sidechain bus and is wired by the compiler.
 * This one function builds the chain for both the renderer and the measurement commands, so what
 * you measured is what renders.
 */
export function audioFxFilters(fx: Fx[] | undefined): string[] {
  const out: string[] = [];
  for (const f of fx ?? []) {
    switch (f.type) {
      case 'gain':
        out.push(`volume=${f4(f.db)}dB`);
        break;
      case 'highpass':
        out.push(`highpass=f=${f4(f.hz)}`);
        break;
      case 'denoise':
        if (f.method === 'arnndn') {
          if (!f.model || !existsSync(f.model)) {
            throw new EngineError(
              'ENGINE_MISSING',
              `arnndn needs an RNNoise model file${f.model ? `; ${f.model} does not exist` : ''}`,
              'download a model (e.g. from the rnnoise-models repo), record its license in docs/licenses.md, and pass --model <file>; or use --method afftdn',
            );
          }
          out.push(`arnndn=m=${f.model}`);
        } else out.push(`afftdn=nr=${f4(f.nr ?? 12)}:nf=${f4(f.nf ?? -50)}`);
        break;
      case 'eq':
        for (const b of f.bands)
          out.push(`equalizer=f=${f4(b.hz)}:t=q:w=${f4(b.q ?? 1)}:g=${f4(b.gain)}`);
        break;
      case 'compress':
        out.push(
          `acompressor=threshold=${f4(dbToLin(f.thresholdDb))}:ratio=${f4(f.ratio)}:attack=${f4(f.attackMs)}:release=${f4(f.releaseMs)}:makeup=${f4(dbToLin(f.makeupDb ?? 0))}`,
        );
        break;
      case 'limit':
        out.push(`alimiter=limit=${f4(dbToLin(f.ceilingDb))}:level=0`);
        break;
      case 'loudnorm': {
        const m = f.measured;
        out.push(
          `loudnorm=I=${f4(f.I)}:TP=${f4(f.TP)}:LRA=${f4(f.LRA ?? 11)}` +
            (m
              ? `:measured_I=${f4(m.I)}:measured_TP=${f4(m.TP)}:measured_LRA=${f4(m.LRA)}:measured_thresh=${f4(m.thresh)}:offset=${f4(m.offset)}:linear=true`
              : ''),
          'aresample=48000', // loudnorm outputs 192 kHz
        );
        break;
      }
      default:
        break; // speed and duck are handled by the compiler
    }
  }
  return out;
}

export interface ChainSource {
  src: string;
  srcInMs: number;
  /** milliseconds of source to read */
  srcSpanMs: number;
  channels: number;
  fx: Fx[] | undefined;
}

/** The per-clip audio chain up to (not including) the join fades: stereo, speed, effects. */
export function clipAudioChain(channels: number, fx: Fx[] | undefined): string[] {
  const speed = fx?.find((f) => f.type === 'speed');
  const factor = speed && speed.type === 'speed' ? speed.factor : 1;
  return [
    'aresample=48000',
    channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo',
    ...(factor !== 1 ? atempoChain(factor) : []),
    ...audioFxFilters(fx),
  ];
}

/** Writes the processed audio of a source range to a WAV (for measuring before/after). Returns the filtergraph used. */
export async function renderAudioChain(s: ChainSource, out: string): Promise<string> {
  mkdirSync(dirname(out), { recursive: true });
  const graph = clipAudioChain(s.channels, s.fx).join(',');
  await ffmpeg([
    '-ss',
    (s.srcInMs / 1000).toFixed(3),
    '-t',
    (s.srcSpanMs / 1000).toFixed(3),
    '-i',
    s.src,
    '-vn',
    '-af',
    graph,
    '-ar',
    '48000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    out,
  ]);
  return graph;
}

export interface LoudnormMeasurement {
  I: number;
  TP: number;
  LRA: number;
  thresh: number;
  offset: number;
}

/** Pass 1 of two-pass loudnorm: measure a file so pass 2 can apply the correction linearly. */
export async function measureLoudnorm(
  file: string,
  target: { I: number; TP: number; LRA?: number },
): Promise<LoudnormMeasurement> {
  const { run } = await import('./run.js');
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-af',
      `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA ?? 11}:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 600_000 },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr);
  if (!m)
    throw new EngineError('ENGINE_FAILED', 'loudnorm produced no measurement (is there audio?)');
  const j = JSON.parse(m[0]);
  if (j.input_i === '-inf')
    throw new EngineError('ENGINE_FAILED', 'the audio is silent; cannot measure loudness');
  return {
    I: Number(j.input_i),
    TP: Number(j.input_tp),
    LRA: Number(j.input_lra),
    thresh: Number(j.input_thresh),
    offset: Number(j.target_offset),
  };
}
