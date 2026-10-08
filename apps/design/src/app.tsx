import {
  Circle, Download, Frame, Moon, MousePointer2, Pen, Redo2, Square, Star, Sun, Type, Undo2,
} from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { canLoad, scoped, sendExport, useLiveSnapshot, useWorkspaces, wsId, type ExportResult } from './api';
import { AnimatePanel } from './AnimatePanel';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { Layers } from './Layers';
import { Timeline, snapFrame } from './Timeline';
import { WorkspaceTabs } from './WorkspaceTabs';
import { commit, design, getState, locked, notify, propSpecs, receive, redo, selected, setState, undo, useS, type Tool } from './state';
import { currentTheme, setTheme, type Theme } from './theme';

const TOOLS: { tool: Tool; key: string; label: string; Icon: typeof Square }[] = [
  { tool: 'select', key: 'V', label: 'Select', Icon: MousePointer2 },
  { tool: 'frame', key: 'F', label: 'Frame', Icon: Frame },
  { tool: 'text', key: 'T', label: 'Text', Icon: Type },
  { tool: 'rect', key: 'R', label: 'Rectangle', Icon: Square },
  { tool: 'ellipse', key: 'O', label: 'Ellipse', Icon: Circle },
  { tool: 'star', key: 'S', label: 'Star', Icon: Star },
  { tool: 'pen', key: 'P', label: 'Pen (Enter to finish)', Icon: Pen },
];
const EXPORTS = [
  { fmt: 'mp4', label: 'MP4 video', note: 'H.264, with audio' },
  { fmt: 'webm', label: 'WebM', note: 'VP9; transparent if the background is' },
  { fmt: 'mov', label: 'MOV (ProRes 4444)', note: 'transparent video for editors' },
  { fmt: 'gif', label: 'GIF', note: 'up to 20 fps' },
  { fmt: 'png', label: 'PNG (this frame)', note: 'the frame at the playhead' },
  { fmt: 'png-seq', label: 'PNG sequence', note: 'one file per frame' },
] as const;

export function App() {
  const workspaces = useWorkspaces();
  const { snap, problem, live, set } = useLiveSnapshot(canLoad(workspaces));
  const s = useS((x) => x.snap);
  const tab = useS((x) => x.tab);
  const tool = useS((x) => x.tool);
  const notice = useS((x) => x.notice);
  const zoom = useS((x) => x.zoom);
  const [theme, setT] = useState<Theme>(currentTheme());
  const [menu, setMenu] = useState(false);

  // the server is the source of truth: every snapshot it sends replaces ours (an agent's edits arrive the same way)
  useEffect(() => {
    if (snap) receive(snap);
  }, [snap]);
  useEffect(() => setState({ live }), [live]);
  useEffect(() => {
    if (problem) notify(problem, 'error');
  }, [problem]);
  void set;

  // A hub opened without ?ws= goes to its first workspace.
  useEffect(() => {
    if (workspaces?.mode === 'hub' && !wsId && workspaces.workspaces[0]) location.replace(`?ws=${workspaces.workspaces[0].slot}`);
  }, [workspaces]);
  // Media is added by the agent. A file dropped on the page must not open in the browser or add anything.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (e.type === 'drop') notify('Images and audio are added by your agent: ask Claude Code to place the file.', 'info');
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  usePlayback();
  useKeys();

  if (workspaces?.mode === 'hub' && !wsId && workspaces.workspaces.length === 0)
    return (
      <div class="boot" role="status" data-testid="no-workspaces">
        No design workspaces are open. Ask Claude Code to open them (up to {workspaces.limit}), or run <code>studio ws open --kind design --count {workspaces.limit}</code>.
      </div>
    );
  if (!s) return <div class="boot" role="status">{problem ?? 'Loading the design…'}</div>;
  const d = s.design;
  const exporting = getState().exporting;
  const lease = s.lease;

  return (
    <div class="shell" data-testid="design-editor" data-locked={lease ? 'true' : undefined}>
      <header class="topbar">
        {workspaces?.mode === 'hub' && <WorkspaceTabs view={workspaces} />}
        <nav class="tools" aria-label="Tools" role="toolbar">
          {TOOLS.map(({ tool: t, key, label, Icon }) => (
            <button key={t} class={`tool ${tool === t ? 'on' : ''}`} disabled={!!lease && t !== 'select'} aria-label={label} aria-pressed={tool === t} title={`${label} (${key})`} data-tool={t} onClick={() => setState({ tool: t })}>
              <Icon size={17} />
            </button>
          ))}
        </nav>
        <SceneTitle name={d.meta.name} disabled={!!lease} />
        <div class="top-right">
          {lease && (
            <span class="agent-pill" data-testid="agent-status" role="status" title={lease.note ?? ''}>
              <span class="ws-dot" aria-hidden="true" />
              {lease.agent} is working{lease.note ? `: ${lease.note}` : ''} · view only
            </span>
          )}
          <span class={`pill ${live ? 'live' : 'off'}`} title={live ? 'Connected: agent edits appear here as they happen' : 'Disconnected from the editor server'}>{live ? 'Live' : 'Offline'}</span>
          <button class="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!s.canUndo || !!lease} onClick={undo}><Undo2 size={16} /></button>
          <button class="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo || !!lease} onClick={redo}><Redo2 size={16} /></button>
          <button class="zoom" aria-label="Fit to screen" title="Zoom (Ctrl + scroll); click to fit" onClick={() => setState({ fit: true })}>{Math.round(zoom * 100)}%</button>
          <button class="icon-btn" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => { const n = theme === 'dark' ? 'light' : 'dark'; setTheme(n); setT(n); }}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <div class="export-wrap">
            <button class="primary" disabled={!!lease} title={lease ? `${lease.agent} is working: export when it finishes` : undefined} aria-haspopup="menu" aria-expanded={menu} data-testid="export-btn" onClick={() => setMenu((v) => !v)}>
              <Download size={14} /> Export
            </button>
            {menu && !lease && <ExportMenu onClose={() => setMenu(false)} />}
          </div>
        </div>
      </header>
      <aside class="left" aria-label="Layers panel">
        <div class="panel-title">Layers</div>
        <Layers />
      </aside>
      <main class="center">
        <Canvas />
      </main>
      <aside class="right" aria-label="Properties panel">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'design'} class={tab === 'design' ? 'on' : ''} onClick={() => setState({ tab: 'design' })}>Design</button>
          <button role="tab" aria-selected={tab === 'animate'} class={tab === 'animate' ? 'on' : ''} data-testid="animate-tab" onClick={() => setState({ tab: 'animate' })}>Animate</button>
        </div>
        <div class="right-scroll" inert={!!lease}>{tab === 'design' ? <Inspector /> : <AnimatePanel />}</div>
      </aside>
      <footer class="bottom">
        <Timeline />
      </footer>
      {exporting && <div class="toast info" role="status">{exporting}</div>}
      {notice && <div class={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    </div>
  );
}

function SceneTitle({ name, disabled }: { name: string; disabled: boolean }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <input
      class="title"
      aria-label="Scene name"
      disabled={disabled}
      value={v}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onBlur={() => v.trim() && v !== name ? commit([{ type: 'scene.set', args: { patch: { name: v.trim().slice(0, 80) } } }], 'rename scene') : setV(name)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function ExportMenu({ onClose }: { onClose: () => void }) {
  const [alpha, setAlpha] = useState(false);
  const [scale, setScale] = useState(1);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = design()!;
  const run = async (fmt: string) => {
    setErr(null);
    setResult(null);
    setState({ exporting: `Rendering ${fmt.toUpperCase()}… this runs in a headless browser, so a long scene takes a moment.` });
    try {
      const r = await sendExport(fmt, { scale, alpha: alpha || d.meta.background === 'transparent', at: Math.round(getState().t) });
      setResult(r);
    } catch (e) {
      setErr((e as { message?: string }).message ?? 'The export failed.');
    } finally {
      setState({ exporting: null });
    }
  };
  return (
    <div class="menu" role="menu" data-testid="export-menu">
      <div class="menu-opts">
        <label class="check"><input type="checkbox" checked={alpha || d.meta.background === 'transparent'} disabled={d.meta.background === 'transparent'} onChange={(e) => setAlpha((e.target as HTMLInputElement).checked)} /> Transparent background</label>
        <label class="check">Scale
          <select value={String(scale)} aria-label="Export scale" onChange={(e) => setScale(Number((e.target as HTMLSelectElement).value))}>
            {[0.5, 1, 2].map((x) => <option key={x} value={x}>{x}x</option>)}
          </select>
        </label>
      </div>
      {EXPORTS.map((e) => (
        <button key={e.fmt} role="menuitem" class="menu-item" data-export={e.fmt} onClick={() => run(e.fmt)}>
          <span>{e.label}</span>
          <span class="muted">{e.note}</span>
        </button>
      ))}
      {err && <p class="menu-err" role="alert">{err}</p>}
      {result && (
        <p class="menu-ok" data-testid="export-result">
          Done: {result.width}×{result.height}, {result.frames} frame{result.frames === 1 ? '' : 's'}, {(result.bytes / 1024).toFixed(0)} KB in {(result.renderMs / 1000).toFixed(1)} s.{' '}
          <a href={result.url} download>Download</a> <span class="muted">(saved as {result.output})</span>
        </p>
      )}
      <button class="menu-close" onClick={onClose}>Close</button>
    </div>
  );
}

/** Plays the scene: time advances with the clock, the canvas redraws, audio layers follow. */
function usePlayback() {
  const playing = useS((x) => x.playing);
  const audio = useRef<Map<string, HTMLAudioElement>>(new Map());
  useEffect(() => {
    const d = design();
    if (!playing || !d) {
      for (const a of audio.current.values()) a.pause();
      return;
    }
    const { duration, fps } = d.meta;
    let last = performance.now();
    let raf = 0;
    const startT = getState().t >= duration - 1 ? 0 : getState().t;
    setState({ t: startT });
    const sync = (t: number) => {
      const dd = design()!;
      for (const l of dd.layers) {
        if (l.type !== 'audio' || l.visible === false) continue;
        let a = audio.current.get(l.id);
        if (!a) {
          a = new Audio(scoped('/' + l.src));
          audio.current.set(l.id, a);
        }
        const from = l.start ?? 0;
        const to = l.end ?? duration;
        a.volume = Math.min(1, l.volume ?? 1);
        if (t >= from && t < to) {
          const want = (t - from + (l.trimIn ?? 0)) / 1000;
          if (a.paused || Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
          if (a.paused) void a.play().catch(() => undefined);
        } else a.pause();
      }
    };
    sync(startT);
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      let t = getState().t + dt;
      if (t >= duration) {
        if (getState().loop) {
          t = 0;
          for (const a of audio.current.values()) a.pause();
        } else return setState({ t: duration, playing: false });
      }
      setState({ t });
      sync(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    void fps;
    return () => {
      cancelAnimationFrame(raf);
      for (const a of audio.current.values()) a.pause();
    };
  }, [playing]);
}

function useKeys() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input,textarea,select,[contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const st = getState();
      const d = design();
      if (!d) return;
      const view = locked(); // an agent is working: keys that look, play and select still work; keys that edit do nothing
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? void redo() : void undo();
      }
      if (mod && e.key.toLowerCase() === 'y') return void (e.preventDefault(), redo());
      if (view && mod && ['d', 'g'].includes(e.key.toLowerCase())) return void e.preventDefault();
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        return void commit(selected().map((l) => ({ type: 'layer.duplicate', args: { id: l.id } })), 'duplicate');
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        return setState({ selection: d.layers.filter((l) => l.parent === null).map((l) => l.id) });
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const ls = selected();
        if (e.shiftKey) {
          // ungroup
          const g = ls[0];
          if (!g || g.type !== 'group') return;
          const kids = d.layers.filter((l) => l.parent === g.id);
          const at = d.layers.filter((l) => l.parent === g.parent).findIndex((l) => l.id === g.id);
          return void commit([...kids.flatMap((k, i) => [{ type: 'layer.move', args: { id: k.id, parent: g.parent, index: at + 1 + i } }, { type: 'layer.set', args: { id: k.id, patch: { x: k.x + g.x, y: k.y + g.y } } }]), { type: 'layer.delete', args: { id: g.id } }], 'ungroup');
        }
        if (ls.length < 2 || ls.some((l) => l.parent !== ls[0]!.parent)) return notify('Select two or more layers with the same parent to group them.', 'error');
        const b = { x: Math.min(...ls.map((l) => l.x)), y: Math.min(...ls.map((l) => l.y)), r: Math.max(...ls.map((l) => l.x + l.w)), b: Math.max(...ls.map((l) => l.y + l.h)) };
        const sibs = d.layers.filter((l) => l.parent === ls[0]!.parent);
        const idx = Math.min(...ls.map((l) => sibs.findIndex((s) => s.id === l.id)));
        const gid = 'l_' + Array.from({ length: 4 }, () => '0123456789abcdefghjkmnpqrstvwxyz'[Math.floor(Math.random() * 32)]).join('');
        const out = commit([
          { type: 'layer.add', args: { layer: { type: 'group', id: gid, name: 'Group', parent: ls[0]!.parent, x: b.x, y: b.y, w: b.r - b.x, h: b.b - b.y }, index: idx } },
          ...ls.flatMap((l) => [{ type: 'layer.move', args: { id: l.id, parent: gid } }, { type: 'layer.set', args: { id: l.id, patch: { x: l.x - b.x, y: l.y - b.y } } }]),
        ], 'group');
        if (out.length) setState({ selection: [gid] });
        return;
      }
      if (mod && (e.key === '0' || e.key === '1')) return void (e.preventDefault(), e.key === '0' ? setState({ fit: true }) : setState({ fit: false, zoom: 1 }));
      if (mod && (e.key === '=' || e.key === '+' || e.key === '-')) {
        e.preventDefault();
        return setState({ fit: false, zoom: Math.min(8, Math.max(0.05, st.zoom * (e.key === '-' ? 0.8 : 1.25))) });
      }
      if (mod) return;
      if (e.key === ' ') return void (e.preventDefault(), setState({ playing: !st.playing }));
      if (e.key === 'Home') return setState({ t: 0, playing: false });
      if (e.key === 'End') return setState({ t: d.meta.duration, playing: false });
      const frame = (dir: number) => {
        const step = (e.shiftKey ? 10 : 1) * (1000 / d.meta.fps);
        setState({ playing: false, t: Math.min(d.meta.duration, Math.max(0, snapFrame(st.t + dir * step, d.meta.fps))) });
      };
      if (e.key === ',' || e.key === '.') return void (e.preventDefault(), frame(e.key === ',' ? -1 : 1));
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        if (view && st.selection.length) return;
        if (!st.selection.length) return e.key === 'ArrowLeft' ? frame(-1) : e.key === 'ArrowRight' ? frame(1) : undefined;
        const n = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
        const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
        return void commit(selected().flatMap((l) => propSpecs(l, dx ? 'x' : 'y', dx ? l.x + dx : l.y + dy, dx ? { x: l.x + dx } : { y: l.y + dy })), 'nudge');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection.length) {
        e.preventDefault();
        if (view) return;
        const ids = st.selection;
        setState({ selection: [] });
        return void commit(ids.map((id) => ({ type: 'layer.delete', args: { id } })), 'delete');
      }
      if (e.key === 'Escape') return setState({ selection: [], tool: 'select' });
      const hit = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (hit && !(view && hit.tool !== 'select')) setState({ tool: hit.tool });
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
