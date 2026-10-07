import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num, store, str } from './shared.js';

export const render: Handler = async (inv) => {
  const E = await import('@studio/engines');
  const { project } = store(inv).load();
  let range: [number, number] | undefined;
  const r = str(inv, 'range');
  if (r) {
    const m = /^(\d+):(\d+)$/.exec(r);
    if (!m) throw new CliError('INVALID_ARGS', `--range must look like 1000:5000 (ms), got "${r}"`);
    range = [Number(m[1]), Number(m[2])];
  }
  const explain = inv.dryRun || !!inv.flags['explain'];
  const rep = await E.render({
    project,
    projectDir: inv.dir,
    preset: str(inv, 'preset') ?? 'youtube-1080p',
    preview: !!inv.flags['preview'],
    range,
    still: num(inv, 'still'),
    name: str(inv, 'out'),
    force: inv.force,
    encoder: str(inv, 'encoder'),
    noNormalize: !!inv.flags['no-normalize'],
    explain,
    log: inv.log,
  });
  const { notes, ...data } = rep;
  return {
    data,
    warnings: notes,
    artifacts: rep.output
      ? [
          { kind: 'render', path: rep.output },
          { kind: 'project-snapshot', path: rep.sidecar! },
        ]
      : [],
  };
};
