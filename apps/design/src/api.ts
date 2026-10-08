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
/** An agent holds the design: the editor is view-only until it finishes. */
export interface Lease {
  agent: string;
  note?: string;
  since: number;
  expires: number;
}
export interface Snapshot {
  rev: string;
  lease: Lease | null;
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

/** The workspace this page shows when the server is a hub (`studio design ui --hub`); null for a single design. */
export const wsId: string | null = new URLSearchParams(location.search).get('ws');
/** Adds the workspace to a request or file URL. */
export const scoped = (path: string): string => (wsId ? `${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(wsId)}` : path);

export interface WsBrief {
  slot: string;
  name: string;
  state: 'idle' | 'agent-working' | 'incomplete';
  agent?: string;
  note?: string;
  items: number;
  assets: number;
}
export interface WsView {
  mode: 'hub' | 'single';
  limit: number;
  workspaces: WsBrief[];
}
/** The workspace tabs: which of the five exist and who is working in them, kept live by the server. */
export function useWorkspaces(): WsView | null {
  const [view, setView] = useState<WsView | null>(null);
  useEffect(() => {
    let es: EventSource | undefined;
    let dead = false;
    fetch('/api/workspaces', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: WsView) => {
        if (dead) return;
        setView(d);
        if (d.mode !== 'hub') return;
        es = new EventSource('/api/workspaces/events');
        es.addEventListener('workspaces', (e) => setView(JSON.parse((e as MessageEvent).data)));
      })
      .catch(() => !dead && setView({ mode: 'single', limit: 5, workspaces: [] })); // not a Studio server: the design load reports that
    return () => {
      dead = true;
      es?.close();
    };
  }, []);
  return view;
}
/** Whether the page can start loading its design: the server kind is known, and a hub has been told which workspace. */
export const canLoad = (view: WsView | null): boolean => view !== null && !(view.mode === 'hub' && !wsId);

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(scoped(path), {
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

/** The live design: the first snapshot, then one per change (the agent's edits arrive here too). */
export function useLiveSnapshot(go: boolean): { snap: Snapshot | null; problem: string | null; live: boolean; set: (s: Snapshot) => void } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!go) return;
    const es = new EventSource(scoped('/api/events'));
    es.addEventListener('lease', (e) => setSnap((s) => (s ? { ...s, lease: JSON.parse((e as MessageEvent).data).lease ?? null } : s)));
    es.addEventListener('gone', () => {
      es.close();
      setLive(false);
      setProblem('This workspace was closed.');
    });
    es.addEventListener('design', (e) => {
      setSnap(JSON.parse((e as MessageEvent).data));
      setProblem(null);
      setLive(true);
    });
    es.addEventListener('problem', (e) => setProblem(JSON.parse((e as MessageEvent).data).message));
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [go]);
  return { snap, problem, live, set: setSnap };
}
