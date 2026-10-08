/**
 * `studio design ui`: serves the design editor (apps/design) and accepts its edits as ops (actor "ui") through the same
 * DesignStore the CLI uses, so an agent and a person can work on one design at once. It never touches project.studio.json.
 */
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesignStore, designHash, DESIGN_FILE } from '@studio/design/store';
import { OpError, PRESETS, type OpSpec } from '@studio/design';
import { CliError } from '../args.js';
import type { Handler } from '../main.js';
import { num } from './shared.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
};
const UPLOAD_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.wav', '.m4a', '.aac', '.ogg'];

function findDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const cands = [process.env['STUDIO_DESIGN_DIST'], resolve(here, '../../../apps/design/dist')].filter(Boolean) as string[];
  const d = cands.find((c) => existsSync(join(c, 'index.html')));
  if (!d) throw new CliError('ENGINE_MISSING', `design editor build not found (looked in ${cands.join(', ')})`, 3, 'run `pnpm design:build` in the Studio repo');
  return d;
}

export const designUi: Handler = async (inv) => {
  const dist = findDist();
  const readOnly = !!inv.flags['read-only'];
  const store = new DesignStore(inv.dir);
  store.load(); // fail now, clearly, if there is no design here

  const clients = new Set<ServerResponse>();
  let rev = '';
  const E = await import('@studio/engines');
  const fonts = (() => {
    try {
      const { palette, root } = E.loadPalette(inv.dir);
      return Object.values(palette.fonts).flatMap((f) =>
        Object.entries(f.files).map(([weight, rel]) => ({ family: f.family, weight, url: `/brand/${rel.replace(/^brand\//, '')}`, abs: resolve(root, rel) })),
      );
    } catch {
      return [];
    }
  })();
  const snapshot = () => {
    const { design } = store.load();
    const st = store.stacks();
    return {
      rev: designHash(design), design, canUndo: st.undo.length > 0, canRedo: st.redo.length > 0, readOnly,
      fonts: fonts.map(({ family, weight, url }) => ({ family, weight, url })),
      presets: PRESETS.map((p) => ({ id: p.id, summary: p.summary, defaults: p.defaults, ...(p.types ? { types: p.types } : {}) })),
    };
  };
  const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(inv.dir, (_ev, name) => {
    if (name !== DESIGN_FILE) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const snap = snapshot();
        if (snap.rev === rev) return;
        rev = snap.rev;
        for (const c of clients) send(c, 'design', snap);
      } catch (e) {
        for (const c of clients) send(c, 'problem', { message: (e as Error).message });
      }
    }, 40);
  });
  rev = snapshot().rev;

  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.headers['x-studio-ui'] !== '1' || !(req.headers['content-type'] ?? '').includes('application/json')) {
      json(res, 403, { code: 'FORBIDDEN', message: 'missing x-studio-ui header or JSON content type' });
      return false;
    }
    if (readOnly) {
      json(res, 403, { code: 'READ_ONLY', message: 'the editor server was started with --read-only' });
      return false;
    }
    return true;
  };
  const body = (req: IncomingMessage, limit: number): Promise<unknown> =>
    new Promise((ok, bad) => {
      let s = '';
      req.on('data', (d) => {
        s += d;
        if (s.length > limit) (bad(new Error('request too large')), req.destroy());
      });
      req.on('end', () => {
        try {
          ok(s ? JSON.parse(s) : {});
        } catch (e) {
          bad(e);
        }
      });
    });

  let exporting: Promise<unknown> = Promise.resolve();
  const handleWrite = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (!guard(req, res)) return;
    try {
      const b = (await body(req, path === '/api/asset' ? 60_000_000 : 2_000_000)) as Record<string, any>;
      if (path === '/api/asset') {
        const name = basename(String(b['name'] ?? '')).replace(/[^A-Za-z0-9_.-]/g, '_');
        const ext = extname(name).toLowerCase();
        if (!name || !UPLOAD_EXT.includes(ext)) return json(res, 400, { code: 'INVALID_ARGS', message: `unsupported file type; use ${UPLOAD_EXT.join(' ')}` });
        const buf = Buffer.from(String(b['data'] ?? ''), 'base64');
        if (!buf.length || buf.length > 40_000_000) return json(res, 400, { code: 'INVALID_ARGS', message: 'file is empty or larger than 40 MB' });
        mkdirSync(join(inv.dir, 'assets'), { recursive: true });
        let final = name;
        for (let i = 1; existsSync(join(inv.dir, 'assets', final)); i++) final = name.replace(ext, `-${i}${ext}`);
        writeFileSync(join(inv.dir, 'assets', final), buf);
        return json(res, 200, { ok: true, src: `assets/${final}` });
      }
      if (path === '/api/export') {
        const fmt = String(b['format'] ?? 'mp4') as import('@studio/engines').DesignFormat;
        if (!['mp4', 'webm', 'mov', 'gif', 'png-seq', 'png'].includes(fmt)) return json(res, 400, { code: 'INVALID_ARGS', message: 'unknown format' });
        const run = async () => {
          try {
            const r = await E.exportDesign({ dir: inv.dir, format: fmt, force: true, alpha: !!b['alpha'], ...(typeof b['scale'] === 'number' ? { scale: b['scale'] } : {}), ...(typeof b['at'] === 'number' ? { at: b['at'] } : {}) });
            json(res, 200, { ok: true, ...r, url: `/renders/${r.output.replace(/^renders\//, '')}` });
          } catch (e) {
            json(res, (e as { code?: string }).code === 'INVALID_INPUT' ? 422 : 500, { code: (e as { code?: string }).code ?? 'ENGINE_FAILED', message: (e as Error).message, fix: (e as { fix?: string }).fix });
          }
        };
        exporting = exporting.then(run, run);
        return;
      }
      const cur = snapshot();
      if (b['baseRev'] && b['baseRev'] !== cur.rev)
        return json(res, 409, { code: 'STALE', message: 'the design changed since you loaded it (an agent edit?); your edit was not applied', rev: cur.rev });
      if (path === '/api/ops') {
        if (!Array.isArray(b['specs']) || !b['specs'].length) return json(res, 400, { code: 'INVALID_ARGS', message: 'specs must be a non-empty array' });
        const step = store.apply(b['specs'] as OpSpec[], { actor: 'ui', label: typeof b['label'] === 'string' ? b['label'] : 'ui edit' });
        return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
      }
      if (path === '/api/undo' || path === '/api/redo') {
        const step = path === '/api/undo' ? store.undo({ actor: 'ui' }) : store.redo({ actor: 'ui' });
        return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
      }
      return json(res, 404, { code: 'NOT_FOUND', message: path });
    } catch (e) {
      const code = e instanceof OpError ? e.code : 'ENGINE_FAILED';
      return json(res, e instanceof OpError ? 422 : 500, { code, message: (e as Error).message });
    }
  };

  const serveFile = (res: ServerResponse, root: string, rel: string) => {
    const file = join(root, normalize(decodeURIComponent(rel)).replace(/^[/\\]+/, ''));
    if (!(file + sep).startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.statusCode = 403;
      return res.end('forbidden host');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return void handleWrite(req, res, url.pathname);
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }
    if (url.pathname === '/api/design') {
      try {
        return json(res, 200, snapshot());
      } catch (e) {
        return json(res, 500, { message: (e as Error).message });
      }
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      try {
        send(res, 'design', snapshot());
      } catch (e) {
        send(res, 'problem', { message: (e as Error).message });
      }
      return;
    }
    if (url.pathname.startsWith('/assets/')) return serveFile(res, resolve(inv.dir, 'assets'), url.pathname.slice('/assets/'.length));
    if (url.pathname.startsWith('/renders/')) return serveFile(res, resolve(inv.dir, 'renders'), url.pathname.slice('/renders/'.length));
    if (url.pathname.startsWith('/brand/')) {
      const f = fonts.find((x) => x.url === url.pathname);
      if (!f || !existsSync(f.abs)) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('content-type', MIME[extname(f.abs).toLowerCase()] ?? 'application/octet-stream');
      return res.end(readFileSync(f.abs));
    }
    return serveFile(res, dist, url.pathname === '/' ? '/index.html' : url.pathname);
  });

  const port = num(inv, 'port') ?? 4174;
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  }).catch((e: NodeJS.ErrnoException) => {
    watcher.close();
    throw new CliError('ENGINE_FAILED', e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message, 1, 'pass --port with another number, or --port 0');
  });
  const actual = (server.address() as { port: number }).port;
  inv.log(`Studio design editor: http://localhost:${actual}  (Ctrl+C to stop)`);
  const stop = () => {
    watcher.close();
    for (const c of clients) c.end();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { data: { url: `http://localhost:${actual}`, port: actual, design: inv.dir, readOnly } };
};
