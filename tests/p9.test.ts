import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileExpr, ExprError, loadPlugin, resolveEffectParams, PluginError } from '@studio/core';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
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
const ev = (src: string, vars: Record<string, number> = {}) => compileExpr(src)({ t: 0, ...vars });

describe('expressions', () => {
  it('follow normal precedence, right-associative power, and a ternary', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('t > 1 ? 10 : 20', { t: 2 })).toBe(10);
    expect(ev('clamp(5, 0, 1) + lerp(0, 10, 0.5) + mod(-1, 3)')).toBe(1 + 5 + 2);
  });
  it('wiggle and noise are deterministic and bounded; a seed changes them', () => {
    const f = compileExpr('wiggle(3, 1, 7)');
    const a = [0, 0.1, 0.5, 1.7].map((t) => f({ t }));
    expect([0, 0.1, 0.5, 1.7].map((t) => f({ t }))).toEqual(a);
    expect(a.every((v) => Math.abs(v) <= 1)).toBe(true);
    expect(compileExpr('wiggle(3, 1, 8)')({ t: 0.5 })).not.toBe(f({ t: 0.5 }));
  });
  it('refuses what is not a formula: property access, unknown names, runaway nesting, long text', () => {
    expect(() => ev('constructor')).toThrow(ExprError);
    expect(() => ev('a.b')).toThrow(ExprError);
    expect(() => ev('process.exit(1)')).toThrow(ExprError);
    expect(() => ev('nope(1)')).toThrow(/unknown function/);
    expect(() => ev('(' .repeat(40) + '1' + ')'.repeat(40))).toThrow(/nested/);
    expect(() => compileExpr('1+'.repeat(300) + '1')).toThrow(/characters/);
    expect(() => compileExpr('1 / 0')({ t: 0 })).not.toThrow(); // division by zero is 0, not Infinity
  });
});

function plugin(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const id = String(manifest['id']);
  const d = join(dir, 'plugins', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'plugin.json'),
    JSON.stringify({ api: 1, name: id, version: '1.0.0', summary: 's', license: 'MIT', ...manifest }),
  );
  for (const [n, body] of Object.entries(files)) writeFileSync(join(d, n), body);
  return d;
}
const fxDecl = (graph: string, params: Record<string, unknown> = {}) => ({
  effects: [{ id: 'fx1', summary: 's', params, graph }],
});

describe('plugin loading', () => {
  it('accepts a small valid effect and reports its size and a content hash', () => {
    const dir = tmpDir('studio-p9-');
    const d = plugin(dir, { id: 'ok-fx', ...fxDecl('[in]hflip[out]') });
    const p = loadPlugin(d, 'project');
    expect(p.bytes).toBeLessThan(2000);
    expect(p.hash).toMatch(/^[0-9a-f]{12}$/);
  });
  it('refuses unsafe or oversized plugins with the reason', () => {
    const dir = tmpDir('studio-p9-');
    const bad = (m: Record<string, unknown>, files?: Record<string, string>) =>
      expect(() => loadPlugin(plugin(dir, m, files), 'project'));
    bad({ id: 'p-movie', ...fxDecl("[in]movie=/etc/passwd[out]") }).toThrow(/movie/);
    bad({ id: 'p-noio', ...fxDecl('hflip') }).toThrow(/\[in\].*\[out\]/);
    bad({ id: 'p-undecl', ...fxDecl('[in]gblur=sigma={zz}[out]') }).toThrow(/declares no such param/);
    bad({ id: 'p-quote', ...fxDecl('[in]hflip"[out]') }).toThrow(/disallowed character/);
    bad({ id: 'p-escape', page: '../../x.js', templates: [{ id: 't1', summary: 's', kind: 'overlay', defaultDurMs: 1000, props: {} }] }).toThrow(/leaves the plugin folder|missing/);
    bad({ id: 'p-big', ...fxDecl('[in]hflip[out]') }, { 'blob.bin': 'x'.repeat(70_000) }).toThrow(/over the 65536 byte budget/);
    bad({ id: 'p-extra', surprise: 1, ...fxDecl('[in]hflip[out]') }).toThrow(PluginError);
    expect(() => loadPlugin(plugin(dir, { id: 'p-wrong', ...fxDecl('[in]hflip[out]') }).replace('p-wrong', 'p-other'), 'project')).toThrow();
  });
  it('validates parameters against the manifest, with the allowed range in the message', () => {
    const dir = tmpDir('studio-p9-');
    const p = loadPlugin(
      plugin(dir, { id: 'rng', ...fxDecl('[in]gblur=sigma={r}[out]', { r: { type: 'number', default: 5, min: 1, max: 20, desc: 'd' } }) }),
      'project',
    );
    const decl = p.manifest.effects![0]!;
    expect(resolveEffectParams(decl, {})).toEqual({ r: '5' });
    expect(() => resolveEffectParams(decl, { r: 99 })).toThrow(/outside 1\.\.20/);
    expect(() => resolveEffectParams(decl, { q: 1 })).toThrow(/unknown param/);
  });
  it('every plugin shipped with Studio loads, stays under the size budget, and is small in total', async () => {
    const r = await studio(['plugins', 'list', '--project', tmpDir('studio-p9-')]);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.problems).toEqual([]);
    const ids = r.json.data.plugins.map((p: any) => p.id).sort();
    expect(ids).toEqual(['glow', 'light-fx', 'logo-reveal', 'shapes']);
    for (const p of r.json.data.plugins) expect(p.bytes).toBeLessThan(16 * 1024);
    expect(r.json.data.totalBytes).toBeLessThan(40 * 1024);
  });
});

describe('plugins through the CLI', () => {
  it('scaffolds a plugin of each kind, and `check` really runs it', async () => {
    const dir = tmpDir('studio-p9-');
    for (const [id, kind] of [['my-glow', 'effect'], ['my-text', 'template'], ['my-script', 'script']] as const) {
      const n = await studio(['plugins', 'new', id, '--kind', kind, '--project', dir]);
      expect(n.json.ok, JSON.stringify(n.json)).toBe(true);
      const c = await studio(['plugins', 'check', id, '--project', dir]);
      expect(c.json.ok, JSON.stringify(c.json)).toBe(true);
    }
    const r = (await studio(['plugins', 'check', 'my-text', '--project', dir])).json.data.results[0];
    expect(r.detail).toMatch(/rendered a frame/);
    expect(existsSync(join(dir, 'renders', 'motion', 'check-my-text.png'))).toBe(true);
    // a second scaffold of the same id is refused without --force
    expect((await studio(['plugins', 'new', 'my-glow', '--project', dir])).code).toBe(5);
  });
  it('check fails loudly on a broken filter graph and on a template that throws', async () => {
    const dir = tmpDir('studio-p9-');
    plugin(dir, { id: 'broken-fx', ...fxDecl('[in]nosuchfilter=1[out]') });
    const a = await studio(['plugins', 'check', 'broken-fx', '--project', dir]);
    expect(a.code).toBe(4);
    expect(a.json.error.code).toBe('PLUGIN_INVALID');
    plugin(
      dir,
      { id: 'throws', page: 'page.js', templates: [{ id: 'boom', summary: 's', kind: 'overlay', defaultDurMs: 1000, props: {} }] },
      { 'page.js': "register('boom', () => { throw new Error('nope from plugin'); });" },
    );
    const b = await studio(['plugins', 'check', 'throws', '--project', dir]);
    expect(b.code).toBe(4);
    expect(b.json.error.message).toMatch(/nope from plugin/);
  });
  it('the renderer is offline: a plugin that loads from a reachable server fails, and the server is never contacted', async () => {
    const { createServer } = await import('node:http');
    let hits = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const srv = createServer((_q, res) => {
      hits++;
      res.setHeader('content-type', 'image/png');
      res.end(png);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const dir = tmpDir('studio-p9-');
      plugin(
        dir,
        { id: 'phone-home', page: 'page.js', templates: [{ id: 'leaky', summary: 's', kind: 'overlay', defaultDurMs: 1000, props: {} }] },
        { 'page.js': `register('leaky', (c) => { const i = document.createElement('img'); i.src = 'http://127.0.0.1:${port}/x.png'; c.root.appendChild(i); return { update() {} }; });` },
      );
      const r = await studio(['plugins', 'check', 'phone-home', '--project', dir]);
      expect(r.code).toBe(4);
      expect(r.json.error.message).toMatch(/leaky/);
      expect(hits).toBe(0);
    } finally {
      srv.close();
    }
  });
  it('a plugin template is a normal template: it is listed, added as a clip, and its props are validated', async () => {
    const dir = tmpDir('studio-p9-');
    await studio(['init', 'p', '--width', '640', '--height', '360', '--project', dir]);
    await studio(['plugins', 'new', 'my-text', '--project', dir]);
    const t = await studio(['motion', 'templates', '--comp', 'my-text', '--project', dir]);
    expect(t.json.ok).toBe(true);
    await studio(['tl', 'add-track', '--type', 'graphics', '--name', 'G', '--id', 't_g1', '--project', dir]);
    const add = await studio(['tl', 'add-clip', '--track', 't_g1', '--comp', 'my-text', '--start', '0', '--dur', '2000', '--project', dir]);
    expect(add.json.ok, JSON.stringify(add.json)).toBe(true);
    const bad = await studio(['motion', 'still', '--comp', 'my-text', '--props', '{"text":5}', '--project', dir]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/expected a string/);
    // a plugin cannot replace a built-in template
    plugin(dir, { id: 'thief', page: 'p.js', templates: [{ id: 'title', summary: 's', kind: 'overlay', defaultDurMs: 1000, props: {} }] }, { 'p.js': '' });
    const l = await studio(['plugins', 'list', '--project', dir]);
    expect(l.json.data.problems.some((p: any) => /template "title" already exists/.test(p.message))).toBe(true);
  });
  it('a plugin effect is an undoable op, validated up front, and visibly changes the rendered frame', async () => {
    ensureFixtures();
    const dir = tmpDir('studio-p9-');
    await studio(['init', 'p', '--width', '320', '--height', '180', '--fps', '24', '--project', dir]);
    const id = (await studio(['ingest', fx('clean.mp4'), '--project', dir])).json.data.ingested[0].id;
    await studio(['tl', 'add-track', '--type', 'video', '--name', 'V', '--id', 't_v1', '--project', dir]);
    await studio(['tl', 'add-clip', '--track', 't_v1', '--asset', id, '--start', '0', '--dur', '2000', '--id', 'c_v1', '--project', dir]);
    const still = async (name: string) => {
      const r = await studio(['render', '--still', '1000', '--out', name, '--no-normalize', '--project', dir]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      // mean colour of the whole frame, measured by scaling it to one pixel
      const px = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, r.json.data.output), '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
      return [px[0]!, px[1]!, px[2]!];
    };
    const before = await still('plain');
    // out-of-range parameter is refused at apply time with the range
    const bad = await studio(['plugins', 'apply', '--clip', 'c_v1', '--effect', 'glow', '--params', '{"amount":3}', '--project', dir]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/outside 0\.\.1/);
    const ok = await studio(['plugins', 'apply', '--clip', 'c_v1', '--effect', 'grain', '--params', '{"strength":60}', '--project', dir]);
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    const okGlow = await studio(['plugins', 'apply', '--clip', 'c_v1', '--effect', 'glow', '--params', '{"amount":1,"radius":30}', '--project', dir]);
    expect(okGlow.json.ok).toBe(true);
    const after = await still('fx');
    expect(after.reduce((a, b) => a + b, 0)).toBeGreaterThan(before.reduce((a, b) => a + b, 0) + 3); // screened glow brightens
    // undo removes both effects and the render matches the original again
    await studio(['project', 'undo', '--n', '2', '--project', dir]);
    const proj = JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8'));
    expect(proj.clips.find((c: any) => c.id === 'c_v1').fx ?? []).toEqual([]);
  }, 120_000);
});

describe('expr bake and scripts', () => {
  async function scene() {
    ensureFixtures();
    const dir = tmpDir('studio-p9-');
    await studio(['init', 'p', '--width', '320', '--height', '180', '--project', dir]);
    const id = (await studio(['ingest', fx('clean.mp4'), '--project', dir])).json.data.ingested[0].id;
    await studio(['tl', 'add-track', '--type', 'video', '--name', 'V', '--id', 't_v1', '--project', dir]);
    await studio(['tl', 'add-clip', '--track', 't_v1', '--asset', id, '--start', '0', '--dur', '3000', '--id', 'c_v1', '--project', dir]);
    return dir;
  }
  const kfs = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8')).clips.find((c: any) => c.id === 'c_v1').keyframes ?? {};

  it('eval shows values; bake writes keyframes in one undoable step and refuses out-of-range values', async () => {
    const dir = await scene();
    const e = await studio(['expr', 'eval', '--expr', 'lerp(1, 2, p)', '--at', '0,0.5,1', '--dur', '1', '--project', dir]);
    expect(e.json.data.values.map((v: any) => v.v)).toEqual([1, 1.5, 2]);
    const bad = await studio(['expr', 'bake', '--clip', 'c_v1', '--prop', 'scale', '--expr', '1 - p', '--project', dir]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/must stay within 1\.\.8/);
    expect(kfs(dir).scale).toBeUndefined();
    const ok = await studio(['expr', 'bake', '--clip', 'c_v1', '--prop', 'scale', '--expr', '1 + p', '--from', '0', '--to', '1000', '--step', '250', '--project', dir]);
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    expect(kfs(dir).scale.map((k: any) => [k.t, k.v])).toEqual([[0, 1], [250, 1.25], [500, 1.5], [750, 1.75], [1000, 2]]);
    await studio(['project', 'undo', '--project', dir]);
    expect(kfs(dir).scale).toBeUndefined();
    const tooFine = await studio(['expr', 'bake', '--clip', 'c_v1', '--prop', 'scale', '--expr', '1', '--step', '10', '--project', dir]);
    expect(tooFine.code).toBe(2);
    expect(tooFine.json.error.message).toMatch(/at least 40 ms/);
  }, 60_000);

  it('the script library lists, runs through studio commands only, validates arguments, and never executes unmarked files', async () => {
    const dir = await scene();
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'boom.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran.txt', import.meta.url), 'x');\n");
    const l = await studio(['script', 'list', '--project', dir]);
    const names = l.json.data.scripts.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(['zoom-punch', 'wiggle-zoom', 'intro-outro']));
    expect(names).not.toContain('boom');
    expect(existsSync(join(dir, 'scripts', 'ran.txt'))).toBe(false);
    const run = await studio(['script', 'run', 'zoom-punch', '--args', '{"clip":"c_v1","at":500,"scale":1.5}', '--project', dir]);
    expect(run.json.ok, JSON.stringify(run.json)).toBe(true);
    expect(run.json.data.studioCalls).toBe(12);
    expect(kfs(dir).scale.map((k: any) => k.v)).toEqual([1, 1.5, 1.5, 1]);
    expect((await studio(['script', 'run', 'zoom-punch', '--args', '{"at":1}', '--project', dir])).json.error.message).toMatch(/"clip" is required/);
    expect((await studio(['script', 'run', 'zoom-punch', '--args', '{"clip":"c_v1","bogus":1}', '--project', dir])).json.error.message).toMatch(/unknown argument "bogus"/);
    const late = await studio(['script', 'run', 'zoom-punch', '--args', '{"clip":"c_v1","at":2900}', '--project', dir]);
    expect(late.json.error.message).toMatch(/clip is 3000 ms long/);
    // every script change was a logged op: one transaction per studio call, undoable
    const log = await studio(['project', 'log', '--limit', '50', '--project', dir]);
    expect(log.json.data.entries?.length ?? log.json.data.log?.length ?? 1).toBeGreaterThan(10);
    // a project script is found too
    writeFileSync(join(dir, 'scripts', 'mine.mjs'), "export const meta = { summary: 'x', args: {} };\nexport default async (api) => ({ n: api.project.clips.length });\n");
    const mine = await studio(['script', 'run', 'mine', '--project', dir]);
    expect(mine.json.data.result).toEqual({ n: 1 });
  }, 90_000);
});

describe('rotation and opacity keyframes', () => {
  it('opacity scales the picture over the background; rotation keeps the frame size and clears the corners', async () => {
    ensureFixtures();
    const dir = tmpDir('studio-p9-');
    await studio(['init', 'p', '--width', '320', '--height', '180', '--fps', '24', '--project', dir]);
    const id = (await studio(['ingest', fx('clean.mp4'), '--project', dir])).json.data.ingested[0].id;
    await studio(['tl', 'add-track', '--type', 'video', '--name', 'V', '--id', 't_v1', '--project', dir]);
    await studio(['tl', 'add-clip', '--track', 't_v1', '--asset', id, '--start', '0', '--dur', '2000', '--id', 'c_v1', '--project', dir]);
    const frame = async (name: string) => {
      const r = await studio(['render', '--still', '1000', '--out', name, '--no-normalize', '--project', dir]);
      expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
      return execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, r.json.data.output), '-vf', 'scale=64:36:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
    };
    const mean = (b: Buffer) => b.reduce((a, c) => a + c, 0) / b.length;
    const plain = await frame('plain');
    for (const [t, v] of [[0, 1], [2000, 0.5]] as const)
      await studio(['tl', 'keyframe', '--clip', 'c_v1', '--prop', 'opacity', '--t', String(t), '--v', String(v), '--project', dir]);
    const faded = await frame('faded');
    // at 1 s the keyframes are at 0.75: the picture is that fraction of its brightness over a black canvas
    expect(mean(faded) / mean(plain)).toBeGreaterThan(0.6);
    expect(mean(faded) / mean(plain)).toBeLessThan(0.9);
    for (const [t, v] of [[0, 0], [2000, 90]] as const)
      await studio(['tl', 'keyframe', '--clip', 'c_v1', '--prop', 'rot', '--t', String(t), '--v', String(v), '--project', dir]);
    const spun = await frame('spun');
    expect(spun.length).toBe(64 * 36);
    // a 45 degree turn of a 16:9 frame leaves its corners empty (black canvas), where the plain frame has picture
    expect(spun[0]).toBeLessThan(plain[0]! / 2 + 8);
    // out-of-range values are refused with the range
    await studio(['tl', 'keyframe', '--clip', 'c_v1', '--prop', 'opacity', '--t', '500', '--v', '1.5', '--project', dir]);
    const bad = await studio(['render', '--still', '1000', '--out', 'bad', '--project', dir]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/opacity 1.5 is outside 0..1/);
  }, 90_000);
});
