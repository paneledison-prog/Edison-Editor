import { readFileSync } from 'node:fs';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { parseJson, str, runSpecs } from './shared.js';

type Spec = { type: string; args: Record<string, unknown> };
const isSpec = (x: any): x is Spec =>
  !!x &&
  typeof x.type === 'string' &&
  !!x.args &&
  typeof x.args === 'object' &&
  !Array.isArray(x.args);

export const apply: Handler = async (inv) => {
  const src = inv.positionals[0];
  if (!src)
    throw new CliError('INVALID_ARGS', 'missing ops file', 2, 'studio ops apply <ops.json|->');
  let text: string;
  try {
    text = readFileSync(src === '-' ? 0 : src, 'utf8');
  } catch (e) {
    throw new CliError('INVALID_ARGS', `cannot read ${src}: ${(e as Error).message}`);
  }
  const raw = parseJson(src, text);
  const list: unknown = Array.isArray(raw) ? raw : raw?.ops;
  if (!Array.isArray(list) || !list.every(isSpec)) {
    throw new CliError(
      'INVALID_ARGS',
      `${src}: expected an array of {type, args} or {ops: [...]}; every op needs a string "type" and an "args" object`,
    );
  }
  const specs = list as Spec[];
  const label =
    str(inv, 'label') ?? (Array.isArray(raw) ? undefined : (raw.label as string | undefined));
  return runSpecs(inv, specs, label);
};
