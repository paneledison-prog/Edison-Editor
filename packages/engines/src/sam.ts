/**
 * The promptable segmenter (Segment Anything 2.1 tiny, `tools/segment.py`) as a long-running helper process: a frame is encoded
 * once (cached on disk), then any number of prompts on it (points inside the object, points outside it, a box) cost
 * about a tenth of a second each. Used by the Object Mask Tool (`mask`) and the `sam` matte engine.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pythonReady } from './bgremove.js';
import { requireModel, studioRoot } from './models.js';
import { EngineError } from './run.js';

export const SAM_MODEL = 'sam2.1-tiny';

export interface SamPrompt {
  /** pixels of the embedded image */
  points?: [number, number][];
  /** 1 = inside the object, 0 = outside it; one per point */
  labels?: number[];
  /** x0, y0, x1, y1 */
  box?: [number, number, number, number];
  /** which of the model's three candidates: whole (the largest), best (its own quality guess), first (the one made for several prompts) */
  pick?: 'auto' | 'whole' | 'best' | 'first';
  /** a candidate by index, overriding pick */
  index?: number;
}
export interface SamMask {
  /** 0..1 per pixel, the size of the embedded image */
  prob: Float32Array;
  picked: number;
  /** predicted quality and area share of the three candidates */
  iou: number[];
  area: number[];
  ms: number;
}

/** Whether the segmenter can run here (python with onnxruntime, and the model files). */
export async function samReady(): Promise<{ ok: boolean; detail: string }> {
  const py = await pythonReady();
  if (!py.ok) return { ok: false, detail: `python is not ready (${py.detail})` };
  try {
    requireModel(SAM_MODEL);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  return { ok: true, detail: 'ok' };
}

export class SamServer {
  private child!: ChildProcessWithoutNullStreams;
  private pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }[] = [];
  private tmp = mkdtempSync(join(tmpdir(), 'studio-sam-'));
  private n = 0;
  private dead: Error | null = null;
  private stderr = '';

  private constructor(private cacheDir: string) {}

  static async start(cacheDir: string): Promise<SamServer> {
    const ready = await samReady();
    if (!ready.ok) throw new EngineError('ENGINE_MISSING', `the segmenter cannot run: ${ready.detail}`, `studio models fetch ${SAM_MODEL}; python3 -m pip install -r tools/requirements.txt`);
    mkdirSync(cacheDir, { recursive: true });
    const s = new SamServer(cacheDir);
    s.child = spawn('python3', ['-I', join(studioRoot(), 'tools', 'segment.py'), '--model-dir', requireModel(SAM_MODEL), '--cache', cacheDir], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      s.dead = new EngineError('ENGINE_FAILED', `the segmenter stopped (exit ${code}): ${s.stderr.trim().split('\n').pop() ?? ''}`);
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

  /** Encodes a frame (RGB bytes) under `id`; a second call with the same id reads the cache. Returns ms (0 if cached). */
  async embed(id: string, rgb: Uint8Array, w: number, h: number): Promise<number> {
    const sharp = (await import('sharp')).default;
    const png = join(this.tmp, `${this.n++}.png`);
    await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toFile(png);
    const r = await this.send({ cmd: 'embed', id, in: png });
    rmSync(png, { force: true });
    if (!r['ok']) throw new EngineError('ENGINE_FAILED', `the segmenter failed on an image: ${String(r['error'])}`);
    return Number(r['ms'] ?? 0);
  }

  async decode(id: string, w: number, h: number, p: SamPrompt): Promise<SamMask> {
    const sharp = (await import('sharp')).default;
    const out = join(this.tmp, `${this.n++}.m.png`);
    const r = await this.send({ cmd: 'decode', id, points: p.points ?? [], labels: p.labels ?? [], box: p.box ?? null, pick: p.pick, index: p.index, out });
    if (!r['ok']) throw new EngineError('ENGINE_FAILED', `the segmenter failed on a prompt: ${String(r['error'])}`);
    const raw = await sharp(out).greyscale().raw().toBuffer();
    rmSync(out, { force: true });
    if (raw.length !== w * h) throw new EngineError('ENGINE_FAILED', 'the segmenter returned a mask of the wrong size');
    return { prob: Float32Array.from(raw, (v) => v / 255), picked: Number(r['picked']), iou: r['iou'] as number[], area: r['area'] as number[], ms: Number(r['ms']) };
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
