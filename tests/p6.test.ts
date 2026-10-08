import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore, validateProject } from '@studio/core';
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

async function serve(dir: string, extra: string[] = []): Promise<string> {
  const child = spawn('node', [BIN, 'ui', '--port', '0', '--project', dir, ...extra], {
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

/** Three contiguous 3 s clips on a video track, plus an empty graphics track. */
function seeded() {
  const dir = tmpDir('studio-p6-');
  const store = ProjectStore.init(dir, { name: 'P6', width: 1920, height: 1080, fps: 30 });
  store.apply([
    { type: 'asset.add', args: { id: 'a_vid1', asset: VIDEO_ASSET } },
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'Screen' } },
    { type: 'track.add', args: { id: 't_g1', type: 'graphics', name: 'Overlays' } },
    ...[1, 2, 3].map((n) => ({
      type: 'clip.add',
      args: {
        clip: {
          id: `c_0${n}`,
          track: 't_v1',
          asset: 'a_vid1',
          start: (n - 1) * 3000,
          dur: 3000,
          srcIn: 10_000 * n,
        },
      },
    })),
  ]);
  return { dir, store };
}
const proj = (dir: string) => JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8'));
const clipOf = (dir: string, id: string) => proj(dir).clips.find((c: any) => c.id === id);
const log = (dir: string) =>
  readFileSync(join(dir, 'ops.log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

async function open(url: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.locator('[data-clip-id]').first().waitFor();
  await page.locator('[data-testid=status][data-status=live]').waitFor();
  return page;
}
/** Drag from the centre of an element (or an offset in it) by dx px, in steps like a hand. */
async function drag(
  page: Page,
  sel: string,
  dx: number,
  at: 'center' | 'left' | 'right' = 'center',
) {
  const b = (await page.locator(sel).first().boundingBox())!;
  const x = at === 'center' ? b.x + b.width / 2 : at === 'left' ? b.x + 2 : b.x + b.width - 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
}
const rev = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-rev'));
const waitRevChange = async (page: Page, before: string | null) =>
  page.waitForFunction((b) => document.documentElement.getAttribute('data-rev') !== b, before);

describe('P6: manual edits in the browser, all through ops', () => {
  it_(
    'drag moves a clip, edge drags trim it (source in-point follows the head), each one op with actor ui',
    async () => {
      const { dir } = seeded();
      const page = await open(await serve(dir));
      // zoom is 0.1 px/ms: 100 px = 1000 ms
      let r = await rev(page);
      await drag(page, '[data-clip-id=c_03]', 100);
      await waitRevChange(page, r);
      expect(clipOf(dir, 'c_03').start).toBe(7000);
      r = await rev(page);
      await drag(page, '[data-clip-id=c_03] .handle-r', -50, 'right');
      await waitRevChange(page, r);
      expect(clipOf(dir, 'c_03').dur).toBe(2500);
      r = await rev(page);
      await drag(page, '[data-clip-id=c_03] .handle-l', 100, 'left');
      await waitRevChange(page, r);
      const c3 = clipOf(dir, 'c_03');
      expect(c3.start).toBe(8000);
      expect(c3.dur).toBe(1500);
      expect(c3.srcIn).toBe(31_000); // head trimmed by 1000 ms of source
      const entries = log(dir).filter((e) => e.actor === 'ui');
      expect(entries.map((e) => e.ops[0].type)).toEqual(['clip.move', 'clip.trim', 'clip.trim']);
      expect(validateProject(proj(dir))).toEqual([]);
    },
    60_000,
  );

  it_(
    'a drag into a neighbour is stopped at its edge instead of overlapping',
    async () => {
      const { dir } = seeded();
      const page = await open(await serve(dir));
      const r = await rev(page);
      await drag(page, '[data-clip-id=c_02]', 600); // would run over c_03 (6000-9000)
      // nothing to move without overlapping: the clip stays and no op is written
      await page.waitForTimeout(400);
      expect(clipOf(dir, 'c_02').start).toBe(3000);
      expect(await rev(page)).toBe(r);
      expect(log(dir).filter((e) => e.actor === 'ui')).toHaveLength(0);
    },
    60_000,
  );

  it_(
    'Escape during a drag cancels it; a click without movement only selects',
    async () => {
      const { dir } = seeded();
      const page = await open(await serve(dir));
      const b = (await page.locator('[data-clip-id=c_03]').boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2, { steps: 5 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForTimeout(300);
      expect(clipOf(dir, 'c_03').start).toBe(6000);
      await page.locator('[data-clip-id=c_01]').click();
      expect(await page.locator('.clip.selected').count()).toBe(1);
      expect(log(dir).filter((e) => e.actor === 'ui')).toHaveLength(0);
    },
    60_000,
  );

  it_(
    'S splits the selected clip at the playhead; Delete removes it; Shift+Delete ripples',
    async () => {
      const { dir } = seeded();
      const page = await open(await serve(dir));
      await page.locator('[data-clip-id=c_01]').click();
      // playhead to 1500 ms: 45 frames at 30 fps
      await page.keyboard.press('Home');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight'); // 4 x 10 frames
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
      const r = await rev(page);
      await page.keyboard.press('s');
      await waitRevChange(page, r);
      const clips = proj(dir)
        .clips.filter((c: any) => c.track === 't_v1')
        .sort((a: any, b: any) => a.start - b.start);
      expect(clips).toHaveLength(4);
      expect(clips[0].start + clips[0].dur).toBe(1500);
      expect(clips[1].start).toBe(1500);
      expect(clips[0].dur + clips[1].dur).toBe(3000);
      // delete the first half
      await page.locator(`[data-clip-id=${clips[0].id}]`).click();
      const r2 = await rev(page);
      await page.keyboard.press('Delete');
      await waitRevChange(page, r2);
      expect(proj(dir).clips).toHaveLength(3);
      // ripple delete the second half: later clips close the gap
      await page.locator(`[data-clip-id=${clips[1].id}]`).click();
      const r3 = await rev(page);
      await page.keyboard.press('Shift+Delete');
      await waitRevChange(page, r3);
      const left = proj(dir).clips.sort((a: any, b: any) => a.start - b.start);
      expect(left).toHaveLength(2);
      expect(left[0].start).toBe(1500); // c_02 moved left by the removed 1500 ms
    },
    60_000,
  );

  it_(
    'keyframes: arrows nudge time and value, the easing editor changes the curve; each is one undoable op',
    async () => {
      const { dir, store } = seeded();
      store.apply([
        { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 500, v: 1, ease: 'linear' } },
        { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 1500, v: 2 } },
      ]);
      const before = readFileSync(join(dir, 'project.studio.json'), 'utf8');
      const page = await open(await serve(dir));
      await page.locator('[data-clip-id=c_01]').click();
      const row = page.locator('[data-kf-row]').first();
      await row.focus();
      let r = await rev(page);
      await row.press('ArrowRight');
      await waitRevChange(page, r);
      const kf0 = clipOf(dir, 'c_01').keyframes.scale[0];
      expect(kf0.t).toBe(533); // one frame at 30 fps, whole ms
      expect(kf0.id).toBeTruthy();
      await page.locator('[data-kf-row]').first().focus();
      r = await rev(page);
      await page.locator('[data-kf-row]').first().press('ArrowUp');
      await waitRevChange(page, r);
      expect(clipOf(dir, 'c_01').keyframes.scale[0].v).toBeCloseTo(1.05, 4);
      // easing editor
      const path0 = await page.locator('[data-testid=ease-path]').first().getAttribute('d');
      r = await rev(page);
      await page
        .locator('[data-kf-row]')
        .first()
        .getByLabel('Easing', { exact: true })
        .selectOption('expo.inOut');
      await waitRevChange(page, r);
      expect(clipOf(dir, 'c_01').keyframes.scale[0].ease).toBe('expo.inOut');
      const path1 = await page.locator('[data-testid=ease-path]').first().getAttribute('d');
      expect(path1).not.toBe(path0);
      // three UI ops, then three undos from the page bring the file back byte for byte
      expect(log(dir).filter((e) => e.actor === 'ui')).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        r = await rev(page);
        await page.getByRole('button', { name: /^Undo/ }).click();
        await waitRevChange(page, r);
      }
      expect(readFileSync(join(dir, 'project.studio.json'), 'utf8')).toBe(before);
    },
    90_000,
  );

  it_(
    'graph editor: drawn from the keyframes, dragging a point is one undoable op, a bad prop tab does not break',
    async () => {
      const { dir, store } = seeded();
      store.apply([
        { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 500, v: 1, ease: 'linear' } },
        { type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 1500, v: 2 } },
        { type: 'kf.set', args: { clip: 'c_01', prop: 'opacity', t: 0, v: 1 } },
      ]);
      const before = readFileSync(join(dir, 'project.studio.json'), 'utf8');
      const page = await open(await serve(dir));
      await page.locator('[data-clip-id=c_01]').click();
      await page.getByTestId('graph-toggle').click();
      await page.getByTestId('graph').waitFor();
      expect(await page.getByTestId('graph-kf').count()).toBe(1); // properties are listed alphabetically: opacity first
      await page.getByRole('tab', { name: 'scale' }).click();
      expect(await page.getByTestId('graph-kf').count()).toBe(2);
      const d0 = await page.getByTestId('graph-curve').getAttribute('d');
      const h = page.locator('[data-testid=graph-kf]').nth(1);
      await h.scrollIntoViewIfNeeded();
      const box = (await h.boundingBox())!;
      const r = await rev(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 + 30, { steps: 6 });
      await page.mouse.up();
      await waitRevChange(page, r);
      const kf = clipOf(dir, 'c_01').keyframes.scale.find((k: any) => k.t < 1500 + 1 && k.v !== 1) ?? clipOf(dir, 'c_01').keyframes.scale[1];
      expect(kf.t === 1500 && kf.v === 2).toBe(false); // it moved in time, in value, or both
      expect(kf.v).toBeLessThan(2);
      expect(await page.getByTestId('graph-curve').getAttribute('d')).not.toBe(d0);
      expect(log(dir).filter((e) => e.actor === 'ui')).toHaveLength(1);
      const r2 = await rev(page);
      await page.getByRole('button', { name: /^Undo/ }).click();
      await waitRevChange(page, r2);
      expect(readFileSync(join(dir, 'project.studio.json'), 'utf8')).toBe(before);
    },
    90_000,
  );

  it_(
    'EXIT: manual and agent edits interleave, and undo walks back across both to the original bytes',
    async () => {
      const { dir } = seeded();
      const original = readFileSync(join(dir, 'project.studio.json'), 'utf8');
      const page = await open(await serve(dir));
      let r = await rev(page);
      // 1. UI: move c_03
      await drag(page, '[data-clip-id=c_03]', 100);
      await waitRevChange(page, r);
      // 2. agent (CLI): trim c_01
      r = await rev(page);
      const a1 = await studio(['tl', 'trim', '--id', 'c_01', '--dur', '2000', '--project', dir]);
      expect(a1.json.ok, JSON.stringify(a1.json)).toBe(true);
      await waitRevChange(page, r); // the page sees the agent's edit live
      expect(await page.locator('[data-clip-id=c_01]').getAttribute('title')).toMatch(/0–2000 ms/);
      // 3. UI: split c_02 at its middle via keyboard
      await page.locator('[data-clip-id=c_02]').click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // 1500 ms: not inside c_02 (3000-6000)
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight'); // +50 frames -> 3167 ms
      r = await rev(page);
      await page.keyboard.press('s');
      await waitRevChange(page, r);
      // 4. agent: add a marker
      r = await rev(page);
      const a2 = await studio([
        'tl',
        'marker',
        '--t',
        '1000',
        '--label',
        'check',
        '--project',
        dir,
      ]);
      expect(a2.json.ok, JSON.stringify(a2.json)).toBe(true);
      await waitRevChange(page, r);
      const actors = log(dir)
        .filter((e) => e.kind === 'apply')
        .slice(-4)
        .map((e) => e.actor);
      expect(actors.slice(-4)).toEqual(['ui', 'agent', 'ui', 'agent']);
      // Undo: UI button, agent CLI, UI keyboard, agent CLI: alternating, newest first.
      r = await rev(page);
      expect((await studio(['project', 'undo', '--project', dir])).json.ok).toBe(true); // marker (agent)
      await waitRevChange(page, r);
      r = await rev(page);
      await page.getByRole('button', { name: /^Undo/ }).click(); // split (ui)
      await waitRevChange(page, r);
      r = await rev(page);
      expect((await studio(['project', 'undo', '--project', dir])).json.ok).toBe(true); // trim (agent)
      await waitRevChange(page, r);
      r = await rev(page);
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z'); // move (ui)
      await waitRevChange(page, r);
      expect(readFileSync(join(dir, 'project.studio.json'), 'utf8')).toBe(original);
      expect(await page.getByRole('button', { name: /^Redo/ }).isDisabled()).toBe(false);
      // Redo from the page replays the agent's and the UI's ops alike.
      for (let i = 0; i < 4; i++) {
        r = await rev(page);
        await page.getByRole('button', { name: /^Redo/ }).click();
        await waitRevChange(page, r);
      }
      expect(proj(dir).markers).toHaveLength(1);
      expect(clipOf(dir, 'c_03').start).toBe(7000);
      expect(validateProject(proj(dir))).toEqual([]);
    },
    120_000,
  );

  it_(
    'an edit made against an old revision is refused (409), and nothing is applied',
    async () => {
      const { dir, store } = seeded();
      const url = await serve(dir);
      const snap = await (await fetch(`${url}/api/project`)).json();
      store.apply([{ type: 'clip.move', args: { id: 'c_03', start: 9000 } }]); // an agent edit after the page's snapshot
      const post = (body: unknown, headers: Record<string, string> = { 'x-studio-ui': '1' }) =>
        fetch(`${url}/api/ops`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
      const stale = await post({
        baseRev: snap.rev,
        specs: [{ type: 'clip.move', args: { id: 'c_01', start: 500 } }],
        label: 'x',
      });
      expect(stale.status).toBe(409);
      expect(clipOf(dir, 'c_01').start).toBe(0);
      // an invalid op is rejected whole and leaves the project alone
      const bad = await post({
        specs: [{ type: 'clip.move', args: { id: 'c_01', start: 3500 } }],
        label: 'overlap',
      });
      expect(bad.status).toBe(422);
      expect((await bad.json()).message).toMatch(/overlap/i);
      expect(clipOf(dir, 'c_01').start).toBe(0);
      // no header: forbidden, as a cross-site form post would be
      expect((await post({ specs: [] }, {})).status).toBe(403);
    },
    60_000,
  );

  it_(
    '--read-only refuses edits and the page offers none',
    async () => {
      const { dir } = seeded();
      const url = await serve(dir, ['--read-only']);
      const r = await fetch(`${url}/api/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-studio-ui': '1' },
        body: JSON.stringify({ specs: [{ type: 'clip.delete', args: { id: 'c_01' } }] }),
      });
      expect(r.status).toBe(403);
      const page = await open(url);
      expect(await page.locator('[data-clip-id=c_01] .handle').count()).toBe(0);
      expect(await page.getByRole('button', { name: /^Undo/ }).isDisabled()).toBe(true);
      expect(clipOf(dir, 'c_01')).toBeTruthy();
    },
    60_000,
  );

  it('two writers at once: 12 concurrent CLI edits all land, none lost, the log stays consistent', async () => {
    const dir = tmpDir('studio-p6-lock-');
    await studio(['init', 'lock', '--project', dir]);
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
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        studio(['tl', 'marker', '--t', String(i * 100), '--label', `m${i}`, '--project', dir]),
      ),
    );
    expect(res.map((x) => x.code)).toEqual(Array(12).fill(0));
    expect(proj(dir).markers).toHaveLength(12);
    expect(log(dir).filter((e) => e.kind === 'apply')).toHaveLength(13);
    expect((await studio(['project', 'validate', '--project', dir])).json.ok).toBe(true);
  }, 120_000);
});
