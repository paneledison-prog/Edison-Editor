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
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useLiveProject, type ProjectView } from './api';
import { Button, IconButton } from './components/Button';
import { EmptyState, PanelHeader } from './components/PanelHeader';
import { currentTheme, setTheme, type Theme } from './theme';
import { snapToFrame, timecode } from './timeline/format';
import { Timeline } from './timeline/Timeline';

const ic = { size: 16, strokeWidth: 1.5 } as const;
const LATER = 'Not available yet';
const DEFAULT_ZOOM = 0.1; // px per ms = 100 px per second
const MIN_ZOOM = 0.002;
const MAX_ZOOM = 2;

const baseName = (p: string) => p.split('/').pop() ?? p;

function Inspector({
  project,
  selectedId,
  timelineMs,
}: {
  project: ProjectView | null;
  selectedId: string | null;
  timelineMs: number;
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
  const { project, timelineMs, status, problem } = useLiveProject();
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, timelineMs, clampZoom]);

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
        <IconButton label="Undo" shortcut="Ctrl+Z" disabled>
          <Undo2 {...ic} />
        </IconButton>
        <IconButton label="Redo" shortcut="Ctrl+Shift+Z" disabled>
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
        <IconButton label="Select" shortcut="V" pressed>
          <MousePointer2 {...ic} />
        </IconButton>
        <IconButton label={`Split. ${LATER}`} shortcut="S" disabled>
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
        <Inspector project={project} selectedId={selectedId} timelineMs={timelineMs} />
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
