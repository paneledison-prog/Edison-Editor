import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  emptyProject,
  projectHash,
  seededRng,
  stepApply,
  stepRedo,
  stepUndo,
  validateProject,
  type LogEntry,
  type OpSpec,
  type Project,
  type Rng,
} from '@studio/core';
import { testCtx, VIDEO_ASSET } from './helpers.js';

const pick = <T>(r: Rng, a: T[]): T | undefined => a[Math.floor(r() * a.length)];
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const EASES = ['linear', 'hold', 'expo.inOut', 'cubic.out', 'back.in', 'bezier(0.2,0.8,0.2,1)'];

function randomSpec(r: Rng, p: Project): OpSpec {
  const clip = pick(r, p.clips);
  const track = pick(r, p.tracks);
  const kinds = [
    'clip.add',
    'clip.move',
    'clip.trim',
    'clip.split',
    'clip.delete',
    'clip.ripple-delete',
    'kf.set',
    'kf.delete',
    'marker.add',
    'marker.remove',
    'export.set',
    'clip.set',
    'track.add',
    'track.set',
    'clip.add',
    'clip.add',
  ];
  switch (pick(r, kinds)) {
    case 'clip.add':
      return track && track.type !== 'captions'
        ? {
            type: 'clip.add',
            args: {
              clip:
                track.type === 'graphics'
                  ? {
                      track: track.id,
                      comp: 'title',
                      start: int(r, 0, 20) * 500,
                      dur: int(r, 1, 8) * 500,
                    }
                  : {
                      track: track.id,
                      asset: 'a_vid1',
                      start: int(r, 0, 20) * 500,
                      dur: int(r, 1, 8) * 500,
                      srcIn: int(r, 0, 20) * 500,
                    },
            },
          }
        : { type: 'track.add', args: { type: 'video', name: 'V' } };
    case 'clip.speed':
      return {
        type: 'clip.speed',
        args: { id: clip?.id ?? 'c_x', factor: pick(r, [0.5, 1, 2, 4])!, ripple: r() < 0.5 },
      };
    case 'fx.set':
      return {
        type: 'clip.set',
        args: {
          id: clip?.id ?? 'c_x',
          patch: {
            fx:
              r() < 0.3
                ? null
                : [
                    { type: 'gain', db: int(r, -6, 6) },
                    { type: 'highpass', hz: 80 },
                  ],
          },
        },
      };
    case 'clip.move':
      return { type: 'clip.move', args: { id: clip?.id ?? 'c_x', start: int(r, 0, 30) * 500 } };
    case 'clip.trim':
      return {
        type: 'clip.trim',
        args: { id: clip?.id ?? 'c_x', dur: int(r, 1, 10) * 500, srcIn: int(r, 0, 10) * 500 },
      };
    case 'clip.split':
      return {
        type: 'clip.split',
        args: { id: clip?.id ?? 'c_x', at: (clip?.start ?? 0) + int(r, 1, 6) * 250 },
      };
    case 'clip.delete':
      return { type: 'clip.delete', args: { id: clip?.id ?? 'c_x' } };
    case 'clip.ripple-delete':
      return {
        type: 'clip.ripple-delete',
        args: { id: clip?.id ?? 'c_x', scope: r() < 0.5 ? 'track' : 'all' },
      };
    case 'kf.set':
      return {
        type: 'kf.set',
        args: {
          clip: clip?.id ?? 'c_x',
          prop: pick(r, ['scale', 'x', 'opacity'])!,
          t: int(r, 0, 8) * 250,
          v: r(),
          ease: pick(r, EASES)!,
        },
      };
    case 'kf.delete': {
      const kf = Object.values(clip?.keyframes ?? {}).flat()[0];
      return { type: 'kf.delete', args: { clip: clip?.id ?? 'c_x', id: kf?.id ?? 'k_xx' } };
    }
    case 'marker.add':
      return { type: 'marker.add', args: { t: int(r, 0, 9000), label: 'm' } };
    case 'marker.remove':
      return { type: 'marker.remove', args: { id: pick(r, p.markers)?.id ?? 'm_xx' } };
    case 'export.set':
      return {
        type: 'export.set',
        args: {
          id: pick(r, ['yt', 'vert', 'sq'])!,
          preset: pick(r, ['youtube-1080p', 'square-1080'])!,
        },
      };
    case 'clip.set':
      return {
        type: 'clip.set',
        args: {
          id: clip?.id ?? 'c_x',
          patch: { transform: { scale: r() + 0.5 }, label: r() < 0.3 ? null : 'L' },
        },
      };
    case 'track.add':
      return {
        type: 'track.add',
        args: {
          type: pick(r, ['video', 'audio', 'graphics', 'captions'] as const)!,
          name: 'T',
          index: int(r, 0, p.tracks.length),
        },
      };
    default:
      return {
        type: 'track.set',
        args: { id: track?.id ?? 't_x', patch: { muted: r() < 0.5, name: 'N' + int(r, 0, 9) } },
      };
  }
}

describe('property: random op sequences are fully reversible and always valid', () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`seed ${seed}`, () => {
      const r = seededRng(seed * 7919);
      const ctx = testCtx(seed);
      let p = stepApply(
        emptyProject({ name: 'prop' }),
        [
          { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
          { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
          { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'VO' } },
          { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } },
        ],
        ctx,
        projectHash,
        new Set(),
      ).project;
      const base = canonicalize(p);
      const log: LogEntry[] = [];
      const states = [base];
      let accepted = 0;
      for (let i = 0; i < 250; i++) {
        let step;
        try {
          step = stepApply(p, [randomSpec(r, p)], ctx, projectHash, new Set(log.map((e) => e.id)));
        } catch {
          continue;
        } // rejected ops are fine; they must leave p untouched
        expect(validateProject(step.project)).toEqual([]);
        p = step.project;
        log.push(step.entry);
        states.push(canonicalize(p));
        accepted++;
      }
      expect(accepted).toBeGreaterThan(30); // the generator must actually exercise the engine
      for (let i = log.length - 1; i >= 0; i--) {
        const u = stepUndo(p, log, ctx, projectHash, new Set(log.map((e) => e.id)));
        p = u.project;
        log.push(u.entry);
        expect(canonicalize(p)).toBe(states[i]);
      }
      expect(canonicalize(p)).toBe(base);
      for (let i = 1; i < states.length; i++) {
        const d = stepRedo(p, log, ctx, projectHash, new Set(log.map((e) => e.id)));
        p = d.project;
        log.push(d.entry);
        expect(canonicalize(p)).toBe(states[i]);
      }
    });
  }
});
