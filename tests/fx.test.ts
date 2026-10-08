import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
const run = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 27 }, (err, stdout) => {
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
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

let dir: string;
let clip: string;
let source: string;
const projFile = () => join(dir, 'project.studio.json');
const project = () => JSON.parse(readFileSync(projFile(), 'utf8'));
const f = ['--project'];

/** A project with one 2 s clip of generated video (moving test pattern). */
async function fresh() {
  const d = tmpDir('studio-fx-');
  const input = join(tmpDir('studio-fx-in-'), 'v.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  ok(await run(['init', 'fx', '--width', '320', '--height', '180', '--fps', '30', '--project', d]));
  ok(await run(['ingest', input, '--no-derive', '--project', d]));
  const asset = Object.keys(JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).assets)[0]!;
  const t = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', d])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t, '--asset', asset, '--start', '0', '--dur', '2000', '--project', d]));
  return { d, clip: JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).clips[0].id as string, src: join(d, JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).assets[asset].path) };
}
const stillSha = async (name: string) => {
  const r = ok(await run(['render', '--still', '500', '--out', name, '--width', '320', '--no-normalize', '--force', ...f, dir]));
  return sha(join(dir, r.output));
};
const lumaOf = (png: string) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' })[0]!;

beforeAll(async () => {
  const x = await fresh();
  dir = x.d;
  clip = x.clip;
  source = x.src;
}, 120_000);

describe('effects sit on top of the original', () => {
  it('adds, changes, switches off, reorders and removes effects by name, and the source file is never written', async () => {
    const before = sha(source);
    const recorded = project().assets[Object.keys(project().assets)[0]!].hash as string;
    const base = readFileSync(projFile(), 'utf8');

    const a = ok(await run(['fx', 'add', '--clip', clip, '--effect', 'lumetri', '--params', '{"exposure":0.8}', ...f, dir]));
    expect(a.node).toMatch(/^f_[0-9a-hjkmnp-tv-z]{4,}$/);
    const b = ok(await run(['fx', 'add', '--clip', clip, '--region', '0.1,0.1,0.3,0.3', '--strength', '20', ...f, dir]));
    const c = ok(await run(['fx', 'add', '--clip', clip, '--effect', 'vignette', ...f, dir]));
    const nodes = [a.node, b.node, c.node];
    expect(new Set(nodes).size).toBe(3);

    const list = ok(await run(['fx', 'list', '--clip', clip, '--verify', ...f, dir]));
    expect(list.stack.map((s: any) => [s.node, s.type, s.what])).toEqual([
      [a.node, 'plugin', 'lumetri'],
      [b.node, 'blur-region', 'blur 10,10 30x30%'],
      [c.node, 'plugin', 'vignette'],
    ]);
    expect(list.stack[0].params.exposure).toBe(0.8);
    expect(list.source.untouched).toBe(true);

    ok(await run(['fx', 'set', '--clip', clip, '--node', a.node, '--params', '{"exposure":0.2}', ...f, dir]));
    expect(project().clips[0].fx[0].params.exposure).toBe(0.2);
    ok(await run(['fx', 'set', '--clip', clip, '--node', b.node, '--region', '0.5,0.5,0.2,0.2', '--strength', '30', ...f, dir]));
    expect(project().clips[0].fx[1]).toMatchObject({ x: 0.5, y: 0.5, w: 0.2, h: 0.2, strength: 30 });
    ok(await run(['fx', 'bypass', '--clip', clip, '--node', c.node, ...f, dir]));
    expect(project().clips[0].fx[2].bypass).toBe(true);
    ok(await run(['fx', 'bypass', '--clip', clip, '--node', c.node, '--off', ...f, dir]));
    expect(project().clips[0].fx[2].bypass).toBeUndefined();
    ok(await run(['fx', 'move', '--clip', clip, '--node', c.node, '--to', '0', ...f, dir]));
    expect(project().clips[0].fx.map((x: any) => x.node)).toEqual([c.node, a.node, b.node]);

    ok(await run(['fx', 'remove', '--clip', clip, '--node', a.node, ...f, dir]));
    ok(await run(['fx', 'remove', '--clip', clip, '--all', ...f, dir]));
    expect(project().clips[0].fx).toBeUndefined(); // nothing left: not even an empty list
    expect(readFileSync(projFile(), 'utf8')).toBe(base); // the project is exactly what it was before the first effect

    expect(sha(source)).toBe(before);
    expect(before).toBe(recorded.replace('sha256:', ''));
    expect(ok(await run(['fx', 'verify', ...f, dir])).allUntouched).toBe(true);
  }, 180_000);

  it('every step is one undo, and the picture with an effect removed is the original picture', async () => {
    const plain = await stillSha('fx-plain');
    const base = readFileSync(projFile(), 'utf8');
    const a = ok(await run(['fx', 'add', '--clip', clip, '--effect', 'lumetri', '--params', '{"exposure":1.2}', ...f, dir]));
    const withFx = await stillSha('fx-with');
    expect(withFx).not.toBe(plain);
    const lum = (n: string) => lumaOf(join(dir, 'renders', `${n}.png`));
    expect(lum('fx-with')).toBeGreaterThan(lum('fx-plain') + 10); // brighter with the effect

    ok(await run(['fx', 'remove', '--clip', clip, '--node', a.node, ...f, dir]));
    expect(await stillSha('fx-removed')).toBe(plain); // byte for byte the picture without it
    ok(await run(['project', 'undo', ...f, dir])); // undo the removal: the effect is back
    expect(await stillSha('fx-undone')).toBe(withFx);
    ok(await run(['project', 'undo', ...f, dir])); // undo the add: the project is as it began
    expect(readFileSync(projFile(), 'utf8')).toBe(base);
  }, 180_000);

  it('an effect that gets keyframes loses them with it in one step, and undo brings both back', async () => {
    const a = ok(await run(['fx', 'add', '--clip', clip, '--effect', 'lumetri', ...f, dir]));
    const k1 = await run(['fx', 'key', '--clip', clip, '--node', a.node, '--param', 'exposure', '--t', '0', '--v', '0', ...f, dir]);
    expect(k1.json.ok, JSON.stringify(k1.json)).toBe(true);
    ok(await run(['fx', 'key', '--clip', clip, '--node', a.node, '--param', 'exposure', '--t', '1000', '--v', '1.5', '--ease', 'sine.inOut', ...f, dir]));
    expect(Object.keys(project().clips[0].keyframes)).toEqual([`fx.${a.node}.exposure`]);
    const withKeys = readFileSync(projFile(), 'utf8');
    ok(await run(['fx', 'remove', '--clip', clip, '--node', a.node, ...f, dir]));
    expect(project().clips[0].keyframes).toBeUndefined();
    ok(await run(['project', 'undo', ...f, dir]));
    expect(readFileSync(projFile(), 'utf8')).toBe(withKeys);
    ok(await run(['fx', 'remove', '--clip', clip, '--all', ...f, dir]));
  }, 180_000);

  it('effects added by `color add` and `plugins apply` are named too, and effects from before ids existed are named when edited', async () => {
    const c1 = ok(await run(['color', 'add', '--clip', clip, '--effect', 'vignette', ...f, dir]));
    expect(project().clips[0].fx[0].node).toMatch(/^f_/);
    ok(await run(['plugins', 'apply', '--clip', clip, '--effect', 'grain', ...f, dir]));
    expect(project().clips[0].fx[1].node).toMatch(/^f_/);
    void c1;
    // an effect written by hand without an id (as older projects have)
    ok(await run(['tl', 'set', '--id', clip, '--patch', JSON.stringify({ fx: [{ type: 'plugin', id: 'glow' }] }), ...f, dir]));
    const listed = ok(await run(['fx', 'list', '--clip', clip, ...f, dir]));
    expect(listed.stack[0].node).toBeNull();
    ok(await run(['fx', 'set', '--clip', clip, '--node', '0', '--params', '{"amount":0.4}', ...f, dir]));
    expect(project().clips[0].fx[0].node).toMatch(/^f_/); // named by the edit
    expect(project().clips[0].fx[0].params.amount).toBe(0.4);
    ok(await run(['fx', 'remove', '--clip', clip, '--all', ...f, dir]));
  }, 120_000);

  it('refuses what cannot work, naming the way out', async () => {
    const a = ok(await run(['fx', 'add', '--clip', clip, '--effect', 'lumetri', ...f, dir]));
    const bad = (args: string[]) => run([...args, ...f, dir]);
    expect((await bad(['fx', 'set', '--clip', clip, '--node', 'f_zzzz'])).json.error.code).toBe('NOT_FOUND');
    expect((await bad(['fx', 'add', '--clip', clip, '--effect', 'lumetri', '--lut', 'x.cube'])).json.error.code).toBe('INVALID_ARGS');
    expect((await bad(['fx', 'add', '--clip', clip, '--effect', 'no-such-effect'])).json.ok).toBe(false);
    expect((await bad(['fx', 'set', '--clip', clip, '--node', a.node, '--params', '{"exposure":99}'])).json.ok).toBe(false); // outside its range
    const kf = await bad(['fx', 'key', '--clip', clip, '--node', a.node, '--param', 'nope', '--t', '0', '--v', '1']);
    expect(kf.json.error.code).toBe('INVALID_INPUT');
    expect(kf.json.error.message).toMatch(/has: .*exposure/);
    const range = await bad(['fx', 'key', '--clip', clip, '--node', a.node, '--param', 'exposure', '--t', '0', '--v', '99']);
    expect(range.json.error.message).toMatch(/outside/);
    expect(project().clips[0].keyframes).toBeUndefined(); // the refused ones wrote nothing
    ok(await run(['fx', 'remove', '--clip', clip, '--all', ...f, dir]));
  }, 120_000);
});

describe('the originals', () => {
  it('assets/ holds exactly what was ingested after all of the above', () => {
    const files = readdirSync(join(dir, 'assets'));
    expect(files).toHaveLength(1);
    expect(existsSync(source)).toBe(true);
  });
});
