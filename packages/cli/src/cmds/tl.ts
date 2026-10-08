import { CliError } from '../args.js';
import type { Handler, Invocation } from '../main.js';
import { num, parseJson, runSpecs, str } from './shared.js';

const opt = <T>(k: string, v: T | undefined) => (v === undefined ? {} : { [k]: v });
const need = (inv: Invocation, k: string) => {
  const v = inv.flags[k];
  if (v === undefined) throw new CliError('INVALID_ARGS', `missing --${k}`);
  return v;
};

export const addTrack: Handler = async (inv) =>
  runSpecs(inv, [
    {
      type: 'track.add',
      args: {
        type: need(inv, 'type'),
        name: need(inv, 'name'),
        ...opt('role', str(inv, 'role')),
        ...opt('id', str(inv, 'id')),
        ...opt('index', num(inv, 'index')),
      },
    },
  ]);

export const addClip: Handler = async (inv) => {
  const asset = str(inv, 'asset');
  const comp = str(inv, 'comp');
  if ((asset === undefined) === (comp === undefined))
    throw new CliError('INVALID_ARGS', 'give exactly one of --asset or --comp');
  const props = str(inv, 'props');
  if (comp) {
    const E = await import('@studio/engines');
    E.validateComp(comp, props ? parseJson('--props', props) : undefined, inv.dir);
  }
  return runSpecs(inv, [
    {
      type: 'clip.add',
      args: {
        clip: {
          track: need(inv, 'track'),
          start: need(inv, 'start'),
          dur: need(inv, 'dur'),
          ...opt('asset', asset),
          ...opt('comp', comp),
          ...opt('srcIn', num(inv, 'src-in')),
          ...opt('id', str(inv, 'id')),
          ...(props ? { props: parseJson('--props', props) } : {}),
        },
      },
    },
  ]);
};

export const move: Handler = async (inv) =>
  runSpecs(inv, [
    {
      type: 'clip.move',
      args: { id: need(inv, 'id'), start: need(inv, 'start'), ...opt('track', str(inv, 'track')) },
    },
  ]);

export const trim: Handler = async (inv) =>
  runSpecs(inv, [
    {
      type: 'clip.trim',
      args: {
        id: need(inv, 'id'),
        ...opt('start', num(inv, 'start')),
        ...opt('dur', num(inv, 'dur')),
        ...opt('srcIn', num(inv, 'src-in')),
      },
    },
  ]);

export const split: Handler = async (inv) =>
  runSpecs(inv, [{ type: 'clip.split', args: { id: need(inv, 'id'), at: need(inv, 'at') } }]);

export const rippleDelete: Handler = async (inv) =>
  runSpecs(inv, [
    {
      type: 'clip.ripple-delete',
      args: { id: need(inv, 'id'), ...opt('scope', str(inv, 'scope')) },
    },
  ]);

export const set: Handler = async (inv) =>
  runSpecs(inv, [
    {
      type: 'clip.set',
      args: { id: need(inv, 'id'), patch: parseJson('--patch', String(need(inv, 'patch'))) },
    },
  ]);

export const keyframe: Handler = async (inv) => {
  const del = str(inv, 'delete');
  if (del)
    return runSpecs(inv, [{ type: 'kf.delete', args: { clip: need(inv, 'clip'), id: del } }]);
  return runSpecs(inv, [
    {
      type: 'kf.set',
      args: {
        clip: need(inv, 'clip'),
        prop: need(inv, 'prop'),
        t: need(inv, 't'),
        v: need(inv, 'v'),
        ...opt('ease', str(inv, 'ease')),
      },
    },
  ]);
};

export const marker: Handler = async (inv) =>
  runSpecs(inv, [{ type: 'marker.add', args: { t: need(inv, 't'), label: need(inv, 'label') } }]);
