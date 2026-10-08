export type FlagType = 'string' | 'number' | 'boolean';
export interface FlagDef {
  name: string;
  type: FlagType;
  desc: string;
  required?: boolean;
  values?: string[];
}
export type FlagValue = string | number | boolean;
export interface Parsed {
  flags: Record<string, FlagValue>;
  positionals: string[];
}

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit: 1 | 2 | 3 | 4 | 5 = 2,
    public fix?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Minimal parser: --flag, --flag value, --flag=value, `--` ends flags. Unknown flags are errors. */
export function parseArgs(argv: string[], defs: FlagDef[]): Parsed {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const def = byName.get(name);
    if (!def)
      throw new CliError(
        'INVALID_ARGS',
        `unknown flag --${name}`,
        2,
        'run `studio tools` to list flags per command',
      );
    let raw: string | undefined = eq < 0 ? undefined : a.slice(eq + 1);
    if (def.type === 'boolean') {
      if (raw !== undefined && !['true', 'false'].includes(raw))
        throw new CliError('INVALID_ARGS', `--${name} takes no value (or true/false)`);
      flags[name] = raw === undefined ? true : raw === 'true';
      continue;
    }
    if (raw === undefined) {
      raw = argv[++i];
      if (raw === undefined || raw.startsWith('--'))
        throw new CliError('INVALID_ARGS', `--${name} needs a value`);
    }
    if (def.type === 'number') {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n))
        throw new CliError('INVALID_ARGS', `--${name} must be a number, got "${raw}"`);
      flags[name] = n;
    } else {
      if (def.values && !def.values.includes(raw))
        throw new CliError(
          'INVALID_ARGS',
          `--${name} must be one of ${def.values.join(', ')}; got "${raw}"`,
        );
      flags[name] = raw;
    }
  }
  for (const d of defs) {
    if (d.required && flags[d.name] === undefined)
      throw new CliError('INVALID_ARGS', `missing required flag --${d.name}`);
  }
  return { flags, positionals };
}

export const GLOBAL_FLAGS: FlagDef[] = [
  { name: 'project', type: 'string', desc: 'project directory (default: current directory)' },
  { name: 'dry-run', type: 'boolean', desc: 'compute and report, write nothing' },
  { name: 'pretty', type: 'boolean', desc: 'indent JSON output' },
  { name: 'force', type: 'boolean', desc: 'allow overwriting existing output' },
  {
    name: 'actor',
    type: 'string',
    desc: 'who is acting, recorded in the log',
    values: ['agent', 'ui', 'cli'],
  },
  { name: 'json', type: 'boolean', desc: 'accepted for clarity; output is always JSON' },
];
