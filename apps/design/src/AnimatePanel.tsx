import { Trash2, Wand2 } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ANIMATABLE, DEFAULT_COLORS, isColorProp, type Layer } from '@studio/design';
import { Color, Empty, Key, Num, Pick, Section } from './controls';
import { commit, design, getState, selected, setState, useS } from './state';

const FAMILIES = ['quad', 'cubic', 'quart', 'quint', 'sine', 'expo', 'circ', 'back', 'elastic', 'bounce', 'spring'];
export const EASES = ['linear', 'hold', ...FAMILIES.flatMap((f) => [`${f}.in`, `${f}.out`, `${f}.inOut`])];

const LABELS: Record<string, string> = {
  x: 'Position X', y: 'Position Y', w: 'Width', h: 'Height', rotation: 'Angle', opacity: 'Opacity', scale: 'Scale',
  cornerRadius: 'Corner', strokeWidth: 'Stroke width', shadowX: 'Shadow X', shadowY: 'Shadow Y', shadowBlur: 'Shadow blur',
  layerBlur: 'Layer blur', trim: 'Trim', charProgress: 'Typing', volume: 'Volume', fill: 'Fill colour', stroke: 'Stroke colour',
};
const baseValue = (l: Layer, p: string): number | string => {
  switch (p) {
    case 'x': return l.x;
    case 'y': return l.y;
    case 'w': return l.w;
    case 'h': return l.h;
    case 'rotation': return l.rotation ?? 0;
    case 'opacity': return l.opacity ?? 1;
    case 'scale': return l.scale ?? 1;
    case 'cornerRadius': return l.cornerRadius ?? 0;
    case 'strokeWidth': return l.stroke?.width ?? 0;
    case 'shadowX': return l.shadow?.x ?? 0;
    case 'shadowY': return l.shadow?.y ?? 0;
    case 'shadowBlur': return l.shadow?.blur ?? 0;
    case 'layerBlur': return l.layerBlur ?? 0;
    case 'trim': return l.type === 'path' ? (l.trim ?? 1) : 1;
    case 'charProgress': return l.type === 'text' ? (l.charProgress ?? 1) : 1;
    case 'volume': return l.type === 'audio' ? (l.volume ?? 1) : 1;
    case 'fill': return l.fill?.type === 'solid' ? l.fill.color : DEFAULT_COLORS.white;
    case 'stroke': return l.stroke?.color ?? DEFAULT_COLORS.black;
    default: return 0;
  }
};
const appliesTo = (l: Layer, p: string) =>
  !(p === 'trim' && l.type !== 'path') && !(p === 'charProgress' && l.type !== 'text') && !(p === 'volume' && l.type !== 'audio') &&
  !(p === 'fill' && (!l.fill || l.fill.type !== 'solid')) && !(p === 'stroke' && !l.stroke);

export function AnimatePanel() {
  const sel = useS((s) => s.selection);
  const d = useS((s) => s.draft ?? s.snap?.design ?? null);
  const presets = useS((s) => s.snap?.presets) ?? [];
  const t = useS((s) => s.t);
  const [dur, setDur] = useState(0);
  const [from, setFrom] = useState<'left' | 'right' | 'top' | 'bottom'>('left');
  const [to, setTo] = useState<string>(DEFAULT_COLORS.shift);
  const ls = sel.map((id) => d?.layers.find((l) => l.id === id)).filter(Boolean) as Layer[];
  if (!d) return null;
  if (!ls.length) return <div class="inspector"><Empty>Select a layer to animate it. Presets start at the playhead.</Empty></div>;
  const l = ls[0]!;
  const apply = (id: string) => {
    const p = presets.find((x) => x.id === id)!;
    commit(
      ls.map((x) => ({
        type: 'anim.preset',
        args: { layer: x.id, preset: id, at: Math.round(getState().t), ...(dur ? { dur } : {}), ...(id.startsWith('slide') ? { from } : {}), ...(id === 'color-shift' ? { to } : {}) },
      })),
      `animate ${p.id}`,
    );
  };
  const list = presets.filter((p) => !p.types || ls.every((x) => p.types!.includes(x.type)));
  const props = Object.keys(l.anim ?? {});
  const addable = (ANIMATABLE as readonly string[]).filter((p) => !props.includes(p) && appliesTo(l, p));
  void t;
  return (
    <div class="inspector" data-testid="animate-panel">
      <Section title="Presets">
        <div class="preset-opts">
          <Num label="Dur ms" value={dur} min={0} max={60000} step={50} onChange={setDur} />
          <span class="opt-label">Slide from (slide-in, slide-out)</span>
          <Pick label="Slide from" value={from} options={['left', 'right', 'top', 'bottom']} onChange={setFrom} />
          <span class="opt-label">Shift to (color-shift)</span>
          <Color label="Colour shift to" value={to} onChange={setTo} />
        </div>
        <div class="presets">
          {list.map((p) => (
            <button key={p.id} class="preset" data-preset={p.id} title={p.summary} onClick={() => apply(p.id)}>
              <Wand2 size={12} /> {p.id}
            </button>
          ))}
        </div>
        <p class="muted">Applies to {ls.length > 1 ? `${ls.length} layers` : l.name} at {Math.round(getState().t)} ms. Duration 0 uses the preset's own.</p>
      </Section>

      <Section title="Timing">
        <div class="grid2">
          <Num label="Start" value={l.start ?? 0} min={0} max={d.meta.duration} step={50} onChange={(v) => commit(ls.map((x) => ({ type: 'layer.set', args: { id: x.id, patch: { start: v <= 0 ? null : Math.round(v) } } })), 'layer start')} />
          <Num label="End" value={l.end ?? d.meta.duration} min={0} max={d.meta.duration} step={50} onChange={(v) => commit(ls.map((x) => ({ type: 'layer.set', args: { id: x.id, patch: { end: v >= d.meta.duration ? null : Math.round(v) } } })), 'layer end')} />
        </div>
      </Section>

      <Section
        title="Keyframes"
        right={props.length ? <button class="icon-btn" aria-label="Clear all keyframes" title="Clear all keyframes" onClick={() => commit(ls.map((x) => ({ type: 'kf.clear', args: { layer: x.id } })), 'clear keyframes')}><Trash2 size={14} /></button> : null}
      >
        {!props.length && <p class="muted">No keyframes yet. Use a preset, or add one for a property below.</p>}
        {props.map((p) => (
          <div key={p} class="kf-group" data-kf-prop={p}>
            <div class="kf-head">
              <span>{LABELS[p] ?? p}</span>
              <span class="spacer" />
              <Key layer={l} prop={p} current={baseValue(l, p)} />
              <button class="icon-btn" aria-label={`Clear ${p} keyframes`} title="Clear" onClick={() => commit([{ type: 'kf.clear', args: { layer: l.id, prop: p } }], `clear ${p}`)}><Trash2 size={13} /></button>
            </div>
            {l.anim![p]!.map((k) => (
              <div key={k.id} class="kf-row" data-kf={k.id}>
                <Num label="ms" value={k.t} min={0} max={d.meta.duration} step={10} onChange={(v) => commit([{ type: 'kf.delete', args: { layer: l.id, id: k.id } }, { type: 'kf.set', args: { layer: l.id, prop: p, t: Math.round(v), v: k.v, id: k.id, ...(k.ease ? { ease: k.ease } : {}) } }], 'move keyframe')} />
                {isColorProp(p) ? (
                  <Color label={`${p} @${k.t}`} value={String(k.v)} onChange={(c) => commit([{ type: 'kf.set', args: { layer: l.id, prop: p, t: k.t, v: c, id: k.id, ...(k.ease ? { ease: k.ease } : {}) } }], 'keyframe colour')} />
                ) : (
                  <Num label="val" value={Number(k.v)} step={p === 'opacity' || p === 'trim' || p === 'charProgress' ? 0.01 : 1} onChange={(v) => commit([{ type: 'kf.set', args: { layer: l.id, prop: p, t: k.t, v, id: k.id, ...(k.ease ? { ease: k.ease } : {}) } }], 'keyframe value')} />
                )}
                <Pick label={`Easing ${p} ${k.t}`} value={k.ease ?? 'linear'} options={EASES} onChange={(e) => commit([{ type: 'kf.set', args: { layer: l.id, prop: p, t: k.t, v: k.v, id: k.id, ease: e } }], 'keyframe easing')} />
                <button class="icon-btn" aria-label="Delete keyframe" onClick={() => commit([{ type: 'kf.delete', args: { layer: l.id, id: k.id } }], 'delete keyframe')}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        ))}
        {addable.length > 0 && (
          <Pick
            label="Add a keyframed property"
            value={'' as never}
            options={[{ v: '' as never, l: 'Add property…' }, ...addable.map((p) => ({ v: p as never, l: LABELS[p] ?? p }))]}
            onChange={(p) => {
              if (!p) return;
              const tt = Math.min(Math.round(getState().t), design()!.meta.duration);
              commit(ls.filter((x) => appliesTo(x, p)).map((x) => ({ type: 'kf.set', args: { layer: x.id, prop: p, t: tt, v: baseValue(x, p) } })), `keyframe ${p}`);
              setState({});
            }}
          />
        )}
      </Section>
    </div>
  );
}
