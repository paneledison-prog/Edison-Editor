import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { FlagDef } from '../args.js';
import { GLOBAL_FLAGS } from '../args.js';
import type { Handler } from '../main.js';
import { COMMANDS, type CmdMeta } from '../registry.js';

/**
 * MCP server over stdio: a thin layer over the CLI. Every tool is a registry command, and a call runs that same
 * command (this bundle, as a child process), so validation, ops, undo, JSON, and exit codes are identical to the CLI.
 * Nothing here is written to stdout except protocol messages: logs go to stderr.
 */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** `ui` is a long-running server and `mcp` is this process. */
export const EXCLUDED = new Set(['ui', 'mcp', 'design.ui']);

export const toolName = (m: CmdMeta) => `studio_${m.name.replace(/[.-]/g, '_')}`;

function schemaFor(m: CmdMeta) {
  const flagSchema = (f: FlagDef) => ({
    type: f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string',
    description: f.desc,
    ...(f.values ? { enum: f.values } : {}),
  });
  const props: Record<string, unknown> = {
    args: {
      type: 'array',
      items: { type: 'string' },
      description: `positional arguments, as in the usage line: ${m.usage}`,
    },
  };
  for (const f of m.flags) props[f.name] = flagSchema(f);
  // global flags that change what a call does
  for (const g of GLOBAL_FLAGS)
    if (['dry-run', 'force'].includes(g.name)) props[g.name] = flagSchema(g);
  props['project'] = {
    type: 'string',
    description: 'project directory (default: the one the server was started in)',
  };
  return {
    type: 'object',
    properties: props,
    required: m.flags.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };
}

export function listTools() {
  return COMMANDS.filter((c) => !EXCLUDED.has(c.name)).map((m) => ({
    name: toolName(m),
    title: `studio ${m.argv.join(' ')}`,
    description: `${m.summary}\nUsage: ${m.usage}\nExample: ${m.example}`,
    inputSchema: schemaFor(m),
    annotations: {
      readOnlyHint: !m.writes,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }));
}

/** argv for one tool call, or an error message when the arguments do not fit the command. */
export function argvFor(
  m: CmdMeta,
  a: Record<string, unknown>,
): { argv: string[] } | { error: string } {
  const known = new Set([...m.flags.map((f) => f.name), 'args', 'project', 'dry-run', 'force']);
  for (const k of Object.keys(a))
    if (!known.has(k)) return { error: `unknown argument "${k}" for ${m.name}` };
  const argv = [...m.argv];
  if (a['args'] !== undefined) {
    if (!Array.isArray(a['args']) || a['args'].some((x) => typeof x !== 'string'))
      return { error: '"args" must be an array of strings' };
    argv.push(...(a['args'] as string[]));
  }
  for (const f of m.flags) {
    const v = a[f.name];
    if (v === undefined) {
      if (f.required) return { error: `missing required argument "${f.name}"` };
      continue;
    }
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') return { error: `"${f.name}" must be true or false` };
      if (v) argv.push(`--${f.name}`);
    } else if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v))
        return { error: `"${f.name}" must be a number` };
      argv.push(`--${f.name}`, String(v));
    } else {
      if (typeof v !== 'string') return { error: `"${f.name}" must be a string` };
      argv.push(`--${f.name}`, v);
    }
  }
  for (const g of ['dry-run', 'force']) if (a[g] === true) argv.push(`--${g}`);
  return { argv };
}

function runCli(
  argv: string[],
  dir: string,
): Promise<{ text: string; ok: boolean; json?: unknown }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [process.argv[1]!, ...argv, '--project', dir],
      { maxBuffer: 512 * 1024 * 1024, timeout: 3 * 3600_000 },
      (err, stdout, stderr) => {
        let json: any;
        try {
          json = JSON.parse(stdout);
        } catch {
          /* not JSON: report the raw text below */
        }
        const ok = !err && json?.ok === true;
        resolve({
          text:
            stdout.trim() || (stderr.trim().split('\n').pop() ?? (err ? String(err.message) : '')),
          ok,
          json,
        });
      },
    );
  });
}

export const mcp: Handler = async (inv) => {
  const dir = inv.dir;
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, 'parse error');
    }
    const { id, method, params } = msg;
    if (method === undefined) return; // a response to something we never asked
    if (id === undefined) return; // notifications (initialized, cancelled): nothing to do
    pending++;
    try {
      if (method === 'initialize') {
        const want = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'studio', version: '0.0.0' },
          instructions:
            'Studio edits real media through ops on project.studio.json. Every tool is a studio CLI command; results are the same JSON the CLI prints. State changes are undoable with studio_project_undo.',
        });
      }
      if (method === 'ping') return reply(id, {});
      if (method === 'tools/list') return reply(id, { tools: listTools() });
      if (method === 'tools/call') {
        const m = COMMANDS.find((c) => !EXCLUDED.has(c.name) && toolName(c) === params?.name);
        if (!m) return fail(id, -32602, `unknown tool "${params?.name}"`);
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const built = argvFor(m, args);
        if ('error' in built)
          return reply(id, { content: [{ type: 'text', text: built.error }], isError: true });
        const r = await runCli(
          built.argv,
          typeof args['project'] === 'string' ? args['project'] : dir,
        );
        return reply(id, {
          content: [{ type: 'text', text: r.text }],
          ...(r.json && typeof r.json === 'object' ? { structuredContent: r.json } : {}),
          isError: !r.ok,
        });
      }
      return fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      return fail(id, -32603, (e as Error).message);
    } finally {
      pending--;
      maybeExit();
    }
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
  inv.log(`Studio MCP server on stdio, project ${dir}`);
  // Never resolves: the process ends when stdin closes. Returning would make the CLI print a JSON line on stdout.
  return new Promise(() => {});
};
