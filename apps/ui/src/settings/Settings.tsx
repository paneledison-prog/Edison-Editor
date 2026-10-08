import { X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  checkConnector,
  getConnector,
  type ConnectorCheck,
  type ConnectorInfo,
  type OpSpec,
  type ProjectView,
} from '../api';
import { Button, IconButton } from '../components/Button';
import type { Theme } from '../theme';
import { DEFAULT_PREFS, type Prefs } from './prefs';

type Tab = 'appearance' | 'project' | 'connector';
const TABS: { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'project', label: 'Project' },
  { id: 'connector', label: 'Connector' },
];

export interface EditResult {
  ok: boolean;
  message?: string;
}
interface Props {
  project: ProjectView | null;
  editable: boolean;
  theme: Theme;
  prefs: Prefs;
  onTheme: (t: Theme) => void;
  onPrefs: (p: Prefs) => void;
  onEdit: (specs: OpSpec[], label: string) => Promise<EditResult>;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Settings({
  project,
  editable,
  theme,
  prefs,
  onTheme,
  onPrefs,
  onEdit,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>('appearance');
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  // Focus moves into the dialog, stays there, and returns to the opener on close.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
    const back = opener.current as HTMLElement | null;
    return () => back?.focus?.();
  }, []);
  // Escape and a stray Tab are handled on the window: when the focused button becomes disabled (Save after saving),
  // focus falls to the page body and the dialog's own handler would never see the key.
  useEffect(() => {
    const onWin = (e: KeyboardEvent) => {
      const inside = !!box.current?.contains(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab' && !inside) {
        e.preventDefault();
        box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    };
    window.addEventListener('keydown', onWin);
    return () => window.removeEventListener('keydown', onWin);
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i + TABS.length - 1) % TABS.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    queueMicrotask(() =>
      box.current?.querySelector<HTMLElement>(`#tab-${TABS[next]!.id}`)?.focus(),
    );
  };

  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={box}
        onKeyDown={onKeyDown}
        data-testid="settings"
      >
        <header class="modal-head">
          <h2 id="settings-title">Settings</h2>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={16} strokeWidth={1.5} />
          </IconButton>
        </header>
        <div class="modal-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              class={`modal-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div class="modal-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'appearance' && (
            <Appearance theme={theme} prefs={prefs} onTheme={onTheme} onPrefs={onPrefs} />
          )}
          {tab === 'project' && (
            <ProjectTab project={project} editable={editable} onEdit={onEdit} />
          )}
          {tab === 'connector' && <Connector />}
        </div>
      </div>
    </div>
  );
}

function Appearance({
  theme,
  prefs,
  onTheme,
  onPrefs,
}: Pick<Props, 'theme' | 'prefs' | 'onTheme' | 'onPrefs'>) {
  return (
    <div class="form">
      <fieldset class="field">
        <legend>Theme</legend>
        {(['light', 'dark'] as Theme[]).map((t) => (
          <label key={t} class="radio">
            <input type="radio" name="theme" checked={theme === t} onChange={() => onTheme(t)} />
            {t === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </fieldset>
      <label class="field">
        <span>Timeline zoom at start (pixels per second)</span>
        <input
          type="number"
          min={2}
          max={2000}
          step={10}
          value={prefs.zoomPxPerSec}
          onChange={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 2 && v <= 2000) onPrefs({ ...prefs, zoomPxPerSec: v });
          }}
        />
        <small class="muted">
          Applies the next time the page loads. Default {DEFAULT_PREFS.zoomPxPerSec}.
        </small>
      </label>
      <label class="radio">
        <input
          type="checkbox"
          checked={prefs.showKeyframes}
          onChange={(e) =>
            onPrefs({ ...prefs, showKeyframes: (e.target as HTMLInputElement).checked })
          }
        />
        Show keyframe markers on clips
      </label>
      <p class="muted">These choices are kept in this browser only.</p>
    </div>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function ProjectTab({ project, editable, onEdit }: Pick<Props, 'project' | 'editable' | 'onEdit'>) {
  const m = project?.meta;
  const [f, setF] = useState({
    name: m?.name ?? '',
    width: String(m?.width ?? ''),
    height: String(m?.height ?? ''),
    fps: String(m?.fps ?? ''),
    background: m?.background ?? '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  if (!project || !m)
    return (
      <p class="muted">
        Open a project with <code>studio ui</code> to change its settings.
      </p>
    );
  const errors: Record<string, string> = {};
  const int = (v: string) => /^\d+$/.test(v) && Number(v) > 0;
  if (!f.name.trim()) errors['name'] = 'A name is required';
  if (!int(f.width) || Number(f.width) > 16384) errors['width'] = 'A whole number from 1 to 16384';
  if (!int(f.height) || Number(f.height) > 16384)
    errors['height'] = 'A whole number from 1 to 16384';
  if (!(Number(f.fps) > 0 && Number(f.fps) <= 240)) errors['fps'] = 'A number above 0, up to 240';
  if (!HEX.test(f.background)) errors['background'] = 'A hex color with 6 digits after the hash';
  const patch: Record<string, unknown> = {};
  if (f.name !== m.name) patch['name'] = f.name;
  if (Number(f.width) !== m.width) patch['width'] = Number(f.width);
  if (Number(f.height) !== m.height) patch['height'] = Number(f.height);
  if (Number(f.fps) !== m.fps) patch['fps'] = Number(f.fps);
  if (f.background !== m.background) patch['background'] = f.background;
  const dirty = Object.keys(patch).length > 0;
  const bad = Object.keys(errors).length > 0;
  const field = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <label class="field">
      <span>{label}</span>
      <input
        value={f[k]}
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `err-${k}` : undefined}
        disabled={!editable}
        onInput={(e) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })}
        {...props}
      />
      {errors[k] && (
        <small id={`err-${k}`} class="error" role="alert">
          {errors[k]}
        </small>
      )}
    </label>
  );
  return (
    <form
      class="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (bad || !dirty) return;
        const r = await onEdit([{ type: 'project.set', args: { patch } }], 'project settings');
        setMsg(r.ok ? 'Saved. Undo restores the previous values.' : (r.message ?? 'Not saved'));
      }}
    >
      {field('name', 'Name')}
      <div class="row">
        {field('width', 'Width (px)', { inputMode: 'numeric' })}
        {field('height', 'Height (px)', { inputMode: 'numeric' })}
        {field('fps', 'Frame rate (fps)', { inputMode: 'decimal' })}
      </div>
      {field('background', 'Background color')}
      {(patch['width'] !== undefined ||
        patch['height'] !== undefined ||
        patch['fps'] !== undefined) && (
        <p class="muted">
          Changing the size or frame rate makes cached motion overlays render again on the next
          render.
        </p>
      )}
      <div class="actions">
        <Button type="submit" variant="secondary" disabled={!editable || !dirty || bad}>
          Save
        </Button>
        {!editable && <span class="muted">Editing is off (read-only or not connected).</span>}
        {msg && (
          <span role="status" class="muted" data-testid="project-msg">
            {msg}
          </span>
        )}
      </div>
    </form>
  );
}

function Connector() {
  const [info, setInfo] = useState<ConnectorInfo | null | undefined>(undefined);
  const [check, setCheck] = useState<ConnectorCheck | 'running' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void getConnector().then(setInfo);
  }, []);
  if (info === undefined) return <p class="muted">Loading…</p>;
  if (info === null)
    return (
      <p class="muted">
        The Studio server did not answer. Start the page with <code>studio ui</code>.
      </p>
    );
  const json = JSON.stringify(info.mcpJson, null, 2);
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
      // Without clipboard access the text is selected so Ctrl+C works.
      const el = document.getElementById(`code-${what}`);
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <div class="form">
      <p>
        Studio runs as an MCP server, so Claude Code can edit this project with the same commands
        and undo history as the page. {info.tools} tools are available.
      </p>
      <h3>1. Add it to Claude Code</h3>
      <p class="muted">Run this in a terminal (macOS or Linux shell):</p>
      <pre class="code" id="code-command" data-testid="connector-command">
        {info.command}
      </pre>
      <div class="actions">
        <Button onClick={() => copy('command', info.command)}>
          {copied === 'command' ? 'Copied' : 'Copy command'}
        </Button>
      </div>
      <p class="muted">
        Or put this in the project's <code>.mcp.json</code>:
      </p>
      <pre class="code" id="code-json">
        {json}
      </pre>
      <div class="actions">
        <Button onClick={() => copy('json', json)}>
          {copied === 'json' ? 'Copied' : 'Copy .mcp.json'}
        </Button>
      </div>
      <h3>2. Check the server starts</h3>
      <div class="actions">
        <Button
          onClick={async () => {
            setCheck('running');
            setCheck(await checkConnector());
          }}
          disabled={check === 'running'}
        >
          {check === 'running' ? 'Checking…' : 'Check server'}
        </Button>
        {check && check !== 'running' && (
          <span role="status" class={check.ok ? 'muted' : 'error'} data-testid="connector-check">
            {check.ok
              ? `Server started and listed ${check.tools} tools in ${check.ms} ms.`
              : `Failed: ${check.message ?? 'no answer'}`}
          </span>
        )}
      </div>
      <p class="muted">
        This only proves the server starts on this machine. Studio cannot see whether Claude Code is
        connected: run <code>/mcp</code> in Claude Code to confirm. The page never runs{' '}
        <code>claude</code> for you.
      </p>
    </div>
  );
}
