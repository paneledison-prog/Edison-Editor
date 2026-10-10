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

/**
 * `studio tl transition`: how a clip comes in (`--in KIND`) or goes out (`--out KIND`). On a clip that follows another on the same
 * track with no gap, `--in` is a transition between the two, centred on the cut (`--between A,B` names the pair); elsewhere it acts
 * on the clip alone, over what is below it. `--remove` takes it off. The answer says where it runs and what each clip had to spare.
 */
export const transition: Handler = async (inv) => {
  const { store: storeOf } = await import('./shared.js');
  const { project } = storeOf(inv).load();
  const pair = str(inv, 'between')?.split(',').map((x) => x.trim());
  let id = str(inv, 'clip');
  let side: 'in' | 'out' | undefined = str(inv, 'in') ? 'in' : str(inv, 'out') ? 'out' : undefined;
  let kind = str(inv, 'in') ?? str(inv, 'out') ?? str(inv, 'kind');
  if (pair) {
    if (pair.length !== 2) throw new CliError('INVALID_ARGS', '--between takes two clip ids: the one before and the one after the cut', 2, 'studio tl transition --between c_a,c_b --kind dissolve');
    const [a, b] = pair.map((x) => project.clips.find((c) => c.id === x));
    if (!a || !b) throw new CliError('NOT_FOUND', `no clip ${!a ? pair[0] : pair[1]}`, 2);
    if (a.track !== b.track || Math.abs(a.start + a.dur - b.start) > 1)
      throw new CliError('INVALID_ARGS', `${a.id} and ${b.id} do not meet at a cut on one track (${a.id} ends at ${a.start + a.dur} ms, ${b.id} starts at ${b.start} ms${a.track !== b.track ? ', on another track' : ''})`, 2, 'studio tl move to put them end to end');
    id = b.id;
    side = 'in';
  }
  if (!id) throw new CliError('INVALID_ARGS', '--clip (or --between A,B) is required', 2);
  const clip = project.clips.find((c) => c.id === id);
  if (!clip) throw new CliError('NOT_FOUND', `no clip ${id}`, 2);
  if (inv.flags['remove']) {
    const which = side ? [side] : (['in', 'out'] as const).filter((s2) => clip[s2 === 'in' ? 'transIn' : 'transOut']);
    if (!which.length) throw new CliError('NOT_FOUND', `${id} has no transition`, 2);
    const patch = Object.fromEntries(which.map((s2) => [s2 === 'in' ? 'transIn' : 'transOut', null]));
    const r = runSpecs(inv, [{ type: 'clip.set', args: { id, patch } }], `tl transition ${id} remove`);
    return { ...r, data: { ...(r.data as object), clip: id, removed: which } };
  }
  if (!side || !kind) throw new CliError('INVALID_ARGS', 'give --in KIND or --out KIND (or --between A,B --kind KIND), KIND one of dissolve, dip, wipe, push, slide; or --remove', 2, 'studio tl transition --clip c_b --in dissolve --dur 600');
  if (kind === 'fade' || kind === 'crossfade' || kind === 'cross-dissolve') kind = 'dissolve';
  if (!['dissolve', 'dip', 'wipe', 'push', 'slide'].includes(kind)) throw new CliError('INVALID_ARGS', `unknown transition ${kind}; one of dissolve (fade), dip, wipe, push, slide`, 2);
  if (clip.comp) throw new CliError('INVALID_ARGS', `${id} is a composition clip: it animates itself (its in and out are in its props)`, 2);
  const dur = Math.round(num(inv, 'dur') ?? 500);
  const dir = str(inv, 'dir');
  if (dir && !['left', 'right', 'up', 'down'].includes(dir)) throw new CliError('INVALID_ARGS', '--dir is left, right, up or down (the way the edge or the picture moves)', 2);
  const E = await import('@studio/engines');
  const tr: Record<string, unknown> = { kind, dur, ease: str(inv, 'ease') ?? E.DEFAULT_EASE[kind as 'dissolve'] };
  if (dir) tr['dir'] = dir;
  else if (kind === 'wipe' || kind === 'push' || kind === 'slide') tr['dir'] = 'left';
  if (str(inv, 'color')) tr['color'] = str(inv, 'color');
  if (num(inv, 'feather') !== undefined) tr['feather'] = num(inv, 'feather');
  const field = side === 'in' ? 'transIn' : 'transOut';
  const r = runSpecs(inv, [{ type: 'clip.set', args: { id, patch: { [field]: tr } } }], `tl transition ${id} ${side} ${kind}`);
  // what it does, from the same plan the render uses
  const after = storeOf(inv).load().project;
  const plan = E.planTransitions(after).plans.find((x) => x.clip === id && x.side === side)!;
  const spare = plan.spare ? { [`${plan.between![0]} after its out point`]: Number.isFinite(plan.spare.after) ? Math.round(plan.spare.after) : 'still image', [`${plan.between![1]} before its in point`]: Number.isFinite(plan.spare.before) ? Math.round(plan.spare.before) : 'still image' } : undefined;
  const mid = Math.round((plan.window[0] + plan.window[1]) / 2);
  return {
    ...r,
    data: {
      ...(r.data as object),
      clip: id,
      [field]: tr,
      ...(plan.between ? { between: plan.between } : {}),
      window: plan.window,
      ...(spare ? { mediaToSpareMs: spare } : {}),
      meaning: plan.between
        ? `a ${kind} between ${plan.between[0]} and ${plan.between[1]} from ${plan.window[0]} to ${plan.window[1]} ms: ${plan.between[0]} plays on past its out point and ${plan.between[1]} starts before its in point, from their own media`
        : `${id} ${side === 'in' ? 'comes in' : 'goes out'} by a ${kind} from ${plan.window[0]} to ${plan.window[1]} ms, over what is below it`,
      next: [`studio render --still ${mid} --out check   (the middle of it)`, `studio render --range ${Math.max(0, plan.window[0] - 300)}:${plan.window[1] + 300} --preview   (watch it move)`],
    },
    ...(plan.warnings.length ? { warnings: [...((r as { warnings?: string[] }).warnings ?? []), ...plan.warnings] } : {}),
  };
};
