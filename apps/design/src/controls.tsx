import { Diamond } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Layer } from '@studio/design';
import { commit, getState, hasKeys } from './state';

const round = (v: number, step: number) => Math.round(v / step) * step;
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

interface NumProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** called while scrubbing, before the final onChange */
  onLive?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  wide?: boolean;
}

/** A number box. Drag its label to scrub; arrows step; the edit is sent when you leave the box or press Enter. */
export function Num({ label, value, onChange, onLive, min = -Infinity, max = Infinity, step = 1, disabled, id, wide }: NumProps) {
  const [text, setText] = useState(fmt(value));
  const scrubbing = useRef(false);
  useEffect(() => {
    if (!scrubbing.current) setText(fmt(value));
  }, [value]);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const apply = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return setText(fmt(value));
    const c = clamp(v);
    setText(fmt(c));
    if (c !== value) onChange(c);
  };
  const scrub = (e: PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = value;
    scrubbing.current = true;
    let cur = v0;
    const move = (m: PointerEvent) => {
      cur = clamp(round(v0 + (m.clientX - x0) * step * (m.shiftKey ? 10 : 1), step / 10));
      setText(fmt(cur));
      onLive?.(cur);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      scrubbing.current = false;
      if (cur !== v0) onChange(cur);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <label class={`num ${wide ? 'wide' : ''}`}>
      <span class="num-label" onPointerDown={scrub} title="Drag to change">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        data-field={id ?? label}
        aria-label={id ?? label}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={(e) => apply((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          if (e.key === 'Enter') el.blur();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = clamp(round(Number(el.value) + d, step / 10));
            setText(fmt(v));
            onChange(v);
          } else if (e.key === 'Escape') {
            setText(fmt(value));
            el.blur();
          }
        }}
      />
    </label>
  );
}

export function Color({ value, onChange, label, disabled }: { value: string; onChange: (c: string) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(value.slice(1));
  useEffect(() => setText(value.slice(1)), [value]);
  const good = (s: string) => /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s);
  return (
    <div class="color">
      <input
        type="color"
        value={value.slice(0, 7)}
        disabled={disabled}
        aria-label={`${label} colour`}
        onInput={(e) => setText((e.target as HTMLInputElement).value.slice(1))}
        onChange={(e) => onChange((e.target as HTMLInputElement).value + (value.length === 9 ? value.slice(7) : ''))}
      />
      <input
        type="text"
        class="hex"
        value={text}
        maxLength={8}
        disabled={disabled}
        aria-label={`${label} hex`}
        onInput={(e) => setText((e.target as HTMLInputElement).value.replace('#', ''))}
        onBlur={() => (good(text) ? onChange('#' + text.toLowerCase()) : setText(value.slice(1)))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

export function Pick<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: readonly (T | { v: T; l: string })[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <select class="pick" value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.v;
        return <option key={v} value={v}>{typeof o === 'string' ? o : o.l}</option>;
      })}
    </select>
  );
}

export function Section({ title, on, onToggle, children, right }: { title: string; on?: boolean; onToggle?: (v: boolean) => void; children?: ComponentChildren; right?: ComponentChildren }) {
  return (
    <section class="section">
      <header>
        <h3>{title}</h3>
        <div class="section-right">
          {right}
          {onToggle && (
            <input type="checkbox" checked={!!on} aria-label={`${title} on`} onChange={(e) => onToggle((e.target as HTMLInputElement).checked)} />
          )}
        </div>
      </header>
      {(onToggle ? on : true) && children ? <div class="section-body">{children}</div> : null}
    </section>
  );
}

/** The keyframe diamond beside an animatable property: filled when a keyframe sits at the playhead, ringed when the property is animated. */
export function Key({ layer, prop, current }: { layer: Layer; prop: string; current: number | string }) {
  const s = getState();
  const kfs = layer.anim?.[prop] ?? [];
  const fps = s.snap?.design.meta.fps ?? 30;
  const here = kfs.find((k) => Math.abs(k.t - s.t) <= 500 / fps);
  const state = here ? 'on' : hasKeys(layer, prop) ? 'some' : 'off';
  return (
    <button
      class={`key ${state}`}
      aria-label={`${state === 'on' ? 'Remove' : 'Add'} ${prop} keyframe at the playhead`}
      title={state === 'on' ? 'Remove keyframe here' : 'Add keyframe at the playhead'}
      data-key={prop}
      data-state={state}
      onClick={() => {
        const t = Math.min(Math.max(0, Math.round(getState().t)), s.snap!.design.meta.duration);
        if (here) commit([{ type: 'kf.delete', args: { layer: layer.id, id: here.id } }], `remove ${prop} keyframe`);
        else commit([{ type: 'kf.set', args: { layer: layer.id, prop, t, v: current } }], `add ${prop} keyframe`);
      }}
    >
      <Diamond size={12} />
    </button>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
