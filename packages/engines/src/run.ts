import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class EngineError extends Error {
  constructor(
    public code:
      | 'ENGINE_MISSING'
      | 'ENGINE_FAILED'
      | 'UNSUPPORTED_INPUT'
      | 'INVALID_INPUT'
      | 'WOULD_OVERWRITE'
      | 'ENCODER_UNSUPPORTED',
    message: string,
    public fix?: string,
  ) {
    super(message);
  }
}

/**
 * A filtergraph longer than this goes to FFmpeg as a script file: one command-line argument is limited to 128 KiB on Linux,
 * and a clip with a table of per-frame corners (stabilize, pin) is larger than that.
 */
const INLINE_GRAPH_MAX = 60_000;

/** Moves long `-filter_complex` graphs into script files. Call `cleanup` when FFmpeg has ended. */
export function withFilterScripts(args: string[]): { args: string[]; cleanup: () => void } {
  let dir: string | undefined;
  const out = args.slice();
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i] !== '-filter_complex' || out[i + 1]!.length <= INLINE_GRAPH_MAX) continue;
    dir ??= mkdtempSync(join(tmpdir(), 'studio-graph-'));
    const file = join(dir, `graph-${i}.txt`);
    writeFileSync(file, out[i + 1]!);
    out[i] = '-filter_complex_script';
    out[i + 1] = file;
  }
  return { args: out, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const FFMPEG_FIX =
  'install ffmpeg (Debian/Ubuntu: apt install ffmpeg; macOS: brew install ffmpeg) and run `studio doctor`';

/** Runs a binary to completion. stdout is captured as text (cap 64 MiB), stderr keeps the last 16 KiB. */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; stdoutCap?: number } = {},
): Promise<RunResult> {
  const scripted = bin === 'ffmpeg' ? withFilterScripts(args) : { args, cleanup: () => undefined };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, scripted.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = opts.stdoutCap ?? 64 * 1024 * 1024;
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < cap) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr = (stderr + d).slice(-16 * 1024);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new EngineError('ENGINE_FAILED', `${bin} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      scripted.cleanup();
      reject(
        e.code === 'ENOENT'
          ? new EngineError('ENGINE_MISSING', `${bin} not found on PATH`, FFMPEG_FIX)
          : new EngineError('ENGINE_FAILED', `${bin}: ${e.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      scripted.cleanup();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** First meaningful stderr line, for error messages. */
export const lastLine = (s: string) =>
  s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '(no output)';

export async function ffmpeg(args: string[], timeoutMs?: number): Promise<RunResult> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { timeoutMs });
  if (r.code !== 0) throw new EngineError('ENGINE_FAILED', `ffmpeg failed: ${lastLine(r.stderr)}`);
  return r;
}
