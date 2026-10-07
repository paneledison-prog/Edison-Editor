import { spawn } from 'node:child_process';

export class EngineError extends Error {
  constructor(
    public code: 'ENGINE_MISSING' | 'ENGINE_FAILED' | 'UNSUPPORTED_INPUT',
    message: string,
    public fix?: string,
  ) {
    super(message);
  }
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
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      reject(
        e.code === 'ENOENT'
          ? new EngineError('ENGINE_MISSING', `${bin} not found on PATH`, FFMPEG_FIX)
          : new EngineError('ENGINE_FAILED', `${bin}: ${e.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
