import { useEffect, useState } from 'preact/hooks';
import {
  ANIMATABLE, applyBatch, defaultCtx, OpError, subtree, type Design, type Layer, type OpSpec,
} from '@studio/design';
import { sendOps, sendRedo, sendUndo, type ApiError, type Snapshot } from './api';

export type Tool = 'select' | 'frame' | 'text' | 'rect' | 'ellipse' | 'star' | 'image' | 'audio' | 'pen';

export interface State {
  snap: Snapshot | null;
  /** a drag in progress: drawn, not sent */
  draft: Design | null;
  selection: string[];
  t: number;
  playing: boolean;
  loop: boolean;
  tool: Tool;
  zoom: number;
  pan: { x: number; y: number };
  fit: boolean;
  tab: 'design' | 'animate';
  expanded: Record<string, boolean>;
  notice: { text: string; kind: 'info' | 'error' } | null;
  live: boolean;
  exporting: string | null;
}

const state: State = {
  snap: null, draft: null, selection: [], t: 0, playing: false, loop: true, tool: 'select', zoom: 1,
  pan: { x: 0, y: 0 }, fit: true, tab: 'design', expanded: {}, notice: null, live: false, exporting: null,
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State>): void {
  Object.assign(state, patch);
  subs.forEach((f) => f());
}
export function useS<T>(pick: (s: State) => T): T {
  const [, tick] = useState(0);
  useEffect(() => {
    let last = pick(state);
    const f = () => {
      const n = pick(state);
      if (n !== last) {
        last = n;
        tick((x) => x + 1);
      }
    };
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return pick(state);
}

export const design = (): Design | null => state.draft ?? state.snap?.design ?? null;
export const layerById = (id: string): Layer | undefined => design()?.layers.find((l) => l.id === id);
export const selected = (): Layer[] => state.selection.map(layerById).filter(Boolean) as Layer[];

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  setState({ notice: { text, kind } });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setState({ notice: null }), kind === 'error' ? 7000 : 3000);
}

export function receive(s: Snapshot): void {
  const ids = new Set(s.design.layers.map((l) => l.id));
  setState({ snap: s, draft: null, selection: state.selection.filter((id) => ids.has(id)) });
}

/**
 * One edit: applied here first so the canvas answers at once, then sent as one validated op batch (actor ui). If the
 * server refuses (or an agent changed the design underneath), the server's version replaces ours and we say why.
 */
let sending: Promise<unknown> = Promise.resolve();
export function commit(specs: OpSpec[], label: string): OpSpec[] {
  const snap = state.snap;
  if (!snap || !specs.length) return [];
  if (snap.readOnly) {
    notify('This editor is read-only.', 'error');
    return [];
  }
  let next: Design;
  let resolved: OpSpec[];
  try {
    const r = applyBatch(snap.design, specs, defaultCtx('ui'));
    next = r.design;
    // the resolved args carry the ids chosen here, so the server replays exactly this edit
    resolved = r.ops.map((o) => ({ type: o.type, args: o.args }));
  } catch (e) {
    notify(e instanceof OpError ? e.message : String(e), 'error');
    setState({ draft: null });
    return [];
  }
  setState({ snap: { ...snap, design: next }, draft: null });
  sending = sending.then(async () => {
    try {
      receive(await sendOps(resolved, getState().snap!.rev, label));
    } catch (e) {
      const err = e as ApiError;
      notify(err.code === 'STALE' ? 'An agent changed the design while you were editing; your change was not applied.' : (err.message ?? 'The edit failed.'), 'error');
      refetch();
    }
  });
  return resolved;
}

export async function refetch(): Promise<void> {
  try {
    receive(await (await fetch('/api/design')).json());
  } catch {
    /* the live stream will deliver it */
  }
}
export async function undo(): Promise<void> {
  if (!state.snap?.canUndo || state.snap.readOnly) return;
  try {
    receive(await sendUndo(state.snap.rev));
  } catch (e) {
    notify((e as ApiError).message, 'error');
    refetch();
  }
}
export async function redo(): Promise<void> {
  if (!state.snap?.canRedo || state.snap.readOnly) return;
  try {
    receive(await sendRedo(state.snap.rev));
  } catch (e) {
    notify((e as ApiError).message, 'error');
    refetch();
  }
}

// ----- edits by property --------------------------------------------------------------------------------------------

const ANIM = new Set<string>(ANIMATABLE);
/** `fill` and `stroke` are animated as colours; their static value lives in the fill/stroke objects. */
export function hasKeys(l: Layer, prop: string): boolean {
  return !!l.anim?.[prop]?.length;
}

/**
 * A change to one property of one layer. If the property already has keyframes, the change is a keyframe at the
 * playhead (so moving a layer while animating records motion); otherwise it changes the base value.
 */
export function propSpecs(l: Layer, prop: string, value: unknown, patch: Record<string, unknown>): OpSpec[] {
  const d = design()!;
  if (ANIM.has(prop) && hasKeys(l, prop) && (typeof value === 'number' || typeof value === 'string')) {
    const t = Math.min(Math.max(0, Math.round(state.t)), d.meta.duration);
    return [{ type: 'kf.set', args: { layer: l.id, prop, t, v: value } }];
  }
  return [{ type: 'layer.set', args: { id: l.id, patch } }];
}

/** The ids of everything inside `id` (and `id`), for selection and drag logic. */
export const withDescendants = (id: string): string[] => (design() ? subtree(design()!, id).map((l) => l.id) : [id]);
