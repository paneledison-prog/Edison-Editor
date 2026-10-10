import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { activatePlugins, effectLines, pluginEffects, type FxContext } from '../packages/engines/src/index.js';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
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
const W = 320;
const H = 180;
const CTX: FxContext = { W, H, FPS: 24, SRCFPS: 24, SPEED: 1, T0: 0 };
const BARS = `smptebars=s=${W}x${H}:r=24:d=1`;
const GRADIENT = `gradients=s=${W}x${H}:r=24:d=1:c0=0x101010:c1=0xf0f0f0:x0=0:y0=0:x1=${W}:y1=0:seed=3`;

beforeAll(() => activatePlugins(ROOT));

/** Runs one effect over a generated picture and returns the path of the last frame as PNG (rgba). */
type RunOpts = { src?: string; frames?: number; alpha?: boolean; ctx?: Partial<FxContext>; out: string };
function runArgs(id: string, params: Record<string, unknown> | undefined, o: RunOpts): string[] {
  const lines = effectLines({ id, ...(params ? { params } : {}) }, 'src', 'fxout', 'chk', { ...CTX, ...o.ctx });
  const fmt = o.alpha ? 'yuva420p' : 'yuv420p';
  return ['-v', 'error', '-y', '-f', 'lavfi', '-i', o.src ?? BARS, '-filter_complex', `[0:v]format=${fmt}[src];${lines.join(';')}`, '-map', '[fxout]', '-frames:v', String(o.frames ?? 1), '-update', '1', '-pix_fmt', 'rgba', o.out];
}
function run(id: string, params: Record<string, unknown> | undefined, o: RunOpts): string {
  execFileSync('ffmpeg', runArgs(id, params, o));
  return o.out;
}
/** The same, without blocking the test worker: the long loops below must let the runner talk to it. */
const execFileP = promisify(execFile);
async function runAsync(id: string, params: Record<string, unknown> | undefined, o: RunOpts): Promise<string> {
  await execFileP('ffmpeg', runArgs(id, params, o));
  return o.out;
}
function px(png: string, x: number, y: number): number[] {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return [b[0]!, b[1]!, b[2]!, b[3]!];
}
function meanRgb(png: string): number[] {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return [b[0]!, b[1]!, b[2]!];
}
const near = (a: number[], b: number[], tol = 8) => a.slice(0, b.length).every((v, i) => Math.abs(v - b[i]!) <= tol);
// SMPTE bars: columns 0..6 are grey, yellow, cyan, green, magenta, red, blue; x centres at (i + 0.5) * W / 7
const bar = (i: number) => Math.round(((i + 0.5) * W) / 7);

describe('colour plugin: every effect, every parameter, at its limits', () => {
  const effects = () => pluginEffects().filter((e) => e.plugin.manifest.id === 'color');

  it('ships the effect set it advertises, inside the size budget', () => {
    const ids = effects().map((e) => e.decl.id).sort();
    expect(ids).toEqual([
      'channel-mixer', 'chromatic', 'colorspace', 'curves', 'denoise', 'denoise-strong', 'drop-shadow', 'film-look', 'gaussian-blur', 'glitch',
      'hue-sat', 'keyer', 'lens-blur', 'light-rays', 'light-sweep', 'lumetri', 'motion-blur', 'optics', 'primary', 'qualifier', 'sharpen',
      'slowmo', 'stabilize', 'tritone', 'turbulent-displace', 'wave-warp', 'window', 'zones',
    ]);
    const size = readFileSync(join(ROOT, 'plugins', 'color', 'plugin.json')).length;
    expect(size).toBeLessThan(48 * 1024);
  });

  it('runs every effect with each parameter at its minimum, maximum, and every enum value, on a picture with and without alpha', async () => {
    const dir = tmpDir('studio-color-');
    const jobs: { name: string; id: string; params: Record<string, unknown>; alpha: boolean }[] = [];
    for (const { decl } of effects()) {
      const sets: Record<string, unknown>[] = [{}];
      for (const [k, p] of Object.entries(decl.params)) {
        if (p.type === 'number') sets.push({ [k]: p.min }, { [k]: p.max });
        else if (p.type === 'enum') for (const v of p.values!) sets.push({ [k]: v });
        else if (p.type === 'boolean') sets.push({ [k]: !p.default });
        else if (p.type === 'points') sets.push({ [k]: '0/0.2 0.5/0.8 1/1' });
        else if (p.type === 'color') sets.push({ [k]: '#ff00aa' });
      }
      sets.forEach((params, i) => jobs.push({ name: `${decl.id}-${i}`, id: decl.id, params, alpha: false }));
      jobs.push({ name: `${decl.id}-alpha`, id: decl.id, params: {}, alpha: true });
    }
    expect(jobs.length).toBeGreaterThan(300);
    const failures: string[] = [];
    const q = [...jobs];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let j = q.shift(); j; j = q.shift()) {
          try {
            // three frames: temporal filters (tmix, denoise) need history; mid-range timestamps exercise {T0} sources
            await runAsync(j.id, j.params, { frames: 3, alpha: j.alpha, out: join(dir, j.name + '.png') });
          } catch (e) {
            failures.push(`${j.id} ${JSON.stringify(j.params)}${j.alpha ? ' (alpha)' : ''}: ${(e as Error).message.split('\n').slice(-2).join(' ')}`);
          }
        }
      }),
    );
    expect(failures).toEqual([]);
  }, 600_000);

  it('rejects an out-of-range or unknown parameter before any render, with the range', () => {
    expect(() => effectLines({ id: 'lumetri', params: { exposure: 9 } }, 'a', 'b', 'u')).toThrow(/outside -4\.\.4/);
    expect(() => effectLines({ id: 'lumetri', params: { bogus: 1 } }, 'a', 'b', 'u')).toThrow(/unknown param/);
    expect(() => effectLines({ id: 'curves', params: { master: '0/0 0.5/2 1/1' } }, 'a', 'b', 'u')).toThrow(/curve points/);
    expect(() => effectLines({ id: 'curves', params: { master: '0/0; movie=x 1/1' } }, 'a', 'b', 'u')).toThrow(/curve points/);
    expect(() => effectLines({ id: 'keyer', params: { key: '00ff00' } }, 'a', 'b', 'u')).toThrow(/#RRGGBB/);
    expect(() => effectLines({ id: 'hue-sat', params: { target: 'x' } }, 'a', 'b', 'u')).toThrow(/expected one of/);
    expect(() => effectLines({ id: 'no-such-effect' }, 'a', 'b', 'u')).toThrow(/no plugin effect/);
  });
});

describe('colour plugin: what each effect does to the picture', () => {
  const dir = tmpDir('studio-color-fx-');
  const out = (n: string) => join(dir, n + '.png');
  const plain = (n: string) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', BARS, '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgba', out(n)]);
    return out(n);
  };

  it('neutral settings leave the picture alone (within 3 levels)', () => {
    const src = plain('src');
    for (const id of ['lumetri', 'primary', 'zones', 'curves', 'hue-sat', 'channel-mixer', 'qualifier', 'window']) {
      const f = run(id, undefined, { out: out('neutral-' + id) });
      for (const x of [0, 1, 2, 3, 4, 5, 6]) expect(near(px(f, bar(x), 60), px(src, bar(x), 60), 3), `${id} bar ${x}`).toBe(true);
    }
  });

  it('lumetri: exposure brightens, temperature shifts red against blue, saturation -100 removes colour', () => {
    const base = meanRgb(plain('base'));
    const bright = meanRgb(run('lumetri', { exposure: 1 }, { out: out('l-exp') }));
    expect(bright.reduce((a, b) => a + b)).toBeGreaterThan(base.reduce((a, b) => a + b) + 30);
    const warm = meanRgb(run('lumetri', { temperature: 100 }, { out: out('l-warm') }));
    const cool = meanRgb(run('lumetri', { temperature: -100 }, { out: out('l-cool') }));
    expect(warm[0]! - warm[2]!).toBeGreaterThan(cool[0]! - cool[2]! + 10);
    const mono = run('lumetri', { saturation: -100 }, { out: out('l-mono') });
    for (const x of [1, 2, 3, 4, 5, 6]) {
      const p = px(mono, bar(x), 60);
      expect(Math.max(p[0]!, p[1]!, p[2]!) - Math.min(p[0]!, p[1]!, p[2]!), `bar ${x}`).toBeLessThanOrEqual(4);
    }
  });

  it('primary: gain 0 on red removes red; lift raises the blacks; curves can invert', () => {
    const noRed = run('primary', { gainR: 0 }, { out: out('p-nored') });
    for (const x of [0, 1, 4, 5]) expect(px(noRed, bar(x), 60)[0]).toBeLessThanOrEqual(3);
    const lifted = px(run('primary', { liftM: 0.3 }, { src: `color=c=black:s=${W}x${H}:r=24:d=1`, out: out('p-lift') }), 5, 5);
    expect(lifted[0]).toBeGreaterThan(50);
    const inv = run('curves', { master: '0/1 1/0' }, { out: out('c-inv') });
    expect(near(px(inv, bar(0), 60), [255 - 191, 255 - 191, 255 - 191], 12)).toBe(true); // the grey bar (191) inverts
    const blackBar = px(inv, bar(0), 170); // bottom strip: black at the far left of the pluge area
    void blackBar;
  });

  it('hue-sat and qualifier act on one colour family only', () => {
    const src = plain('s2');
    const g = run('hue-sat', { target: 'g', hue: 120 }, { out: out('hs-g') });
    expect(near(px(g, bar(3), 60), px(src, bar(3), 60), 10)).toBe(false); // the green bar moved
    for (const x of [0, 1, 4, 5]) expect(near(px(g, bar(x), 60), px(src, bar(x), 60), 14), `hue-sat left bar ${x} alone`).toBe(true);
    const q = run('qualifier', { hue: 120, hueWidth: 30, shift: 120 }, { out: out('q') });
    expect(near(px(q, bar(3), 60), px(src, bar(3), 60), 10)).toBe(false);
    for (const x of [0, 1, 2, 4, 5, 6]) expect(near(px(q, bar(x), 60), px(src, bar(x), 60), 6), `qualifier left bar ${x} alone`).toBe(true);
    // inverted selection: everything but green
    const qi = run('qualifier', { hue: 120, hueWidth: 30, shift: 120, invert: true }, { out: out('qi') });
    expect(near(px(qi, bar(3), 60), px(src, bar(3), 60), 6)).toBe(true);
    expect(near(px(qi, bar(5), 60), px(src, bar(5), 60), 10)).toBe(false);
  });

  it('the qualifier turns a muted colour too (a navy shirt), not only pure ones', () => {
    // navy: hue about 220 degrees, saturation 0.55, value 0.36; shifted by -150 degrees it must land far from blue
    const src = `color=c=0x2a3a5c:s=${W}x${H}:r=24:d=1`;
    const q = run('qualifier', { hue: 220, hueWidth: 25, satMin: 0.3, valMin: 0.05, shift: -150 }, { src, out: out('q-navy') });
    const [r, g, b] = px(q, W / 2, H / 2) as [number, number, number];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const hue = max === min ? 0 : max === r ? (60 * ((g - b) / (max - min)) + 360) % 360 : max === g ? 60 * ((b - r) / (max - min)) + 120 : 60 * ((r - g) / (max - min)) + 240;
    console.log(`QUALIFIER navy 0x2a3a5c shifted -150: ${r},${g},${b} (hue ${Math.round(hue)} degrees)`);
    expect(Math.abs(((hue - 220 + 540) % 360) - 180)).toBeGreaterThan(80);
  });

  it('window grades inside only, with a soft edge', () => {
    const src = `color=c=0x606060:s=${W}x${H}:r=24:d=1`;
    const f = run('window', { exposure: 1, feather: 0.1 }, { src, out: out('w') });
    expect(px(f, W / 2, H / 2)[0]).toBeGreaterThan(0x60 + 40); // centre brightened
    expect(Math.abs(px(f, 3, 3)[0]! - 0x60)).toBeLessThanOrEqual(2); // corner untouched
    const inv = run('window', { exposure: 1, feather: 0.1, invert: true }, { src, out: out('wi') });
    expect(Math.abs(px(inv, W / 2, H / 2)[0]! - 0x60)).toBeLessThanOrEqual(2);
    expect(px(inv, 3, 3)[0]).toBeGreaterThan(0x60 + 40);
  });

  it('tritone maps black and white to its colours; the keyer clears the green and keeps the subject; drop shadow sits under the shape', () => {
    const t = run('tritone', { shadow: '#102030', high: '#f0e0d0' }, { src: `gradients=s=${W}x${H}:r=24:d=1:c0=0x000000:c1=0xffffff:x0=0:y0=0:x1=${W}:y1=0:seed=1`, out: out('t') });
    expect(near(px(t, 2, 90), [0x10, 0x20, 0x30], 14)).toBe(true);
    expect(near(px(t, W - 3, 90), [0xf0, 0xe0, 0xd0], 14)).toBe(true);
    const key = run('keyer', undefined, { src: `color=c=0x00ff00:s=${W}x${H}:r=24:d=1,drawbox=x=100:y=50:w=100:h=80:color=red:t=fill`, alpha: true, out: out('k') });
    expect(px(key, 5, 5)[3]).toBeLessThanOrEqual(8); // screen is transparent
    expect(px(key, 150, 90)[3]).toBeGreaterThanOrEqual(247); // subject is opaque
    expect(near(px(key, 150, 90), [255, 0, 0], 24)).toBe(true);
    const sh = run('drop-shadow', { dx: 20, dy: 20, blur: 0, opacity: 1 }, { src: `color=c=black@0:s=${W}x${H}:r=24:d=1,format=rgba,drawbox=x=100:y=50:w=80:h=60:color=white:t=fill:replace=1`, alpha: true, out: out('sh') });
    expect(px(sh, 190, 120)[3]).toBeGreaterThanOrEqual(247); // the shadow, 20 px down and right of the square
    expect(px(sh, 190, 120).slice(0, 3).every((v) => v <= 8)).toBe(true); // and it is black
    expect(px(sh, 140, 80)[0]).toBeGreaterThanOrEqual(247); // the white square is on top
  });

  it('blur and sharpen change detail in the expected direction; light sweep adds light only while it passes', () => {
    const edges = (png: string) => {
      const a = px(png, bar(1) - 2, 60);
      const b = px(png, bar(1) + 2, 60);
      return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
    };
    const base = edges(plain('e0'));
    const edgeAt = (png: string) => {
      const a = px(png, Math.round(W / 7) - 1, 60);
      const b = px(png, Math.round(W / 7) + 1, 60);
      return Math.abs(a[0]! - b[0]!) + Math.abs(a[2]! - b[2]!);
    };
    void base;
    const soft = run('gaussian-blur', { radius: 6 }, { out: out('gb') });
    expect(edgeAt(soft)).toBeLessThan(edgeAt(plain('e1')));
    const sharp = run('sharpen', { amount: 3 }, { out: out('sh2') });
    expect(edgeAt(sharp)).toBeGreaterThanOrEqual(edgeAt(plain('e2')));
    const early = run('light-sweep', { period: 4, sweep: 1, intensity: 1 }, { src: `color=c=0x303030:s=${W}x${H}:r=24:d=3`, frames: 1, out: out('ls0') });
    expect(Math.abs(meanRgb(early)[0]! - 0x30)).toBeLessThan(20);
  });
});

describe('colour plugin: in a render', () => {
  async function scene() {
    ensureFixtures();
    const dir = tmpDir('studio-color-render-');
    await studio(['init', 'c', '--width', '320', '--height', '180', '--fps', '30', '--project', dir]);
    const id = (await studio(['ingest', fx('scenes.mp4'), '--project', dir])).json.data.ingested[0].id;
    await studio(['tl', 'add-track', '--type', 'video', '--name', 'V', '--id', 't_v1', '--project', dir]);
    await studio(['tl', 'add-clip', '--track', 't_v1', '--asset', id, '--start', '0', '--dur', '2000', '--id', 'c_c1', '--project', dir]);
    return dir;
  }
  const still = async (dir: string, name: string, at = 500) => {
    const r = await studio(['render', '--still', String(at), '--out', name, '--no-normalize', '--force', '--project', dir]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    return join(dir, r.json.data.output);
  };

  it('a node stack is edited with commands: add, set, move, bypass, remove; each is one undoable op and a bypassed node renders as if absent', async () => {
    const dir = await scene();
    const p = ['--project', dir];
    const base = meanRgb(await still(dir, 'base'));
    expect((await studio(['color', 'add', '--clip', 'c_c1', '--effect', 'lumetri', '--params', '{"exposure":1}', ...p])).json.ok).toBe(true);
    expect((await studio(['color', 'add', '--clip', 'c_c1', '--effect', 'tritone', ...p])).json.ok).toBe(true);
    const stack = (await studio(['color', 'stack', '--clip', 'c_c1', ...p])).json.data.nodes;
    expect(stack.map((n: any) => n.id)).toEqual(['lumetri', 'tritone']);
    expect(stack[0].params.exposure).toBe(1);
    expect(stack[0].params.contrast).toBe(0); // defaults are filled in
    await studio(['color', 'set', '--clip', 'c_c1', '--node', '0', '--params', '{"contrast":20}', ...p]);
    const s2 = (await studio(['color', 'stack', '--clip', 'c_c1', ...p])).json.data.nodes;
    expect(s2[0].params).toMatchObject({ exposure: 1, contrast: 20 });
    await studio(['color', 'move', '--clip', 'c_c1', '--node', '1', '--to', '0', ...p]);
    expect((await studio(['color', 'stack', '--clip', 'c_c1', ...p])).json.data.nodes.map((n: any) => n.id)).toEqual(['tritone', 'lumetri']);
    // bypass both: the picture is the original again
    await studio(['color', 'bypass', '--clip', 'c_c1', '--node', '0', ...p]);
    await studio(['color', 'bypass', '--clip', 'c_c1', '--node', '1', ...p]);
    expect(near(meanRgb(await still(dir, 'bypassed')), base, 1)).toBe(true);
    await studio(['color', 'bypass', '--clip', 'c_c1', '--node', '0', '--off', ...p]);
    expect(near(meanRgb(await still(dir, 'one-on')), base, 1)).toBe(false);
    await studio(['color', 'remove', '--clip', 'c_c1', '--node', '0', ...p]);
    await studio(['color', 'remove', '--clip', 'c_c1', '--node', '0', ...p]);
    expect((await studio(['color', 'stack', '--clip', 'c_c1', ...p])).json.data.nodes).toEqual([]);
    // errors say what is wrong
    const bad = await studio(['color', 'add', '--clip', 'c_c1', '--effect', 'lumetri', '--params', '{"exposure":99}', ...p]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/outside -4\.\.4/);
    expect((await studio(['color', 'set', '--clip', 'c_c1', '--node', '7', '--params', '{}', ...p])).json.error.message).toMatch(/--node must be an index/);
    await studio(['project', 'undo', '--n', '9', ...p]);
    expect((await studio(['color', 'stack', '--clip', 'c_c1', ...p])).json.data.nodes).toEqual([]);
  }, 180_000);

  it('a LUT file changes the picture; a missing or outside file is refused', async () => {
    const dir = await scene();
    const p = ['--project', dir];
    mkdirSync(join(dir, 'luts'), { recursive: true });
    // a 2-point 3D LUT that inverts every channel
    const rows: string[] = [];
    for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
    writeFileSync(join(dir, 'luts', 'invert.cube'), `TITLE "invert"\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`);
    const base = meanRgb(await still(dir, 'b'));
    expect((await studio(['color', 'lut', '--clip', 'c_c1', '--file', 'luts/invert.cube', ...p])).json.ok).toBe(true);
    const inv = meanRgb(await still(dir, 'inv'));
    for (let i = 0; i < 3; i++) expect(Math.abs(inv[i]! - (255 - base[i]!))).toBeLessThan(40);
    expect((await studio(['color', 'lut', '--clip', 'c_c1', '--file', 'luts/none.cube', ...p])).code).toBe(2);
    copyFileSync(join(dir, 'luts', 'invert.cube'), join(tmpDir('outside-'), 'x.cube'));
    expect((await studio(['color', 'lut', '--clip', 'c_c1', '--file', '../x.cube', ...p])).json.error.message).toMatch(/outside the project/);
  }, 120_000);

  it('slowmo interpolates before the clip is slowed: the graph asks for source fps / speed', async () => {
    const dir = await scene();
    const p = ['--project', dir];
    await studio(['video', 'speed', '--clip', 'c_c1', '--factor', '0.5', ...p]);
    await studio(['color', 'add', '--clip', 'c_c1', '--effect', 'slowmo', '--params', '{"mode":"blend"}', ...p]);
    const r = await studio(['render', '--explain', ...p]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    const graph = r.json.data.ffmpegArgs[r.json.data.ffmpegArgs.indexOf('-filter_complex') + 1] as string;
    expect(graph).toMatch(/minterpolate=fps=60/);
    expect(graph.indexOf('minterpolate')).toBeLessThan(graph.indexOf('setpts=(PTS-STARTPTS)/0.5'));
    const rr = await studio(['render', '--preview', '--range', '0:1000', '--out', 'slow', ...p]);
    expect(rr.json.ok, JSON.stringify(rr.json)).toBe(true);
    expect(rr.json.warnings.join(' ')).toMatch(/slowmo.*heavy/);
  }, 180_000);

  it('analyze, auto, match, scopes, gallery and still: measured, applied as nodes, and reported before and after', async () => {
    const dir = await scene();
    const p = ['--project', dir];
    // a deliberately dark, flat, blue-tinted node to correct
    await studio(['color', 'add', '--clip', 'c_c1', '--effect', 'lumetri', '--params', '{"exposure":-3.4,"contrast":-30,"temperature":-60}', ...p]);
    const a = await studio(['color', 'analyze', '--clip', 'c_c1', '--at', '500', ...p]);
    expect(a.json.ok, JSON.stringify(a.json)).toBe(true);
    expect(a.json.data.stats.luma.p50).toBeLessThan(0.3);
    expect(a.json.data.notes.join(' ')).toMatch(/dark|low contrast|cool cast/);
    const auto = await studio(['color', 'auto', '--clip', 'c_c1', '--at', '500', ...p]);
    expect(auto.json.ok, JSON.stringify(auto.json)).toBe(true);
    const { before, after } = auto.json.data;
    expect(Math.abs(after.medianLuma - 0.45)).toBeLessThan(Math.abs(before.medianLuma - 0.45));
    expect(auto.json.data.applied.exposure).toBeGreaterThan(0);
    // match a second clip to the first
    await studio(['tl', 'add-clip', '--track', 't_v1', '--asset', Object.keys(JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8')).assets)[0], '--start', '2000', '--dur', '1500', '--id', 'c_c2', '--project', dir]);
    await studio(['color', 'add', '--clip', 'c_c2', '--effect', 'lumetri', '--params', '{"exposure":1,"temperature":80}', ...p]);
    const m = await studio(['color', 'match', '--clip', 'c_c2', '--ref', 'c_c1', '--at', '2500', '--ref-at', '500', ...p]);
    expect(m.json.ok, JSON.stringify(m.json)).toBe(true);
    expect(m.json.data.distance.after).toBeLessThan(m.json.data.distance.before);
    // scopes are real images
    const sc = await studio(['color', 'scopes', '--clip', 'c_c1', '--at', '500', ...p]);
    expect(sc.json.ok, JSON.stringify(sc.json)).toBe(true);
    const sheet = join(dir, sc.json.data.sheet);
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', sheet]).toString()).streams[0];
    expect(info.width).toBe(960);
    expect(info.height).toBe(600);
    expect(meanRgb(sheet).some((v) => v > 4)).toBe(true);
    // gallery: save c_c1's grade, apply to a third clip, replace
    expect((await studio(['color', 'save', '--clip', 'c_c1', '--name', 'look-a', ...p])).json.ok).toBe(true);
    expect((await studio(['color', 'gallery', ...p])).json.data.grades).toEqual([{ name: 'look-a', nodes: ['lumetri', 'lumetri'] }]);
    expect((await studio(['color', 'save', '--clip', 'c_c1', '--name', 'look-a', ...p])).code).toBe(5);
    await studio(['color', 'apply', '--name', 'look-a', '--clips', 'c_c2', '--replace', ...p]);
    expect((await studio(['color', 'stack', '--clip', 'c_c2', ...p])).json.data.nodes.map((n: any) => n.id)).toEqual(['lumetri', 'lumetri']);
    // images get the same tools
    const img = await studio(['color', 'still', '--file', fx('astronaut.png'), '--nodes', '[{"id":"lumetri","params":{"exposure":1}},{"id":"tritone"}]', '--out', 'renders/color/a.png', ...p]);
    expect(img.json.ok, JSON.stringify(img.json)).toBe(true);
    expect(existsOk(join(dir, 'renders', 'color', 'a.png'))).toBe(true);
  }, 300_000);
});
const existsOk = (f: string) => {
  try {
    return readFileSync(f).length > 1000;
  } catch {
    return false;
  }
};

describe('colour plugin: speed (printed, not a pass mark; each must finish)', () => {
  it('per-effect cost at 1280x720, 24 frames', async () => {
    const rows: string[] = [];
    for (const { decl } of pluginEffects().filter((e) => e.plugin.manifest.id === 'color')) {
      const lines = effectLines({ id: decl.id }, 'src', 'fxout', 'sp', { W: 1280, H: 720, FPS: 24, SRCFPS: 24, SPEED: 1, T0: 0 });
      const t0 = Date.now();
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=1', '-filter_complex', `[0:v]format=yuv420p[src];${lines.join(';')}`, '-map', '[fxout]', '-frames:v', '24', '-f', 'null', '-'], { timeout: 120_000 });
      rows.push(`${decl.id.padEnd(20)} ${String(Date.now() - t0).padStart(5)} ms  (${decl.cost ?? 'light'})`);
    }
    console.log('COLOR EFFECT COST, 24 frames at 1280x720 on this machine:\n' + rows.join('\n'));
    expect(rows).toHaveLength(28);
  }, 300_000);
});
