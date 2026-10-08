import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { argvFor, EXCLUDED, listTools, toolName } from '../packages/cli/src/cmds/mcp.js';
import { COMMANDS } from '../packages/cli/src/registry.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');

/** A minimal MCP client over the server's stdio. */
function client(dir: string) {
  const child = spawn('node', [BIN, 'mcp', '--project', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (m: any) => void>();
  const stray: string[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      return void stray.push(l);
    }
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method: string) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await call('tools/call', { name, arguments: args })).result;
  const end = () =>
    new Promise<number | null>((r) => {
      child.on('close', r);
      child.stdin.end();
    });
  return { call, notify, tool, end, stray, child };
}

describe('P7: MCP server over the CLI', () => {
  it('every command except the long-running servers and mcp is a tool with a valid schema, and names are unique', () => {
    const tools = listTools();
    expect(tools.length).toBe(COMMANDS.length - EXCLUDED.size);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^studio_[a-z0-9_]+$/);
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description).toMatch(/Usage:/);
    }
    const trim = tools.find((t) => t.name === 'studio_tl_trim')!;
    expect(trim.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'studio_project_show')!.annotations.readOnlyHint).toBe(
      true,
    );
    expect(tools.some((t) => t.name === 'studio_ui' || t.name === 'studio_mcp')).toBe(false);
  });

  it('arguments become the same argv the CLI takes, and bad ones are refused before running', () => {
    const m = COMMANDS.find((c) => c.name === 'tl.add-clip')!;
    expect(argvFor(m, { track: 't_v1', asset: 'a_1', start: 0, dur: 1000 })).toEqual({
      argv: [
        'tl',
        'add-clip',
        '--track',
        't_v1',
        '--asset',
        'a_1',
        '--start',
        '0',
        '--dur',
        '1000',
      ],
    });
    expect(argvFor(m, { track: 't_v1', start: 'x' })).toHaveProperty('error');
    expect(
      (argvFor(m, { track: 't', asset: 'a', start: 0, dur: 5, nope: 1 }) as { error: string })
        .error,
    ).toMatch(/unknown argument "nope"/);
    expect(JSON.stringify(argvFor(m, { asset: 'a', start: 0 }))).toMatch(
      /missing required argument/,
    );
    expect(
      argvFor(
        COMMANDS.find((c) => c.name === 'render')!,
        { 'dry-run': true },
      ),
    ).toEqual({ argv: ['render', '--dry-run'] });
    expect(toolName(COMMANDS.find((c) => c.name === 'video.cut-silence')!)).toBe(
      'studio_video_cut_silence',
    );
  });

  it('speaks MCP: initialize, tools/list, tools/call, errors, ping; stdout carries only protocol messages', async () => {
    const dir = tmpDir('studio-p7-');
    const c = client(dir);
    const init = await c.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(init.result.serverInfo.name).toBe('studio');
    const old = await c.call('initialize', { protocolVersion: '1999-01-01' });
    expect(old.result.protocolVersion).toBe('2025-06-18'); // proposes its own newest
    c.notify('notifications/initialized');
    expect((await c.call('ping')).result).toEqual({});
    const list = await c.call('tools/list');
    expect(list.result.tools.length).toBe(COMMANDS.length - EXCLUDED.size);
    // init is an op-less command; then every state change below is an op the CLI logs
    const init2 = await c.tool('studio_init', { args: ['mcp-demo'], width: 640, height: 360 });
    expect(init2.isError).toBe(false);
    expect(init2.structuredContent.ok).toBe(true);
    expect(existsSync(join(dir, 'project.studio.json'))).toBe(true);
    const track = await c.tool('studio_tl_add_track', {
      type: 'graphics',
      name: 'Overlays',
      id: 't_g1',
    });
    expect(track.isError).toBe(false);
    const clip = await c.tool('studio_tl_add_clip', {
      track: 't_g1',
      comp: 'title',
      start: 0,
      dur: 2500,
      id: 'c_t1',
      props: '{"title":"Hello"}',
    });
    expect(clip.isError, clip.content[0].text).toBe(false);
    const show = await c.tool('studio_project_show');
    expect(show.structuredContent.data.clips ?? show.structuredContent.data.counts).toBeTruthy();
    expect(JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8')).clips).toHaveLength(
      1,
    );
    // the CLI's own errors come through as tool errors with the CLI's code and fix
    const bad = await c.tool('studio_tl_add_clip', {
      track: 't_g1',
      comp: 'title',
      start: 0,
      dur: 1000,
      props: '{"bogus":1}',
    });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe('INVALID_INPUT');
    // undo through the tool: the clip is gone, same as `studio project undo`
    const undo = await c.tool('studio_project_undo');
    expect(undo.isError).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8')).clips).toHaveLength(
      0,
    );
    // protocol errors
    expect((await c.call('tools/call', { name: 'studio_nope', arguments: {} })).error.code).toBe(
      -32602,
    );
    expect((await c.call('resources/list')).error.code).toBe(-32601);
    const badArg = await c.tool('studio_tl_trim', { id: 'c_t1', dur: 'long' });
    expect(badArg.isError).toBe(true);
    expect(badArg.content[0].text).toMatch(/must be a number/);
    expect(c.stray).toEqual([]);
    expect(await c.end()).toBe(0);
  }, 120_000);

  it('answers several calls in flight and exits cleanly when stdin closes', async () => {
    const dir = tmpDir('studio-p7-par-');
    const c = client(dir);
    await c.call('initialize', { protocolVersion: '2025-06-18' });
    await c.tool('studio_init', { args: ['p'] });
    const rs = await Promise.all(Array.from({ length: 6 }, () => c.tool('studio_project_show')));
    expect(rs.every((r) => !r.isError)).toBe(true);
    expect(await c.end()).toBe(0);
  }, 60_000);
});
