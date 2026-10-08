// Punch-in zoom: ease to `scale` at `at`, hold, ease back. Writes scale keyframes through `studio tl keyframe`.
export const meta = {
  summary: 'Punch-in zoom on a clip: ease in, hold, ease out.',
  args: {
    clip: { type: 'string', required: true, desc: 'media clip id' },
    at: { type: 'number', default: 1000, desc: 'ms into the clip where the zoom starts' },
    scale: { type: 'number', default: 1.3, desc: 'zoom level, 1 to 8' },
    inMs: { type: 'number', default: 350, desc: 'ease-in length' },
    holdMs: { type: 'number', default: 1200, desc: 'time held at full zoom' },
    outMs: { type: 'number', default: 400, desc: 'ease-out length' },
    x: { type: 'number', default: 0.5, desc: 'focus x, fraction of the frame' },
    y: { type: 'number', default: 0.5, desc: 'focus y, fraction of the frame' },
  },
};
export default async function run(api) {
  const a = api.args;
  const clip = api.project.clips.find((c) => c.id === a.clip);
  if (!clip) throw new Error(`no clip ${a.clip}`);
  const t0 = a.at, t1 = t0 + a.inMs, t2 = t1 + a.holdMs, t3 = t2 + a.outMs;
  if (t3 > clip.dur) throw new Error(`the zoom ends at ${t3} ms but the clip is ${clip.dur} ms long`);
  const kf = (prop, t, v, ease) =>
    api.studio(['tl', 'keyframe', '--clip', a.clip, '--prop', prop, '--t', String(t), '--v', String(v), '--ease', ease]);
  for (const [t, v, e] of [[t0, 1, 'expo.inOut'], [t1, a.scale, 'expo.inOut'], [t2, a.scale, 'expo.inOut'], [t3, 1, 'expo.inOut']]) await kf('scale', t, v, e);
  for (const prop of ['x', 'y'])
    for (const t of [t0, t1, t2, t3]) await kf(prop, t, prop === 'x' ? a.x : a.y, 'linear');
  return { zoom: { from: t0, to: t3, scale: a.scale } };
}
