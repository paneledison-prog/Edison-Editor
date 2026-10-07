import { GLOBAL_FLAGS } from '../args.js';
import { COMMANDS } from '../registry.js';
import type { Handler } from '../main.js';

export const tools: Handler = async () => ({
  data: {
    commands: COMMANDS.map(({ name, summary, usage, example, flags, writes }) => ({
      name: name.replace(/\./g, ' '),
      summary,
      usage,
      example,
      flags,
      writes,
    })),
    globalFlags: GLOBAL_FLAGS,
    exitCodes: {
      0: 'ok',
      1: 'runtime error',
      2: 'invalid input',
      3: 'missing engine or model',
      4: 'validation failed',
      5: 'would overwrite (needs --force)',
    },
    output: 'stdout is one JSON object; logs go to stderr',
  },
});
