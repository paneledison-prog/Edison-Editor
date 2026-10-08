/**
 * `studio design ui`: serves the design editor (apps/design) and accepts its edits as ops (actor "ui") through the same
 * DesignStore the CLI uses. It never touches project.studio.json. A person edits only while no agent holds the design (the
 * lease), and adds no media: images and audio are placed by the agent. With --hub it serves design workspaces d1..d5.
 */
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesignStore, designHash, DESIGN_FILE } from '@studio/design/store';
import { OpError, PRESETS, type OpSpec } from '@studio/design';
import { kindOfSlot, listInfo, readLease, readMeta, slotDir, SLOT_LIMIT, WorkspaceError, type Info } from '@studio/workspace';
import { CliError } from '../args.js';
import { withJob } from '../jobs.js';
import type { Handler } from '../main.js';
import { num } from './shared.js';
import { rootOf } from './workspace.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
};

function findDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const cands = [process.env['STUDIO_DESIGN_DIST'], resolve(here, '../../../apps/design/dist')].filter(Boolean) as string[];
  const d = cands.find((c) => existsSync(join(c, 'index.html')));
  if (!d) throw new CliError('ENGINE_MISSING', `design editor build not found (looked in ${cands.join(', ')})`, 3, 'run `pnpm design:build` in the Studio repo');
  return d;
}

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
/** Edits from a page that would bring in media: refused, the agent does that. */
function addsMedia(specs: OpSpec[]): boolean {
  const media = (t: unknown) => t === 'image' || t === 'audio';
  return specs.some((x) => {
    const a = (x?.args ?? {}) as Record<string, any>;
    if (x?.type === 'layer.add') return media(a['layer']?.type);
    if (x?.type === 'layer.set') return !!a['patch'] && typeof a['patch'] === 'object' && 'src' in a['patch'];
    if (x?.type === 'layer.restore') return Array.isArray(a['layers']) && a['layers'].some((l: any) => media(l?.type));
    return false;
  });
}

export const designUi: Handler = async (inv) => {
  const dist = findDist();
  const readOnly = !!inv.flags['read-only'];
  const hub = !!inv.flags['hub'];
  const root = rootOf(inv);
  const E = await import('@studio/engines');

  const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
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
  const serveFile = (res: ServerResponse, rootDir: string, rel: string) => {
    const file = join(rootDir, normalize(decodeURIComponent(rel)).replace(/^[/\\]+/, ''));
    if (!(file + sep).startsWith(rootDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(readFileSync(file));
  };

  /** Everything that belongs to one design. A single-design server has one; the hub makes one per workspace on first use. */
  const makeCtx = (dir: string) => {
    const store = new DesignStore(dir);
    store.load(); // fail now, clearly, if there is no design here
    const clients = new Set<ServerResponse>();
    /** The lease each open page was last told about. Compared per page, so a page that connected while an agent was working still hears it end. */
    const known = new Map<ServerResponse, string>();
    let rev = '';
    const fonts = (() => {
      try {
        const { palette, root: brandRoot } = E.loadPalette(dir);
        return Object.values(palette.fonts).flatMap((f) =>
          Object.entries(f.files).map(([weight, rel]) => ({ family: f.family, weight, url: `/brand/${rel.replace(/^brand\//, '')}`, abs: resolve(brandRoot, rel) })),
        );
      } catch {
        return [];
      }
    })();
    const snapshot = () => {
      const { design } = store.load();
      const st = store.stacks();
      return {
        rev: designHash(design), design, canUndo: st.undo.length > 0, canRedo: st.redo.length > 0, readOnly, lease: leaseView(dir),
        fonts: fonts.map(({ family, weight, url }) => ({ family, weight, url })),
        presets: PRESETS.map((p) => ({ id: p.id, summary: p.summary, defaults: p.defaults, ...(p.types ? { types: p.types } : {}) })),
      };
    };

    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(dir, (_ev, name) => {
      if (name !== DESIGN_FILE) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const snap = snapshot();
          if (snap.rev === rev) return;
          rev = snap.rev;
          const k = JSON.stringify(snap.lease);
          for (const c of clients) {
            send(c, 'design', snap);
            known.set(c, k);
          }
        } catch (e) {
          for (const c of clients) send(c, 'problem', { message: (e as Error).message });
        }
      }, 40);
    });
    rev = snapshot().rev;
    const tickLease = () => {
      const lease = leaseView(dir);
      const k = JSON.stringify(lease);
      for (const c of clients)
        if (known.get(c) !== k) {
          send(c, 'lease', { lease });
          known.set(c, k);
        }
    };

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

    let exporting: Promise<unknown> = Promise.resolve();
    const handleWrite = async (req: IncomingMessage, res: ServerResponse, path: string) => {
      if (!guard(req, res)) return;
      try {
        if (path === '/api/asset')
          return json(res, 403, { code: 'AGENT_ONLY', message: 'media is added by your agent: ask it to place the image or audio (studio design asset, studio design add)' });
        const lease = leaseView(dir);
        if (lease)
          return json(res, 423, { code: 'AGENT_WORKING', message: `${lease.agent} is working here${lease.note ? ` (${lease.note})` : ''}; editing opens again when it finishes`, lease });
        const b = (await body(req, 2_000_000)) as Record<string, any>;
        if (path === '/api/export') {
          const fmt = String(b['format'] ?? 'mp4') as import('@studio/engines').DesignFormat;
          if (!['mp4', 'webm', 'mov', 'gif', 'png-seq', 'png'].includes(fmt)) return json(res, 400, { code: 'INVALID_ARGS', message: 'unknown format' });
          const run = async () => {
            try {
              // a browser and FFmpeg: it waits for a machine-wide job slot like any other heavy command
              const r = await withJob('design.export', () =>
                E.exportDesign({ dir, format: fmt, force: true, alpha: !!b['alpha'], ...(typeof b['scale'] === 'number' ? { scale: b['scale'] } : {}), ...(typeof b['at'] === 'number' ? { at: b['at'] } : {}) }),
              );
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
          if (addsMedia(b['specs'] as OpSpec[]))
            return json(res, 403, { code: 'AGENT_ONLY', message: 'media is added by your agent: ask it to place the image or audio' });
          const step = store.apply(b['specs'] as OpSpec[], { actor: 'ui', label: typeof b['label'] === 'string' ? b['label'] : 'ui edit' });
          return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
        }
        if (path === '/api/undo' || path === '/api/redo') {
          const step = path === '/api/undo' ? store.undo({ actor: 'ui' }) : store.redo({ actor: 'ui' });
          return json(res, 200, { ok: true, txn: step.entry.id, ...snapshot() });
        }
        return json(res, 404, { code: 'NOT_FOUND', message: path });
      } catch (e) {
        if (e instanceof WorkspaceError) return json(res, 423, { code: e.code, message: e.message });
        const code = e instanceof OpError ? e.code : 'ENGINE_FAILED';
        return json(res, e instanceof OpError ? 422 : 500, { code, message: (e as Error).message });
      }
    };

    const events = (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => (clients.delete(res), known.delete(res)));
      try {
        const snap = snapshot();
        send(res, 'design', snap);
        known.set(res, JSON.stringify(snap.lease));
      } catch (e) {
        send(res, 'problem', { message: (e as Error).message });
      }
    };
    const serveBrand = (res: ServerResponse, urlPath: string) => {
      const f = fonts.find((x) => x.url === urlPath);
      if (!f || !existsSync(f.abs)) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('content-type', MIME[extname(f.abs).toLowerCase()] ?? 'application/octet-stream');
      res.end(readFileSync(f.abs));
    };
    const close = () => {
      clearTimeout(timer);
      watcher.close();
      for (const c of clients) {
        send(c, 'gone', {});
        c.end();
      }
    };
    return { dir, born: readMeta(dir)?.createdAt, clients, snapshot, tickLease, handleWrite, events, serveBrand, close };
  };
  type Ctx = ReturnType<typeof makeCtx>;

  const single: Ctx | undefined = hub ? undefined : makeCtx(inv.dir);
  const hubCtxs = new Map<string, Ctx>();
  const ctxFor = (url: URL): Ctx | undefined => {
    if (!hub) return single;
    const id = url.searchParams.get('ws') ?? '';
    if (kindOfSlot(id) !== 'design') return undefined;
    const have = hubCtxs.get(id);
    if (have) return have;
    const dir = slotDir(root, id);
    if (!existsSync(join(dir, DESIGN_FILE))) return undefined;
    const c = makeCtx(dir);
    hubCtxs.set(id, c);
    return c;
  };

  const wsClients = new Set<ServerResponse>();
  /** What each tab strip was last told, so one that connected between changes still gets the next one. */
  const wsKnown = new Map<ServerResponse, string>();
  const wsView = () => ({ mode: hub ? 'hub' : 'single', kind: 'design', limit: SLOT_LIMIT, workspaces: hub ? listInfo(root, 'design').map(brief) : [] });
  const tick = () => {
    for (const [id, c] of hubCtxs) {
      if (!(existsSync(join(c.dir, DESIGN_FILE)) && readMeta(c.dir)?.createdAt === c.born)) {
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
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.statusCode = 403;
      return res.end('forbidden host');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, wsView());
    if (req.method === 'GET' && url.pathname === '/api/workspaces/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      wsClients.add(res);
      req.on('close', () => (wsClients.delete(res), wsKnown.delete(res)));
      const view = wsView();
      wsKnown.set(res, JSON.stringify(view));
      return void send(res, 'workspaces', view);
    }
    const scoped = url.pathname.startsWith('/api/') || /^\/(assets|renders|brand)\//.test(url.pathname);
    if (scoped) {
      const ctx = ctxFor(url);
      if (!ctx) return json(res, 404, { code: 'NOT_FOUND', message: 'no such workspace (it may have been closed)', fix: 'studio ws list' });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) return void ctx.handleWrite(req, res, url.pathname);
      if (req.method !== 'GET') {
        res.statusCode = 405;
        return res.end('method not allowed');
      }
      if (url.pathname === '/api/design') {
        try {
          return json(res, 200, ctx.snapshot());
        } catch (e) {
          return json(res, 500, { message: (e as Error).message });
        }
      }
      if (url.pathname === '/api/events') return void ctx.events(req, res);
      if (url.pathname.startsWith('/assets/')) return serveFile(res, resolve(ctx.dir, 'assets'), url.pathname.slice('/assets/'.length));
      if (url.pathname.startsWith('/renders/')) return serveFile(res, resolve(ctx.dir, 'renders'), url.pathname.slice('/renders/'.length));
      if (url.pathname.startsWith('/brand/')) return ctx.serveBrand(res, url.pathname);
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }
    return serveFile(res, dist, url.pathname === '/' ? '/index.html' : url.pathname);
  });

  const allCtx = () => [...(single ? [single] : []), ...hubCtxs.values()];
  const port = num(inv, 'port') ?? 4174;
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  }).catch((e: NodeJS.ErrnoException) => {
    clearInterval(ticker);
    for (const c of allCtx()) c.close();
    throw new CliError('ENGINE_FAILED', e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message, 1, 'pass --port with another number, or --port 0');
  });
  const actual = (server.address() as { port: number }).port;
  inv.log(`Studio design editor: http://localhost:${actual}${hub ? '  (workspaces d1..d5 under ' + root + ')' : ''}  (Ctrl+C to stop)`);
  const stop = () => {
    clearInterval(ticker);
    for (const c of allCtx()) c.close();
    for (const c of wsClients) c.end();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { data: { url: `http://localhost:${actual}`, port: actual, design: hub ? null : inv.dir, ...(hub ? { hub: true, root } : {}), readOnly } };
};
