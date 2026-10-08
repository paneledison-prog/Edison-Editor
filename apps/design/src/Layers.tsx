import {
  AudioLines, ChevronDown, ChevronRight, Circle, Eye, EyeOff, Folder, Frame, Image as ImageIcon, Lock, Spline, Square, Star, Type, Unlock,
} from 'lucide-preact';
import { useState } from 'preact/hooks';
import { CONTAINERS, type Design, type Layer } from '@studio/design';
import { commit, getState, setState, useS } from './state';

const ICON: Record<string, typeof Square> = {
  frame: Frame, group: Folder, rect: Square, ellipse: Circle, star: Star, path: Spline, text: Type, image: ImageIcon, audio: AudioLines,
};

interface Row {
  layer: Layer;
  depth: number;
}
/** Front-most first, like every design tool: the last sibling is drawn on top, so it is listed first. */
function flatten(d: Design, expanded: Record<string, boolean>): Row[] {
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = d.layers.filter((l) => l.parent === parent).reverse();
    for (const l of kids) {
      out.push({ layer: l, depth });
      if (CONTAINERS.includes(l.type) && expanded[l.id] !== false) walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

type Drop = { id: string; where: 'above' | 'below' | 'inside' } | null;

export function Layers() {
  const d = useS((s) => s.draft ?? s.snap?.design ?? null);
  const sel = useS((s) => s.selection);
  const expanded = useS((s) => s.expanded);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  if (!d) return null;
  const rows = flatten(d, expanded);

  const select = (id: string, e: MouseEvent) => {
    const cur = getState().selection;
    setState({ selection: e.shiftKey || e.metaKey || e.ctrlKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id] });
  };
  const doDrop = () => {
    if (!drag || !drop || drag === drop.id) return setDrop(null);
    const target = d.layers.find((l) => l.id === drop.id)!;
    const parent = drop.where === 'inside' ? target.id : target.parent;
    const sibs = d.layers.filter((l) => l.parent === parent && l.id !== drag);
    const at = drop.where === 'inside' ? sibs.length : sibs.findIndex((l) => l.id === target.id) + (drop.where === 'above' ? 1 : 0);
    commit([{ type: 'layer.move', args: { id: drag, parent, index: at } }], 'reorder layer');
    setDrag(null);
    setDrop(null);
  };

  return (
    <div class="layers" data-testid="layers" role="tree" aria-label="Layers">
      {rows.length === 0 && <p class="empty">No layers yet. Pick a tool above and drag on the canvas.</p>}
      {rows.map(({ layer: l, depth }) => {
        const Icon = ICON[l.type] ?? Square;
        const isC = CONTAINERS.includes(l.type);
        const open = expanded[l.id] !== false;
        const on = sel.includes(l.id);
        return (
          <div
            key={l.id}
            role="treeitem"
            aria-selected={on}
            class={`layer-row ${on ? 'on' : ''} ${l.visible === false ? 'off' : ''} ${drop?.id === l.id ? `drop-${drop.where}` : ''}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            data-layer-row={l.id}
            draggable={editing !== l.id}
            onDragStart={(e) => {
              setDrag(l.id);
              e.dataTransfer?.setData('text/plain', l.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const y = (e.clientY - r.top) / r.height;
              setDrop({ id: l.id, where: isC && y > 0.3 && y < 0.7 ? 'inside' : y < 0.5 ? 'above' : 'below' });
            }}
            onDragLeave={() => setDrop((x) => (x?.id === l.id ? null : x))}
            onDrop={(e) => {
              e.preventDefault();
              doDrop();
            }}
            onDragEnd={() => (setDrag(null), setDrop(null))}
            onClick={(e) => select(l.id, e as unknown as MouseEvent)}
          >
            <button
              class="caret"
              tabIndex={-1}
              aria-label={isC ? (open ? 'Collapse' : 'Expand') : ''}
              style={{ visibility: isC ? 'visible' : 'hidden' }}
              onClick={(e) => {
                e.stopPropagation();
                setState({ expanded: { ...expanded, [l.id]: !open } });
              }}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <Icon size={14} class="type-icon" />
            {editing === l.id ? (
              <input
                class="rename"
                autoFocus
                defaultValue={l.name}
                aria-label="Layer name"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  setEditing(null);
                  if (v && v !== l.name) commit([{ type: 'layer.set', args: { id: l.id, patch: { name: v.slice(0, 80) } } }], 'rename layer');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span class="name" onDblClick={() => setEditing(l.id)}>{l.name}</span>
            )}
            <span class="row-actions">
              <button
                class="icon-btn"
                aria-label={l.locked ? 'Unlock' : 'Lock'}
                title={l.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit([{ type: 'layer.set', args: { id: l.id, patch: { locked: l.locked ? null : true } } }], 'lock');
                }}
              >
                {l.locked ? <Lock size={12} /> : <Unlock size={12} />}
              </button>
              <button
                class="icon-btn"
                aria-label={l.visible === false ? 'Show' : 'Hide'}
                title={l.visible === false ? 'Show' : 'Hide'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit([{ type: 'layer.set', args: { id: l.id, patch: { visible: l.visible === false ? null : false } } }], 'visibility');
                }}
              >
                {l.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
