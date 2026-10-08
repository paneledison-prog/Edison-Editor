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
  let preset = str(inv, 'preset') ?? 'youtube-1080p';
  let reframe = str(inv, 'reframe') as 'fit' | 'blur' | 'center-crop' | undefined;
  const exportId = str(inv, 'export');
  if (exportId) {
    const ex = project.exports.find((e) => e.id === exportId);
    if (!ex)
      throw new CliError(
        'INVALID_ARGS',
        `export ${exportId} not found`,
        2,
        `recorded exports: ${project.exports.map((e) => e.id).join(', ') || 'none'}; add one with \`studio video reframe\``,
      );
    preset = ex.preset;
    if (!reframe) {
      if (ex.reframe && !['fit', 'blur', 'center-crop'].includes(ex.reframe)) {
        throw new CliError(
          'INVALID_ARGS',
          `export ${exportId} has reframe "${ex.reframe}", which needs tracking data that is not available`,
          2,
          'use fit, blur, or center-crop',
        );
      }
      reframe = ex.reframe as typeof reframe;
    }
  }
  const rep = await E.render({
    project,
    projectDir: inv.dir,
    preset,
    preview: !!inv.flags['preview'],
    range,
    still: num(inv, 'still'),
    name: str(inv, 'out'),
    force: inv.force,
    encoder: str(inv, 'encoder'),
    noNormalize: !!inv.flags['no-normalize'],
    width: num(inv, 'width'),
    reframe,
    x264Preset: str(inv, 'x264-preset'),
    alphaFormat: str(inv, 'alpha-format') as 'prores4444' | 'webm' | undefined,
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
