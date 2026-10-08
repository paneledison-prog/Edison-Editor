import {
  Circle,
  Hand,
  Maximize,
  MousePointer2,
  Moon,
  Play,
  Redo2,
  Repeat,
  Scissors,
  SkipBack,
  Sun,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { sendOps, sendRedo, sendUndo, useLiveProject, type OpSpec, type ProjectView } from './api';
import { Button, IconButton } from './components/Button';
import { EaseEditor } from './components/EaseEditor';
import { EmptyState, PanelHeader } from './components/PanelHeader';
import { KF_STEP, frameMs, kfSetSpecs } from './timeline/edit';
import { currentTheme, setTheme, type Theme } from './theme';
import { snapToFrame, timecode } from './timeline/format';
import { Timeline } from './timeline/Timeline';

const ic = { size: 16, strokeWidth: 1.5 } as const;
const LATER = 'Not available yet';
const DEFAULT_ZOOM = 0.1; // px per ms = 100 px per second
const MIN_ZOOM = 0.002;
const MAX_ZOOM = 2;

const baseName = (p: string) => p.split('/').pop() ?? p;

function KeyframeEditor({
  project,
  clipId,
  editable,
  onEdit,
}: {
  project: ProjectView;
  clipId: string;
  editable: boolean;
  onEdit: (specs: OpSpec[], label: string) => void;
}) {
  const clip = project.clips.find((c) => c.id === clipId);
  const [active, setActive] = useState<string | null>(null);
  const fps = project.meta.fps;
  if (!clip?.keyframes || !Object.keys(clip.keyframes).length) return null;
  return (
    <div data-testid="keyframes">
      <dt>Keyframes</dt>
      {Object.entries(clip.keyframes).map(([prop, kfs]) =>
        kfs.map((k) => (
          <div
            key={k.id}
            class={`kf-row ${active === k.id ? 'active' : ''}`}
            data-kf-row={k.id}
            tabIndex={0}
            onFocus={() => setActive(k.id)}
            onKeyDown={(e) => {
              if (!editable) return;
              const frame = Math.round(1000 / fps);
              const step = KF_STEP[prop] ?? 0.05;
              let next: { t?: number; v?: number } | null = null;
              if (e.key === 'ArrowLeft')
                next = { t: Math.max(0, k.t - frame * (e.shiftKey ? 10 : 1)) };
              else if (e.key === 'ArrowRight')
                next = { t: Math.min(clip.dur, k.t + frame * (e.shiftKey ? 10 : 1)) };
              else if (e.key === 'ArrowUp')
                next = { v: Math.round((k.v + step * (e.shiftKey ? 10 : 1)) * 1e4) / 1e4 };
              else if (e.key === 'ArrowDown')
                next = { v: Math.round((k.v - step * (e.shiftKey ? 10 : 1)) * 1e4) / 1e4 };
              if (!next) return;
              e.preventDefault();
              e.stopPropagation();
              if (next.t !== undefined) next.t = frameMs(next.t, fps);
              if (next.t === k.t) return;
              onEdit(kfSetSpecs(clip.id, prop, k, next), `nudge ${prop} keyframe`);
            }}
          >
            <span>
              {prop} <code>{k.t} ms</code> = <code>{k.v}</code>
            </span>
            <EaseEditor
              value={k.ease ?? 'linear'}
              disabled={!editable}
              onChange={(ease) =>
                onEdit(kfSetSpecs(clip.id, prop, k, { ease }), `ease ${prop} keyframe`)
              }
            />
          </div>
        )),
      )}
      <p class="muted">
        Focus a row, then arrows: left and right move it a frame (Shift: ten), up and down change
        the value.
      </p>
    </div>
  );
}

function Inspector({
  project,
  selectedId,
  timelineMs,
  editable,
  onEdit,
}: {
  project: ProjectView | null;
  selectedId: string | null;
  timelineMs: number;
  editable: boolean;
  onEdit: (specs: OpSpec[], label: string) => void;
}) {
  const clip = project?.clips.find((c) => c.id === selectedId);
  if (!project)
    return (
      <EmptyState>
        Open a project with <code>studio ui</code> to inspect it.
      </EmptyState>
    );
  const rows: [string, string][] = clip
    ? [
        ['Clip', clip.id],
        ['Track', project.tracks.find((t) => t.id === clip.track)?.name ?? clip.track],
        [
          clip.comp ? 'Composition' : 'Asset',
          clip.comp ?? baseName(project.assets[clip.asset!]?.path ?? clip.asset!),
        ],
        ['Start', `${clip.start} ms`],
        ['Duration', `${clip.dur} ms`],
        ['End', `${clip.start + clip.dur} ms`],
        ...(clip.srcIn !== undefined
          ? ([['Source in', `${clip.srcIn} ms`]] as [string, string][])
          : []),
        [
          'Keyframes',
          String(Object.values(clip.keyframes ?? {}).reduce((n, k) => n + k.length, 0)),
        ],
      ]
    : [
        ['Canvas', `${project.meta.width}×${project.meta.height}`],
        ['Frame rate', `${project.meta.fps} fps`],
        ['Duration', `${timelineMs} ms`],
        ['Tracks', String(project.tracks.length)],
        ['Clips', String(project.clips.length)],
      ];
  return (
    <dl class="props" data-testid="inspector">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {clip && (
        <KeyframeEditor project={project} clipId={clip.id} editable={editable} onEdit={onEdit} />
      )}
      {clip?.props && (
        <div>
          <dt>Props</dt>
          <dd>
            <code class="block">{JSON.stringify(clip.props, null, 1)}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

export function App() {
  const [theme, setT] = useState<Theme>(currentTheme());
  const { project, timelineMs, status, problem, rev, canUndo, canRedo, readOnly } =
    useLiveProject();
  const [tool, setTool] = useState<'select' | 'split'>('select');
  const [notice, setNotice] = useState<string | null>(null);
  const revRef = useRef(rev);
  revRef.current = rev;
  const editable = !!project && !readOnly && status === 'live';
  const report = useCallback((r: { ok: boolean; message?: string }) => {
    setNotice(r.ok ? null : (r.message ?? 'edit failed'));
  }, []);
  // Every edit names the revision it was made against; the server refuses it if an agent changed the project since.
  const edit = useCallback(
    async (specs: OpSpec[], label: string) => report(await sendOps(revRef.current, specs, label)),
    [report],
  );
  const undo = useCallback(async () => report(await sendUndo(revRef.current)), [report]);
  const redo = useCallback(async () => report(await sendRedo(revRef.current)), [report]);
  const [playheadMs, setPlayhead] = useState(0);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setT(next);
  };
  const clampZoom = useCallback((z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), []);

  // A live reload replaces `project` only. Drop the selection if that clip is gone; keep everything else.
  useEffect(() => {
    if (selectedId && project && !project.clips.some((c) => c.id === selectedId)) setSelected(null);
  }, [project, selectedId]);

  const fps = project?.meta.fps ?? 30;
  // The handler is read through a ref and subscribed once: re-subscribing after every state change leaves a gap
  // in which fast key presses are lost.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && editable) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (k === 'y') {
        e.preventDefault();
        void redo();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (editable && project) {
      if (e.key === 'v' || e.key === 'V') return void setTool('select');
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        // split the selected clip at the playhead, else every clip under the playhead on the first track that has one
        const t = playheadMs;
        const target =
          project.clips.find((c) => c.id === selectedId && t > c.start && t < c.start + c.dur) ??
          project.clips.find((c) => t > c.start && t < c.start + c.dur);
        if (target)
          void edit(
            [{ type: 'clip.split', args: { id: target.id, at: Math.round(t) } }],
            `split ${target.id}`,
          );
        else setNotice('Move the playhead inside a clip to split it');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        void edit(
          [{ type: e.shiftKey ? 'clip.ripple-delete' : 'clip.delete', args: { id: selectedId } }],
          `${e.shiftKey ? 'ripple ' : ''}delete ${selectedId}`,
        );
        return;
      }
    }
    const frame = 1000 / fps;
    // Functional updates: two quick key presses must compose even if this effect has not re-run in between.
    const clamp = (ms: number) => Math.min(Math.max(0, snapToFrame(ms, fps)), timelineMs);
    const step = (d: number) => {
      e.preventDefault();
      setPlayhead((p) => clamp(p + d));
    };
    const jump = (ms: number) => {
      e.preventDefault();
      setPlayhead(clamp(ms));
    };
    if (e.key === 'ArrowRight') step(frame * (e.shiftKey ? 10 : 1));
    else if (e.key === 'ArrowLeft') step(-frame * (e.shiftKey ? 10 : 1));
    else if (e.key === 'Home') jump(0);
    else if (e.key === 'End') jump(timelineMs);
    else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      setZoom((z) => clampZoom(z * 1.25));
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom((z) => clampZoom(z / 1.25));
    } else if (e.key === 'Escape') setSelected(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const assets = useMemo(() => (project ? Object.entries(project.assets) : []), [project]);
  const aspect = project ? `${project.meta.width} / ${project.meta.height}` : '16 / 9';
  const statusText = {
    connecting: 'Connecting',
    live: 'Live',
    offline: 'Reconnecting',
    'no-server': 'No project loaded',
  }[status];

  return (
    <div class="shell">
      <header class="topbar">
        <strong class="project-name">{project?.meta.name ?? 'Studio'}</strong>
        <span class="muted" data-testid="status" data-status={status} role="status">
          {statusText}
        </span>
        {problem && (
          <span class="problem" role="alert">
            {problem}
          </span>
        )}
        <span class="spacer" />
        {notice && (
          <span class="notice" role="status" data-testid="notice">
            {notice}
          </span>
        )}
        <IconButton
          label="Undo"
          shortcut="Ctrl+Z"
          disabled={!editable || !canUndo}
          onClick={() => void undo()}
        >
          <Undo2 {...ic} />
        </IconButton>
        <IconButton
          label="Redo"
          shortcut="Ctrl+Shift+Z"
          disabled={!editable || !canRedo}
          onClick={() => void redo()}
        >
          <Redo2 {...ic} />
        </IconButton>
        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={flip}
        >
          {theme === 'dark' ? <Sun {...ic} /> : <Moon {...ic} />}
        </IconButton>
        <Button variant="action" disabled title="Rendering from the UI is not available yet">
          Export
        </Button>
      </header>

      <nav class="rail" aria-label="Tools">
        <IconButton
          label="Select: drag clips to move, drag edges to trim"
          shortcut="V"
          pressed={tool === 'select'}
          onClick={() => setTool('select')}
        >
          <MousePointer2 {...ic} />
        </IconButton>
        <IconButton
          label="Split: click a clip, or press S at the playhead"
          shortcut="S"
          pressed={tool === 'split'}
          disabled={!editable}
          onClick={() => setTool('split')}
        >
          <Scissors {...ic} />
        </IconButton>
        <IconButton label={`Pan. ${LATER}`} shortcut="H" disabled>
          <Hand {...ic} />
        </IconButton>
      </nav>

      <aside class="panel assets" aria-label="Assets">
        <PanelHeader title="Assets" />
        {assets.length === 0 ? (
          <EmptyState>
            No assets yet. Ask Claude Code to ingest a file, or run{' '}
            <code>studio ingest &lt;file&gt;</code>.
          </EmptyState>
        ) : (
          <ul class="asset-list">
            {assets.map(([id, a]) => (
              <li key={id} class="asset-row" title={a.path}>
                <span
                  class={`dot dot-${a.kind === 'image' ? 'image' : a.kind}`}
                  aria-hidden="true"
                />
                <span class="asset-name">{baseName(a.path)}</span>
                <span class="muted asset-dur">
                  {a.probe.durMs !== undefined ? `${(a.probe.durMs / 1000).toFixed(1)} s` : a.kind}
                </span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main class="canvas" aria-label="Canvas">
        <div
          class="artboard"
          role="img"
          aria-label="Artboard"
          style={{ aspectRatio: aspect, background: project?.meta.background }}
        />
        <span class="badge" title="Proxy media and overlays; render a preview for the exact result">
          Approximate preview
        </span>
        {project && (
          <span class="canvas-note muted">
            No media preview yet. Render a preview to review the result.
          </span>
        )}
      </main>

      <aside class="panel inspector" aria-label="Inspector">
        <PanelHeader title={selectedId ? 'Clip' : 'Project'} />
        <Inspector
          project={project}
          selectedId={selectedId}
          timelineMs={timelineMs}
          editable={editable}
          onEdit={edit}
        />
      </aside>

      <section class="timeline" aria-label="Timeline">
        <div class="transport">
          <IconButton
            label={`To start. ${LATER}`}
            shortcut="Home"
            onClick={() => setPlayhead(0)}
            disabled={!project}
          >
            <SkipBack {...ic} />
          </IconButton>
          <IconButton label={`Play. ${LATER}`} shortcut="Space" disabled>
            <Play {...ic} />
          </IconButton>
          <IconButton label={`Loop. ${LATER}`} shortcut="L" disabled>
            <Repeat {...ic} />
          </IconButton>
          <IconButton label={`Record. ${LATER}`} disabled>
            <Circle {...ic} />
          </IconButton>
          <span class="timecode" aria-label="Playhead position" data-testid="timecode">
            {timecode(playheadMs)}
          </span>
          <span class="spacer" />
          <IconButton
            label="Zoom out"
            shortcut="-"
            onClick={() => setZoom((z) => clampZoom(z / 1.25))}
          >
            <ZoomOut {...ic} />
          </IconButton>
          <IconButton
            label="Zoom in"
            shortcut="="
            onClick={() => setZoom((z) => clampZoom(z * 1.25))}
          >
            <ZoomIn {...ic} />
          </IconButton>
          <IconButton
            label="Zoom to fit"
            shortcut="Shift+Z"
            disabled={!project || timelineMs === 0}
            onClick={() =>
              setZoom(clampZoom(Math.max(400, window.innerWidth - 148 - 40) / (timelineMs + 2000)))
            }
          >
            <Maximize {...ic} />
          </IconButton>
        </div>
        {project && project.tracks.length > 0 ? (
          <Timeline
            project={project}
            timelineMs={timelineMs}
            pxPerMs={zoom}
            playheadMs={playheadMs}
            selectedId={selectedId}
            onSeek={setPlayhead}
            onSelect={setSelected}
            onZoom={(z) => setZoom(clampZoom(z))}
            tool={tool}
            editable={editable}
            onEdit={edit}
          />
        ) : (
          <>
            <div class="ruler" aria-hidden="true" />
            <EmptyState>
              No clips yet. Ask Claude Code to add one, or run <code>studio tl add-clip</code>.
            </EmptyState>
          </>
        )}
      </section>
    </div>
  );
}
