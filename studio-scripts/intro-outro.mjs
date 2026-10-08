// Adds a title card at the start of the graphics track and a closing card at the end of the timeline.
export const meta = {
  summary: 'Add a title at the start and a closing card at the end of the timeline.',
  args: {
    title: { type: 'string', required: true, desc: 'opening title' },
    subtitle: { type: 'string', desc: 'opening subtitle' },
    outro: { type: 'string', default: 'Thanks for watching', desc: 'closing line' },
    track: { type: 'string', required: true, desc: 'graphics track id' },
    introMs: { type: 'number', default: 2600, desc: 'opening card length' },
    outroMs: { type: 'number', default: 3000, desc: 'closing card length' },
  },
};
export default async function run(api) {
  const a = api.args;
  const end = Math.max(...api.project.clips.map((c) => c.start + c.dur));
  const place = async (comp, start, dur, props) => {
    const before = new Set(api.project.clips.map((c) => c.id));
    await api.studio(['tl', 'add-clip', '--track', a.track, '--comp', comp, '--start', String(start), '--dur', String(dur)]);
    const id = api.project.clips.find((c) => !before.has(c.id)).id;
    await api.studio(['tl', 'set', '--id', id, '--patch', JSON.stringify({ props })]);
    return id;
  };
  const intro = await place('title', 0, a.introMs, { title: a.title, ...(a.subtitle ? { subtitle: a.subtitle } : {}) });
  const close = await place('title', Math.max(0, end - a.outroMs), a.outroMs, { title: a.outro });
  return { intro, close };
}
