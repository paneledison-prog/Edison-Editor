import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSpeech, FIX, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

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
  ensureSpeech();
  if (chromePath)
    browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill('SIGKILL'));
});
const studio = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 28 }, (err, stdout) => {
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

/** A black 13.5 s video with a title card over 2 to 6 s, plus the testsrc clip after it. */
async function project() {
  const dir = tmpDir('studio-prev-');
  await studio([
    'init',
    'prev',
    '--width',
    '960',
    '--height',
    '540',
    '--fps',
    '30',
    '--project',
    dir,
  ]);
  const a = (await studio(['ingest', fx('speech.mp4'), '--project', dir])).json.data.ingested[0]
    .id as string;
  await studio([
    'tl',
    'add-track',
    '--type',
    'video',
    '--name',
    'V',
    '--id',
    't_v1',
    '--project',
    dir,
  ]);
  await studio([
    'tl',
    'add-track',
    '--type',
    'graphics',
    '--name',
    'G',
    '--id',
    't_g1',
    '--project',
    dir,
  ]);
  await studio([
    'tl',
    'add-clip',
    '--track',
    't_v1',
    '--asset',
    a,
    '--start',
    '0',
    '--dur',
    '10000',
    '--id',
    'c_v1',
    '--project',
    dir,
  ]);
  await studio([
    'tl',
    'add-clip',
    '--track',
    't_g1',
    '--comp',
    'title',
    '--start',
    '2000',
    '--dur',
    '4000',
    '--id',
    'c_tt',
    '--props',
    '{"title":"Hello world"}',
    '--project',
    dir,
  ]);
  return dir;
}
const bright = async (png: Buffer) => {
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (const v of data) if (v > 200) n++;
  return n;
};
const frame = (url: string, t: number, w = 640) => fetch(`${url}/api/frame?t=${t}&w=${w}`);

describe('canvas preview (GET /api/frame)', () => {
  it_(
    'returns the frame at the playhead through the compiler: a title card appears only while its clip is on',
    async () => {
      const url = await serve(await project());
      const during = await frame(url, 4000);
      expect(during.status).toBe(200);
      expect(during.headers.get('content-type')).toBe('image/png');
      const dPng = Buffer.from(await during.arrayBuffer());
      expect(await sharp(dPng).metadata()).toMatchObject({ width: 640, height: 360 });
      const after = Buffer.from(await (await frame(url, 8000)).arrayBuffer());
      const [bd, ba] = [await bright(dPng), await bright(after)];
      console.log(
        `P8 preview: bright pixels at 4 s (title on) ${bd}, at 8 s (title off) ${ba}; first request ${during.headers.get('x-preview-ms')} ms`,
      );
      expect(bd).toBeGreaterThan(500);
      expect(ba).toBe(0);
    },
    120_000,
  );

  it_(
    'caches by project revision and time, and a changed project is not served a stale frame',
    async () => {
      const dir = await project();
      const url = await serve(dir);
      const a = await frame(url, 4000);
      await a.arrayBuffer();
      expect(a.headers.get('x-preview-cached')).toBe('false');
      const b = await frame(url, 4000);
      await b.arrayBuffer();
      expect(b.headers.get('x-preview-cached')).toBe('true');
      // delete the title clip: the same time now has no title
      expect(
        (await studio(['tl', 'ripple-delete', '--id', 'c_tt', '--project', dir])).json.ok,
      ).toBe(true);
      const c = await frame(url, 4000);
      expect(await bright(Buffer.from(await c.arrayBuffer()))).toBe(0);
      expect(c.headers.get('x-preview-cached')).toBe('false');
    },
    120_000,
  );

  it_(
    'refuses a bad time, a time past the end, and a nonsense width',
    async () => {
      const url = await serve(await project());
      expect((await frame(url, NaN as any)).status).toBe(400);
      expect((await fetch(`${url}/api/frame?t=-5`)).status).toBe(400);
      expect((await fetch(`${url}/api/frame?t=1.5`)).status).toBe(400);
      const past = await frame(url, 60000);
      expect(past.status).toBe(422);
      expect((await past.json()).message).toMatch(/outside the timeline/);
      const tiny = await frame(url, 1000, 10);
      expect((await sharp(Buffer.from(await tiny.arrayBuffer())).metadata()).width).toBe(160); // clamped
    },
    120_000,
  );

  it_(
    'the page shows the frame at the playhead, follows it, and the newest request wins',
    async () => {
      const dir = await project();
      const url = await serve(dir);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page: Page = await ctx.newPage();
      await page.goto(url);
      const img = page.getByTestId('preview-img');
      await img.waitFor();
      expect(await img.getAttribute('data-preview-t')).toBe('0');
      // move the playhead many frames quickly: only the last position may end up on screen
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowRight'); // 12 x 10 frames = 4 s
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=preview-img]')?.getAttribute('data-preview-t') ===
          '4000',
      );
      expect(await page.getByTestId('timecode').innerText()).toBe('00:00:04.000');
      const titleSeen = await page.evaluate(async () => {
        const el = document.querySelector('[data-testid=preview-img]') as HTMLImageElement;
        const c = document.createElement('canvas');
        c.width = el.naturalWidth;
        c.height = el.naturalHeight;
        const g = c.getContext('2d')!;
        g.drawImage(el, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 200) n++;
        return n;
      });
      expect(titleSeen).toBeGreaterThan(500);
      // an edit from the CLI refreshes the preview
      expect(
        (await studio(['tl', 'ripple-delete', '--id', 'c_tt', '--project', dir])).json.ok,
      ).toBe(true);
      await page.waitForFunction(
        async () => {
          const el = document.querySelector('[data-testid=preview-img]') as HTMLImageElement | null;
          if (!el || !el.complete) return false;
          const c = document.createElement('canvas');
          c.width = el.naturalWidth;
          c.height = el.naturalHeight;
          const g = c.getContext('2d')!;
          g.drawImage(el, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4) if (d[i]! > 200) return false;
          return true;
        },
        null,
        { timeout: 30_000 },
      );
      await page.screenshot({ path: join(FIX, 'preview-dark.png') });
      await ctx.close();
      const light = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        colorScheme: 'light',
      });
      const p2 = await light.newPage();
      await p2.goto(url);
      await p2.getByTestId('preview-img').waitFor();
      await p2.screenshot({ path: join(FIX, 'preview-light.png') });
    },
    180_000,
  );

  it_(
    'an empty timeline asks for nothing and says so',
    async () => {
      const dir = tmpDir('studio-prev-empty-');
      await studio(['init', 'e', '--project', dir]);
      const url = await serve(dir);
      const page = await (await browser.newContext()).newPage();
      await page.goto(url);
      await page.getByTestId('canvas-note').waitFor();
      expect(await page.getByTestId('canvas-note').innerText()).toMatch(/No clips yet/);
      expect(await page.getByTestId('preview-img').count()).toBe(0);
    },
    60_000,
  );
});
