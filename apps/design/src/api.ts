import { useEffect, useState } from 'preact/hooks';
import type { Design, OpSpec } from '@studio/design';

export interface FontFace_ {
  family: string;
  weight: string;
  url: string;
}
export interface PresetInfo {
  id: string;
  summary: string;
  defaults: { dur: number; ease: string };
  types?: string[];
}
export interface Snapshot {
  rev: string;
  design: Design;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  fonts: FontFace_[];
  presets: PresetInfo[];
}
export interface ApiError {
  code: string;
  message: string;
  rev?: string;
  fix?: string;
}

export type { Design, OpSpec };

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-ui': '1' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ code: 'ENGINE_FAILED', message: `the server answered ${r.status}` }));
  if (!r.ok) throw j as ApiError;
  return j as T;
}

export const sendOps = (specs: OpSpec[], baseRev: string, label: string) => post<Snapshot>('/api/ops', { specs, baseRev, label });
export const sendUndo = (baseRev: string) => post<Snapshot>('/api/undo', { baseRev });
export const sendRedo = (baseRev: string) => post<Snapshot>('/api/redo', { baseRev });

export interface ExportResult {
  ok: true;
  output: string;
  url: string;
  format: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
  renderMs: number;
  renderFps: number;
  warnings: string[];
}
export const sendExport = (format: string, opts: { scale?: number; alpha?: boolean; at?: number }) => post<ExportResult>('/api/export', { format, ...opts });

/** Uploads an image or audio file into the design's assets folder; returns its project path. */
export async function uploadAsset(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return (await post<{ src: string }>('/api/asset', { name: file.name, data: btoa(s) })).src;
}

/** The live design: the first snapshot, then one per change (the agent's edits arrive here too). */
export function useLiveSnapshot(): { snap: Snapshot | null; problem: string | null; live: boolean; set: (s: Snapshot) => void } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('design', (e) => {
      setSnap(JSON.parse((e as MessageEvent).data));
      setProblem(null);
      setLive(true);
    });
    es.addEventListener('problem', (e) => setProblem(JSON.parse((e as MessageEvent).data).message));
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, []);
  return { snap, problem, live, set: setSnap };
}
