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
    fx?: { type: string; factor?: number }[];
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

/**
 * Loads the project from `studio ui` and follows changes over server-sent events.
 * Only the project value changes on a reload: playhead, selection, zoom, and scroll live elsewhere and are untouched.
 */
export function useLiveProject(): {
  project: ProjectView | null;
  timelineMs: number;
  status: Status;
  problem: string | null;
  rev: string;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
} {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [timelineMs, setTimelineMs] = useState(0);
  const [status, setStatus] = useState<Status>('connecting');
  const [problem, setProblem] = useState<string | null>(null);
  const [meta, setMeta] = useState({ rev: '', canUndo: false, canRedo: false, readOnly: false });

  useEffect(() => {
    let es: EventSource | undefined;
    let dead = false;
    (async () => {
      try {
        const r = await fetch('/api/project', { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json'))
          throw new Error('not studio ui');
      } catch {
        if (!dead) setStatus('no-server');
        return;
      }
      es = new EventSource('/api/events');
      es.onopen = () => setStatus('live');
      es.onerror = () => setStatus('offline'); // EventSource reconnects by itself
      es.addEventListener('project', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setProject(d.project);
        setTimelineMs(d.timelineMs);
        setProblem(null);
        setMeta({ rev: d.rev, canUndo: !!d.canUndo, canRedo: !!d.canRedo, readOnly: !!d.readOnly });
        document.documentElement.setAttribute('data-rev', d.rev); // observable by tests and tooling
      });
      es.addEventListener('problem', (e) =>
        setProblem(JSON.parse((e as MessageEvent).data).message),
      );
    })();
    return () => {
      dead = true;
      es?.close();
    };
  }, []);
  return { project, timelineMs, status, problem, ...meta };
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
    const r = await fetch(path, {
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
    const r = await fetch('/api/connector', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function checkConnector(): Promise<ConnectorCheck> {
  try {
    const r = await fetch('/api/connector/check', {
      method: 'POST',
      headers: { 'x-studio-ui': '1' },
    });
    return await r.json();
  } catch {
    return { ok: false, message: 'could not reach the Studio server' };
  }
}
