import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectHash, ProjectStore, timelineDuration } from '@studio/core';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num } from './shared.js';

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

export const ui: Handler = async (inv) => {
  const dist = findDist();
  const store = new ProjectStore(inv.dir);
  store.load(); // fail now with a clear message if there is no project

  const clients = new Set<ServerResponse>();
  let rev = '';
  const snapshot = () => {
    const { project } = store.load();
    return { rev: projectHash(project), project, timelineMs: timelineDuration(project) };
  };
  const send = (res: ServerResponse, event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Atomic writes replace the file, so watch the directory. Debounce 50 ms, send only when content changed.
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(inv.dir, (_ev, name) => {
    if (name !== 'project.studio.json') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const snap = snapshot();
        if (snap.rev === rev) return;
        rev = snap.rev;
        for (const c of clients) send(c, 'project', snap);
      } catch (e) {
        for (const c of clients) send(c, 'problem', { message: (e as Error).message });
      }
    }, 50);
  });
  rev = snapshot().rev;

  const server = createServer((req, res) => {
    // Only answer requests addressed to localhost: blocks DNS-rebinding reads of the project from a web page.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.statusCode = 403;
      return res.end('forbidden host');
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('read-only');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/project') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      try {
        return res.end(JSON.stringify(snapshot()));
      } catch (e) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ message: (e as Error).message }));
      }
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      try {
        send(res, 'project', snapshot());
      } catch (e) {
        send(res, 'problem', { message: (e as Error).message });
      }
      return;
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

  const port = num(inv, 'port') ?? 4173;
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  }).catch((e: NodeJS.ErrnoException) => {
    watcher.close();
    throw new CliError(
      'ENGINE_FAILED',
      e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message,
      1,
      'pass --port with another number, or --port 0',
    );
  });
  const actual = (server.address() as { port: number }).port;
  inv.log(`Studio UI: http://localhost:${actual}  (Ctrl+C to stop)`);
  const stop = () => {
    watcher.close();
    for (const c of clients) c.end();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return {
    data: { url: `http://localhost:${actual}`, port: actual, project: inv.dir, readOnly: true },
  };
};
