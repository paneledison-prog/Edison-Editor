import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectHash, ProjectStore, timelineDuration, OpError, type OpSpec } from '@studio/core';
import {
  kindOfSlot, listInfo, readLease, readMeta, slotDir, SLOT_LIMIT, WorkspaceError, type Info,
} from '@studio/workspace';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num } from './shared.js';
import { rootOf } from './workspace.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function findDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // packages/cli/dist/
  const cands = [process.env['STUDIO_UI_DIST'], resolve(here, '../../../apps/ui/dist')].filter(
    Boolean,
  ) as string[];
  const d = cands.find((c) => existsSync(join(c, 'index.html')));
  if (!d)
    throw new CliError(
      'ENGINE_MISSING',
      `UI build not found (looked in ${cands.join(', ')})`,
      3,
      'run `pnpm ui:build` in the Studio repo',
    );
  return d;
}

/** What the page needs to know about the agent lease. */
const leaseView = (dir: string) => {
  const l = readLease(dir);
  return l ? { agent: l.agent, ...(l.note ? { note: l.note } : {}), since: l.since, expires: l.expires } : null;
};
const brief = (w: Info) => ({
  slot: w.slot,
  name: w.name,
  state: w.state,
  ...(w.agent ? { agent: w.agent, ...(w.note ? { note: w.note } : {}) } : {}),
  items: w.items,
  assets: w.assets,
});

export const ui: Handler = async (inv) => {
  const dist = findDist();
  const readOnly = !!inv.flags['read-only'];
  const hub = !!inv.flags['hub'];
  const root = rootOf(inv);

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const send = (res: ServerResponse, event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const sh = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

  /**
   * Everything that belongs to one project: its store, the pages watching it, the frame queue. A single-project server
   * has one; the hub makes one per workspace the first time a page asks for it (at most five exist).
   */
  const makeCtx = (dir: string) => {
    const store = new ProjectStore(dir);
    store.load(); // fail now with a clear message if there is no project
    const clients = new Set<ServerResponse>();
    /** The lease each open page was last told about. Compared per page, so a page that connected while an agent was working still hears it end. */
    const known = new Map<ServerResponse, string>();
    let rev = '';
    const snapshot = () => {
      const { project } = store.load();
      const st = store.stacks();
      return {
        rev: projectHash(project),
        project,
        timelineMs: timelineDuration(project),
        canUndo: st.undo.length > 0,
        canRedo: st.redo.length > 0,
        readOnly,
        lease: leaseView(dir),
      };
    };

    // Atomic writes replace the file, so watch the directory. Debounce 50 ms, send only when content changed.
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(dir, (_ev, name) => {
      if (name !== 'project.studio.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const snap = snapshot();
          if (snap.rev === rev) return;
          rev = snap.rev;
          const k = JSON.stringify(snap.lease);
          for (const c of clients) {
            send(c, 'project', snap);
            known.set(c, k);
          }
        } catch (e) {
          for (const c of clients) send(c, 'problem', { message: (e as Error).message });
        }
      }, 50);
    });
    rev = snapshot().rev;

    /** A lease starts, is renewed with a new expiry, or runs out without any file change the watcher would see. */
    const tickLease = () => {
      const lease = leaseView(dir);
      const k = JSON.stringify(lease);
      for (const c of clients)
        if (known.get(c) !== k) {
          send(c, 'lease', { lease });
          known.set(c, k);
        }
    };

    /**
     * One frame of the timeline for the canvas. Requests are serialized (one ffmpeg and one browser at a time) and a
     * request for an old time is cheap to drop: the page only keeps the newest answer.
     */
    let framing: Promise<unknown> = Promise.resolve();
    const sendFrame = (res: ServerResponse, url: URL) => {
      const t = Number(url.searchParams.get('t'));
      const w = Number(url.searchParams.get('w') ?? 640);
      if (!Number.isInteger(t) || t < 0 || !Number.isFinite(w))
        return json(res, 400, {
          code: 'INVALID_ARGS',
          message: 't must be a whole number of milliseconds, w a width in px',
        });
      const run = async () => {
        try {
          const E = await import('@studio/engines');
          const { project } = store.load();
          const r = await E.previewFrame(project, dir, t, w);
          res.setHeader('content-type', 'image/png');
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-preview-ms', String(r.ms));
          res.setHeader('x-preview-cached', String(r.cached));
          res.end(readFileSync(r.file));
        } catch (e) {
          const code = (e as { code?: string }).code;
          // "No preview for this frame" (missing media, an encoder failure) is an expected state, not a server error:
          // 204 with the reason in a header keeps the browser console clean and lets the page say why.
          if (code === 'ENGINE_MISSING' || code === 'ENGINE_FAILED') {
            res.statusCode = 204;
            res.setHeader('x-preview-error', encodeURIComponent((e as Error).message.slice(0, 300)));
            return void res.end();
          }
          json(res, code === 'INVALID_INPUT' ? 422 : 500, {
            code: code ?? 'ENGINE_FAILED',
            message: (e as Error).message,
            fix: (e as { fix?: string }).fix,
          });
        }
      };
      framing = framing.then(run, run);
    };

    /** What a person needs to connect Claude Code to this project: the exact command for this machine and folder. */
    const connectorInfo = async () => {
      const cli = process.argv[1]!;
      const { listTools } = await import('./mcp.js');
      return {
        cli,
        node: process.execPath,
        project: dir,
        tools: listTools().length,
        command: `claude mcp add studio -- node ${sh(cli)} mcp --project ${sh(dir)}`,
        mcpJson: {
          mcpServers: { studio: { command: 'node', args: [cli, 'mcp', '--project', dir] } },
        },
      };
    };
    /** Starts a throwaway `studio mcp`, performs initialize and tools/list, and reports what came back. */
    const checkMcp = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const t0 = Date.now();
        import('node:child_process').then(({ spawn }) => {
          const child = spawn(process.execPath, [process.argv[1]!, 'mcp', '--project', dir], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let buf = '';
          let err = '';
          let done = false;
          const finish = (r: Record<string, unknown>) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            child.kill();
            resolve({ ...r, ms: Date.now() - t0 });
          };
          const timer = setTimeout(
            () => finish({ ok: false, message: 'the MCP server did not answer within 10 s' }),
            10_000,
          );
          child.stderr.on('data', (d) => (err += d));
          // the child can exit while a request is being written (it is killed when the answer is in): never crash the UI server on it
          child.stdin.on('error', () => {});
          child.on('error', (e) => finish({ ok: false, message: e.message }));
          child.on('close', (code) =>
            finish({
              ok: false,
              message: `the MCP server exited (${code}): ${err.trim().split('\n').pop() ?? ''}`,
            }),
          );
          child.stdout.on('data', (d) => {
            buf += d;
            // each complete line once: the answer to tools/list is large and comes in many chunks
            const lines = buf.split('\n');
            buf = lines.pop()!;
            for (const line of lines) {
              if (done) return;
              let m: any;
              try {
                m = JSON.parse(line);
              } catch {
                continue;
              }
              if (m.id === 1)
                child.stdin.write(
                  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
                );
              if (m.id === 2)
                finish({
                  ok: Array.isArray(m.result?.tools),
                  tools: m.result?.tools?.length ?? 0,
                  server: 'studio',
                });
            }
          });
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'studio-ui-check', version: '0' },
              },
            }) + '\n',
          );
        });
      });

    /**
     * Edits from the page. Each is one validated, logged, undoable op batch with actor "ui", through the same store the
     * CLI uses. `baseRev` is the project the person was looking at: if an agent changed it since, nothing is applied
     * (409) and the page, which already received the new project, shows what happened. While an agent holds the
     * workspace nothing is applied at all (423): the person may watch, and edits when the agent has finished. The person
     * adds no media either: ops that register assets are the agent's.
     */
    const handleWrite = (req: IncomingMessage, res: ServerResponse, path: string) => {
      // Cross-site pages cannot send this header without a preflight, which this server never grants.
      if (
        req.headers['x-studio-ui'] !== '1' ||
        !(req.headers['content-type'] ?? '').includes('application/json')
      )
        return json(res, 403, {
          code: 'FORBIDDEN',
          message: 'missing x-studio-ui header or JSON content type',
        });
      if (readOnly)
        return json(res, 403, {
          code: 'READ_ONLY',
          message: 'the UI server was started with --read-only',
        });
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const lease = leaseView(dir);
          if (lease)
            return json(res, 423, {
              code: 'AGENT_WORKING',
              message: `${lease.agent} is working here${lease.note ? ` (${lease.note})` : ''}; editing opens again when it finishes`,
              lease,
            });
          const b = body ? JSON.parse(body) : {};
          const cur = snapshot();
          if (b.baseRev && b.baseRev !== cur.rev)
            return json(res, 409, {
              code: 'STALE',
              message:
                'the project changed since you loaded it (an agent edit?); your edit was not applied',
              rev: cur.rev,
            });
          if (path === '/api/ops') {
            if (!Array.isArray(b.specs) || !b.specs.length)
              return json(res, 400, {
                code: 'INVALID_ARGS',
                message: 'specs must be a non-empty array',
              });
            if ((b.specs as OpSpec[]).some((x) => /^asset\./.test(String(x?.type))))
              return json(res, 403, {
                code: 'AGENT_ONLY',
                message: 'media is added by your agent: ask it to ingest the file',
              });
            const step = store.apply(b.specs as OpSpec[], {
              actor: 'ui',
              label: typeof b.label === 'string' ? b.label : 'ui edit',
            });
            return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
          }
          if (path === '/api/undo' || path === '/api/redo') {
            const step =
              path === '/api/undo' ? store.undo({ actor: 'ui' }) : store.redo({ actor: 'ui' });
            return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
          }
          return json(res, 404, { code: 'NOT_FOUND', message: path });
        } catch (e) {
          if (e instanceof WorkspaceError) return json(res, 423, { code: e.code, message: e.message });
          const code = e instanceof OpError ? e.code : 'ENGINE_FAILED';
          return json(res, code === 'NOT_FOUND' || e instanceof OpError ? 422 : 500, {
            code,
            message: (e as Error).message,
          });
        }
      });
    };

    const events = (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      clients.add(res);
      req.on('close', () => (clients.delete(res), known.delete(res)));
      try {
        const snap = snapshot();
        send(res, 'project', snap);
        known.set(res, JSON.stringify(snap.lease));
      } catch (e) {
        send(res, 'problem', { message: (e as Error).message });
      }
    };
    const close = () => {
      clearTimeout(timer);
      watcher.close();
      for (const c of clients) {
        send(c, 'gone', {});
        c.end();
      }
    };
    return { dir, born: readMeta(dir)?.createdAt, clients, snapshot, tickLease, sendFrame, connectorInfo, checkMcp, handleWrite, events, close };
  };
  type Ctx = ReturnType<typeof makeCtx>;

  // Single mode: the one project this server was started for. Hub mode: workspaces m1..m5, found on first use.
  const single: Ctx | undefined = hub ? undefined : makeCtx(inv.dir);
  const hubCtxs = new Map<string, Ctx>();
  const ctxFor = (url: URL): Ctx | undefined => {
    if (!hub) return single;
    const id = url.searchParams.get('ws') ?? '';
    if (kindOfSlot(id) !== 'media') return undefined;
    const have = hubCtxs.get(id);
    if (have) return have;
    const dir = slotDir(root, id);
    if (!existsSync(join(dir, 'project.studio.json'))) return undefined;
    const c = makeCtx(dir);
    hubCtxs.set(id, c);
    return c;
  };
  const notFound = (res: ServerResponse) =>
    json(res, 404, { code: 'NOT_FOUND', message: 'no such workspace (it may have been closed)', fix: 'studio ws list' });

  // The tab strip: which workspaces exist and who is working in them.
  const wsClients = new Set<ServerResponse>();
  /** What each tab strip was last told, so one that connected between changes still gets the next one. */
  const wsKnown = new Map<ServerResponse, string>();
  const wsView = () => ({
    mode: hub ? 'hub' : 'single',
    kind: 'media',
    limit: SLOT_LIMIT,
    workspaces: hub ? listInfo(root, 'media').map(brief) : [],
  });
  const tick = () => {
    // closed (or replaced) workspaces: drop their watchers and tell the pages that were open on them
    for (const [id, c] of hubCtxs) {
      const here = existsSync(join(c.dir, 'project.studio.json')) && readMeta(c.dir)?.createdAt === c.born;
      if (!here) {
        c.close();
        hubCtxs.delete(id);
      }
    }
    for (const c of hubCtxs.values()) if (c.clients.size) c.tickLease();
    single?.tickLease();
    if (!wsClients.size) return;
    const view = wsView();
    const k = JSON.stringify(view);
    for (const c of wsClients)
      if (wsKnown.get(c) !== k) {
        send(c, 'workspaces', view);
        wsKnown.set(c, k);
      }
  };
  const ticker = setInterval(tick, 700);

  const server = createServer((req, res) => {
    // Only answer requests addressed to localhost: blocks DNS-rebinding reads of the project from a web page.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.statusCode = 403;
      return res.end('forbidden host');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, wsView());
    if (req.method === 'GET' && url.pathname === '/api/workspaces/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      wsClients.add(res);
      req.on('close', () => (wsClients.delete(res), wsKnown.delete(res)));
      const view = wsView();
      wsKnown.set(res, JSON.stringify(view));
      return void send(res, 'workspaces', view);
    }
    if (url.pathname.startsWith('/api/')) {
      const ctx = ctxFor(url);
      if (!ctx) return notFound(res);
      if (req.method === 'GET' && url.pathname === '/api/frame') return void ctx.sendFrame(res, url);
      if (req.method === 'GET' && url.pathname === '/api/connector')
        return void ctx.connectorInfo().then((d) => json(res, 200, d));
      if (req.method === 'POST' && url.pathname === '/api/connector/check') {
        if (req.headers['x-studio-ui'] !== '1')
          return json(res, 403, { code: 'FORBIDDEN', message: 'missing x-studio-ui header' });
        return void ctx.checkMcp().then((d) => json(res, 200, d));
      }
      if (req.method === 'POST') return void ctx.handleWrite(req, res, url.pathname);
      if (req.method !== 'GET') {
        res.statusCode = 405;
        return res.end('method not allowed');
      }
      if (url.pathname === '/api/project') {
        try {
          return json(res, 200, ctx.snapshot());
        } catch (e) {
          return json(res, 500, { message: (e as Error).message });
        }
      }
      if (url.pathname === '/api/events') return void ctx.events(req, res);
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }
    const rel = normalize(
      decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    ).replace(/^[/\\]+/, '');
    const file = join(dist, rel);
    if (!(file + sep).startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });

  const allCtx = () => [...(single ? [single] : []), ...hubCtxs.values()];
  const port = num(inv, 'port') ?? 4173;
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  }).catch((e: NodeJS.ErrnoException) => {
    clearInterval(ticker);
    for (const c of allCtx()) c.close();
    throw new CliError(
      'ENGINE_FAILED',
      e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message,
      1,
      'pass --port with another number, or --port 0',
    );
  });
  const actual = (server.address() as { port: number }).port;
  inv.log(`Studio UI: http://localhost:${actual}${hub ? '  (workspaces m1..m5 under ' + root + ')' : ''}  (Ctrl+C to stop)`);
  const stop = () => {
    clearInterval(ticker);
    for (const c of allCtx()) c.close();
    for (const c of wsClients) c.end();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return {
    data: {
      url: `http://localhost:${actual}`,
      port: actual,
      project: hub ? null : inv.dir,
      ...(hub ? { hub: true, root } : {}),
      readOnly,
    },
  };
};
