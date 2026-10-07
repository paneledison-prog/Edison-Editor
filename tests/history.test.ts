import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpError, ProjectStore, type OpSpec } from '@studio/core';
import { testCtx, tmpDir, VIDEO_ASSET } from './helpers.js';

const bytes = (s: ProjectStore) => readFileSync(s.projectPath);

/** 10 distinct ops, applied one transaction each. */
const TEN: OpSpec[] = [
  { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
  { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
  { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } },
  {
    type: 'clip.add',
    args: {
      clip: { id: 'c_01', track: 't_v1', asset: 'a_vid1', start: 0, dur: 8000, srcIn: 12_000 },
    },
  },
  { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 1000, v: 1, ease: 'expo.inOut' } },
  { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 1600, v: 1.8, ease: 'expo.inOut' } },
  { type: 'clip.split', args: { id: 'c_01', at: 4000 } },
  {
    type: 'clip.add',
    args: {
      clip: {
        id: 'c_02',
        track: 't_g1',
        comp: 'lower-third',
        start: 2000,
        dur: 3500,
        props: { title: 'Ada' },
      },
    },
  },
  { type: 'marker.add', args: { t: 5000, label: 'Click: Save' } },
  { type: 'export.set', args: { id: 'yt', preset: 'youtube-1080p' } },
];

describe('P0 exit criterion (synthetic assets): apply 10 ops, undo 10, project is byte-identical', () => {
  it('holds at the file level', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'p0' });
    const original = bytes(s);
    const ctx = testCtx(3);
    for (const op of TEN) s.apply([op], { ctx });
    expect(bytes(s).equals(original)).toBe(false);
    for (let i = 0; i < 10; i++) s.undo({ ctx });
    expect(bytes(s).equals(original)).toBe(true);
    expect(s.readLog()).toHaveLength(20); // 10 applies + 10 undos; history is never rewritten
  });

  it('redo restores each state and a new apply clears redo', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'p0' });
    const ctx = testCtx(4);
    const states: Buffer[] = [bytes(s)];
    for (const op of TEN) {
      s.apply([op], { ctx });
      states.push(bytes(s));
    }
    for (let i = 0; i < 10; i++) s.undo({ ctx });
    for (let i = 1; i <= 10; i++) {
      s.redo({ ctx });
      expect(bytes(s).equals(states[i]!)).toBe(true);
    }
    s.undo({ ctx });
    s.apply([{ type: 'marker.add', args: { t: 1, label: 'x' } }], { ctx });
    expect(() => s.redo({ ctx })).toThrow(/nothing to redo/);
  });
});

describe('store behaviour', () => {
  it('batch is one undo step', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'b' });
    const original = bytes(s);
    s.apply(TEN.slice(0, 4), { ctx: testCtx(5) });
    s.undo({ ctx: testCtx(6) });
    expect(bytes(s).equals(original)).toBe(true);
  });

  it('failed batch writes nothing, not even a log line', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'f' });
    const original = bytes(s);
    expect(() => s.apply([TEN[0]!, { type: 'clip.delete', args: { id: 'c_nope' } }])).toThrow(
      OpError,
    );
    expect(bytes(s).equals(original)).toBe(true);
    expect(s.readLog()).toHaveLength(0);
  });

  it('dry run returns the result and leaves disk untouched', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'd' });
    const original = bytes(s);
    const step = s.apply(TEN.slice(0, 2), { dryRun: true });
    expect(Object.keys(step.project.assets)).toEqual(['a_vid1']);
    expect(bytes(s).equals(original)).toBe(true);
    expect(s.readLog()).toHaveLength(0);
  });

  it('records the actor and keeps UI edits when the agent undoes only its own latest step', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'i' });
    s.apply(TEN.slice(0, 4), { actor: 'agent', ctx: testCtx(7, 'agent') });
    s.apply([{ type: 'clip.move', args: { id: 'c_01', start: 500 } }], {
      actor: 'ui',
      ctx: testCtx(8, 'ui'),
    });
    expect(s.readLog().map((e) => e.actor)).toEqual(['agent', 'ui']);
    expect(s.load().project.clips[0]!.start).toBe(500);
  });

  it('flags drift when the file was edited outside ops', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'x' });
    s.apply(TEN.slice(0, 2), { ctx: testCtx(9) });
    expect(s.load().driftedFromLog).toBe(false);
    const p = JSON.parse(readFileSync(s.projectPath, 'utf8'));
    p.meta.name = 'edited by hand';
    writeFileSync(s.projectPath, JSON.stringify(p, null, 2));
    expect(s.load().driftedFromLog).toBe(true);
  });

  it('refuses to init over an existing project without force', () => {
    const dir = tmpDir();
    ProjectStore.init(dir, { name: 'one' });
    expect(() => ProjectStore.init(dir, { name: 'two' })).toThrow(/--force/);
  });

  it('leaves no .partial file behind', () => {
    const s = ProjectStore.init(tmpDir(), { name: 'p' });
    s.apply(TEN.slice(0, 2));
    expect(() => readFileSync(s.projectPath + '.partial')).toThrow();
  });
});
