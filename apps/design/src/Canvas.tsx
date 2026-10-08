import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { resolve, type Design, type Layer } from '@studio/design';
import { Scene } from '@studio/design/render';
import { scoped } from './api';
import { commit, design, getState, locked, notify, propSpecs, setState, useS, withDescendants, type Tool } from './state';

const TOOL_TYPES: Partial<Record<Tool, string>> = { frame: 'frame', rect: 'rect', ellipse: 'ellipse', star: 'star', text: 'text' };

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}
type Guide = { axis: 'x' | 'y'; at: number };

/** Rotation and scale inherited from a layer's parents at time t. */
function inherited(d: Design, l: Layer, t: number): { rot: number; scale: number } {
  let rot = 0;
  let scale = 1;
  for (let p = l.parent; p; ) {
    const pl = d.layers.find((x) => x.id === p);
    if (!pl) break;
    const r = resolve(pl, t, d.meta.duration);
    rot += r.rotation;
    scale *= r.scale;
    p = pl.parent;
  }
  return { rot, scale };
}
const rad = (deg: number) => (deg * Math.PI) / 180;
const rotate = (x: number, y: number, deg: number): [number, number] => [x * Math.cos(rad(deg)) - y * Math.sin(rad(deg)), x * Math.sin(rad(deg)) + y * Math.cos(rad(deg))];

export function Canvas() {
  const host = useRef<HTMLDivElement>(null);
  const rootEl = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const d = useS((s) => s.draft ?? s.snap?.design ?? null);
  const t = useS((s) => s.t);
  const zoom = useS((s) => s.zoom);
  const pan = useS((s) => s.pan);
  const fit = useS((s) => s.fit);
  const tool = useS((s) => s.tool);
  const sel = useS((s) => s.selection);
  const fonts = useS((s) => s.snap?.fonts);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [guides, setGuides] = useState<Guide[]>([]);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pen, setPen] = useState<{ pts: [number, number][]; cursor: [number, number] | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const lease = useS((s) => s.snap?.lease ?? null);

  // fonts: the editor draws text with the same font files the export uses
  useEffect(() => {
    for (const f of fonts ?? []) {
      const face = new FontFace(f.family, `url(${scoped(f.url)})`, { weight: f.weight });
      face.load().then((ff) => (document.fonts as unknown as { add(f: FontFace): void }).add(ff)).catch(() => undefined);
    }
  }, [fonts?.length]);

  useLayoutEffect(() => {
    if (!rootEl.current || sceneRef.current) return;
    sceneRef.current = new Scene(rootEl.current, { assetUrl: (src) => (src.startsWith('data:') ? src : scoped('/' + src)), fontFamily: 'Inter' });
  }, []);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // fit the artboard to the viewport until the person zooms or pans themselves
  useEffect(() => {
    if (!fit || !d) return;
    const z = Math.max(0.05, Math.min((size.w - 120) / d.meta.width, (size.h - 120) / d.meta.height, 4));
    setState({ zoom: z, pan: { x: (size.w - d.meta.width * z) / 2, y: (size.h - d.meta.height * z) / 2 } });
  }, [fit, size.w, size.h, d?.meta.width, d?.meta.height]);

  // draw, then measure the selection from what was actually drawn
  useLayoutEffect(() => {
    if (!d || !sceneRef.current) return;
    sceneRef.current.update(d, t);
    const hostRect = host.current!.getBoundingClientRect();
    const next: Record<string, Box> = {};
    for (const id of sel) {
      const l = d.layers.find((x) => x.id === id);
      const el = sceneRef.current.elementOf(id);
      if (!l || !el || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const res = resolve(l, t, d.meta.duration);
      const inh = inherited(d, l, t);
      next[id] = {
        cx: r.left + r.width / 2 - hostRect.left,
        cy: r.top + r.height / 2 - hostRect.top,
        w: res.w * res.scale * inh.scale * zoom,
        h: res.h * res.scale * inh.scale * zoom,
        rot: res.rotation + inh.rot,
      };
    }
    setBoxes((b) => (JSON.stringify(b) === JSON.stringify(next) ? b : next));
  }, [d, t, sel, zoom, pan, size.w, size.h]);

  const toScene = (cx: number, cy: number): [number, number] => {
    const r = host.current!.getBoundingClientRect();
    const s = getState();
    return [(cx - r.left - s.pan.x) / s.zoom, (cy - r.top - s.pan.y) / s.zoom];
  };

  /** The layer under the pointer: groups select as a whole; frames let you reach what is inside them. */
  const hit = (cx: number, cy: number): Layer | null => {
    const dd = design();
    if (!dd) return null;
    for (const el of document.elementsFromPoint(cx, cy)) {
      const id = (el as HTMLElement).dataset?.['layer'] ?? (el.closest?.('[data-layer]') as HTMLElement | null)?.dataset['layer'];
      if (!id) continue;
      let l = dd.layers.find((x) => x.id === id);
      if (!l || l.locked || l.visible === false) continue;
      // climb to the outermost group
      for (let p = l.parent; p; ) {
        const pl = dd.layers.find((x) => x.id === p);
        if (!pl) break;
        if (pl.type === 'group' && !pl.locked) l = pl;
        p = pl.parent;
      }
      return l;
    }
    return null;
  };
  const frameAt = (cx: number, cy: number): Layer | null => {
    const dd = design()!;
    for (const el of document.elementsFromPoint(cx, cy)) {
      const id = (el as HTMLElement).dataset?.['layer'];
      const l = id ? dd.layers.find((x) => x.id === id) : undefined;
      if (l && (l.type === 'frame') && !l.locked) return l;
    }
    return null;
  };

  // ----- move / resize / rotate -----------------------------------------------------------------------------------
  const startMove = (e: PointerEvent, ids: string[]) => {
    const dd = design()!;
    const layers = ids.map((id) => dd.layers.find((l) => l.id === id)!).filter((l) => l && !l.locked);
    if (!layers.length) return;
    const s = getState();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const first = layers[0]!;
    const inh = inherited(dd, first, s.t);
    const parent = first.parent ? dd.layers.find((l) => l.id === first.parent) : null;
    const frame = { w: parent ? parent.w : dd.meta.width, h: parent ? parent.h : dd.meta.height };
    const sibs = dd.layers.filter((l) => l.parent === first.parent && !ids.includes(l.id));
    const base = layers.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }));
    const bb = { x: Math.min(...base.map((b) => b.x)), y: Math.min(...base.map((b) => b.y)), r: Math.max(...base.map((b) => b.x + b.w)), b: Math.max(...base.map((b) => b.y + b.h)) };
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    const move = (m: PointerEvent) => {
      let [dx, dy] = rotate((m.clientX - x0) / s.zoom, (m.clientY - y0) / s.zoom, -inh.rot);
      dx /= inh.scale;
      dy /= inh.scale;
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return;
      moved = true;
      if (m.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      const gs: Guide[] = [];
      if (inh.rot === 0 && !m.altKey) {
        const thr = 6 / s.zoom / inh.scale;
        const xs = [0, frame.w / 2, frame.w, ...sibs.flatMap((l) => [l.x, l.x + l.w / 2, l.x + l.w])];
        const ys = [0, frame.h / 2, frame.h, ...sibs.flatMap((l) => [l.y, l.y + l.h / 2, l.y + l.h])];
        const mine = (v: number, lo: number, hi: number) => [v + lo, v + (lo + hi) / 2, v + hi];
        const snapAxis = (cands: number[], edges: number[], delta: number, axis: 'x' | 'y') => {
          let best: { d: number; at: number } | null = null;
          for (const e1 of edges) for (const c of cands) {
            const dd2 = c - (e1 + delta);
            if (Math.abs(dd2) <= thr && (!best || Math.abs(dd2) < Math.abs(best.d))) best = { d: dd2, at: c };
          }
          if (best) gs.push({ axis, at: best.at });
          return best ? delta + best.d : delta;
        };
        dx = snapAxis(xs, [bb.x, (bb.x + bb.r) / 2, bb.r], dx, 'x');
        dy = snapAxis(ys, [bb.y, (bb.y + bb.b) / 2, bb.b], dy, 'y');
        void mine;
      }
      lastX = Math.round(dx * 100) / 100;
      lastY = Math.round(dy * 100) / 100;
      setGuides(gs);
      const cur = design()!;
      const m2 = new Map(base.map((b) => [b.id, b]));
      setState({ draft: { ...cur, layers: cur.layers.map((l) => (m2.has(l.id) ? ({ ...l, x: m2.get(l.id)!.x + lastX, y: m2.get(l.id)!.y + lastY } as Layer) : l)) } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides([]);
      if (!moved) return setState({ draft: null });
      const cur = getState().snap!.design;
      commit(
        base.flatMap((b) => {
          const l = cur.layers.find((x) => x.id === b.id)!;
          return [...propSpecs(l, 'x', Math.round((b.x + lastX) * 100) / 100, { x: Math.round((b.x + lastX) * 100) / 100 }), ...propSpecs(l, 'y', Math.round((b.y + lastY) * 100) / 100, { y: Math.round((b.y + lastY) * 100) / 100 })];
        }),
        'move',
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startResize = (e: PointerEvent, l: Layer, hx: number, hy: number) => {
    e.stopPropagation();
    const dd = design()!;
    const s = getState();
    const inh = inherited(dd, l, s.t);
    const b0 = { x: l.x, y: l.y, w: l.w, h: l.h };
    const rot = (l.rotation ?? 0);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let out = b0;
    const move = (m: PointerEvent) => {
      let [dx, dy] = rotate((m.clientX - x0) / s.zoom, (m.clientY - y0) / s.zoom, -(inh.rot + rot));
      dx /= inh.scale * (l.scale ?? 1);
      dy /= inh.scale * (l.scale ?? 1);
      let w = b0.w + hx * dx;
      let h = b0.h + hy * dy;
      if (m.shiftKey && hx && hy) {
        const k = Math.max(w / b0.w, h / b0.h);
        w = b0.w * k;
        h = b0.h * k;
      }
      w = Math.max(1, w);
      h = Math.max(1, h);
      // keep the opposite edge fixed: the centre moves half the size change along the rotated axes
      const [cx, cy] = rotate((hx * (w - b0.w)) / 2, (hy * (h - b0.h)) / 2, rot);
      out = { x: Math.round((b0.x + b0.w / 2 + cx - w / 2) * 100) / 100, y: Math.round((b0.y + b0.h / 2 + cy - h / 2) * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
      const cur = design()!;
      setState({ draft: { ...cur, layers: cur.layers.map((x) => (x.id === l.id ? ({ ...x, ...out } as Layer) : x)) } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = getState().snap!.design.layers.find((x) => x.id === l.id)!;
      if (out === b0) return setState({ draft: null });
      commit(['x', 'y', 'w', 'h'].flatMap((k) => propSpecs(cur, k, (out as Record<string, number>)[k]!, { [k]: (out as Record<string, number>)[k]! })), 'resize');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startRotate = (e: PointerEvent, l: Layer, box: Box) => {
    e.stopPropagation();
    const hostRect = host.current!.getBoundingClientRect();
    const inh = inherited(design()!, l, getState().t);
    let deg = l.rotation ?? 0;
    const move = (m: PointerEvent) => {
      const a = (Math.atan2(m.clientY - hostRect.top - box.cy, m.clientX - hostRect.left - box.cx) * 180) / Math.PI + 90 - inh.rot;
      deg = Math.round((m.shiftKey ? Math.round(a / 15) * 15 : a) * 10) / 10;
      const cur = design()!;
      setState({ draft: { ...cur, layers: cur.layers.map((x) => (x.id === l.id ? ({ ...x, rotation: deg } as Layer) : x)) } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = getState().snap!.design.layers.find((x) => x.id === l.id)!;
      commit(propSpecs(cur, 'rotation', deg, { rotation: deg }), 'rotate');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ----- creating layers ----------------------------------------------------------------------------------------
  const localPoint = (cx: number, cy: number, parent: Layer | null): [number, number] => {
    const [sx, sy] = toScene(cx, cy);
    if (!parent) return [sx, sy];
    const el = sceneRef.current!.elementOf(parent.id)!.getBoundingClientRect();
    const [px, py] = toScene(el.left, el.top);
    return [sx - px, sy - py];
  };
  const create = (type: string, extra: Record<string, unknown>, parent: Layer | null) => {
    const layer: Record<string, unknown> = { type, ...extra, ...(parent ? { parent: parent.id } : {}) };
    const specs = commit([{ type: 'layer.add', args: { layer } }], `add ${type}`);
    const id = (specs[0]?.args as { layer?: { id?: string } } | undefined)?.layer?.id;
    if (id) setState({ selection: [id], tool: 'select' });
    return id;
  };

  const startCreate = (e: PointerEvent, type: string) => {
    const parent = frameAt(e.clientX, e.clientY);
    const [x0, y0] = localPoint(e.clientX, e.clientY, parent);
    const [sx0, sy0] = toScene(e.clientX, e.clientY);
    let dragged = false;
    let rect = { x: x0, y: y0, w: 0, h: 0 };
    const move = (m: PointerEvent) => {
      const [x1, y1] = localPoint(m.clientX, m.clientY, parent);
      const [sx1, sy1] = toScene(m.clientX, m.clientY);
      dragged = dragged || Math.hypot(sx1 - sx0, sy1 - sy0) * getState().zoom > 4;
      let w = x1 - x0;
      let h = y1 - y0;
      if (m.shiftKey) w = h = Math.max(Math.abs(w), Math.abs(h)) * Math.sign(w || 1);
      rect = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) };
      setGhost({ x: Math.min(sx0, sx0 + (sx1 - sx0)), y: Math.min(sy0, sy1), w: Math.abs(sx1 - sx0), h: Math.abs(sy1 - sy0) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
      const props = dragged && r.w > 2 && r.h > 2 ? r : type === 'text' ? { x: Math.round(x0), y: Math.round(y0) } : { x: Math.round(x0 - 80), y: Math.round(y0 - 60) };
      const id = create(type, type === 'text' && dragged ? { ...props, h: Math.max(props['h' as keyof typeof props] as number, 40) } : props, parent);
      if (type === 'text' && id) setTimeout(() => setEditing(id), 30);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const finishPen = (pts: [number, number][]) => {
    setPen(null);
    if (pts.length < 2) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(4, Math.max(...xs) - x);
    const h = Math.max(4, Math.max(...ys) - y);
    const dstr = pts.map((p, i) => `${i ? 'L' : 'M'}${Math.round((p[0] - x) * 10) / 10} ${Math.round((p[1] - y) * 10) / 10}`).join(' ');
    create('path', { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), d: dstr }, null);
  };

  // ----- pointer entry ------------------------------------------------------------------------------------------
  const down = (e: PointerEvent) => {
    if (!d) return;
    const s = getState();
    if (e.button === 1 || spaceDown || s.tool === 'select' && e.button === 2) {
      e.preventDefault();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const p0 = s.pan;
      const move = (m: PointerEvent) => setState({ fit: false, pan: { x: p0.x + m.clientX - x0, y: p0.y + m.clientY - y0 } });
      const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    if (editing) return;
    if (locked()) {
      // view only while an agent works: clicking selects, nothing moves, nothing is drawn
      const l = hit(e.clientX, e.clientY);
      return setState({ selection: l ? [l.id] : [] });
    }
    if (s.tool === 'pen') {
      const [x, y] = toScene(e.clientX, e.clientY);
      return setPen((p) => ({ pts: [...(p?.pts ?? []), [x, y]], cursor: [x, y] }));
    }
    const type = TOOL_TYPES[s.tool];
    if (type) return startCreate(e, type);
    // select tool
    const l = hit(e.clientX, e.clientY);
    if (l) {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const ids = s.selection.includes(l.id) ? (additive ? s.selection.filter((x) => x !== l.id) : s.selection) : additive ? [...s.selection, l.id] : [l.id];
      setState({ selection: ids });
      if (ids.includes(l.id)) startMove(e, ids);
      return;
    }
    // empty space: rubber band
    if (!e.shiftKey) setState({ selection: [] });
    const [sx0, sy0] = toScene(e.clientX, e.clientY);
    const base = e.shiftKey ? s.selection : [];
    const move = (m: PointerEvent) => {
      const [sx1, sy1] = toScene(m.clientX, m.clientY);
      const r = { x: Math.min(sx0, sx1), y: Math.min(sy0, sy1), w: Math.abs(sx1 - sx0), h: Math.abs(sy1 - sy0) };
      setMarquee(r);
      const hostRect = host.current!.getBoundingClientRect();
      const ids = d.layers
        .filter((l) => l.parent === null && !l.locked && l.visible !== false && l.type !== 'audio')
        .filter((l) => {
          const el = sceneRef.current?.elementOf(l.id);
          if (!el) return false;
          const b = el.getBoundingClientRect();
          const [ax, ay] = toScene(b.left + hostRect.left * 0, b.top);
          const [bx, by] = toScene(b.right, b.bottom);
          return ax < r.x + r.w && bx > r.x && ay < r.y + r.h && by > r.y;
        })
        .map((l) => l.id);
      setState({ selection: [...new Set([...base, ...ids])] });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) {
        setSpaceDown(e.type === 'keydown');
        if (e.type === 'keydown') e.preventDefault();
      }
      if (e.type === 'keydown' && getState().tool === 'pen') {
        if (e.key === 'Enter') setPen((p) => (p && (finishPen(p.pts), null)) || p);
        if (e.key === 'Escape') setPen(null);
      }
    };
    window.addEventListener('keydown', k);
    window.addEventListener('keyup', k);
    return () => (window.removeEventListener('keydown', k), window.removeEventListener('keyup', k));
  }, []);

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = getState();
    if (e.ctrlKey || e.metaKey) {
      const r = host.current!.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const z = Math.min(8, Math.max(0.05, s.zoom * Math.exp(-e.deltaY * 0.01)));
      const k = z / s.zoom;
      setState({ fit: false, zoom: z, pan: { x: px - (px - s.pan.x) * k, y: py - (py - s.pan.y) * k } });
    } else setState({ fit: false, pan: { x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY } });
  };
  useEffect(() => {
    const el = host.current!;
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const single = sel.length === 1 ? d?.layers.find((l) => l.id === sel[0]) : undefined;
  const sbox = single ? boxes[single.id] : undefined;
  const editLayer = editing ? d?.layers.find((l) => l.id === editing) : undefined;

  return (
    <div
      ref={host}
      class={`canvas tool-${tool} ${spaceDown ? 'panning' : ''}`}
      data-testid="canvas"
      onPointerDown={down as never}
      onDblClick={(e) => {
        const l = d && (() => {
          for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
            const id = (el as HTMLElement).dataset?.['layer'];
            const x = id ? d.layers.find((q) => q.id === id) : undefined;
            if (x && !x.locked) return x;
          }
          return null;
        })();
        if (locked()) return;
        if (l?.type === 'text') setEditing(l.id);
        else if (l) setState({ selection: [l.id] });
        else if (pen) finishPen(pen.pts);
      }}
      onPointerMove={(e) => pen && setPen({ ...pen, cursor: toScene(e.clientX, e.clientY) })}
    >
      <div class="artboard-shadow" style={{ left: `${pan.x}px`, top: `${pan.y}px`, width: `${(d?.meta.width ?? 0) * zoom}px`, height: `${(d?.meta.height ?? 0) * zoom}px` }} />
      <div ref={rootEl} class="scene-root" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />
      {d && <div class="scene-label" style={{ left: `${pan.x}px`, top: `${pan.y - 22}px` }}>{d.meta.name} · {(d.meta.duration / 1000).toFixed(1)}s</div>}
      <svg class="overlay" width={size.w} height={size.h} aria-hidden="true">
        {guides.map((g, i) => {
          const at = (g.axis === 'x' ? pan.x : pan.y) + g.at * zoom;
          return g.axis === 'x' ? <line key={i} class="guide" x1={at} x2={at} y1={0} y2={size.h} /> : <line key={i} class="guide" y1={at} y2={at} x1={0} x2={size.w} />;
        })}
        {sel.map((id) => {
          const b = boxes[id];
          if (!b) return null;
          return <rect key={id} class="sel-box" x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} transform={`translate(${b.cx} ${b.cy}) rotate(${b.rot})`} />;
        })}
        {ghost && <rect class="ghost" x={pan.x + ghost.x * zoom} y={pan.y + ghost.y * zoom} width={ghost.w * zoom} height={ghost.h * zoom} />}
        {marquee && <rect class="ghost" x={pan.x + marquee.x * zoom} y={pan.y + marquee.y * zoom} width={marquee.w * zoom} height={marquee.h * zoom} />}
        {pen && pen.pts.length > 0 && (
          <polyline class="pen-line" fill="none" points={[...pen.pts, ...(pen.cursor ? [pen.cursor] : [])].map((p) => `${pan.x + p[0] * zoom},${pan.y + p[1] * zoom}`).join(' ')} />
        )}
      </svg>
      {single && sbox && !single.locked && !lease && tool === 'select' && (
        <div class="handles" style={{ left: `${sbox.cx}px`, top: `${sbox.cy}px`, width: `${sbox.w}px`, height: `${sbox.h}px`, transform: `translate(-50%, -50%) rotate(${sbox.rot}deg)` }}>
          {([[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const).map(([hx, hy]) => (
            <div
              key={`${hx}${hy}`}
              class="handle"
              data-handle={`${hx},${hy}`}
              style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: hx && hy ? (hx * hy > 0 ? 'nwse-resize' : 'nesw-resize') : hx ? 'ew-resize' : 'ns-resize' }}
              onPointerDown={(e) => startResize(e as unknown as PointerEvent, single, hx, hy)}
            />
          ))}
          <div class="rotate-handle" data-handle="rotate" onPointerDown={(e) => startRotate(e as unknown as PointerEvent, single, sbox)} />
        </div>
      )}
      {sel.length > 1 && (
        <div class="multi-tag">{sel.length} selected</div>
      )}
      {editLayer && editLayer.type === 'text' && sceneRef.current?.elementOf(editLayer.id) && (() => {
        const r = sceneRef.current!.elementOf(editLayer.id)!.getBoundingClientRect();
        const h = host.current!.getBoundingClientRect();
        return <TextEditor layer={editLayer} zoom={zoom} rect={{ left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height }} onDone={() => setEditing(null)} />;
      })()}
      {d && d.layers.length === 0 && !ghost && <div class="canvas-hint">{lease ? `${lease.agent} is designing this. It appears here as it goes.` : 'Pick a tool above (R rectangle, O ellipse, T text) and drag on the artboard, or ask your agent to design it.'}</div>}
    </div>
  );
}

/** Edit text in place: a textarea laid over the drawn text at the same size; Enter with Cmd/Ctrl or a click away saves. */
function TextEditor({ layer, rect, zoom, onDone }: { layer: Extract<Layer, { type: 'text' }>; rect: { left: number; top: number; width: number; height: number }; zoom: number; onDone: () => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus();
    ta.current?.select();
  }, []);
  const save = () => {
    const v = ta.current?.value ?? layer.text;
    onDone();
    if (v !== layer.text) commit([{ type: 'layer.set', args: { id: layer.id, patch: { text: v.slice(0, 2000) } } }], 'edit text');
  };
  return (
    <textarea
      ref={ta}
      class="text-edit"
      aria-label="Edit text"
      defaultValue={layer.text}
      style={{
        left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(rect.width, 80)}px`, height: `${Math.max(rect.height, layer.fontSize * zoom * 1.3)}px`,
        font: `${layer.fontWeight ?? 500} ${layer.fontSize * zoom}px/${layer.lineHeight ?? 1.2} ${layer.fontFamily ?? 'Inter'}, system-ui, sans-serif`,
        textAlign: layer.align ?? 'left',
      }}
      onBlur={save}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onDone();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.current?.blur();
      }}
    />
  );
}
