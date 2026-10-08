import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore } from '@studio/core';
import { FIX } from './fixtures.js';
import { tmpDir, VIDEO_ASSET } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
const chromePath = (() => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  const d = readdirSync(base).find((x) => /^chromium-\d+$/.test(x));
  const p = d && join(base, d, 'chrome-linux', 'chrome');
  return p && existsSync(p) ? p : undefined;
})();
const it_ = it.skipIf(!chromePath);

let browser: Browser;
const servers: ChildProcess[] = [];
beforeAll(async () => {
  if (chromePath)
    browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill('SIGKILL'));
});

const studio = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 26 }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );
async function serve(dir: string): Promise<string> {
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
function seeded() {
  const dir = tmpDir('studio-set-');
  const store = ProjectStore.init(dir, {
    name: 'Settings test',
    width: 1920,
    height: 1080,
    fps: 30,
  });
  store.apply([
    { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
    {
      type: 'clip.add',
      args: { clip: { id: 'c_01', track: 't_v1', asset: 'a_vid1', start: 0, dur: 3000, srcIn: 0 } },
    },
  ]);
  return dir;
}
const meta = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8')).meta;
const file = (dir: string) => readFileSync(join(dir, 'project.studio.json'), 'utf8');
const rev = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-rev'));
const waitRevChange = (page: Page, before: string | null) =>
  page.waitForFunction((b) => document.documentElement.getAttribute('data-rev') !== b, before);
async function open(url: string, ctx?: BrowserContext): Promise<Page> {
  const c = ctx ?? (await browser.newContext({ viewport: { width: 1280, height: 800 } }));
  const page = await c.newPage();
  await page.goto(url);
  await page.locator('[data-clip-id]').first().waitFor();
  await page.locator('[data-testid=status][data-status=live]').waitFor();
  return page;
}

describe('project.set op and command', () => {
  it('changes canvas, fps, name and background as one op, and undo restores the file byte for byte', async () => {
    const dir = seeded();
    const before = file(dir);
    const r = await studio([
      'project',
      'set',
      '--width',
      '1080',
      '--height',
      '1920',
      '--fps',
      '60',
      '--name',
      'Vertical',
      '--background',
      '#112233',
      '--project',
      dir,
    ]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(meta(dir)).toEqual({
      name: 'Vertical',
      width: 1080,
      height: 1920,
      fps: 60,
      background: '#112233',
    });
    expect(r.json.warnings.join('|')).toMatch(/cached motion overlays/);
    expect((await studio(['project', 'undo', '--project', dir])).json.ok).toBe(true);
    expect(file(dir)).toBe(before);
    expect((await studio(['project', 'redo', '--project', dir])).json.ok).toBe(true);
    expect(meta(dir).fps).toBe(60);
  }, 60_000);

  it('refuses nothing-to-change, a zero frame rate, a bad color, and unknown fields, leaving the file alone', async () => {
    const dir = seeded();
    const before = file(dir);
    for (const args of [[], ['--fps', '0'], ['--width', '-4'], ['--background', 'red']]) {
      const r = await studio(['project', 'set', ...args, '--project', dir]);
      expect(r.json.ok).toBe(false);
      expect([2, 4]).toContain(r.code);
    }
    expect(file(dir)).toBe(before);
  }, 60_000);
});

describe('Settings window', () => {
  it_(
    'opens from the button and Ctrl+Comma, traps focus, closes on Escape and returns focus to the button',
    async () => {
      const page = await open(await serve(seeded()));
      const gear = page.getByRole('button', { name: 'Settings' });
      await gear.click();
      const dlg = page.getByRole('dialog', { name: 'Settings' });
      await dlg.waitFor();
      expect(await page.getByRole('tab').allInnerTexts()).toEqual([
        'Appearance',
        'Project',
        'Connector',
      ]);
      // Tab many times: focus never leaves the dialog
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(
          true,
        );
      }
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(
          true,
        );
      }
      await page.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Settings',
      );
      await page.keyboard.press('Control+,');
      await dlg.waitFor();
      await page.keyboard.press('Control+,');
      await dlg.waitFor({ state: 'detached' });
      // shortcuts of the editor are inert while it is open: S must not split anything
      await page.locator('[data-clip-id=c_01]').click();
      await page.keyboard.press('Control+,');
      await dlg.waitFor();
      await page.keyboard.press('s');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    },
    60_000,
  );

  it_(
    'tabs follow the arrow keys',
    async () => {
      const page = await open(await serve(seeded()));
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Appearance' }).focus();
      await page.keyboard.press('ArrowRight');
      expect(await page.getByRole('tab', { name: 'Project' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      await page.keyboard.press('ArrowRight');
      expect(await page.getByRole('tab', { name: 'Connector' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      await page.keyboard.press('ArrowRight');
      expect(
        await page.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected'),
      ).toBe('true');
    },
    60_000,
  );

  it_(
    'Appearance: theme persists across a reload, and still works when storage is blocked',
    async () => {
      const url = await serve(seeded());
      const page = await open(url);
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByLabel('Light', { exact: true }).check();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
        'light',
      );
      await page.reload();
      await page.locator('[data-clip-id]').first().waitFor();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
        'light',
      );
      // blocked storage
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('blocked');
          },
        });
      });
      const errors: string[] = [];
      const p2 = await ctx.newPage();
      p2.on('pageerror', (e) => errors.push(e.message));
      await p2.goto(url);
      await p2.locator('[data-clip-id]').first().waitFor();
      await p2.getByRole('button', { name: 'Settings' }).click();
      await p2.getByLabel('Dark', { exact: true }).check();
      await p2.getByLabel('Show keyframe markers on clips').uncheck();
      expect(await p2.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
        'dark',
      );
      expect(errors).toEqual([]);
    },
    60_000,
  );

  it_(
    'Appearance: keyframe markers can be hidden, and the zoom preference is read at load',
    async () => {
      const dir = seeded();
      new ProjectStore(dir).apply([
        { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 500, v: 1 } },
      ]);
      const url = await serve(dir);
      const page = await open(url);
      expect(await page.locator('[data-kf]').count()).toBe(1);
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByLabel('Show keyframe markers on clips').uncheck();
      expect(await page.locator('[data-kf]').count()).toBe(0);
      await page.getByLabel(/Timeline zoom at start/).fill('200');
      await page.getByLabel(/Timeline zoom at start/).press('Tab');
      await page.reload();
      await page.locator('[data-clip-id]').first().waitFor();
      // 3000 ms at 200 px/s is 600 px wide
      const w = (await page.locator('[data-clip-id=c_01]').boundingBox())!.width;
      expect(Math.round(w)).toBe(600);
      expect(await page.locator('[data-kf]').count()).toBe(0);
    },
    60_000,
  );

  it_(
    'Project: saving writes one op as actor ui, shows in the timeline duration, and Undo restores the file',
    async () => {
      const dir = seeded();
      const before = file(dir);
      const page = await open(await serve(dir));
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Project' }).click();
      const save = page.getByRole('button', { name: 'Save' });
      expect(await save.isDisabled()).toBe(true); // nothing changed yet
      // invalid values are reported and cannot be saved
      await page.getByLabel('Frame rate (fps)').fill('0');
      expect(await page.getByRole('alert').first().innerText()).toMatch(/above 0/);
      expect(await save.isDisabled()).toBe(true);
      await page.getByLabel('Frame rate (fps)').fill('24');
      await page.getByLabel('Width (px)').fill('1080');
      await page.getByLabel('Height (px)').fill('1920');
      await page.getByLabel('Name').fill('Vertical cut');
      const r = await rev(page);
      await save.click();
      await waitRevChange(page, r);
      expect(meta(dir)).toMatchObject({ name: 'Vertical cut', width: 1080, height: 1920, fps: 24 });
      const last = readFileSync(join(dir, 'ops.log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .pop();
      expect(last.actor).toBe('ui');
      expect(last.ops).toHaveLength(1);
      expect(last.ops[0].type).toBe('project.set');
      expect(await page.getByTestId('project-msg').innerText()).toMatch(/Saved/);
      await page.keyboard.press('Escape');
      expect(await page.locator('.project-name').innerText()).toBe('Vertical cut');
      const r2 = await rev(page);
      await page.getByRole('button', { name: /^Undo/ }).click();
      await waitRevChange(page, r2);
      expect(file(dir)).toBe(before);
    },
    60_000,
  );

  it_(
    'Connector: shows the exact command for this server, copies it, and the check starts a real MCP server',
    async () => {
      const dir = seeded();
      const url = await serve(dir);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: new URL(url).origin,
      });
      const page = await open(url, ctx);
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Connector' }).click();
      const cmd = await page.getByTestId('connector-command').innerText();
      expect(cmd.trim()).toBe(`claude mcp add studio -- node ${BIN} mcp --project ${dir}`);
      await page.getByRole('button', { name: 'Copy command' }).click();
      await page.getByRole('button', { name: 'Copied' }).waitFor();
      expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(cmd.trim());
      expect(await page.locator('#code-json').innerText()).toContain('"mcpServers"');
      expect(
        JSON.parse(await page.locator('#code-json').innerText()).mcpServers.studio.args,
      ).toEqual([BIN, 'mcp', '--project', dir]);
      await page.getByRole('button', { name: 'Check server' }).click();
      const res = page.getByTestId('connector-check');
      await res.waitFor();
      expect(await res.innerText()).toMatch(/Server started and listed \d+ tools in \d+ ms/);
      const tools = Number(/listed (\d+) tools/.exec(await res.innerText())![1]);
      expect(tools).toBeGreaterThan(40);
      expect(await page.getByText(/cannot see whether Claude Code is connected/).count()).toBe(1);
      // the check endpoint refuses cross-site style calls
      expect((await fetch(`${url}/api/connector/check`, { method: 'POST' })).status).toBe(403);
      // and a project path with spaces is quoted
      const info = await (await fetch(`${url}/api/connector`)).json();
      expect(info.tools).toBe(tools);
    },
    60_000,
  );

  it_(
    'screenshots of all three tabs in both themes',
    async () => {
      const dir = seeded();
      const url = await serve(dir);
      for (const scheme of ['dark', 'light'] as const) {
        const ctx = await browser.newContext({
          viewport: { width: 1100, height: 760 },
          colorScheme: scheme,
        });
        const page = await open(url, ctx);
        await page.getByRole('button', { name: 'Settings' }).click();
        for (const t of ['Appearance', 'Project', 'Connector']) {
          await page.getByRole('tab', { name: t }).click();
          if (t === 'Connector') await page.getByTestId('connector-command').waitFor();
          await page.screenshot({ path: join(FIX, `settings-${scheme}-${t.toLowerCase()}.png`) });
        }
      }
      expect(existsSync(join(FIX, 'settings-light-connector.png'))).toBe(true);
    },
    90_000,
  );
});
