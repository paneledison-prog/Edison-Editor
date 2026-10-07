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
import { useState } from 'preact/hooks';
import { Button, IconButton } from './components/Button';
import { EmptyState, PanelHeader } from './components/PanelHeader';
import { currentTheme, setTheme, type Theme } from './theme';

const ic = { size: 16, strokeWidth: 1.5 } as const;
const LATER = 'Not available yet';

export function App() {
  const [theme, setT] = useState<Theme>(currentTheme());
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setT(next);
  };

  return (
    <div class="shell">
      <header class="topbar">
        <strong class="project-name">Studio</strong>
        <span class="muted">No project loaded</span>
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
        <Button variant="action" disabled title="Rendering is not available yet">
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
        <EmptyState>
          No assets yet. Ask Claude Code to ingest a file, or run{' '}
          <code>studio ingest &lt;file&gt;</code>.
        </EmptyState>
      </aside>

      <main class="canvas" aria-label="Canvas">
        <div class="artboard" role="img" aria-label="Empty artboard" />
        <span class="badge" title="Proxy media and overlays; render a preview for the exact result">
          Approximate preview
        </span>
      </main>

      <aside class="panel inspector" aria-label="Inspector">
        <PanelHeader title="Inspector" />
        <EmptyState>
          Select a clip to see its transform, fill, stroke, grid, and export settings.
        </EmptyState>
      </aside>

      <section class="timeline" aria-label="Timeline">
        <div class="transport">
          <IconButton label={`To start. ${LATER}`} shortcut="Home" disabled>
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
          <span class="timecode" aria-label="Playhead position">
            00:00:00.000
          </span>
          <span class="spacer" />
          <IconButton label={`Zoom out. ${LATER}`} shortcut="-" disabled>
            <ZoomOut {...ic} />
          </IconButton>
          <IconButton label={`Zoom in. ${LATER}`} shortcut="=" disabled>
            <ZoomIn {...ic} />
          </IconButton>
          <IconButton label={`Zoom to fit. ${LATER}`} shortcut="Shift+Z" disabled>
            <Maximize {...ic} />
          </IconButton>
        </div>
        <div class="ruler" aria-hidden="true" />
        <EmptyState>
          No clips yet. Ask Claude Code to add one, or run <code>studio tl add-clip</code>.
        </EmptyState>
      </section>
    </div>
  );
}
