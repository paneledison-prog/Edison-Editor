import { useRef, useState } from 'preact/hooks';
import { easeFn } from '../../../../motion/src/ease';
import { frameMs, kfSetSpecs } from '../timeline/edit';
import type { OpSpec } from '../api';

interface Kf {
  id: string;
  t: number;
  v: number;
  ease?: string;
}
interface Props {
  clipId: string;
  dur: number;
  fps: number;
  keyframes: Record<string, Kf[]>;
  editable: boolean;
  onEdit: (specs: OpSpec[], label: string) => void;
}

const W = 264;
const H = 150;
const PAD = 18;
const RANGE: Record<string, [number, number]> = { scale: [1, 2], x: [0, 1], y: [0, 1], opacity: [0, 1], rot: [-45, 45] };

/**
 * Value graph of one keyframed property: time across, value up. The curve is drawn from the same easing
 * functions the renderer uses (motion/src/ease.ts); a handle drags in time (snapped to a frame) and in value,
 * and the edit is sent once, on release, as one undoable op.
 */
export default function GraphEditor({ clipId, dur, fps, keyframes, editable, onEdit }: Props) {
  const props = Object.keys(keyframes).filter((p) => keyframes[p]!.length);
  const [prop, setProp] = useState(props[0]!);
  const [drag, setDrag] = useState<{ id: string; t: number; v: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const active = props.includes(prop) ? prop : props[0]!;
  const base = keyframes[active]!;
  const kfs = base
    .map((k) => (drag && drag.id === k.id ? { ...k, t: drag.t, v: drag.v } : k))
    .sort((a, b) => a.t - b.t);
  const [d0, d1] = RANGE[active] ?? [0, 1];
  const lo = Math.min(d0, ...kfs.map((k) => k.v));
  const hi = Math.max(d1, ...kfs.map((k) => k.v));
  const span = hi - lo || 1;
  const X = (t: number) => PAD + (t / Math.max(1, dur)) * (W - 2 * PAD);
  const Y = (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  const fromX = (x: number) => ((x - PAD) / (W - 2 * PAD)) * dur;
  const fromY = (y: number) => lo + ((H - PAD - y) / (H - 2 * PAD)) * span;

  let path = '';
  kfs.forEach((k, i) => {
    path += `${i ? 'L' : 'M'}${X(k.t).toFixed(1)},${Y(k.v).toFixed(1)}`;
    const n = kfs[i + 1];
    if (!n) return;
    const e = k.ease ?? 'linear';
    if (e === 'hold') path += `L${X(n.t).toFixed(1)},${Y(k.v).toFixed(1)}`;
    else if (e !== 'linear') {
      const f = easeFn(e);
      for (let s = 1; s < 24; s++) {
        const u = s / 24;
        path += `L${X(k.t + (n.t - k.t) * u).toFixed(1)},${Y(k.v + (n.v - k.v) * f(u)).toFixed(1)}`;
      }
    }
  });
  if (kfs.length) path += `L${X(dur).toFixed(1)},${Y(kfs[kfs.length - 1]!.v).toFixed(1)}`;

  const pointer = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    return {
      t: Math.min(dur, Math.max(0, frameMs(fromX(x), fps))),
      v: Math.round(fromY(y) * 1e3) / 1e3,
    };
  };
  const commit = (k: Kf, next: { t: number; v: number }) => {
    if (next.t === k.t && next.v === k.v) return;
    onEdit(kfSetSpecs(clipId, active, k, next), `drag ${active} keyframe`);
  };

  return (
    <div class="graph" data-testid="graph">
      <div class="graph-tabs" role="tablist">
        {props.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={p === active}
            class={`graph-tab ${p === active ? 'on' : ''}`}
            onClick={() => setProp(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${active} over time`}>
        {[0, 0.5, 1].map((u) => (
          <line key={u} class="graph-grid" x1={PAD} x2={W - PAD} y1={Y(lo + span * u)} y2={Y(lo + span * u)} />
        ))}
        <text class="graph-label" x={2} y={Y(hi) + 4}>{Math.round(hi * 100) / 100}</text>
        <text class="graph-label" x={2} y={Y(lo) + 4}>{Math.round(lo * 100) / 100}</text>
        <path class="graph-curve" data-testid="graph-curve" d={path} />
        {kfs.map((k) => (
          <circle
            key={k.id}
            class={`graph-kf ${drag?.id === k.id ? 'drag' : ''}`}
            data-testid="graph-kf"
            data-kf={k.id}
            cx={X(k.t)}
            cy={Y(k.v)}
            r={6}
            tabIndex={0}
            aria-label={`${active} keyframe at ${k.t} ms, value ${k.v}`}
            onPointerDown={(e) => {
              if (!editable) return;
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              setDrag({ id: k.id, t: k.t, v: k.v });
            }}
            onPointerMove={(e) => drag?.id === k.id && setDrag({ id: k.id, ...pointer(e) })}
            onPointerUp={(e) => {
              if (drag?.id !== k.id) return;
              const next = pointer(e);
              setDrag(null);
              const orig = base.find((b) => b.id === k.id)!;
              commit(orig, next);
            }}
          />
        ))}
      </svg>
      <p class="muted">Drag a point: left and right change its time (a frame at a time), up and down its value.</p>
    </div>
  );
}
