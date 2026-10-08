import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
} from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_COLORS, type Fill, type Layer, type OpSpec } from '@studio/design';
import { Color, Key, Num, Pick, Section, Empty } from './controls';
import { commit, design, propSpecs, selected, setState, useS } from './state';

const solid = (c: string): Fill => ({ type: 'solid', color: c });

/** One change to one property on every selected layer; becomes a keyframe at the playhead if that property is animated. */
function edit(prop: string, value: unknown, patch?: Record<string, unknown>, label?: string) {
  const specs: OpSpec[] = selected().flatMap((l) => propSpecs(l, prop, value, patch ?? { [prop]: value }));
  commit(specs, label ?? `set ${prop}`);
}
const patchAll = (patch: Record<string, unknown>, label: string) =>
  commit(selected().map((l) => ({ type: 'layer.set', args: { id: l.id, patch } })), label);

/** A live change while scrubbing: drawn on the canvas, sent on release. */
function live(prop: string, v: number) {
  const d = design();
  const ids = new Set(selected().map((l) => l.id));
  if (!d) return;
  setState({ draft: { ...d, layers: d.layers.map((l) => (ids.has(l.id) ? ({ ...l, [prop]: v } as Layer) : l)) } });
}

function alignSpecs(to: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
  const d = design()!;
  const ls = selected();
  if (!ls.length) return;
  const parent = ls[0]!.parent ? d.layers.find((l) => l.id === ls[0]!.parent) : null;
  const box =
    ls.length > 1
      ? { x: Math.min(...ls.map((l) => l.x)), y: Math.min(...ls.map((l) => l.y)), r: Math.max(...ls.map((l) => l.x + l.w)), b: Math.max(...ls.map((l) => l.y + l.h)) }
      : { x: 0, y: 0, r: parent ? parent.w : d.meta.width, b: parent ? parent.h : d.meta.height };
  const patch = (l: Layer): Record<string, number> =>
    to === 'left' ? { x: box.x } : to === 'right' ? { x: box.r - l.w } : to === 'center' ? { x: (box.x + box.r) / 2 - l.w / 2 }
    : to === 'top' ? { y: box.y } : to === 'bottom' ? { y: box.b - l.h } : { y: (box.y + box.b) / 2 - l.h / 2 };
  commit(ls.map((l) => ({ type: 'layer.set', args: { id: l.id, patch: patch(l) } })), `align ${to}`);
}

const ALIGN = [
  ['left', AlignStartVertical], ['center', AlignCenterVertical], ['right', AlignEndVertical],
  ['top', AlignStartHorizontal], ['middle', AlignCenterHorizontal], ['bottom', AlignEndHorizontal],
] as const;
const WEIGHTS = ['300', '400', '500', '600', '700', '800', '900'] as const;

export function Inspector() {
  const sel = useS((s) => s.selection);
  const d = useS((s) => s.draft ?? s.snap?.design ?? null);
  const fonts = useS((s) => s.snap?.fonts);
  const t = useS((s) => s.t);
  const ls = sel.map((id) => d?.layers.find((l) => l.id === id)).filter(Boolean) as Layer[];
  if (!d) return null;
  if (!ls.length) return <SceneInspector />;
  const l = ls[0]!;
  const multi = ls.length > 1;
  const families = [...new Set([...(fonts ?? []).map((f) => f.family), 'system-ui', 'Georgia', 'Courier New'])];
  const fillColor = l.fill?.type === 'solid' ? l.fill.color : null;
  const strokeOn = !!l.stroke;
  const visual = l.type !== 'audio';
  void t;

  return (
    <div class="inspector" data-testid="design-panel">
      <div class="layer-head">
        <span class="layer-name">{multi ? `${ls.length} layers` : l.name}</span>
        <span class="muted">{multi ? '' : l.type}</span>
      </div>
      {visual && (
        <div class="align-row" role="group" aria-label="Align">
          {ALIGN.map(([to, Icon]) => (
            <button key={to} class="icon-btn" aria-label={`Align ${to}`} title={`Align ${to}`} onClick={() => alignSpecs(to)}>
              <Icon size={16} />
            </button>
          ))}
        </div>
      )}
      <Section title="Layout">
        <div class="grid2">
          <Num label="X" value={l.x} step={1} onChange={(v) => edit('x', v)} onLive={(v) => live('x', v)} />
          <Num label="Y" value={l.y} step={1} onChange={(v) => edit('y', v)} onLive={(v) => live('y', v)} />
          <Num label="W" value={l.w} min={0} step={1} onChange={(v) => edit('w', v)} onLive={(v) => live('w', v)} disabled={l.type === 'audio'} />
          <Num label="H" value={l.h} min={0} step={1} onChange={(v) => edit('h', v)} onLive={(v) => live('h', v)} disabled={l.type === 'audio'} />
        </div>
        <div class="row">
          <Num label="Angle" value={l.rotation ?? 0} min={-3600} max={3600} step={1} onChange={(v) => edit('rotation', v)} onLive={(v) => live('rotation', v)} wide />
          {!multi && <Key layer={l} prop="rotation" current={l.rotation ?? 0} />}
        </div>
        <div class="row">
          <Num label="Scale" value={l.scale ?? 1} min={0} max={50} step={0.05} onChange={(v) => edit('scale', v)} wide />
          {!multi && <Key layer={l} prop="scale" current={l.scale ?? 1} />}
        </div>
      </Section>

      {l.type === 'frame' && (
        <Section title="Clip content" on={l.clip !== false} onToggle={(v) => patchAll({ clip: v }, 'clip content')} />
      )}

      {visual && (
        <>
          <div class="row spaced">
            <Num label="Opacity" value={Math.round((l.opacity ?? 1) * 100)} min={0} max={100} step={1} wide onChange={(v) => edit('opacity', v / 100)} onLive={(v) => live('opacity', v / 100)} />
            {!multi && <Key layer={l} prop="opacity" current={l.opacity ?? 1} />}
          </div>
          {['frame', 'rect', 'image', 'star'].includes(l.type) && (
            <div class="row spaced">
              <Num label="Corner" value={l.cornerRadius ?? 0} min={0} step={1} wide onChange={(v) => edit('cornerRadius', v)} onLive={(v) => live('cornerRadius', v)} />
              {!multi && <Key layer={l} prop="cornerRadius" current={l.cornerRadius ?? 0} />}
            </div>
          )}
        </>
      )}

      {l.type === 'text' && (
        <Section title="Text">
          <textarea
            class="textarea"
            aria-label="Text content"
            value={l.text}
            onBlur={(e) => {
              const v = (e.target as HTMLTextAreaElement).value;
              if (v !== l.text) patchAll({ text: v }, 'edit text');
            }}
          />
          <Pick label="Font" value={l.fontFamily ?? families[0]!} options={families} onChange={(v) => patchAll({ fontFamily: v }, 'font')} />
          <div class="grid2">
            <Num label="Size" value={l.fontSize} min={1} max={2000} onChange={(v) => patchAll({ fontSize: v }, 'font size')} />
            <Pick label="Weight" value={String(l.fontWeight ?? 500) as (typeof WEIGHTS)[number]} options={WEIGHTS} onChange={(v) => patchAll({ fontWeight: Number(v) }, 'font weight')} />
            <Num label="Line" value={l.lineHeight ?? 1.2} min={0.5} max={4} step={0.05} onChange={(v) => patchAll({ lineHeight: v }, 'line height')} />
            <Num label="Track" value={l.letterSpacing ?? 0} min={-50} max={200} step={0.5} onChange={(v) => patchAll({ letterSpacing: v }, 'letter spacing')} />
          </div>
          <div class="seg" role="group" aria-label="Text align">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} class={(l.align ?? 'left') === a ? 'on' : ''} aria-pressed={(l.align ?? 'left') === a} onClick={() => patchAll({ align: a }, 'text align')}>
                {a === 'left' ? <AlignHorizontalJustifyStart size={14} /> : a === 'center' ? <AlignHorizontalJustifyCenter size={14} /> : <AlignHorizontalJustifyEnd size={14} />}
              </button>
            ))}
          </div>
        </Section>
      )}
      {l.type === 'star' && (
        <Section title="Star">
          <div class="grid2">
            <Num label="Points" value={l.points} min={3} max={32} onChange={(v) => patchAll({ points: Math.round(v) }, 'star points')} />
            <Num label="Inner" value={l.innerRatio} min={0.05} max={0.98} step={0.01} onChange={(v) => patchAll({ innerRatio: v }, 'star inner')} />
          </div>
        </Section>
      )}
      {l.type === 'image' && (
        <Section title="Image">
          <Pick label="Fit" value={l.fit ?? 'cover'} options={['cover', 'contain', 'fill']} onChange={(v) => patchAll({ fit: v }, 'image fit')} />
        </Section>
      )}
      {l.type === 'path' && (
        <Section title="Path">
          <div class="row">
            <Num label="Trim" value={Math.round((l.trim ?? 1) * 100)} min={0} max={100} step={1} wide onChange={(v) => edit('trim', v / 100)} />
            {!multi && <Key layer={l} prop="trim" current={l.trim ?? 1} />}
          </div>
          <Pick label="Cap" value={l.cap ?? 'round'} options={['butt', 'round', 'square']} onChange={(v) => patchAll({ cap: v }, 'path cap')} />
        </Section>
      )}
      {l.type === 'audio' && (
        <Section title="Audio">
          <div class="row">
            <Num label="Volume" value={Math.round((l.volume ?? 1) * 100)} min={0} max={200} wide onChange={(v) => edit('volume', v / 100)} />
            {!multi && <Key layer={l} prop="volume" current={l.volume ?? 1} />}
          </div>
          <p class="muted">Plays under the scene and is mixed into MP4, WebM and MOV exports.</p>
        </Section>
      )}

      {visual && l.type !== 'group' && (
        <Section
          title="Fill"
          on={!!l.fill}
          onToggle={(v) => patchAll({ fill: v ? solid(DEFAULT_COLORS.fill) : null }, 'fill')}
          right={!multi && fillColor ? <Key layer={l} prop="fill" current={fillColor} /> : null}
        >
          <Pick
            label="Fill type"
            value={l.fill?.type ?? 'solid'}
            options={['solid', 'linear', 'radial']}
            onChange={(v) => {
              const c = l.fill?.type === 'solid' ? l.fill.color : l.fill?.stops[0]?.color ?? DEFAULT_COLORS.fill;
              patchAll({ fill: v === 'solid' ? solid(c) : v === 'linear' ? { type: 'linear', angle: 90, stops: [{ at: 0, color: c }, { at: 1, color: DEFAULT_COLORS.white }] } : { type: 'radial', stops: [{ at: 0, color: c }, { at: 1, color: DEFAULT_COLORS.white }] } }, 'fill type');
            }}
          />
          {l.fill?.type === 'solid' && <Color label="Fill" value={l.fill.color} onChange={(c) => edit('fill', c, { fill: solid(c) }, 'fill colour')} />}
          {l.fill && l.fill.type !== 'solid' && (
            <>
              {l.fill.stops.map((st, i) => (
                <Color key={i} label={`Stop ${i + 1}`} value={st.color} onChange={(c) => patchAll({ fill: { ...l.fill, stops: l.fill!.type === 'solid' ? [] : l.fill!.stops.map((s, j) => (j === i ? { ...s, color: c } : s)) } }, 'gradient stop')} />
              ))}
              {l.fill.type === 'linear' && <Num label="Angle" value={l.fill.angle} min={-360} max={360} onChange={(v) => patchAll({ fill: { ...l.fill, angle: v } }, 'gradient angle')} />}
            </>
          )}
        </Section>
      )}

      {visual && (
        <>
          <Section
            title="Stroke"
            on={strokeOn}
            onToggle={(v) => patchAll({ stroke: v ? { color: DEFAULT_COLORS.ink, width: 2 } : null }, 'stroke')}
            right={!multi && l.stroke ? <Key layer={l} prop="strokeWidth" current={l.stroke.width} /> : null}
          >
            {l.stroke && (
              <>
                <Color label="Stroke" value={l.stroke.color} onChange={(c) => patchAll({ stroke: { ...l.stroke, color: c } }, 'stroke colour')} />
                <div class="grid2">
                  <Num label="Width" value={l.stroke.width} min={0} max={200} step={0.5} onChange={(v) => edit('strokeWidth', v, { stroke: { ...l.stroke, width: v } })} />
                  <Pick label="Stroke align" value={l.stroke.align ?? 'inside'} options={['inside', 'center', 'outside']} onChange={(v) => patchAll({ stroke: { ...l.stroke, align: v } }, 'stroke align')} />
                </div>
              </>
            )}
          </Section>
          <Section title="Shadow" on={!!l.shadow} onToggle={(v) => patchAll({ shadow: v ? { x: 0, y: 8, blur: 24, color: DEFAULT_COLORS.shadow } : null }, 'shadow')}>
            {l.shadow && (
              <>
                <div class="grid2">
                  <Num label="X" value={l.shadow.x} onChange={(v) => patchAll({ shadow: { ...l.shadow, x: v } }, 'shadow x')} />
                  <Num label="Y" value={l.shadow.y} onChange={(v) => patchAll({ shadow: { ...l.shadow, y: v } }, 'shadow y')} />
                  <Num label="Blur" value={l.shadow.blur} min={0} onChange={(v) => edit('shadowBlur', v, { shadow: { ...l.shadow, blur: v } })} />
                </div>
                <Color label="Shadow" value={l.shadow.color} onChange={(c) => patchAll({ shadow: { ...l.shadow, color: c } }, 'shadow colour')} />
              </>
            )}
          </Section>
          <Section title="Layer blur" on={(l.layerBlur ?? 0) > 0} onToggle={(v) => patchAll({ layerBlur: v ? 8 : null }, 'layer blur')} right={!multi ? <Key layer={l} prop="layerBlur" current={l.layerBlur ?? 0} /> : null}>
            <Num label="Amount" value={l.layerBlur ?? 0} min={0} max={500} onChange={(v) => edit('layerBlur', v)} wide />
          </Section>
          <Section title="Background blur" on={(l.bgBlur ?? 0) > 0} onToggle={(v) => patchAll({ bgBlur: v ? 16 : null }, 'background blur')}>
            <Num label="Amount" value={l.bgBlur ?? 0} min={0} max={500} onChange={(v) => patchAll({ bgBlur: v }, 'background blur')} wide />
          </Section>
          <Section title="Glass" on={!!l.glass} onToggle={(v) => patchAll({ glass: v ? true : null }, 'glass')} />
        </>
      )}
    </div>
  );
}

function SceneInspector() {
  const d = useS((s) => s.snap?.design)!;
  const m = d.meta;
  const set = (patch: Record<string, unknown>, label: string) => commit([{ type: 'scene.set', args: { patch } }], label);
  return (
    <div class="inspector" data-testid="scene-panel">
      <div class="layer-head"><span class="layer-name">Scene</span><span class="muted">{m.name}</span></div>
      <Section title="Canvas">
        <div class="grid2">
          <Num label="W" value={m.width} min={16} max={4096} onChange={(v) => set({ width: Math.round(v) }, 'scene width')} />
          <Num label="H" value={m.height} min={16} max={4096} onChange={(v) => set({ height: Math.round(v) }, 'scene height')} />
          <Num label="FPS" value={m.fps} min={1} max={120} onChange={(v) => set({ fps: Math.round(v) }, 'scene fps')} />
          <Num label="Secs" value={m.duration / 1000} min={0.1} max={600} step={0.1} onChange={(v) => set({ duration: Math.round(v * 1000) }, 'scene length')} />
        </div>
        <SceneBackground />
      </Section>
      <Empty>Select a layer to edit it, or press R, O, T, F to draw one.</Empty>
    </div>
  );
}

function SceneBackground() {
  const m = useS((s) => s.snap?.design.meta)!;
  const [t, setT] = useState(m.background === 'transparent');
  useEffect(() => setT(m.background === 'transparent'), [m.background]);
  return (
    <>
      <label class="check">
        <input type="checkbox" checked={t} onChange={(e) => commit([{ type: 'scene.set', args: { patch: { background: (e.target as HTMLInputElement).checked ? 'transparent' : DEFAULT_COLORS.background } } }], 'background')} />
        Transparent background
      </label>
      {m.background !== 'transparent' && <Color label="Background" value={m.background} onChange={(c) => commit([{ type: 'scene.set', args: { patch: { background: c } } }], 'background colour')} />}
    </>
  );
}
