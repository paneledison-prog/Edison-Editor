import { ChevronDown, ChevronRight, Pause, Play, Repeat, SkipBack } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { CONTAINERS, type Design, type Layer } from '@studio/design';
import { commit, getState, setState, useS } from './state';

const LABEL_W = 190;
const ROW = 26;

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.round(ms % 1000)).padStart(3, '0')}`;
};
export const snapFrame = (ms: number, fps: number) => Math.round((Math.round((ms * fps) / 1000) * 1000) / fps);

function order(d: Design): Layer[] {
  const out: Layer[] = [];
  const walk = (p: string | null) => {
    for (const l of d.layers.filter((x) => x.parent === p).reverse()) {
      out.push(l);
      if (CONTAINERS.includes(l.type)) walk(l.id);
    }
  };
  walk(null);
  return out;
}
const depthOf = (d: Design, l: Layer) => {
  let n = 0;
  for (let p = l.parent; p; p = d.layers.find((x) => x.id === p)?.parent ?? null) n++;
  return n;
};

export function Timeline() {
  const d = useS((s) => s.draft ?? s.snap?.design ?? null);
  const t = useS((s) => s.t);
  const playing = useS((s) => s.playing);
  const loop = useS((s) => s.loop);
  const sel = useS((s) => s.selection);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [zoomX, setZoomX] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  if (!d) return null;
  const { duration, fps } = d.meta;
  const trackW = Math.max(400, 760 * zoomX);
  const px = (ms: number) => (ms / duration) * trackW;
  const ms = (x: number) => (x / trackW) * duration;
  const rows = order(d);

  const scrub = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const at = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setState({ t: Math.min(duration, Math.max(0, snapFrame(ms(ev.clientX - r.left), fps))), playing: false });
    };
    at(e);
    const move = (m: PointerEvent) => at(m);
    const up = () => (el.removeEventListener('pointermove', move), el.removeEventListener('pointerup', up));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const dragBar = (e: PointerEvent, l: Layer, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setState({ selection: [l.id] });
    const x0 = e.clientX;
    const s0 = l.start ?? 0;
    const e0 = l.end ?? duration;
    let s = s0;
    let en = e0;
    const move = (m: PointerEvent) => {
      const dx = ms(m.clientX - x0);
      if (mode === 'move') {
        const len = e0 - s0;
        s = Math.min(duration - len, Math.max(0, snapFrame(s0 + dx, fps)));
        en = s + len;
      } else if (mode === 'start') s = Math.min(e0 - 1000 / fps, Math.max(0, snapFrame(s0 + dx, fps)));
      else en = Math.max(s0 + 1000 / fps, Math.min(duration, snapFrame(e0 + dx, fps)));
      const cur = getState().draft ?? getState().snap!.design;
      setState({ draft: { ...cur, layers: cur.layers.map((x) => (x.id === l.id ? ({ ...x, ...(s > 0 ? { start: Math.round(s) } : { start: undefined }), ...(en < duration ? { end: Math.round(en) } : { end: undefined }) } as Layer) : x)) } });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (s === s0 && en === e0) return setState({ draft: null });
      commit([{ type: 'layer.set', args: { id: l.id, patch: { start: s > 0 ? Math.round(s) : null, end: en < duration - 0.5 ? Math.round(en) : null } } }], 'retime layer');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const dragKf = (e: PointerEvent, l: Layer, prop: string, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setState({ selection: [l.id] });
    const k = l.anim![prop]!.find((x) => x.id === id)!;
    const x0 = e.clientX;
    let nt = k.t;
    const move = (m: PointerEvent) => {
      nt = Math.min(duration, Math.max(0, snapFrame(k.t + ms(m.clientX - x0), fps)));
      const cur = getState().draft ?? getState().snap!.design;
      setState({ draft: { ...cur, layers: cur.layers.map((x) => (x.id === l.id ? ({ ...x, anim: { ...x.anim, [prop]: x.anim![prop]!.map((q) => (q.id === id ? { ...q, t: Math.round(nt) } : q)) } } as Layer) : x)) } });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setState({ draft: null });
      if (Math.round(nt) === k.t) return setState({ t: k.t });
      commit([{ type: 'kf.delete', args: { layer: l.id, id } }, { type: 'kf.set', args: { layer: l.id, prop, t: Math.round(nt), v: k.v, id, ...(k.ease ? { ease: k.ease } : {}) } }], 'move keyframe');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const ticks: number[] = [];
  const step = duration <= 2000 ? 100 : duration <= 6000 ? 250 : duration <= 20000 ? 1000 : 5000;
  for (let x = 0; x <= duration; x += step) ticks.push(x);

  return (
    <div class="timeline" data-testid="timeline">
      <div class="tl-controls">
        <button class="icon-btn" aria-label="Back to start" title="Back to start (Home)" onClick={() => setState({ t: 0, playing: false })}><SkipBack size={14} /></button>
        <button class="icon-btn play" aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" data-testid="play" onClick={() => setState({ playing: !playing })}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button class={`icon-btn ${loop ? 'on' : ''}`} aria-label="Loop" aria-pressed={loop} title="Loop" onClick={() => setState({ loop: !loop })}><Repeat size={14} /></button>
        <span class="time" data-testid="time">{fmtTime(t)}</span>
        <span class="muted">/ {fmtTime(duration)} · frame {Math.round((t * fps) / 1000)}</span>
        <span class="spacer" />
        <label class="tl-zoom">Zoom <input type="range" min={1} max={8} step={0.25} value={zoomX} aria-label="Timeline zoom" onInput={(e) => setZoomX(Number((e.target as HTMLInputElement).value))} /></label>
      </div>
      <div class="tl-body" ref={scroller}>
        <div class="tl-labels" style={{ width: `${LABEL_W}px` }}>
          <div class="tl-corner" />
          {rows.map((l) => (
            <div key={l.id}>
              <div class={`tl-label ${sel.includes(l.id) ? 'on' : ''}`} style={{ height: `${ROW}px`, paddingLeft: `${6 + depthOf(d, l) * 10}px` }} onClick={() => setState({ selection: [l.id] })}>
                <button class="caret" aria-label={open[l.id] ? 'Hide properties' : 'Show properties'} style={{ visibility: l.anim ? 'visible' : 'hidden' }} onClick={(e) => (e.stopPropagation(), setOpen({ ...open, [l.id]: !open[l.id] }))}>
                  {open[l.id] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
                <span class="name">{l.name}</span>
              </div>
              {open[l.id] && l.anim && Object.keys(l.anim).map((p) => <div key={p} class="tl-label prop" style={{ height: `${ROW}px` }}>{p}</div>)}
            </div>
          ))}
        </div>
        <div class="tl-track-wrap">
          <div class="tl-track" style={{ width: `${trackW}px` }}>
            <div class="tl-ruler" onPointerDown={scrub as never} data-testid="ruler">
              {ticks.map((x) => (
                <span key={x} class="tick" style={{ left: `${px(x)}px` }}>{x % 1000 === 0 ? `${x / 1000}s` : ''}</span>
              ))}
            </div>
            {rows.map((l) => {
              const s = l.start ?? 0;
              const e = l.end ?? duration;
              const kfAll = l.anim ? Object.entries(l.anim).flatMap(([p, ks]) => ks.map((k) => ({ ...k, prop: p }))) : [];
              return (
                <div key={l.id}>
                  <div class="tl-row" style={{ height: `${ROW}px` }}>
                    <div
                      class={`bar ${sel.includes(l.id) ? 'on' : ''} t-${l.type}`}
                      data-layer-bar={l.id}
                      style={{ left: `${px(s)}px`, width: `${Math.max(6, px(e - s))}px` }}
                      onPointerDown={(ev) => dragBar(ev as unknown as PointerEvent, l, 'move')}
                    >
                      <span class="edge l" onPointerDown={(ev) => dragBar(ev as unknown as PointerEvent, l, 'start')} />
                      <span class="edge r" onPointerDown={(ev) => dragBar(ev as unknown as PointerEvent, l, 'end')} />
                      {kfAll.map((k) => (
                        <span key={k.id} class="kf mini" style={{ left: `${px(k.t) - px(s) - 4}px` }} />
                      ))}
                    </div>
                  </div>
                  {open[l.id] && l.anim && Object.entries(l.anim).map(([p, ks]) => (
                    <div key={p} class="tl-row prop" style={{ height: `${ROW}px` }}>
                      {ks.map((k) => (
                        <button
                          key={k.id}
                          class={`kf ${Math.abs(k.t - t) < 500 / fps ? 'at' : ''}`}
                          data-kf-diamond={k.id}
                          aria-label={`${p} keyframe at ${k.t} ms`}
                          style={{ left: `${px(k.t) - 6}px` }}
                          onPointerDown={(ev) => dragKf(ev as unknown as PointerEvent, l, p, k.id)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
            <div class="playhead" data-testid="playhead" style={{ left: `${px(t)}px` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
