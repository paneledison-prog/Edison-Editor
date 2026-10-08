import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { OpSpec, ProjectView } from '../api';
import {
  canSplit,
  frameMs,
  moveClip,
  moveSpec,
  snapPoints,
  snapTime,
  splitSpec,
  trimClip,
  trimSpec,
} from './edit';
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
  /** the tool in the rail: select (drag, trim) or split (click a clip) */
  tool: 'select' | 'split';
  editable: boolean;
  showKeyframes?: boolean;
  onEdit: (specs: OpSpec[], label: string) => void;
}

interface Drag {
  id: string;
  mode: 'move' | 'trim-left' | 'trim-right';
  x0: number;
  moved: boolean;
  /** transient values while the pointer is down; one op is sent on release */
  start: number;
  dur: number;
  srcIn?: number;
  track: string;
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
  tool,
  editable,
  showKeyframes = true,
  onEdit,
}: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const fps = project.meta.fps;
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

  // ---- editing: pointer drags on clips. Nothing is written until release; Escape cancels. ----
  const setD = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const beginDrag = (e: PointerEvent, c: Clip, mode: Drag['mode']) => {
    if (!editable || tool === 'split' || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSelect(c.id);
    setD({
      id: c.id,
      mode,
      x0: e.clientX,
      moved: false,
      start: c.start,
      dur: c.dur,
      srcIn: c.srcIn,
      track: c.track,
    });
    dragOwner.current = e.currentTarget as HTMLElement;
  };
  const dragOwner = useRef<HTMLElement | null>(null);
  const moveDrag = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const c = project.clips.find((x) => x.id === d.id);
    if (!c) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(e.movementY) < 3 && d.mode === 'move') {
      // a click, not yet a drag; vertical movement is judged from the row below
    }
    const pts = snapPoints(project, c.id, playheadMs);
    const delta = dx / pxPerMs;
    if (d.mode === 'move') {
      // The track under the pointer, if it is the same kind as the clip's own.
      let track = d.track;
      const row = (
        document
          .elementsFromPoint(e.clientX, e.clientY)
          .find((el) => (el as HTMLElement).dataset?.track) as HTMLElement | undefined
      )?.dataset.track;
      const rowTrack = row ? project.tracks.find((t) => t.id === row) : undefined;
      const own = project.tracks.find((t) => t.id === c.track);
      if (rowTrack && own && rowTrack.type === own.type) track = rowTrack.id;
      // snap the clip's start or its end, whichever is closer to a snap point
      const sStart = snapTime(c.start + delta, pts, pxPerMs, fps);
      const sEnd = snapTime(c.start + c.dur + delta, pts, pxPerMs, fps) - c.dur;
      const wantStart =
        Math.abs(sStart - (c.start + delta)) <= Math.abs(sEnd - (c.start + delta)) ? sStart : sEnd;
      const m = moveClip(project, c, wantStart, track);
      setD({
        ...d,
        moved: d.moved || Math.abs(dx) >= 3 || m.track !== c.track,
        start: m.start,
        track: m.track,
      });
    } else {
      const edgeT = d.mode === 'trim-left' ? c.start + delta : c.start + c.dur + delta;
      const to = snapTime(edgeT, pts, pxPerMs, fps);
      const r = trimClip(project, c, d.mode === 'trim-left' ? 'left' : 'right', to, fps);
      setD({
        ...d,
        moved: d.moved || Math.abs(dx) >= 3,
        start: r.start,
        dur: r.dur,
        srcIn: r.srcIn,
      });
    }
  };
  const endDrag = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setD(null);
    const c = project.clips.find((x) => x.id === d.id);
    if (!c || !d.moved) return;
    if (d.mode === 'move') {
      if (d.start !== c.start || d.track !== c.track)
        onEdit([moveSpec(c, d.start, d.track)], `move ${c.id}`);
    } else if (d.start !== c.start || d.dur !== c.dur)
      onEdit([trimSpec(c, { start: d.start, dur: d.dur, srcIn: d.srcIn })], `trim ${c.id}`);
  };
  const cancelDrag = () => setD(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) setD(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
                  const d = drag?.id === c.id ? drag : null;
                  const st = d ? d.start : c.start;
                  const du = d ? d.dur : c.dur;
                  const kfs = Object.values(c.keyframes ?? {}).flat();
                  return (
                    <div
                      key={c.id}
                      data-clip-id={c.id}
                      role="button"
                      tabIndex={0}
                      class={`clip ${colorClass(c, t, project)} ${selectedId === c.id ? 'selected' : ''} ${d ? 'dragging' : ''} ${editable && tool === 'split' ? 'tool-split' : ''}`}
                      style={{
                        transform: `translateX(${st * pxPerMs}px)`,
                        width: `${Math.max(2, du * pxPerMs)}px`,
                      }}
                      title={`${clipLabel(c, project)} · ${st}–${st + du} ms`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(c.id);
                        }
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editable && tool === 'split') {
                          const rect = content.current!.getBoundingClientRect();
                          const at = frameMs((e.clientX - rect.left - HEADER_W) / pxPerMs, fps);
                          if (canSplit(c, at)) onEdit([splitSpec(c, at)], `split ${c.id}`);
                          return;
                        }
                        onSelect(c.id);
                      }}
                      onPointerDown={(e) => beginDrag(e, c, 'move')}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={cancelDrag}
                    >
                      {editable && (
                        <span
                          class="handle handle-l"
                          data-handle="left"
                          onPointerDown={(e) => beginDrag(e, c, 'trim-left')}
                        />
                      )}
                      <span class="clip-label">{clipLabel(c, project)}</span>
                      {(showKeyframes ? kfs : []).map((k) => (
                        <span
                          key={k.id}
                          class="kf"
                          data-kf={k.id}
                          style={{ left: `${Math.min(du, Math.max(0, k.t)) * pxPerMs}px` }}
                          aria-hidden="true"
                        />
                      ))}
                      {editable && (
                        <span
                          class="handle handle-r"
                          data-handle="right"
                          onPointerDown={(e) => beginDrag(e, c, 'trim-right')}
                        />
                      )}
                    </div>
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
