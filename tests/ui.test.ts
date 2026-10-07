import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIX } from './fixtures.js';

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
  // vitest sets NODE_ENV=test, which would build a non-production bundle.
  execFileSync('pnpm', ['-C', 'apps/ui', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
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
        (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`),
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
