import { useEffect, useRef, useState } from 'preact/hooks';
import { scoped, type ProjectView } from './api';

interface Props {
  project: ProjectView | null;
  timelineMs: number;
  playheadMs: number;
  rev: string;
  live: boolean;
}

const DEBOUNCE_MS = 180;

/**
 * The artboard with the frame at the playhead, from the server's compiler (`GET /api/frame`). While the playhead or
 * the project changes only the newest request may land, and the previous image stays up until the new one is ready.
 */
export function Canvas({ project, timelineMs, playheadMs, rev, live }: Props) {
  const [src, setSrc] = useState<{ url: string; t: number } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const current = useRef<string | null>(null);
  const aspect = project ? `${project.meta.width} / ${project.meta.height}` : '16 / 9';
  const t = Math.min(Math.max(0, Math.round(playheadMs)), Math.max(0, timelineMs - 1));
  const wanted = live && !!project && timelineMs > 0;

  useEffect(() => {
    if (!wanted) return;
    const mine = ++token.current;
    setState('loading');
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(scoped(`/api/frame?t=${t}&w=640`), { cache: 'no-store' });
        if (r.status === 204) {
          // no preview for this frame (for example the media file is missing): say why, and drop the old image
          if (mine !== token.current) return;
          setSrc(null);
          setState('error');
          setError(decodeURIComponent(r.headers.get('x-preview-error') ?? 'unavailable'));
          return;
        }
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.message ?? `preview failed (${r.status})`);
        }
        const blob = await r.blob();
        if (mine !== token.current) return; // a newer request owns the canvas
        const url = URL.createObjectURL(blob);
        const old = current.current;
        current.current = url;
        setSrc({ url, t });
        setState('idle');
        setError(null);
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      } catch (e) {
        if (mine !== token.current) return;
        setState('error');
        setError((e as Error).message);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [t, rev, wanted]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return (
    <>
      <div
        class="artboard"
        role="img"
        aria-label="Artboard"
        style={{ aspectRatio: aspect, background: project?.meta.background }}
      >
        {src && wanted && (
          <img
            src={src.url}
            alt={`Frame at ${src.t} ms`}
            data-testid="preview-img"
            data-preview-t={src.t}
            draggable={false}
          />
        )}
      </div>
      <span
        class="badge"
        title="Original media and overlays at the playhead, no audio; render a preview for the exact result"
      >
        Approximate preview
      </span>
      {project && (
        <span class="canvas-note muted" data-testid="canvas-note" role="status">
          {timelineMs === 0
            ? 'No clips yet.'
            : state === 'error'
              ? `Preview failed: ${error}`
              : state === 'loading'
                ? 'Rendering preview…'
                : ''}
        </span>
      )}
    </>
  );
}
