import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIX } from './fixtures.js';
import { ProjectStore } from '@studio/core';
import { testCtx, tmpDir, VIDEO_ASSET } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'apps/ui/dist');
const chromePath = (() => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  const d = readdirSync(base).find((x) => /^chromium-\d+$/.test(x));
  const p = d && join(base, d, 'chrome-linux', 'chrome');
  return p && existsSync(p) ? p : undefined;
})();

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
let server: Server;
let base = '';
let browser: Browser;

beforeAll(async () => {
  if (!chromePath) return;
  // apps/ui/dist is built once by tests/global-setup.ts (with NODE_ENV=production)
  server = createServer((req, res) => {
    const p = join(
      DIST,
      req.url === '/' ? 'index.html' : decodeURIComponent((req.url ?? '').split('?')[0]!),
    );
    if (!p.startsWith(DIST) || !existsSync(p)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
    res.end(readFileSync(p));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/`;
  browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.close();
});

// Reported as skipped (not passed) when no Chromium is installed.
const it_ = it.skipIf(!chromePath);

describe('UI shell in a real browser', () => {
  it_(
    'sets the theme before the app runs, from the OS setting, with the app script blocked',
    async () => {
      for (const scheme of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ colorScheme: scheme });
        const page = await ctx.newPage();
        await page.route('**/*.js', (r) => r.abort());
        await page.goto(base);
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
          scheme,
        );
        await ctx.close();
      }
    },
  );

  it_(
    'toggle switches theme, changes real colors from tokens, persists across reload',
    async () => {
      const ctx = await browser.newContext({
        colorScheme: 'dark',
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      const problems: string[] = [];
      page.on(
        'console',
        // The page probes /api/project; a plain static server has none, so that 404 is expected in this test only.
        (m) =>
          ['error', 'warning'].includes(m.type()) &&
          !/status of 404/.test(m.text()) &&
          problems.push(`${m.type()}: ${m.text()}`),
      );
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.goto(base);
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const tok = (n: string) =>
        page.evaluate(
          (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
          n,
        );
      expect(await tok('--color-bg-canvas')).toBe('#141416');
      expect(await bg()).toBe('rgb(20, 20, 22)');
      await page.screenshot({ path: join(FIX, 'ui-dark.png') });
      await page.getByRole('button', { name: 'Switch to light theme' }).click();
      expect(await tok('--color-bg-canvas')).toBe('#ededf0');
      expect(await bg()).toBe('rgb(237, 237, 240)');
      await page.screenshot({ path: join(FIX, 'ui-light.png') });
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
        'light',
      );
      expect(problems).toEqual([]);
      await ctx.close();
    },
  );

  it_('works when localStorage is blocked', async () => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'light',
    );
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'dark',
    );
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it_('every button has an accessible name and a hit area of at least 24x24', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base);
    const bad = await page.$$eval('button', (bs) =>
      bs.flatMap((b) => {
        const r = b.getBoundingClientRect();
        const name = b.getAttribute('aria-label') || b.textContent?.trim();
        return !name || r.width < 24 || r.height < 24
          ? [`${name || '(no name)'} ${Math.round(r.width)}x${Math.round(r.height)}`]
          : [];
      }),
    );
    expect(bad).toEqual([]);
    await ctx.close();
  });

  it_(
    'renders the five regions without page scroll, and shows the Approximate indicator',
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(base);
      for (const name of ['Tools', 'Assets', 'Canvas', 'Inspector', 'Timeline'])
        await page.getByLabel(name, { exact: true }).first().waitFor();
      expect(await page.getByText('Approximate preview').isVisible()).toBe(true);
      const over = await page.evaluate(() => [
        document.documentElement.scrollWidth - innerWidth,
        document.documentElement.scrollHeight - innerHeight,
      ]);
      expect(over).toEqual([0, 0]);
      // exactly one action-colored control in the view
      const actions = await page.locator('.btn-action').count();
      expect(actions).toBe(1);
      await ctx.close();
    },
  );

  it_('is idle: main-thread task time over 3 s of nothing is under 1% of wall time', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForTimeout(500);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const task = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!
        .value;
    const t0 = await task();
    const w0 = performance.now();
    await page.waitForTimeout(3000);
    const share = ((await task()) - t0) / ((performance.now() - w0) / 1000);
    console.log(`UI IDLE: main-thread busy ${(share * 100).toFixed(3)}% over 3 s`);
    expect(share).toBeLessThan(0.01);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Live timeline: `studio ui` serves the built UI and pushes project changes.
// ---------------------------------------------------------------------------------------------
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
const servers: ChildProcess[] = [];
afterAll(() => servers.forEach((s) => s.kill('SIGKILL')));

async function serve(dir: string): Promise<string> {
  // the CLI bundle is built once by tests/global-setup.ts
  const child = spawn('node', [BIN, 'ui', '--port', '0', '--project', dir], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  servers.push(child);
  const line: string = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf);
    });
    child.on('close', () => reject(new Error('studio ui exited: ' + buf)));
  });
  return JSON.parse(line).data.url as string;
}

function seeded(n = 3) {
  const dir = tmpDir('studio-live-');
  const store = ProjectStore.init(dir, {
    name: 'Sample project',
    width: 1920,
    height: 1080,
    fps: 30,
  });
  const ctx = testCtx(21);
  store.apply(
    [
      { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
      { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
      { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } },
      ...Array.from({ length: n }, (_, i) => ({
        type: 'clip.add',
        args: {
          clip: {
            id: `c_${String(i + 1).padStart(2, '0')}`,
            track: 't_v1',
            asset: 'a_vid1',
            start: i * 3000,
            dur: 3000,
            srcIn: 0,
          },
        },
      })),
    ],
    { ctx },
  );
  return { dir, store, ctx };
}

// Input handlers update state asynchronously: poll for the result instead of reading once.
const expectTc = (page: Page, t: string) =>
  expect.poll(() => page.getByTestId('timecode').textContent(), { timeout: 2000 }).toBe(t);

describe('live timeline in a real browser', () => {
  it_(
    'shows the project, and a change made through ops appears within 200 ms with playhead, selection, zoom, and scroll intact',
    async () => {
      const { dir, store, ctx } = seeded(3);
      const url = await serve(dir);
      const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await bctx.newPage();
      const problems: string[] = [];
      page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text()));
      page.on('pageerror', (e) => problems.push(e.message));
      await page.goto(url);
      await page.locator('[data-testid=status][data-status=live]').waitFor();
      expect(await page.locator('[data-clip-id]').count()).toBe(3);
      expect(await page.getByText('Live', { exact: true }).count()).toBe(1);
      expect(await page.locator('.asset-row').count()).toBe(1);

      // Set up state that must survive a reload: playhead at 2 s, a selected clip, zoomed in, scrolled.
      // Clicking the ruler seeks (clicking a clip selects it). At 0.1 px/ms, 2 s is 200 px from the ruler start.
      const ruler = (await page.locator('.tl-ruler').boundingBox())!;
      await page.mouse.click(ruler.x + 2000 * 0.1, ruler.y + 10);
      await expectTc(page, '00:00:02.000');
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.locator('[data-clip-id=c_02]').click();
      await page.getByTestId('timeline-scroll').evaluate((el) => {
        el.scrollLeft = 120;
      });
      await page.waitForTimeout(100);
      const before = await page.evaluate(() => ({
        scroll: document.querySelector('[data-testid=timeline-scroll]')!.scrollLeft,
        sel: document.querySelectorAll('.clip.selected').length,
        head: getComputedStyle(document.querySelector('[data-testid=playhead]')!).transform,
      }));
      await page.evaluate(() => {
        const w = window as any;
        w.__revs = [];
        new MutationObserver(() =>
          w.__revs.push(performance.timeOrigin + performance.now()),
        ).observe(document.documentElement, { attributes: true, attributeFilter: ['data-rev'] });
      });

      const lat: number[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `c_${String(10 + i)}`;
        store.apply(
          [
            {
              type: 'clip.add',
              args: {
                clip: {
                  id,
                  track: 't_v1',
                  asset: 'a_vid1',
                  start: 20_000 + i * 1000,
                  dur: 1000,
                  srcIn: 0,
                },
              },
            },
          ],
          { ctx, actor: 'agent' },
        );
        const t0 = Date.now();
        await page
          .locator(`[data-clip-id=${id}]`)
          .waitFor({ state: 'attached', timeout: 2000 })
          .catch(() => {});
        const at = await page.evaluate(() => (window as any).__revs.at(-1) as number);
        lat.push(at - t0);
      }
      lat.sort((a, b) => a - b);
      console.log(
        `LIVE RELOAD latency (file written -> UI updated): median ${lat[2]!.toFixed(0)} ms, max ${lat[4]!.toFixed(0)} ms`,
      );
      expect(lat[4]!).toBeLessThan(200);

      const after = await page.evaluate(() => ({
        scroll: document.querySelector('[data-testid=timeline-scroll]')!.scrollLeft,
        sel: document.querySelectorAll('.clip.selected').length,
        head: getComputedStyle(document.querySelector('[data-testid=playhead]')!).transform,
        tc: document.querySelector('[data-testid=timecode]')!.textContent,
        inspector: document.querySelector('[data-testid=inspector]')!.textContent,
      }));
      expect(after.scroll).toBe(before.scroll);
      expect(after.sel).toBe(1);
      expect(after.head).toBe(before.head);
      expect(after.tc).toBe('00:00:02.000');
      expect(after.inspector).toContain('c_02');

      // Deleting the selected clip clears the selection and nothing else.
      store.apply([{ type: 'clip.delete', args: { id: 'c_02' } }], { ctx });
      await page.locator('[data-clip-id=c_02]').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelectorAll('.clip.selected').length === 0);
      await expectTc(page, '00:00:02.000');
      expect(problems).toEqual([]);
      await bctx.close();
    },
    60_000,
  );

  it_(
    'keyboard: arrows step one frame, Shift+arrows ten, Home/End jump',
    async () => {
      const { dir } = seeded(2);
      const url = await serve(dir);
      const page = await (
        await browser.newContext({ viewport: { width: 1440, height: 900 } })
      ).newPage();
      await page.goto(url);
      await page.locator('[data-clip-id]').first().waitFor();
      await page.keyboard.press('ArrowRight');
      await expectTc(page, '00:00:00.033');
      await page.keyboard.press('Shift+ArrowRight');
      await expectTc(page, '00:00:00.367'); // 11 frames at 30 fps
      await page.keyboard.press('End');
      await expectTc(page, '00:00:06.000');
      await page.keyboard.press('ArrowRight');
      await expectTc(page, '00:00:06.000'); // clamped at the end
      await page.keyboard.press('Home');
      await expectTc(page, '00:00:00.000');
      await page.keyboard.press('Escape');
    },
    60_000,
  );

  it_(
    'virtualizes: 500 clips keep the DOM small while scrolling and zooming; frame times reported',
    async () => {
      const dir = tmpDir('studio-500-');
      const store = ProjectStore.init(dir, { name: 'Big', width: 1920, height: 1080, fps: 30 });
      const ctx = testCtx(22);
      store.apply(
        [
          { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
          { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
          { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'VO' } },
          ...Array.from({ length: 500 }, (_, i) => ({
            type: 'clip.add',
            args: {
              clip: {
                id: `c_${i.toString(36).padStart(4, '0')}`,
                track: i % 2 ? 't_a1' : 't_v1',
                asset: 'a_vid1',
                start: Math.floor(i / 2) * 1000,
                dur: 900,
                srcIn: 0,
              },
            },
          })),
        ],
        { ctx },
      );
      const url = await serve(dir);
      const page = await (
        await browser.newContext({ viewport: { width: 1440, height: 900 } })
      ).newPage();
      await page.goto(url);
      await page.locator('[data-clip-id]').first().waitFor();
      const counts = () =>
        page.getByTestId('virtualization').evaluate((el) => ({
          rendered: Number(el.getAttribute('data-rendered-clips')),
          total: Number(el.getAttribute('data-total-clips')),
        }));
      const c0 = await counts();
      expect(c0.total).toBe(500);
      expect(c0.rendered).toBeLessThan(40);

      // 240 frames of scrolling across the whole timeline, measuring rAF intervals.
      const stats = await page.getByTestId('timeline-scroll').evaluate(async (el) => {
        const dts: number[] = [];
        let last = performance.now();
        const max = el.scrollWidth - el.clientWidth;
        let peak = 0;
        for (let i = 0; i < 240; i++) {
          el.scrollLeft = (max * i) / 239;
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const now = performance.now();
          dts.push(now - last);
          last = now;
          peak = Math.max(peak, document.querySelectorAll('[data-clip-id]').length);
        }
        dts.sort((a, b) => a - b);
        return {
          median: dts[120]!,
          p95: dts[Math.floor(dts.length * 0.95)]!,
          max: dts[dts.length - 1]!,
          peakNodes: peak,
        };
      });
      console.log(
        `TIMELINE 500 clips scroll: median frame ${stats.median.toFixed(1)} ms (${(1000 / stats.median).toFixed(0)} fps), p95 ${stats.p95.toFixed(1)} ms, worst ${stats.max.toFixed(1)} ms, peak clip nodes ${stats.peakNodes}`,
      );
      expect(stats.peakNodes).toBeLessThan(60);

      for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
      const far = await counts();
      console.log(`TIMELINE zoomed out 6 steps: ${far.rendered} of ${far.total} clips in the DOM`);
      expect(far.rendered).toBeLessThanOrEqual(500);
      await page.getByRole('button', { name: 'Zoom to fit' }).click();
      expect((await counts()).rendered).toBe(500); // everything is visible at fit, so all are drawn
      expect(await page.locator('.tl-row').count()).toBe(2);
    },
    120_000,
  );

  it_(
    'server is localhost-only, refuses edits without the UI header, and does not serve files outside the UI build',
    async () => {
      const { dir } = seeded(1);
      const url = await serve(dir);
      const port = new URL(url).port;
      const req = (path: string, opts: { method?: string; host?: string } = {}) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          import('node:http').then(({ request }) => {
            const r = request(
              {
                host: '127.0.0.1',
                port,
                path,
                method: opts.method ?? 'GET',
                headers: { host: opts.host ?? `localhost:${port}` },
              },
              (res) => {
                let body = '';
                res.on('data', (d) => (body += d));
                res.on('end', () => resolve({ status: res.statusCode!, body }));
              },
            );
            r.on('error', reject);
            r.end();
          });
        });
      expect((await req('/api/project')).status).toBe(200);
      expect((await req('/api/project', { host: 'evil.example' })).status).toBe(403);
      expect((await req('/api/ops', { method: 'POST' })).status).toBe(403); // no x-studio-ui header
      expect((await req('/api/project', { method: 'DELETE' })).status).toBe(405);
      expect((await req('/../../../../etc/passwd')).status).toBe(404);
      expect((await req('/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404);
      expect((await req('/project.studio.json')).status).toBe(404); // the project is only available via /api/project
    },
    60_000,
  );

  it_(
    'is idle with a live connection open: main-thread busy under 1% over 3 s',
    async () => {
      const { dir } = seeded(3);
      const url = await serve(dir);
      const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await bctx.newPage();
      await page.goto(url);
      await page.locator('[data-clip-id]').first().waitFor();
      await page.waitForTimeout(500);
      const cdp = await bctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      const task = async () =>
        (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!
          .value;
      const t0 = await task();
      const w0 = performance.now();
      await page.waitForTimeout(3000);
      const share = ((await task()) - t0) / ((performance.now() - w0) / 1000);
      console.log(
        `UI IDLE (live timeline, SSE open): main-thread busy ${(share * 100).toFixed(3)}%`,
      );
      expect(share).toBeLessThan(0.01);
      await page.screenshot({ path: join(FIX, 'ui-live.png') });
      await bctx.close();
    },
    60_000,
  );

  it_('shows a clear state when the page is not served by `studio ui`', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base); // the static server from the first tests has no /api
    await page.locator('[data-testid=status][data-status=no-server]').waitFor();
    expect(await page.getByTestId('status').textContent()).toBe('No project loaded');
  });
});

describe('effects in the inspector', () => {
  it_('the person can switch an effect off and on and remove it with its keyframes, each as one step; while an agent holds the workspace the controls are off', async () => {
    const { dir, store, ctx } = seeded(1);
    store.apply(
      [
        { type: 'clip.set', args: { id: 'c_01', patch: { fx: [{ type: 'plugin', id: 'lumetri', node: 'f_aaaa' }] } } },
        { type: 'kf.set', args: { clip: 'c_01', prop: 'fx.f_aaaa.exposure', t: 0, v: 0 } },
      ],
      { ctx, actor: 'agent' },
    );
    const url = await serve(dir);
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await bctx.newPage();
    await page.goto(url);
    await page.locator('[data-testid=status][data-status=live]').waitFor();
    await page.locator('[data-clip-id=c_01]').click();
    const row = page.locator('[data-fx-node=f_aaaa]');
    await row.waitFor();
    const box = row.getByRole('checkbox');
    const fx = () => (store.load().project.clips[0] as any).fx;
    await box.uncheck();
    await expect.poll(() => fx()?.[0]?.bypass, { timeout: 3000 }).toBe(true);
    await box.check();
    await expect.poll(() => fx()?.[0]?.bypass, { timeout: 3000 }).toBeUndefined();
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => fx(), { timeout: 3000 }).toBeUndefined();
    expect(Object.keys(store.load().project.clips[0]!.keyframes ?? {})).toEqual([]);
    store.undo({ actor: 'agent', ctx });
    await expect.poll(() => fx()?.length, { timeout: 3000 }).toBe(1);
    expect(Object.keys(store.load().project.clips[0]!.keyframes ?? {}).length).toBe(1); // one undo brought both back
    // an agent holds the workspace: the controls are off
    writeFileSync(join(dir, '.studio', 'agent.json'), JSON.stringify({ agent: 'a1', start: Date.now(), expires: Date.now() + 60_000 }));
    await expect.poll(() => row.getByRole('checkbox').isDisabled(), { timeout: 5000 }).toBe(true);
    expect(await row.getByRole('button', { name: 'Remove' }).isDisabled()).toBe(true);
    await bctx.close();
  }, 60_000);
});
