import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBatch, canonicalize, emptyDesign, inverseSpecs, mixColor, OpError, resolve, sample, seededRng,
  type Ctx, type Design, type OpSpec,
} from '../packages/design/src/index.js';
import { DesignStore } from '../packages/design/src/store.js';
import { tmpDir } from './helpers.js';

const ctx = (seed = 1): Ctx => {
  let t = 1_700_000_000_000;
  return { actor: 'agent', now: () => t++, rng: seededRng(seed) };
};
const base = () => emptyDesign({ name: 't', width: 1280, height: 720, duration: 4000 });
const run = (d: Design, specs: OpSpec[], c = ctx()) => applyBatch(d, specs, c);
const ids = (d: Design) => d.layers.map((l) => l.id);
const add = (type: string, extra: Record<string, unknown> = {}, index?: number): OpSpec => ({
  type: 'layer.add', args: { layer: { type, ...extra }, ...(index !== undefined ? { index } : {}) },
});

describe('layers and the tree', () => {
  it('adds every layer type with working defaults and unique names', () => {
    let d = base();
    for (const t of ['frame', 'group', 'rect', 'ellipse', 'star', 'path', 'text', 'image', 'audio']) {
      const extra: Record<string, unknown> = t === 'image' ? { src: 'assets/a.png' } : t === 'audio' ? { src: 'assets/a.mp3' } : {};
      d = run(d, [add(t, extra)]).design;
    }
    expect(d.layers.map((l) => l.type)).toEqual(['frame', 'group', 'rect', 'ellipse', 'star', 'path', 'text', 'image', 'audio']);
    expect(new Set(d.layers.map((l) => l.name)).size).toBe(9);
    d = run(d, [add('rect')]).design;
    expect(d.layers.at(-1)!.name).toBe('Rectangle 2');
  });

  it('keeps siblings in order, reorders, reparents, and refuses nonsense', () => {
    let d = base();
    d = run(d, [add('frame', { id: 'l_fr01' }), add('rect', { id: 'l_aa01', parent: 'l_fr01' }), add('rect', { id: 'l_bb01', parent: 'l_fr01' }), add('ellipse', { id: 'l_cc01' })]).design;
    expect(ids(d)).toEqual(['l_fr01', 'l_aa01', 'l_bb01', 'l_cc01']); // depth-first
    d = run(d, [{ type: 'layer.move', args: { id: 'l_bb01', index: 0 } }]).design;
    expect(ids(d)).toEqual(['l_fr01', 'l_bb01', 'l_aa01', 'l_cc01']);
    d = run(d, [{ type: 'layer.move', args: { id: 'l_cc01', parent: 'l_fr01', index: 1 } }]).design;
    expect(ids(d)).toEqual(['l_fr01', 'l_bb01', 'l_cc01', 'l_aa01']);
    expect(() => run(d, [{ type: 'layer.move', args: { id: 'l_fr01', parent: 'l_aa01' } }])).toThrow(/only frames and groups|inside itself/);
    expect(() => run(d, [{ type: 'layer.move', args: { id: 'l_fr01', parent: 'l_fr01' } }])).toThrow(/inside itself/);
    expect(() => run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { parent: null } } }])).toThrow(/cannot be set here/);
    expect(() => run(d, [{ type: 'layer.delete', args: { id: 'l_zz99' } }])).toThrow(/not found/);
  });

  it('layer.set changes and removes fields; bad values are refused with the reason', () => {
    let d = run(base(), [add('rect', { id: 'l_aa01', shadow: { x: 0, y: 4, blur: 8, color: '#00000040' } })]).design;
    d = run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { x: 50, opacity: 0.5, shadow: null } } }]).design;
    const l = d.layers[0]!;
    expect(l.x).toBe(50);
    expect(l.opacity).toBe(0.5);
    expect(l.shadow).toBeUndefined();
    expect(() => run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { opacity: 3 } } }])).toThrow(/opacity/);
    expect(() => run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { nope: 1 } } }])).toThrow(/Unrecognized key/);
  });

  it('delete removes the subtree and undo restores it byte for byte', () => {
    let d = run(base(), [add('frame', { id: 'l_fr01' }), add('rect', { id: 'l_aa01', parent: 'l_fr01' }), add('text', { id: 'l_tx01', parent: 'l_fr01' }), add('ellipse', { id: 'l_cc01' })]).design;
    d = run(d, [{ type: 'kf.set', args: { layer: 'l_aa01', prop: 'opacity', t: 0, v: 0 } }, { type: 'kf.set', args: { layer: 'l_aa01', prop: 'opacity', t: 1000, v: 1 } }]).design;
    const before = canonicalize(d);
    const r = run(d, [{ type: 'layer.delete', args: { id: 'l_fr01' } }]);
    expect(ids(r.design)).toEqual(['l_cc01']);
    const back = run(r.design, inverseSpecs(r.ops)).design;
    expect(canonicalize(back)).toBe(before);
  });

  it('duplicate copies a subtree with fresh layer and keyframe ids', () => {
    let d = run(base(), [add('frame', { id: 'l_fr01' }), add('rect', { id: 'l_aa01', parent: 'l_fr01' })]).design;
    d = run(d, [{ type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 500, v: 10 } }]).design;
    const r = run(d, [{ type: 'layer.duplicate', args: { id: 'l_fr01' } }]);
    expect(r.design.layers).toHaveLength(4);
    expect(new Set(ids(r.design)).size).toBe(4);
    const kfs = r.design.layers.flatMap((l) => Object.values(l.anim ?? {}).flat().map((k) => k.id));
    expect(new Set(kfs).size).toBe(2);
    expect(r.design.layers.find((l) => l.name === 'Frame 1 copy')).toBeTruthy();
    expect(canonicalize(run(r.design, inverseSpecs(r.ops)).design)).toBe(canonicalize(d));
  });

  it('refuses a broken tree and a layer that outlives the scene', () => {
    const d = run(base(), [add('rect', { id: 'l_aa01' })]).design;
    expect(() => run(d, [add('rect', { parent: 'l_aa01' })])).toThrow(/not a frame or group|BAD_PARENT|only frames/);
    expect(() => run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { start: 3000, end: 2000 } } }])).toThrow(/end \(2000\) must be after start/);
    expect(() => run(d, [{ type: 'layer.set', args: { id: 'l_aa01', patch: { end: 9000 } } }])).toThrow(/after the scene end/);
  });
});

describe('animation', () => {
  const withRect = () => run(base(), [add('rect', { id: 'l_aa01', x: 100, opacity: 1 })]).design;

  it('keyframes sample with easing, hold, and colour mixing', () => {
    let d = withRect();
    d = run(d, [
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 0, v: 0, ease: 'linear' } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 1000, v: 200 } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'fill', t: 0, v: '#000000' } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'fill', t: 1000, v: '#ffffff' } },
    ]).design;
    const kx = d.layers[0]!.anim!['x']!;
    expect(sample(kx, 'x', -50)).toBe(0);
    expect(sample(kx, 'x', 500)).toBe(100);
    expect(sample(kx, 'x', 5000)).toBe(200);
    expect(resolve(d.layers[0]!, 500, 4000).x).toBe(100);
    expect(resolve(d.layers[0]!, 500, 4000).fillColor).toBe('#808080');
    expect(mixColor('#ff000000', '#ff0000ff', 0.5)).toBe('#ff000080');
  });

  it('spring easing overshoots and lands exactly on the target', () => {
    let d = withRect();
    d = run(d, [
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 0, v: 0, ease: 'spring.out' } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 1000, v: 100 } },
    ]).design;
    const k = d.layers[0]!.anim!['x']!;
    const vals = Array.from({ length: 99 }, (_, i) => sample(k, 'x', (i + 1) * 10) as number);
    expect(Math.max(...vals)).toBeGreaterThan(100); // overshoot
    expect(sample(k, 'x', 1000)).toBe(100);
  });

  it('refuses keyframes that make no sense, with the reason', () => {
    const d = withRect();
    const bad = (a: Record<string, unknown>) => () => run(d, [{ type: 'kf.set', args: { layer: 'l_aa01', ...a } }]);
    expect(bad({ prop: 'opacity', t: 0, v: 2 })).toThrow(/outside 0\.\.1/);
    expect(bad({ prop: 'fill', t: 0, v: 5 })).toThrow(/colour/);
    expect(bad({ prop: 'x', t: 0, v: '#ffffff' })).toThrow(/number/);
    expect(bad({ prop: 'trim', t: 0, v: 0 })).toThrow(/paths only/);
    expect(bad({ prop: 'banana', t: 0, v: 0 })).toThrow(/cannot be animated/);
    expect(bad({ prop: 'x', t: 9000, v: 0 })).toThrow(/after the scene end/);
    expect(bad({ prop: 'x', t: 0, v: 0, ease: 'wobbly' })).toThrow(/easing/);
  });

  it('presets produce keyframes that undo exactly; unknown or mismatched ones are refused', () => {
    const d = withRect();
    for (const p of ['fade-in', 'fade-out', 'slide-in', 'slide-out', 'scale-in', 'pop', 'scale-out', 'rotate-in', 'blur-in', 'bounce', 'pulse', 'wiggle']) {
      const r = run(d, [{ type: 'anim.preset', args: { layer: 'l_aa01', preset: p, at: 200 } }]);
      expect(Object.keys(r.design.layers[0]!.anim ?? {}).length, p).toBeGreaterThan(0);
      expect(canonicalize(run(r.design, inverseSpecs(r.ops)).design), p).toBe(canonicalize(d));
    }
    const fade = run(d, [{ type: 'anim.preset', args: { layer: 'l_aa01', preset: 'fade-in', at: 0, dur: 400 } }]).design.layers[0]!.anim!['opacity']!;
    expect(fade.map((k) => [k.t, k.v])).toEqual([[0, 0], [400, 1]]);
    expect(() => run(d, [{ type: 'anim.preset', args: { layer: 'l_aa01', preset: 'draw-on' } }])).toThrow(/for path layers/);
    expect(() => run(d, [{ type: 'anim.preset', args: { layer: 'l_aa01', preset: 'sparkle' } }])).toThrow(/unknown preset/);
    const t = run(d, [add('text', { id: 'l_tx01' }), { type: 'anim.preset', args: { layer: 'l_tx01', preset: 'typewriter', dur: 1000 } }]).design;
    expect(t.layers[1]!.anim!['charProgress']).toHaveLength(2);
  });

  it('kf.delete and kf.clear invert', () => {
    let d = withRect();
    d = run(d, [
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 0, v: 0 } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 500, v: 50 } },
      { type: 'kf.set', args: { layer: 'l_aa01', prop: 'y', t: 100, v: 5 } },
    ]).design;
    const c = run(d, [{ type: 'kf.clear', args: { layer: 'l_aa01' } }]);
    expect(c.design.layers[0]!.anim).toBeUndefined();
    expect(canonicalize(run(c.design, inverseSpecs(c.ops)).design)).toBe(canonicalize(d));
    const id = d.layers[0]!.anim!['x']![1]!.id;
    const x = run(d, [{ type: 'kf.delete', args: { layer: 'l_aa01', id } }]);
    expect(x.design.layers[0]!.anim!['x']).toHaveLength(1);
    expect(canonicalize(run(x.design, inverseSpecs(x.ops)).design)).toBe(canonicalize(d));
  });

  it('shrinking the scene below a keyframe is refused (the batch is atomic)', () => {
    let d = withRect();
    d = run(d, [{ type: 'kf.set', args: { layer: 'l_aa01', prop: 'x', t: 3000, v: 1 } }]).design;
    expect(() => run(d, [{ type: 'scene.set', args: { patch: { duration: 1000 } } }])).toThrow(/after the scene end/);
    expect(d.meta.duration).toBe(4000);
  });
});

describe('random edits always undo back to the original bytes', () => {
  it('300 seeded operations, then undo all', () => {
    const rng = seededRng(42);
    let d = base();
    const hist: { ops: ReturnType<typeof run>['ops']; before: string }[] = [];
    const types = ['rect', 'ellipse', 'star', 'text', 'frame'];
    for (let i = 0; i < 300; i++) {
      const layers = d.layers;
      const pick = () => layers[Math.floor(rng() * layers.length)]?.id;
      const r = rng();
      let spec: OpSpec | null = null;
      if (r < 0.3 || !layers.length) spec = add(types[Math.floor(rng() * types.length)]!, { x: Math.floor(rng() * 500), y: Math.floor(rng() * 500) });
      else if (r < 0.45) spec = { type: 'layer.set', args: { id: pick()!, patch: { x: Math.floor(rng() * 900), opacity: Math.round(rng() * 100) / 100 } } };
      else if (r < 0.6) spec = { type: 'kf.set', args: { layer: pick()!, prop: 'x', t: Math.floor(rng() * 40) * 100, v: Math.floor(rng() * 800) } };
      else if (r < 0.7) spec = { type: 'anim.preset', args: { layer: pick()!, preset: ['fade-in', 'pop', 'slide-in', 'pulse'][Math.floor(rng() * 4)]!, at: Math.floor(rng() * 20) * 100 } };
      else if (r < 0.8) spec = { type: 'layer.duplicate', args: { id: pick()! } };
      else if (r < 0.9) {
        const p = pick()!;
        const holders = layers.filter((l) => ['frame', 'group'].includes(l.type) && l.id !== p).map((l) => l.id);
        spec = { type: 'layer.move', args: { id: p, parent: holders.length && rng() < 0.7 ? holders[Math.floor(rng() * holders.length)]! : null, index: Math.floor(rng() * 3) } };
      } else spec = { type: 'layer.delete', args: { id: pick()! } };
      try {
        const out = run(d, [spec], ctx(i + 1));
        hist.push({ ops: out.ops, before: canonicalize(d) });
        d = out.design;
      } catch (e) {
        expect(e).toBeInstanceOf(OpError); // a refusal, never a crash, and the document is unchanged
      }
    }
    expect(hist.length).toBeGreaterThan(150);
    for (const h of hist.reverse()) {
      d = run(d, inverseSpecs(h.ops)).design;
      expect(canonicalize(d)).toBe(h.before);
    }
    expect(d.layers).toHaveLength(0);
  });
});

describe('the store', () => {
  it('applies, logs, undoes and redoes across processes (a fresh store each time)', () => {
    const dir = tmpDir('studio-design-');
    DesignStore.init(dir, { name: 'demo' });
    const original = readFileSync(join(dir, 'design.studio.json'), 'utf8');
    new DesignStore(dir).apply([add('rect', { id: 'l_aa01' })], { actor: 'agent' });
    new DesignStore(dir).apply([{ type: 'layer.set', args: { id: 'l_aa01', patch: { x: 40 } } }], { actor: 'ui', label: 'drag' });
    const after = readFileSync(join(dir, 'design.studio.json'), 'utf8');
    expect(new DesignStore(dir).load().design.layers[0]!.x).toBe(40);
    new DesignStore(dir).undo();
    expect(new DesignStore(dir).load().design.layers[0]!.x).toBe(0);
    new DesignStore(dir).redo();
    expect(readFileSync(join(dir, 'design.studio.json'), 'utf8')).toBe(after);
    new DesignStore(dir).undo();
    new DesignStore(dir).undo();
    expect(readFileSync(join(dir, 'design.studio.json'), 'utf8')).toBe(original);
    expect(() => new DesignStore(dir).undo()).toThrow(/nothing to undo/);
    const log = new DesignStore(dir).readLog();
    expect(log.map((e) => e.kind)).toEqual(['apply', 'apply', 'undo', 'redo', 'undo', 'undo']);
    expect(log[1]!.actor).toBe('ui');
  });

  it('a failing batch changes nothing and writes no log line; a dry run writes nothing', () => {
    const dir = tmpDir('studio-design-');
    const s = DesignStore.init(dir, { name: 'demo' });
    s.apply([add('rect', { id: 'l_aa01' })]);
    const file = readFileSync(s.file, 'utf8');
    const lines = readFileSync(s.logFile, 'utf8').length;
    expect(() => s.apply([add('rect', { id: 'l_bb01' }), { type: 'layer.set', args: { id: 'l_aa01', patch: { opacity: 9 } } }])).toThrow(OpError);
    s.apply([add('rect', { id: 'l_cc01' })], { dryRun: true });
    expect(readFileSync(s.file, 'utf8')).toBe(file);
    expect(readFileSync(s.logFile, 'utf8').length).toBe(lines);
  });

  it('refuses a design that was edited into an invalid state, and reports drift', () => {
    const dir = tmpDir('studio-design-');
    const s = DesignStore.init(dir, { name: 'demo' });
    s.apply([add('rect', { id: 'l_aa01' })]);
    const raw = JSON.parse(readFileSync(s.file, 'utf8'));
    raw.layers[0].x = 5;
    require_write(s.file, JSON.stringify(raw));
    expect(s.load().driftedFromLog).toBe(true);
    raw.layers[0].parent = 'l_zzzz';
    require_write(s.file, JSON.stringify(raw));
    expect(() => s.load()).toThrow(/parent l_zzzz does not exist/);
  });
});

import { writeFileSync } from 'node:fs';
function require_write(p: string, s: string) {
  writeFileSync(p, s);
}
