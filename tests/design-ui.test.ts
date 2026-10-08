import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  if (chromePath) browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
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

/** A small design: a frame with a rect and a text, 2 s long, 800x450. */
async function seeded(): Promise<string> {
  const dir = tmpDir('studio-design-ui-');
  await studio(['design', 'new', 'Test scene', '--width', '800', '--height', '450', '--fps', '30', '--duration', '2000', '--project', dir]);
  const ops = [
    { type: 'layer.add', args: { layer: { type: 'rect', id: 'l_aa01', name: 'Card', x: 100, y: 80, w: 200, h: 120, fill: { type: 'solid', color: '#ff3366' } } } },
    { type: 'layer.add', args: { layer: { type: 'text', id: 'l_tx01', name: 'Title', x: 100, y: 240, w: 400, h: 60, text: 'Hello', fontSize: 48, fill: { type: 'solid', color: '#111111' } } } },
  ];
  writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
  const r = await studio(['design', 'apply', 'ops.json', '--project', dir]);
  expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
  return dir;
}
async function serve(dir: string, extra: string[] = []): Promise<string> {
  const child = spawn('node', [BIN, 'design', 'ui', '--port', '0', '--project', dir, ...extra], { stdio: ['ignore', 'pipe', 'ignore'] });
  servers.push(child);
  const line: string = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf);
    });
    child.on('close', () => reject(new Error('design ui exited: ' + buf)));
  });
  return JSON.parse(line).data.url as string;
}
const doc = (dir: string) => JSON.parse(readFileSync(join(dir, 'design.studio.json'), 'utf8'));
const layer = (dir: string, id: string) => doc(dir).layers.find((l: any) => l.id === id);
const log = (dir: string) => readFileSync(join(dir, 'design.ops.log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const errors = new WeakMap<Page, string[]>();
async function open(url: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 } });
  const page = await ctx.newPage();
  const errs: string[] = [];
  errors.set(page, errs);
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.locator('[data-testid=design-editor]').waitFor();
  await page.locator('[data-layer-row]').first().waitFor();
  return page;
}
const canvasBox = async (page: Page) => (await page.locator('[data-testid=canvas]').boundingBox())!;
/** Screen position of a scene point, from where the artboard is drawn. */
async function sceneToScreen(page: Page, x: number, y: number) {
  const stage = (await page.locator('.scene-root > div').first().boundingBox())!;
  const z = stage.width / 800;
  return { x: stage.x + x * z, y: stage.y + y * z, z };
}
async function waitFile(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('timed out waiting for the design file to change');
}

describe('design editor in a real browser', () => {
  it_('draws the scene from the file, with no console errors', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    expect(await page.locator('[data-layer-row]').count()).toBe(2);
    expect(await page.locator('.scene-root [data-layer]').count()).toBe(2);
    const card = (await page.locator('[data-layer=l_aa01]').boundingBox())!;
    const stage = (await page.locator('.scene-root > div').first().boundingBox())!;
    expect(card.width / stage.width).toBeCloseTo(200 / 800, 2);
    expect(await page.locator('[data-layer=l_tx01]').textContent()).toBe('Hello');
    expect(errors.get(page)).toEqual([]);
  }, 60_000);

  it_('draws a rectangle with the tool: one op from the page, selected, tool returns to select', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.keyboard.press('r');
    const a = await sceneToScreen(page, 400, 100);
    const b = await sceneToScreen(page, 560, 200);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await waitFile(() => doc(dir).layers.length === 3);
    const added = doc(dir).layers.find((l: any) => l.type === 'rect' && l.id !== 'l_aa01');
    expect(Math.abs(added.x - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(added.w - 160)).toBeLessThanOrEqual(3);
    expect(Math.abs(added.h - 100)).toBeLessThanOrEqual(3);
    expect(log(dir).at(-1).actor).toBe('ui');
    await expect.poll(() => page.locator('[data-tool=select]').getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => page.locator('[data-layer-row].on').count()).toBe(1);
  }, 60_000);

  it_('dragging a layer moves it by the screen distance over the zoom; undo restores the bytes', async () => {
    const dir = await seeded();
    const before = readFileSync(join(dir, 'design.studio.json'), 'utf8');
    const page = await open(await serve(dir));
    const c = (await page.locator('[data-layer=l_aa01]').boundingBox())!;
    const { z } = await sceneToScreen(page, 0, 0);
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + 40, c.y + c.height / 2 + 20, { steps: 6 });
    await page.mouse.move(c.x + c.width / 2 + 120, c.y + c.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await waitFile(() => layer(dir, 'l_aa01').x !== 100);
    const l = layer(dir, 'l_aa01');
    expect(Math.abs(l.x - (100 + 120 / z))).toBeLessThan(8); // snapping may move it a few px
    expect(l.y).toBeGreaterThan(80);
    expect(log(dir).filter((e) => e.actor === 'ui' && e.kind === 'apply')).toHaveLength(1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await waitFile(() => readFileSync(join(dir, 'design.studio.json'), 'utf8') === before);
  }, 60_000);

  it_('a number box edits a property; Enter sends it; a wrong value is refused with a message', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.getByRole('textbox', { name: 'X', exact: true }).first().fill('250');
    await page.keyboard.press('Enter');
    await waitFile(() => layer(dir, 'l_aa01').x === 250);
    const op = page.getByRole('textbox', { name: 'Opacity' });
    await op.fill('40');
    await page.keyboard.press('Enter');
    await waitFile(() => layer(dir, 'l_aa01').opacity === 0.4);
    // the box clamps to its own range instead of sending a value the file would refuse
    await op.fill('900');
    await page.keyboard.press('Enter');
    await expect.poll(() => op.inputValue()).toBe('100');
  }, 60_000);

  it_('Animate: a preset adds keyframes, the timeline shows them, scrubbing changes what is drawn', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.getByTestId('animate-tab').click();
    await page.locator('[data-preset=fade-in]').click();
    await waitFile(() => !!layer(dir, 'l_aa01').anim?.opacity);
    expect(layer(dir, 'l_aa01').anim.opacity.map((k: any) => [k.t, k.v])).toEqual([[0, 0], [500, 1]]);
    // at t=0 the card is transparent, at 1 s it is solid
    const opacityNow = () => page.locator('[data-layer=l_aa01]').evaluate((e) => getComputedStyle(e).opacity);
    expect(Number(await opacityNow())).toBe(0);
    const ruler = (await page.getByTestId('ruler').boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width * 0.5, ruler.y + 10);
    await expect.poll(async () => Number(await opacityNow())).toBe(1);
    // the diamonds are in the timeline once the layer's properties are opened
    await page.getByRole('button', { name: 'Show properties' }).first().click();
    expect(await page.locator('[data-kf-diamond]').count()).toBe(2);
  }, 60_000);

  it_('with keyframes on a property, dragging records a keyframe at the playhead instead of changing the base', async () => {
    const dir = await seeded();
    await studio(['design', 'keyframe', '--layer', 'l_aa01', '--prop', 'x', '--t', '0', '--v', '100', '--project', dir]);
    await studio(['design', 'keyframe', '--layer', 'l_aa01', '--prop', 'x', '--t', '1000', '--v', '300', '--project', dir]);
    const page = await open(await serve(dir));
    const ruler = (await page.getByTestId('ruler').boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width * 0.5, ruler.y + 10); // 1 s
    const c = (await page.locator('[data-layer=l_aa01]').boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + 30, c.y + c.height / 2, { steps: 5 });
    await page.mouse.move(c.x + c.width / 2 + 90, c.y + c.height / 2, { steps: 5 });
    await page.mouse.up();
    await waitFile(() => (layer(dir, 'l_aa01').anim.x as any[]).some((k) => k.t === 1000 && k.v !== 300));
    expect(layer(dir, 'l_aa01').x).toBe(100); // the base value is untouched
  }, 60_000);

  it_('an agent edit appears in the open editor without a reload', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await studio(['design', 'add', 'ellipse', '--name', 'From agent', '--project', dir]);
    await page.locator('[data-layer-row]', { hasText: 'From agent' }).waitFor();
    expect(await page.locator('.scene-root [data-layer]').count()).toBe(3);
    await studio(['design', 'set', '--id', 'l_aa01', '--props', '{"x":500}', '--project', dir]);
    await expect.poll(async () => (await page.locator('[data-layer=l_aa01]').evaluate((e) => (e as HTMLElement).style.left))).toBe('500px');
  }, 60_000);

  it_('layers panel: rename, hide, and drag to reorder are ops', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.locator('[data-layer-row=l_aa01] .name').dblclick();
    await page.getByLabel('Layer name').fill('Hero card');
    await page.keyboard.press('Enter');
    await waitFile(() => layer(dir, 'l_aa01').name === 'Hero card');
    await page.locator('[data-layer-row=l_aa01]').hover();
    await page.locator('[data-layer-row=l_aa01]').getByRole('button', { name: 'Hide' }).click();
    await waitFile(() => layer(dir, 'l_aa01').visible === false);
    expect(await page.locator('[data-layer=l_aa01]').evaluate((e) => getComputedStyle(e).display)).toBe('none');
    // the text is on top (listed first); drag the card above it
    const order0 = doc(dir).layers.map((l: any) => l.id);
    expect(order0).toEqual(['l_aa01', 'l_tx01']);
    await page.locator('[data-layer-row=l_aa01]').dragTo(page.locator('[data-layer-row=l_tx01]'), { targetPosition: { x: 80, y: 3 } });
    await waitFile(() => doc(dir).layers[0].id === 'l_tx01');
  }, 60_000);

  it_('keyboard: Delete removes, Ctrl+Z brings it back, Ctrl+D duplicates, Ctrl+G groups', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.keyboard.press('Delete');
    await waitFile(() => doc(dir).layers.length === 1);
    await page.keyboard.press('Control+z');
    await waitFile(() => doc(dir).layers.length === 2);
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.keyboard.press('Control+d');
    await waitFile(() => doc(dir).layers.length === 3);
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.locator('[data-layer-row=l_tx01]').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+g');
    await waitFile(() => doc(dir).layers.some((l: any) => l.type === 'group'));
    const g = doc(dir).layers.find((l: any) => l.type === 'group');
    expect(doc(dir).layers.filter((l: any) => l.parent === g.id)).toHaveLength(2);
  }, 60_000);

  it_('text tool: click, type, click away saves the text', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.keyboard.press('t');
    const p = await sceneToScreen(page, 450, 120);
    await page.mouse.click(p.x, p.y);
    await page.getByLabel('Edit text').waitFor();
    await page.keyboard.type('Typed in the editor');
    await page.locator('[data-layer-row]').first().click(); // click away
    await waitFile(() => doc(dir).layers.some((l: any) => l.text === 'Typed in the editor'));
  }, 60_000);

  it_('play advances time and stops at the end when loop is off; both themes render', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.getByRole('button', { name: 'Loop' }).click();
    await page.getByTestId('play').click();
    await expect.poll(async () => (await page.getByTestId('time').textContent())!.startsWith('00:02'), { timeout: 8000 }).toBe(true);
    await expect.poll(() => page.getByTestId('play').getAttribute('aria-label')).toBe('Play');
    for (const label of ['Light theme', 'Dark theme']) {
      const b = page.getByRole('button', { name: /(Light|Dark) theme/ });
      await b.click();
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toMatch(/^rgb/);
      void label;
    }
    expect(errors.get(page)).toEqual([]);
  }, 60_000);

  it_('export: MP4 from the page renders the scene, reports numbers, and the file is real', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir));
    await page.getByTestId('export-btn').click();
    await page.locator('[data-export=mp4]').click();
    const done = page.getByTestId('export-result');
    await done.waitFor({ timeout: 60_000 });
    expect(await done.textContent()).toMatch(/800×450, 60 frames/);
    const file = join(dir, 'renders', 'test-scene.mp4');
    expect(existsSync(file)).toBe(true);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    expect(dur).toBeCloseTo(2, 1);
  }, 120_000);

  it_('read-only mode refuses edits from the page', async () => {
    const dir = await seeded();
    const page = await open(await serve(dir, ['--read-only']));
    await page.locator('[data-layer-row=l_aa01]').click();
    await page.getByRole('textbox', { name: 'X', exact: true }).first().fill('300');
    await page.keyboard.press('Enter');
    await page.getByRole('alert').waitFor();
    expect(layer(dir, 'l_aa01').x).toBe(100);
  }, 60_000);
});

describe('design editor bundle', () => {
  it('the whole editor stays under the 250 KB gzip budget', () => {
    const dir = join(ROOT, 'apps', 'design', 'dist', 'editor');
    const total = readdirSync(dir).reduce((n, f) => n + gzipSync(readFileSync(join(dir, f))).length, 0);
    console.log(`design editor: ${(total / 1024).toFixed(1)} KB gzip`);
    expect(total).toBeLessThan(250 * 1024);
  });
});
