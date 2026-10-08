import { useEffect, useState } from 'preact/hooks';

/** The part of project.studio.json the UI reads. Kept local so the UI never imports the zod-based core. */
export interface ProjectView {
  meta: { name: string; fps: number; width: number; height: number; background: string };
  assets: Record<
    string,
    {
      path: string;
      kind: 'video' | 'audio' | 'image';
      probe: { durMs?: number; w?: number; h?: number };
    }
  >;
  tracks: {
    id: string;
    type: 'video' | 'audio' | 'graphics' | 'captions';
    name: string;
    muted?: boolean;
    hidden?: boolean;
  }[];
  clips: {
    id: string;
    track: string;
    asset?: string;
    comp?: string;
    start: number;
    dur: number;
    srcIn?: number;
    props?: Record<string, unknown>;
    keyframes?: Record<string, Keyframe[]>;
    fx?: { type: string; factor?: number; id?: string; node?: string }[];
    label?: string;
  }[];
  markers: { id: string; t: number; label: string }[];
}
export interface Keyframe {
  id: string;
  t: number;
  v: number;
  ease?: string;
}
/** One edit for the server: an op as the CLI would send it. */
export interface OpSpec {
  type: string;
  args: Record<string, unknown>;
}
export type Status = 'connecting' | 'live' | 'offline' | 'no-server';

/** The workspace this page shows when the server is a hub (`studio ui --hub`); null for a single project. */
export const wsId: string | null = new URLSearchParams(location.search).get('ws');
/** Adds the workspace to a request to the server. */
export const scoped = (path: string): string => (wsId ? `${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(wsId)}` : path);

/** An agent holds the workspace: the page is view-only until it finishes. */
export interface Lease {
  agent: string;
  note?: string;
  since: number;
  expires: number;
}
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
      .catch(() => !dead && setView({ mode: 'single', limit: 5, workspaces: [] })); // not a Studio server: the project load reports that
    return () => {
      dead = true;
      es?.close();
    };
  }, []);
  return view;
}
/** Whether the page can start loading its project: the server kind is known, and a hub has been told which workspace. */
export const canLoad = (view: WsView | null): boolean => view !== null && !(view.mode === 'hub' && !wsId);

/**
 * Loads the project from `studio ui` and follows changes over server-sent events.
 * Only the project value changes on a reload: playhead, selection, zoom, and scroll live elsewhere and are untouched.
 */
export function useLiveProject(go: boolean): {
  project: ProjectView | null;
  timelineMs: number;
  status: Status;
  problem: string | null;
  rev: string;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  lease: Lease | null;
} {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [timelineMs, setTimelineMs] = useState(0);
  const [status, setStatus] = useState<Status>('connecting');
  const [problem, setProblem] = useState<string | null>(null);
  const [meta, setMeta] = useState({ rev: '', canUndo: false, canRedo: false, readOnly: false });
  const [lease, setLease] = useState<Lease | null>(null);

  useEffect(() => {
    if (!go) return;
    let es: EventSource | undefined;
    let dead = false;
    (async () => {
      try {
        const r = await fetch(scoped('/api/project'), { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json'))
          throw new Error('not studio ui');
      } catch {
        if (!dead) setStatus('no-server');
        return;
      }
      es = new EventSource(scoped('/api/events'));
      es.onopen = () => setStatus('live');
      es.onerror = () => setStatus('offline'); // EventSource reconnects by itself
      es.addEventListener('project', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setProject(d.project);
        setTimelineMs(d.timelineMs);
        setProblem(null);
        setMeta({ rev: d.rev, canUndo: !!d.canUndo, canRedo: !!d.canRedo, readOnly: !!d.readOnly });
        setLease(d.lease ?? null);
        document.documentElement.setAttribute('data-rev', d.rev); // observable by tests and tooling
      });
      es.addEventListener('problem', (e) =>
        setProblem(JSON.parse((e as MessageEvent).data).message),
      );
      es.addEventListener('lease', (e) => setLease(JSON.parse((e as MessageEvent).data).lease ?? null));
      es.addEventListener('gone', () => {
        es?.close();
        setStatus('no-server');
        setProblem('This workspace was closed.');
      });
    })();
    return () => {
      dead = true;
      es?.close();
    };
  }, [go]);
  return { project, timelineMs, status, problem, lease, ...meta };
}

export interface WriteResult {
  ok: boolean;
  /** what to tell the person when it did not apply */
  message?: string;
  stale?: boolean;
}

/** POST an edit. The server answers 409 when an agent changed the project after `baseRev`; nothing is applied then. */
async function post(path: string, body: unknown): Promise<WriteResult> {
  try {
    const r = await fetch(scoped(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-ui': '1' },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const e = await r.json().catch(() => ({}));
    return {
      ok: false,
      stale: r.status === 409,
      message: e.message ?? `edit failed (${r.status})`,
    };
  } catch {
    return { ok: false, message: 'could not reach the Studio server' };
  }
}
export const sendOps = (baseRev: string, specs: OpSpec[], label: string) =>
  post('/api/ops', { baseRev, specs, label });
export const sendUndo = (baseRev: string) => post('/api/undo', { baseRev });
export const sendRedo = (baseRev: string) => post('/api/redo', { baseRev });

export interface ConnectorInfo {
  cli: string;
  node: string;
  project: string;
  tools: number;
  command: string;
  mcpJson: unknown;
}
export interface ConnectorCheck {
  ok: boolean;
  tools?: number;
  message?: string;
  ms?: number;
}
export async function getConnector(): Promise<ConnectorInfo | null> {
  try {
    const r = await fetch(scoped('/api/connector'), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function checkConnector(): Promise<ConnectorCheck> {
  try {
    const r = await fetch(scoped('/api/connector/check'), {
      method: 'POST',
      headers: { 'x-studio-ui': '1' },
    });
    return await r.json();
  } catch {
    return { ok: false, message: 'could not reach the Studio server' };
  }
}
