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
    keyframes?: Record<string, unknown[]>;
    label?: string;
  }[];
  markers: { id: string; t: number; label: string }[];
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
} {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [timelineMs, setTimelineMs] = useState(0);
  const [status, setStatus] = useState<Status>('connecting');
  const [problem, setProblem] = useState<string | null>(null);

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
  return { project, timelineMs, status, problem };
}
