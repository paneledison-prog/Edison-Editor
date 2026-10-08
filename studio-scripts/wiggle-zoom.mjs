// A slow, alive push-in with a little handheld wiggle, baked from a formula.
export const meta = {
  summary: 'Slow push-in with handheld wiggle over a clip, baked from an expression.',
  args: {
    clip: { type: 'string', required: true, desc: 'media clip id' },
    amount: { type: 'number', default: 0.12, desc: 'how far to push in (0.12 = 12%)' },
    shake: { type: 'number', default: 0.006, desc: 'wiggle size, as a fraction of the scale' },
    stepMs: { type: 'number', default: 200, desc: 'sample spacing in ms' },
  },
};
export default async function run(api) {
  const a = api.args;
  const expr = `clamp(1 + ${a.amount} * p + ${a.shake} * (1 + wiggle(2.5, 1)), 1, 8)`;
  const r = await api.studio(['expr', 'bake', '--clip', a.clip, '--prop', 'scale', '--expr', expr, '--step', String(a.stepMs)]);
  return { expr, keyframes: r.baked?.keyframes };
}
