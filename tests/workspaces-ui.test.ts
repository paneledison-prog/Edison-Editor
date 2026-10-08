import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const run = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 26 }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );
const ok = (r: { json: any }) => {
  expect(r.json?.ok, JSON.stringify(r.json)).toBe(true);
  return r.json.data;
};
async function serve(args: string[]): Promise<string> {
  const child = spawn('node', [BIN, ...args, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  servers.push(child);
  const line: string = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf);
    });
    child.on('close', () => reject(new Error('server exited: ' + buf)));
  });
  return JSON.parse(line).data.url as string;
}
const poll = <T>(fn: () => Promise<T> | T) => expect.poll(fn, { timeout: 8000, interval: 100 });

const errors = new WeakMap<Page, string[]>();
async function page(url: string, ready: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 } });
  const p = await ctx.newPage();
  const errs: string[] = [];
  errors.set(p, errs);
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(url);
  await p.locator(ready).waitFor();
  return p;
}
const tab = (p: Page, slot: string) => p.locator(`[data-testid=ws-tabs] [data-ws=${slot}]`);
const post = (p: Page, url: string, path: string, data: unknown) =>
  p.request.post(url + path, { headers: { 'x-studio-ui': '1', 'content-type': 'application/json' }, data });
/** A file dragged onto the page, as a browser delivers it. Returns whether the page cancelled the default (opening the file). */
const dropFile = (p: Page) =>
  p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['not really a picture'], 'cat.png', { type: 'image/png' }));
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(over);
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  });

// ---------------------------------------------------------------------------------------------------------------------
// media editor hub

describe('media editor: workspaces m1..m5 in one window', () => {
  let root: string;
  let url: string;
  const dir = (slot: string) => join(root, 'workspaces', slot);
  const proj = (slot: string) => JSON.parse(readFileSync(join(dir(slot), 'project.studio.json'), 'utf8'));

  beforeAll(async () => {
    root = tmpDir('studio-wsui-m-');
    for (const [name, w, h] of [['Alpha', 1280, 720], ['Beta', 1920, 1080], ['Gamma', 640, 360]] as const)
      ok(await run(['ws', 'open', '--kind', 'media', '--name', name, '--width', String(w), '--height', String(h), '--root', root]));
    url = await serve(['ui', '--hub', '--root', root]);
  }, 120_000);

  it_('has a tab per workspace, opens the first when no workspace is named, and switching shows the other project', async () => {
    const p = await page(url, '[data-testid=ws-tabs]');
    await poll(() => p.url()).toContain('?ws=m1');
    expect(await p.locator('[data-testid=ws-tabs] [role=tab]').allTextContents()).toEqual(['m1Alpha', 'm2Beta', 'm3Gamma']);
    expect(await tab(p, 'm1').getAttribute('aria-selected')).toBe('true');
    await p.locator('[data-testid=status][data-status=live]').waitFor();
    await poll(() => p.locator('[data-testid=inspector]').textContent()).toContain('1280×720');
    await tab(p, 'm2').click();
    await poll(() => p.url()).toContain('?ws=m2');
    await p.locator('[data-testid=status][data-status=live]').waitFor();
    await poll(() => p.locator('[data-testid=inspector]').textContent()).toContain('1920×1080');
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 90_000);

  it_('an agent working in a workspace shows on its tab live and makes that page view-only; its edits still arrive; it opens again when the agent ends', async () => {
    const p = await page(url + '?ws=m1', '[data-testid=status][data-status=live]');
    const split = p.getByRole('button', { name: /^Split/ });
    expect(await split.isDisabled()).toBe(false);

    ok(await run(['work', 'begin', '--agent', 'grade-agent', '--note', 'colour grading', '--project', dir('m2')]));
    await poll(() => tab(p, 'm2').getAttribute('data-state')).toBe('agent-working'); // seen from another workspace's page
    expect(await tab(p, 'm1').getAttribute('data-state')).toBe('idle');
    expect(await split.isDisabled()).toBe(false); // m1 is still the person's

    await tab(p, 'm2').click();
    const pill = p.locator('[data-testid=agent-status]');
    await pill.waitFor();
    expect(await pill.textContent()).toMatch(/grade-agent is working: colour grading · view only/);
    expect(await p.getByRole('button', { name: /^Split/ }).isDisabled()).toBe(true);
    expect(await p.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(true);

    // the server holds the line even if a page tried: nothing is written
    const before = readFileSync(join(dir('m2'), 'project.studio.json'), 'utf8');
    const refused = await post(p, url, '/api/ops?ws=m2', { specs: [{ type: 'track.add', args: { type: 'video', name: 'Sneaky' } }], label: 'try' });
    expect(refused.status()).toBe(423);
    expect((await refused.json()).code).toBe('AGENT_WORKING');
    expect((await post(p, url, '/api/undo?ws=m2', {})).status()).toBe(423);
    expect(readFileSync(join(dir('m2'), 'project.studio.json'), 'utf8')).toBe(before);

    // watching: the agent's own edit shows in the open page with no reload
    const tracks = async () => Number((await p.locator('[data-testid=inspector]').textContent())!.match(/Tracks(\d+)/)?.[1]);
    const had = await tracks();
    ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'Graded', '--agent', 'grade-agent', '--project', dir('m2')]));
    await poll(tracks).toBe(had + 1);

    ok(await run(['work', 'end', '--agent', 'grade-agent', '--project', dir('m2')]));
    await pill.waitFor({ state: 'detached', timeout: 8000 });
    await poll(() => tab(p, 'm2').getAttribute('data-state')).toBe('idle');
    await poll(() => p.getByRole('button', { name: /^Split/ }).isDisabled()).toBe(false);
    const ok2 = await post(p, url, '/api/ops?ws=m2', { specs: [{ type: 'track.add', args: { type: 'audio', name: 'Mine' } }], label: 'ui edit' });
    expect(ok2.status()).toBe(200);
    const log = readFileSync(join(dir('m2'), 'ops.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1).actor).toBe('ui');
    expect(proj('m2').tracks.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Graded', 'Mine']));
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 120_000);

  it_('the person adds no media from the page: no file picker, a dropped file is turned away with a note, media ops are refused', async () => {
    const p = await page(url + '?ws=m1', '[data-testid=status][data-status=live]');
    expect(await p.locator('input[type=file]').count()).toBe(0);
    expect(await p.getByText('Add media', { exact: false }).count()).toBe(0);
    const before = readFileSync(join(dir('m1'), 'project.studio.json'), 'utf8');
    expect(await dropFile(p)).toBe(true); // the browser is told not to open the file
    await poll(() => p.locator('[data-testid=notice]').textContent()).toMatch(/Media is added by your agent/);
    expect(p.url()).toContain('?ws=m1'); // still on the editor
    const asset = { path: 'assets/x.png', kind: 'image', hash: 'sha256:' + 'b'.repeat(64), probe: { w: 10, h: 10 } };
    const r = await post(p, url, '/api/ops?ws=m1', { specs: [{ type: 'asset.add', args: { asset } }], label: 'sneak' });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('AGENT_ONLY');
    expect(readFileSync(join(dir('m1'), 'project.studio.json'), 'utf8')).toBe(before);
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 90_000);

  it_('a workspace that is not there is a clear 404, and one of the other editor is not served', async () => {
    const p = await page(url + '?ws=m1', '[data-testid=status][data-status=live]');
    expect((await p.request.get(url + '/api/project?ws=m5')).status()).toBe(404);
    expect((await p.request.get(url + '/api/project?ws=d1')).status()).toBe(404);
    expect((await p.request.get(url + '/api/project?ws=../../etc')).status()).toBe(404);
    await p.context().close();
  }, 60_000);

  it_('a page opened while an agent is working still hears when it finishes, even when that happens before the server’s next look', async () => {
    expect((await (await fetch(url + '/api/project?ws=m3')).json()).lease).toBeNull(); // the server already holds m3, with no agent in it
    for (let i = 0; i < 3; i++) {
      ok(await run(['work', 'begin', '--agent', `quick-${i}`, '--project', dir('m3')]));
      const p = await page(url + '?ws=m3', '[data-testid=agent-status]');
      ok(await run(['work', 'end', '--agent', `quick-${i}`, '--project', dir('m3')])); // ends within a fraction of the 700 ms look
      await p.locator('[data-testid=agent-status]').waitFor({ state: 'detached', timeout: 8000 });
      expect(await tab(p, 'm3').getAttribute('data-state')).toBe('idle');
      await p.context().close();
    }
  }, 90_000);

  it_('closing a workspace takes its tab away everywhere and tells the page that was open on it', async () => {
    const r2 = tmpDir('studio-wsui-m2-');
    ok(await run(['ws', 'open', '--kind', 'media', '--count', '2', '--root', r2]));
    const u = await serve(['ui', '--hub', '--root', r2]);
    const a = await page(u + '?ws=m1', '[data-testid=status][data-status=live]');
    const b = await page(u + '?ws=m2', '[data-testid=status][data-status=live]');
    ok(await run(['ws', 'close', 'm2', '--root', r2]));
    await poll(() => tab(a, 'm2').count()).toBe(0);
    await poll(() => b.locator('[data-testid=status]').getAttribute('data-status')).toBe('no-server');
    expect(await b.locator('.problem').textContent()).toMatch(/workspace was closed/);
    await a.context().close();
    await b.context().close();
  }, 90_000);

  it_('a hub with no workspaces says how to open them', async () => {
    const u = await serve(['ui', '--hub', '--root', tmpDir('studio-wsui-empty-')]);
    const p = await page(u, '[data-testid=no-workspaces]');
    expect(await p.locator('[data-testid=no-workspaces]').textContent()).toMatch(/studio ws open --kind media --count 5/);
    await p.context().close();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// design editor hub

describe('design editor: workspaces d1..d5 in one window', () => {
  let root: string;
  let url: string;
  const dir = (slot: string) => join(root, 'workspaces', slot);
  const doc = (slot: string) => JSON.parse(readFileSync(join(dir(slot), 'design.studio.json'), 'utf8'));
  const layer = (slot: string, id: string) => doc(slot).layers.find((l: any) => l.id === id);
  const log = (slot: string) => readFileSync(join(dir(slot), 'design.ops.log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  beforeAll(async () => {
    root = tmpDir('studio-wsui-d-');
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const [w] = ok(await run(['ws', 'open', '--kind', 'design', '--name', name, '--width', '800', '--height', '450', '--duration', '2000', '--root', root])).workspaces;
      const ops = [
        { type: 'layer.add', args: { layer: { type: 'rect', id: 'l_aa01', name: `${name} card`, x: 100, y: 80, w: 200, h: 120, fill: { type: 'solid', color: '#ff3366' } } } },
      ];
      writeFileSync(join(w.dir, 'ops.json'), JSON.stringify(ops));
      ok(await run(['design', 'apply', 'ops.json', '--project', w.dir]));
    }
    url = await serve(['design', 'ui', '--hub', '--root', root]);
  }, 180_000);

  const open = (slot: string) => page(`${url}?ws=${slot}`, '[data-layer-row]');
  async function sceneToScreen(p: Page, x: number, y: number) {
    const stage = (await p.locator('.scene-root > div').first().boundingBox())!;
    const z = stage.width / 800;
    return { x: stage.x + x * z, y: stage.y + y * z, z };
  }

  it_('has a tab per workspace, opens the first when none is named, and each tab is its own design', async () => {
    const p = await page(url, '[data-testid=ws-tabs]');
    await poll(() => p.url()).toContain('?ws=d1');
    expect(await p.locator('[data-testid=ws-tabs] [role=tab]').allTextContents()).toEqual(['d1Alpha', 'd2Beta', 'd3Gamma']);
    await poll(() => p.locator('[data-layer-row]').allTextContents()).toEqual(['Alpha card']);
    await tab(p, 'd3').click();
    await poll(() => p.url()).toContain('?ws=d3');
    await poll(() => p.locator('[data-layer-row]').allTextContents()).toEqual(['Gamma card']);
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 90_000);

  it_('while an agent works the page only watches: nothing it does reaches the file, the agent’s edits appear live, and it is the person’s again when the agent ends', async () => {
    const p = await open('d2');
    ok(await run(['work', 'begin', '--agent', 'motion-agent', '--note', 'animating', '--project', dir('d2')]));
    const pill = p.locator('[data-testid=agent-status]');
    await pill.waitFor();
    expect(await pill.textContent()).toMatch(/motion-agent is working: animating · view only/);
    await poll(() => tab(p, 'd2').getAttribute('data-state')).toBe('agent-working');
    expect(await tab(p, 'd1').getAttribute('data-state')).toBe('idle');

    // controls are off, selecting still works
    expect(await p.getByRole('button', { name: 'Undo' }).isDisabled()).toBe(true);
    expect(await p.getByTestId('export-btn').isDisabled()).toBe(true);
    for (const t of ['rect', 'ellipse', 'text', 'pen', 'frame', 'star']) expect(await p.locator(`[data-tool=${t}]`).isDisabled()).toBe(true);
    expect(await p.locator('[data-tool=select]').isDisabled()).toBe(false);
    expect(await p.locator('.right-scroll').getAttribute('inert')).not.toBeNull();
    await p.locator('[data-layer-row=l_aa01]').click();
    await poll(() => p.locator('[data-layer-row].on').count()).toBe(1);

    // drag, nudge, delete, undo, duplicate, draw: none of it is sent
    const before = readFileSync(join(dir('d2'), 'design.studio.json'), 'utf8');
    const logLen = log('d2').length;
    const c = (await p.locator('[data-layer=l_aa01]').boundingBox())!;
    await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await p.mouse.down();
    await p.mouse.move(c.x + c.width / 2 + 60, c.y + c.height / 2 + 30, { steps: 6 });
    await p.mouse.up();
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Control+d');
    await p.keyboard.press('Delete');
    await p.keyboard.press('Control+z');
    await p.keyboard.press('r');
    const a = await sceneToScreen(p, 400, 100);
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    await p.mouse.move(a.x + 80, a.y + 50, { steps: 4 });
    await p.mouse.up();
    await p.waitForTimeout(500);
    expect(readFileSync(join(dir('d2'), 'design.studio.json'), 'utf8')).toBe(before);
    expect(log('d2')).toHaveLength(logLen);
    expect(await p.locator('[data-layer-row]').count()).toBe(1);
    expect(await p.locator('[data-tool=select]').getAttribute('aria-pressed')).toBe('true'); // the R key did not pick a tool

    // the server refuses too
    for (const [path, body] of [['/api/ops?ws=d2', { specs: [{ type: 'layer.delete', args: { id: 'l_aa01' } }] }], ['/api/undo?ws=d2', {}], ['/api/export?ws=d2', { format: 'png' }]] as const) {
      const r = await post(p, url, path, body);
      expect(r.status(), path).toBe(423);
      expect((await r.json()).code).toBe('AGENT_WORKING');
    }

    // watching the agent work
    ok(await run(['design', 'add', 'ellipse', '--name', 'Dot', '--props', '{"x":400,"y":100,"w":90,"h":90}', '--agent', 'motion-agent', '--project', dir('d2')]));
    await poll(() => p.locator('[data-layer-row]').count()).toBe(2);

    ok(await run(['work', 'end', '--agent', 'motion-agent', '--project', dir('d2')]));
    await pill.waitFor({ state: 'detached', timeout: 8000 });
    await poll(() => p.locator('[data-tool=rect]').isDisabled()).toBe(false);
    await poll(() => p.getByTestId('export-btn').isDisabled()).toBe(false);

    // and now it is the person's: the same drag is one op from the page
    await p.locator('[data-layer-row=l_aa01]').click();
    const c2 = (await p.locator('[data-layer=l_aa01]').boundingBox())!;
    const x0 = layer('d2', 'l_aa01').x;
    await p.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2);
    await p.mouse.down();
    await p.mouse.move(c2.x + c2.width / 2 + 40, c2.y + c2.height / 2 + 20, { steps: 6 });
    await p.mouse.move(c2.x + c2.width / 2 + 120, c2.y + c2.height / 2 + 60, { steps: 6 });
    await p.mouse.up();
    await poll(() => layer('d2', 'l_aa01').x).not.toBe(x0);
    expect(log('d2').at(-1).actor).toBe('ui');
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 180_000);

  it_('the person adds no media from the page: no Image or Audio tool, no file picker, a dropped file is turned away, media is refused by the server', async () => {
    const p = await open('d1');
    expect(await p.locator('[data-tool=image]').count()).toBe(0);
    expect(await p.locator('[data-tool=audio]').count()).toBe(0);
    expect(await p.locator('input[type=file]').count()).toBe(0);
    await p.keyboard.press('i');
    await p.keyboard.press('a');
    expect(await p.locator('[data-tool=select]').getAttribute('aria-pressed')).toBe('true'); // no shortcut for them either
    expect(await dropFile(p)).toBe(true);
    await poll(() => p.locator('.toast').textContent()).toMatch(/added by your agent/);
    expect(p.url()).toContain('?ws=d1');

    const before = readFileSync(join(dir('d1'), 'design.studio.json'), 'utf8');
    const up = await post(p, url, '/api/asset?ws=d1', { name: 'a.png', data: 'AAAA' });
    expect(up.status()).toBe(403);
    expect((await up.json()).code).toBe('AGENT_ONLY');
    expect(existsSync(join(dir('d1'), 'assets', 'a.png'))).toBe(false);
    for (const spec of [
      { type: 'layer.add', args: { layer: { type: 'image', src: 'assets/a.png', w: 10, h: 10 } } },
      { type: 'layer.add', args: { layer: { type: 'audio', src: 'assets/a.mp3' } } },
      { type: 'layer.set', args: { id: 'l_aa01', patch: { src: 'assets/a.png' } } },
    ]) {
      const r = await post(p, url, '/api/ops?ws=d1', { specs: [spec] });
      expect(r.status(), JSON.stringify(spec)).toBe(403);
      expect((await r.json()).code).toBe('AGENT_ONLY');
    }
    expect(readFileSync(join(dir('d1'), 'design.studio.json'), 'utf8')).toBe(before);

    // the agent does place them, and they show: the page draws what the agent adds
    const png = join(tmpDir('studio-wsui-img-'), 'dot.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', png]); // a small real PNG
    ok(await run(['design', 'asset', png, '--project', dir('d1')]));
    ok(await run(['design', 'add', 'image', '--name', 'Dot', '--src', 'assets/dot.png', '--props', '{"x":400,"y":100,"w":64,"h":64}', '--project', dir('d1')]));
    await poll(() => p.locator('.scene-root [data-layer] img').count()).toBeGreaterThan(0);
    await poll(() => p.locator('.scene-root [data-layer] img').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    expect(errors.get(p)).toEqual([]);
    await p.context().close();
  }, 120_000);

  it_('a page opened while an agent is working still hears when it finishes, even when that happens before the server’s next look', async () => {
    expect((await (await fetch(`${url}/api/design?ws=d3`)).json()).lease).toBeNull();
    for (let i = 0; i < 3; i++) {
      ok(await run(['work', 'begin', '--agent', `quick-${i}`, '--project', dir('d3')]));
      const p = await page(`${url}?ws=d3`, '[data-testid=agent-status]');
      ok(await run(['work', 'end', '--agent', `quick-${i}`, '--project', dir('d3')]));
      await p.locator('[data-testid=agent-status]').waitFor({ state: 'detached', timeout: 8000 });
      expect(await p.locator('[data-tool=rect]').isDisabled()).toBe(false);
      await p.context().close();
    }
  }, 90_000);

  it_('a hub with no design workspaces says how to open them', async () => {
    const u = await serve(['design', 'ui', '--hub', '--root', tmpDir('studio-wsui-dempty-')]);
    const p = await page(u, '[data-testid=no-workspaces]');
    expect(await p.locator('[data-testid=no-workspaces]').textContent()).toMatch(/studio ws open --kind design --count 5/);
    await p.context().close();
  }, 60_000);
});
