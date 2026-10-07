import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProjectView } from '../api';
import { snapToFrame, tickLabel, tickStep } from './format';

export const HEADER_W = 148;
const OVERSCAN_PX = 400;

type Clip = ProjectView['clips'][number];
type Track = ProjectView['tracks'][number];

function colorClass(c: Clip, t: Track, p: ProjectView): string {
  if (c.comp) return 'clip-comp';
  const a = c.asset ? p.assets[c.asset] : undefined;
  if (a?.kind === 'image') return 'clip-image';
  return `clip-${t.type}`;
}
const baseName = (path: string) => path.split('/').pop() ?? path;
const clipLabel = (c: Clip, p: ProjectView) =>
  c.label ?? (c.comp ? c.comp : c.asset ? baseName(p.assets[c.asset]?.path ?? c.asset) : c.id);

interface Props {
  project: ProjectView;
  timelineMs: number;
  pxPerMs: number;
  playheadMs: number;
  selectedId: string | null;
  onSeek: (ms: number) => void;
  onSelect: (id: string | null) => void;
  onZoom: (next: number) => void;
}

/**
 * Read-only timeline. Only clips and ruler ticks inside the viewport (plus overscan) are in the DOM,
 * so 500 clips cost the same as 20. Positions are absolute times scaled by `pxPerMs`.
 */
export function Timeline({
  project,
  timelineMs,
  pxPerMs,
  playheadMs,
  selectedId,
  onSeek,
  onSelect,
  onZoom,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(1200);
  const pendingAnchor = useRef<{ ms: number; px: number } | null>(null);
  const raf = useRef(0);

  const totalMs = Math.max(timelineMs + 2000, 10_000);
  const totalPx = totalMs * pxPerMs;

  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setScrollLeft(scroller.current?.scrollLeft ?? 0));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Runs after layout whenever zoom or content width changes. Keeps the time under the cursor fixed while zooming,
  // and re-reads scrollLeft because the browser clamps it when the content shrinks (zoom out, deleted clips).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const a = pendingAnchor.current;
    if (a) {
      el.scrollLeft = a.ms * pxPerMs - a.px;
      pendingAnchor.current = null;
    }
    setScrollLeft(el.scrollLeft);
  }, [pxPerMs, totalPx]);

  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !scroller.current) return;
    e.preventDefault();
    const rect = scroller.current.getBoundingClientRect();
    const px = Math.max(0, e.clientX - rect.left - HEADER_W);
    pendingAnchor.current = { ms: (scroller.current.scrollLeft + px) / pxPerMs, px };
    onZoom(pxPerMs * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  const seekFromEvent = (e: MouseEvent) => {
    const rect = content.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - HEADER_W;
    if (x < 0) return;
    onSeek(snapToFrame(Math.min(totalMs, x / pxPerMs), project.meta.fps));
  };

  const visFrom = Math.max(0, (scrollLeft - OVERSCAN_PX) / pxPerMs);
  const visTo = (scrollLeft + viewW + OVERSCAN_PX) / pxPerMs;

  const rows = useMemo(() => {
    const by = new Map<string, Clip[]>();
    for (const c of project.clips) (by.get(c.track) ?? by.set(c.track, []).get(c.track)!).push(c);
    return project.tracks.map((t) => ({ t, clips: by.get(t.id) ?? [] }));
  }, [project]);

  const step = tickStep(pxPerMs);
  const ticks: number[] = [];
  for (let t = Math.floor(visFrom / step) * step; t <= Math.min(visTo, totalMs); t += step)
    ticks.push(t);

  let rendered = 0;
  return (
    <div
      class="tl-scroll"
      ref={scroller}
      onScroll={onScroll}
      onWheel={onWheel as any}
      data-testid="timeline-scroll"
      tabIndex={0}
      aria-label="Timeline tracks"
    >
      <div
        class="tl-content"
        ref={content}
        style={{ width: `${HEADER_W + totalPx}px` }}
        onClick={seekFromEvent}
      >
        <div class="tl-ruler-row">
          <div class="tl-corner" style={{ width: `${HEADER_W}px` }} />
          <div class="tl-ruler" style={{ width: `${totalPx}px` }} aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} class="tick" style={{ transform: `translateX(${t * pxPerMs}px)` }}>
                {tickLabel(t, step)}
              </span>
            ))}
            {project.markers
              .filter((m) => m.t >= visFrom && m.t <= visTo)
              .map((m) => (
                <span
                  key={m.id}
                  class="marker"
                  title={m.label}
                  style={{ transform: `translateX(${m.t * pxPerMs}px)` }}
                />
              ))}
          </div>
        </div>
        {rows.map(({ t, clips }) => (
          <div class="tl-row" key={t.id} data-track={t.id}>
            <div class="tl-head" style={{ width: `${HEADER_W}px` }}>
              <span class={`dot dot-${t.type}`} aria-hidden="true" />
              <span class="tl-name">{t.name}</span>
              <span class="muted tl-type">
                {t.type}
                {t.muted ? ' · muted' : ''}
                {t.hidden ? ' · hidden' : ''}
              </span>
            </div>
            <div class="tl-lane" style={{ width: `${totalPx}px` }}>
              {clips
                .filter((c) => c.start + c.dur >= visFrom && c.start <= visTo)
                .map((c) => {
                  rendered++;
                  return (
                    <button
                      type="button"
                      key={c.id}
                      data-clip-id={c.id}
                      class={`clip ${colorClass(c, t, project)} ${selectedId === c.id ? 'selected' : ''}`}
                      style={{
                        transform: `translateX(${c.start * pxPerMs}px)`,
                        width: `${Math.max(2, c.dur * pxPerMs)}px`,
                      }}
                      title={`${clipLabel(c, project)} · ${c.start}–${c.start + c.dur} ms`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(c.id);
                      }}
                    >
                      <span class="clip-label">{clipLabel(c, project)}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        <div
          class="playhead"
          style={{ transform: `translateX(${HEADER_W + playheadMs * pxPerMs}px)` }}
          data-testid="playhead"
          aria-hidden="true"
        />
        <span
          hidden
          data-rendered-clips={rendered}
          data-total-clips={project.clips.length}
          data-testid="virtualization"
        />
      </div>
    </div>
  );
}
