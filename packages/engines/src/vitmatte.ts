/**
 * The hair matting model (ViTMatte small, `tools/matting.py`) as a helper process: given a picture and a trimap (sure object,
 * sure background, unknown band) it returns the opacity in the unknown band. Used by the edge engine's `model` tier.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pythonReady } from './bgremove.js';
import { requireModel, studioRoot } from './models.js';
import { EngineError } from './run.js';

export const MATTING_MODEL = 'vitmatte-small';

/** Whether the matting model can run here (python with onnxruntime, and the model file). */
export async function vitmatteReady(): Promise<{ ok: boolean; detail: string }> {
  const py = await pythonReady();
  if (!py.ok) return { ok: false, detail: `python is not ready (${py.detail})` };
  try {
    requireModel(MATTING_MODEL);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  return { ok: true, detail: 'ok' };
}

export class VitMatteServer {
  private child!: ChildProcessWithoutNullStreams;
  private pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }[] = [];
  private tmp = mkdtempSync(join(tmpdir(), 'studio-vitmatte-'));
  private n = 0;
  private dead: Error | null = null;
  private stderr = '';

  static async start(): Promise<VitMatteServer> {
    const ready = await vitmatteReady();
    if (!ready.ok) throw new EngineError('ENGINE_MISSING', `the matting model cannot run: ${ready.detail}`, `studio models fetch ${MATTING_MODEL}; python3 -m pip install -r tools/requirements.txt`);
    const s = new VitMatteServer();
    s.child = spawn('python3', ['-I', join(studioRoot(), 'tools', 'matting.py'), '--model', requireModel(MATTING_MODEL)], { stdio: ['pipe', 'pipe', 'pipe'] });
    s.child.stderr.on('data', (d: Buffer) => (s.stderr = (s.stderr + d.toString()).slice(-4000)));
    createInterface({ input: s.child.stdout }).on('line', (line) => {
      const p = s.pending.shift();
      if (!p) return;
      try {
        p.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (e) {
        p.reject(e as Error);
      }
    });
    s.child.on('exit', (code) => {
      s.dead = new EngineError('ENGINE_FAILED', `the matting model stopped (exit ${code}): ${s.stderr.trim().split('\n').pop() ?? ''}`);
      for (const p of s.pending.splice(0)) p.reject(s.dead);
    });
    return s;
  }

  private send(q: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(q) + '\n');
    });
  }

  /** `trimap` bytes: 0 sure background, 255 sure object, other = unknown. Returns the opacity 0..1 (the trimap's 0 and 1 outside the band). */
  async matte(rgb: Uint8Array, trimap: Uint8Array, w: number, h: number): Promise<{ alpha: Float32Array; ms: number }> {
    const sharp = (await import('sharp')).default;
    const base = join(this.tmp, String(this.n++));
    await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toFile(`${base}.rgb.png`);
    await sharp(Buffer.from(trimap), { raw: { width: w, height: h, channels: 1 } }).png({ compressionLevel: 1 }).toFile(`${base}.tri.png`);
    const r = await this.send({ cmd: 'matte', in: `${base}.rgb.png`, tri: `${base}.tri.png`, out: `${base}.a.png` });
    if (!r['ok']) throw new EngineError('ENGINE_FAILED', `the matting model failed: ${String(r['error'])}`);
    const raw = await sharp(`${base}.a.png`).greyscale().raw().toBuffer();
    rmSync(`${base}.rgb.png`, { force: true });
    rmSync(`${base}.tri.png`, { force: true });
    rmSync(`${base}.a.png`, { force: true });
    if (raw.length !== w * h) throw new EngineError('ENGINE_FAILED', 'the matting model returned a mask of the wrong size');
    return { alpha: Float32Array.from(raw, (v) => v / 255), ms: Number(r['ms'] ?? 0) };
  }

  async close(): Promise<void> {
    try {
      this.child.stdin.end(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {
      /* already gone */
    }
    setTimeout(() => this.child.kill(), 2000).unref();
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
