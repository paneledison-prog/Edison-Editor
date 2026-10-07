import { CliError } from '../args.js';
import type { Handler } from '../main.js';

export const doctor: Handler = async (inv) => {
  const { doctor: run } = await import('@studio/engines');
  const r = await run(inv.dir);
  const fatal = r.problems.find((p) => p.code === 'ENGINE_MISSING' || p.code === 'ENCODER_MISSING');
  if (fatal) throw new CliError(fatal.code, fatal.message, 3, fatal.fix, r);
  const hw = r.ffmpeg!.encoders.filter((e) => e.kind === 'hardware');
  return {
    data: r,
    warnings: [
      ...r.problems.map((p) => `${p.message} (${p.fix})`),
      ...(hw.length && !hw.some((e) => e.usable)
        ? [
            'no hardware encoder is usable here (listed in ffmpeg, failed a test encode); x264 will be used',
          ]
        : []),
    ],
  };
};
