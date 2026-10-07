import { describe, expect, it } from 'vitest';
import {
  applyBatch,
  canonicalize,
  inverseSpecs,
  OpError,
  timelineDuration,
  validateProject,
} from '@studio/core';
import { baseProject, testCtx } from './helpers.js';

const addClip = (extra: Record<string, unknown> = {}) => ({
  type: 'clip.add',
  args: { clip: { track: 't_v1', asset: 'a_vid1', start: 0, dur: 5000, srcIn: 0, ...extra } },
});

describe('validation invariants', () => {
  it('rejects overlap on a video track but allows it on graphics', () => {
    const p = applyBatch(baseProject(), [addClip({ id: 'c_one' })], testCtx()).project;
    expect(() => applyBatch(p, [addClip({ id: 'c_two', start: 4000 })], testCtx())).toThrowError(
      /overlap/,
    );
    const g = (id: string, start: number) => ({
      type: 'clip.add',
      args: { clip: { id, track: 't_g1', comp: 'title', start, dur: 3000 } },
    });
    expect(() => applyBatch(p, [g('c_g1', 0), g('c_g2', 1000)], testCtx())).not.toThrow();
  });

  it('rejects srcIn+dur past the asset duration', () => {
    expect(() =>
      applyBatch(baseProject(), [addClip({ srcIn: 58_000, dur: 5000 })], testCtx()),
    ).toThrowError(/exceeds asset duration/);
  });

  it('rejects keyframes out of range and missing references', () => {
    const p = applyBatch(baseProject(), [addClip({ id: 'c_one' })], testCtx()).project;
    expect(() =>
      applyBatch(
        p,
        [{ type: 'kf.set', args: { clip: 'c_one', prop: 'scale', t: 6000, v: 1 } }],
        testCtx(),
      ),
    ).toThrowError(/after clip end/);
    expect(() =>
      applyBatch(p, [addClip({ asset: 'a_nope', start: 9000 })], testCtx()),
    ).toThrowError(/missing asset/);
  });

  it('rejects an unknown easing name', () => {
    const p = applyBatch(baseProject(), [addClip({ id: 'c_one' })], testCtx()).project;
    expect(() =>
      applyBatch(
        p,
        [
          {
            type: 'kf.set',
            args: { clip: 'c_one', prop: 'scale', t: 100, v: 1, ease: 'wobble.in' },
          },
        ],
        testCtx(),
      ),
    ).toThrowError(OpError);
    expect(() =>
      applyBatch(
        p,
        [
          {
            type: 'kf.set',
            args: { clip: 'c_one', prop: 'scale', t: 100, v: 1, ease: 'expo.inOut' },
          },
        ],
        testCtx(),
      ),
    ).not.toThrow();
    expect(() =>
      applyBatch(
        p,
        [
          {
            type: 'kf.set',
            args: { clip: 'c_one', prop: 'scale', t: 100, v: 1, ease: 'bezier(0.2,0.8,0.2,1)' },
          },
        ],
        testCtx(),
      ),
    ).not.toThrow();
  });

  it('derives timeline duration from the last clip end', () => {
    const p = applyBatch(
      baseProject(),
      [addClip({ id: 'c_one' }), addClip({ id: 'c_two', start: 8000 })],
      testCtx(),
    ).project;
    expect(timelineDuration(p)).toBe(13_000);
    expect('duration' in p).toBe(false);
  });
});

describe('atomic batches', () => {
  it('applies nothing when one op in the batch is invalid', () => {
    const base = baseProject();
    const before = canonicalize(base);
    expect(() =>
      applyBatch(
        base,
        [addClip({ id: 'c_one' }), addClip({ id: 'c_two', start: 1000 })],
        testCtx(),
      ),
    ).toThrow();
    expect(canonicalize(base)).toBe(before); // input untouched
  });

  it('reports the failing op index and a code', () => {
    try {
      applyBatch(
        baseProject(),
        [addClip({ id: 'c_one' }), { type: 'clip.delete', args: { id: 'c_zzz' } }],
        testCtx(),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe('NOT_FOUND');
      expect((e as OpError).message).toMatch(/^op 1 clip\.delete/);
    }
  });
});

describe('op semantics', () => {
  const setup = () =>
    applyBatch(
      baseProject(),
      [
        addClip({ id: 'c_one', dur: 6000 }),
        addClip({ id: 'c_two', start: 6000, dur: 4000, srcIn: 10_000 }),
        {
          type: 'kf.set',
          args: { clip: 'c_one', prop: 'scale', t: 1000, v: 1, ease: 'expo.inOut' },
        },
        { type: 'kf.set', args: { clip: 'c_one', prop: 'scale', t: 4000, v: 1.8 } },
      ],
      testCtx(),
    ).project;

  it('split divides keyframes and advances srcIn', () => {
    const p = applyBatch(
      setup(),
      [{ type: 'clip.split', args: { id: 'c_one', at: 3000 } }],
      testCtx(5),
    ).project;
    const l = p.clips.find((c) => c.id === 'c_one')!;
    const r = p.clips.find((c) => c.id !== 'c_one' && c.start === 3000)!;
    expect([l.dur, r.start, r.dur, r.srcIn]).toEqual([3000, 3000, 3000, 3000]);
    expect(l.keyframes!.scale!.map((k) => k.t)).toEqual([1000]);
    expect(r.keyframes!.scale!.map((k) => k.t)).toEqual([1000]); // 4000 - 3000
  });

  it('split rejects a time at or outside the clip edge', () => {
    expect(() =>
      applyBatch(setup(), [{ type: 'clip.split', args: { id: 'c_one', at: 0 } }], testCtx()),
    ).toThrow(/not inside/);
    expect(() =>
      applyBatch(setup(), [{ type: 'clip.split', args: { id: 'c_one', at: 6000 } }], testCtx()),
    ).toThrow(/not inside/);
  });

  it('ripple-delete closes the gap on the track only (scope track)', () => {
    const p = applyBatch(
      setup(),
      [{ type: 'clip.ripple-delete', args: { id: 'c_one' } }],
      testCtx(),
    ).project;
    expect(p.clips.map((c) => [c.id, c.start])).toEqual([['c_two', 0]]);
  });

  it('ripple-delete scope all refuses when a clip on another track straddles the gap', () => {
    const p = applyBatch(
      setup(),
      [
        {
          type: 'clip.add',
          args: { clip: { id: 'c_vo', track: 't_a1', asset: 'a_vid1', start: 1000, dur: 20_000 } },
        },
      ],
      testCtx(),
    ).project;
    expect(() =>
      applyBatch(
        p,
        [{ type: 'clip.ripple-delete', args: { id: 'c_one', scope: 'all' } }],
        testCtx(),
      ),
    ).toThrow(/straddles/);
  });

  it('kf.set at an existing time replaces it and keeps the id', () => {
    const p1 = setup();
    const id = p1.clips[0]!.keyframes!.scale![0]!.id;
    const p2 = applyBatch(
      p1,
      [{ type: 'kf.set', args: { clip: 'c_one', prop: 'scale', t: 1000, v: 2 } }],
      testCtx(),
    ).project;
    const k = p2.clips[0]!.keyframes!.scale![0]!;
    expect([k.id, k.v]).toEqual([id, 2]);
  });

  it('every op inverts to the exact prior canonical project', () => {
    const start = setup();
    const specs = [
      { type: 'clip.move', args: { id: 'c_two', start: 7000 } },
      { type: 'clip.trim', args: { id: 'c_two', dur: 3000, srcIn: 12_000 } },
      {
        type: 'clip.set',
        args: { id: 'c_one', patch: { transform: { scale: 1.2 }, label: 'hi' } },
      },
      { type: 'clip.split', args: { id: 'c_one', at: 2500 } },
      { type: 'kf.delete', args: { clip: 'c_one', id: start.clips[0]!.keyframes!.scale![0]!.id } },
      { type: 'marker.add', args: { t: 100, label: 'Click: Save' } },
      { type: 'export.set', args: { id: 'yt', preset: 'youtube-1080p' } },
      { type: 'track.set', args: { id: 't_v1', patch: { muted: true, name: 'Renamed' } } },
      { type: 'track.add', args: { type: 'captions', name: 'Captions', index: 1 } },
      { type: 'clip.ripple-delete', args: { id: 'c_two' } },
    ];
    let cur = start;
    for (const s of specs) {
      const r = applyBatch(cur, [s], testCtx(7));
      const back = applyBatch(r.project, inverseSpecs(r.ops), testCtx(8)).project;
      expect(canonicalize(back), s.type).toBe(canonicalize(cur));
      cur = r.project;
    }
    expect(validateProject(cur)).toEqual([]);
  });
});

describe('fx and speed', () => {
  const base = () =>
    applyBatch(
      baseProject(),
      [
        {
          type: 'clip.add',
          args: {
            clip: { id: 'c_one', track: 't_v1', asset: 'a_vid1', start: 0, dur: 4000, srcIn: 0 },
          },
        },
        {
          type: 'clip.add',
          args: {
            clip: {
              id: 'c_two',
              track: 't_v1',
              asset: 'a_vid1',
              start: 4000,
              dur: 2000,
              srcIn: 10_000,
            },
          },
        },
      ],
      testCtx(),
    ).project;

  it('clip.speed halves duration at 2x, ripples later clips, and inverts exactly', () => {
    const p = base();
    const r = applyBatch(
      p,
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 2, ripple: true } }],
      testCtx(),
    );
    const [a, b] = r.project.clips.sort((x, y) => x.start - y.start);
    expect([a!.dur, a!.fx, b!.start]).toEqual([2000, [{ type: 'speed', factor: 2 }], 2000]);
    expect(canonicalize(applyBatch(r.project, inverseSpecs(r.ops), testCtx()).project)).toBe(
      canonicalize(p),
    );
    // without ripple the next clip stays put
    const nr = applyBatch(
      p,
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 2 } }],
      testCtx(),
    ).project;
    expect(nr.clips.find((c) => c.id === 'c_two')!.start).toBe(4000);
  });

  it('factor 1 removes the effect; changing speed twice uses the source span, not the current duration', () => {
    const p = base();
    const x4 = applyBatch(
      p,
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 4 } }],
      testCtx(),
    ).project;
    expect(x4.clips.find((c) => c.id === 'c_one')!.dur).toBe(1000);
    const x2 = applyBatch(
      x4,
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 2 } }],
      testCtx(),
    ).project;
    expect(x2.clips.find((c) => c.id === 'c_one')!.dur).toBe(2000);
    const x1 = applyBatch(
      x2,
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 1 } }],
      testCtx(),
    ).project;
    const c = x1.clips.find((c) => c.id === 'c_one')!;
    expect([c.dur, c.fx]).toEqual([4000, undefined]);
  });

  it('clip.speed keeps the source span; extending duration under speed is bounded by dur x speed', () => {
    const p = applyBatch(
      baseProject(),
      [
        {
          type: 'clip.add',
          args: {
            clip: {
              id: 'c_end',
              track: 't_v1',
              asset: 'a_vid1',
              start: 0,
              dur: 2000,
              srcIn: 50_000,
            },
          },
        },
      ],
      testCtx(),
    ).project;
    // slowing to 0.5x doubles dur but consumes the same 2000 ms of source: still valid
    const slow = applyBatch(
      p,
      [{ type: 'clip.speed', args: { id: 'c_end', factor: 0.5 } }],
      testCtx(),
    ).project;
    expect(slow.clips[0]!.dur).toBe(4000);
    // at 4x, 2000 ms of timeline is 8000 ms of source (58000 end); extending to 3000 ms would reach 62000 > 60000
    const fast = applyBatch(
      p,
      [{ type: 'clip.speed', args: { id: 'c_end', factor: 4 } }],
      testCtx(),
    ).project; // dur 500
    expect(() =>
      applyBatch(fast, [{ type: 'clip.trim', args: { id: 'c_end', dur: 3000 } }], testCtx()),
    ).toThrow(/source range end 62000/);
    expect(() =>
      applyBatch(fast, [{ type: 'clip.trim', args: { id: 'c_end', dur: 2000 } }], testCtx()),
    ).not.toThrow();
  });

  it('split on a sped-up clip advances srcIn by leftDur x speed', () => {
    const p = applyBatch(
      base(),
      [{ type: 'clip.speed', args: { id: 'c_one', factor: 2 } }],
      testCtx(),
    ).project; // dur 2000
    const s = applyBatch(
      p,
      [{ type: 'clip.split', args: { id: 'c_one', at: 500 } }],
      testCtx(3),
    ).project;
    const right = s.clips.find((c) => c.start === 500)!;
    expect(right.srcIn).toBe(1000); // 500 ms of timeline at 2x = 1000 ms of source
    expect(right.fx).toEqual([{ type: 'speed', factor: 2 }]);
  });

  it('rejects unknown fx types, out-of-range parameters, bad duck targets, and duplicates', () => {
    const p = base();
    const set = (fx: unknown[]) =>
      applyBatch(p, [{ type: 'clip.set', args: { id: 'c_one', patch: { fx } } }], testCtx());
    expect(() => set([{ type: 'sparkle' }])).toThrow(OpError);
    expect(() => set([{ type: 'gain', db: 400 }])).toThrow(OpError);
    expect(() =>
      set([
        { type: 'speed', factor: 2 },
        { type: 'speed', factor: 3 },
      ]),
    ).toThrow(/more than one speed/);
    expect(() =>
      set([
        { type: 'duck', by: 't_zzz', thresholdDb: -30, ratio: 6, attackMs: 20, releaseMs: 400 },
      ]),
    ).toThrow(/missing track/);
    expect(() =>
      set([{ type: 'duck', by: 't_g1', thresholdDb: -30, ratio: 6, attackMs: 20, releaseMs: 400 }]),
    ).toThrow(/graphics track/);
    expect(() =>
      set([{ type: 'duck', by: 't_v1', thresholdDb: -30, ratio: 6, attackMs: 20, releaseMs: 400 }]),
    ).toThrow(/own track/);
    expect(() =>
      set([
        { type: 'duck', by: 't_a1', thresholdDb: -30, ratio: 6, attackMs: 20, releaseMs: 400 },
        { type: 'highpass', hz: 80 },
      ]),
    ).not.toThrow();
  });
});
