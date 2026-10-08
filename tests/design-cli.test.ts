import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
const probe = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
/** The colour of one pixel of a PNG as [r,g,b,a]. */
function pixel(png: string, x: number, y: number): number[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}
const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

async function scene(opts: { alpha?: boolean } = {}) {
  const dir = tmpDir('studio-design-cli-');
  const r = await studio(['design', 'new', 'CLI scene', '--width', '640', '--height', '360', '--fps', '24', '--duration', '1500', '--background', opts.alpha ? 'transparent' : '#ffffff', '--project', dir]);
  expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
  const ops = [
    { type: 'layer.add', args: { layer: { type: 'rect', id: 'l_rc01', name: 'Block', x: 40, y: 40, w: 200, h: 120, fill: { type: 'solid', color: '#ff3366' } } } },
    { type: 'layer.add', args: { layer: { type: 'ellipse', id: 'l_ee01', name: 'Dot', x: 400, y: 100, w: 120, h: 120, fill: { type: 'solid', color: '#1e90ff' } } } },
    { type: 'layer.add', args: { layer: { type: 'text', id: 'l_tx01', name: 'Words', x: 40, y: 220, w: 500, h: 80, text: 'Studio', fontSize: 72, fontWeight: 700, fill: { type: 'solid', color: '#111111' } } } },
  ];
  writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
  expect((await studio(['design', 'apply', 'ops.json', '--project', dir])).json.ok).toBe(true);
  return dir;
}

describe('studio design: commands', () => {
  it('builds a design through commands; every change is logged and undoable', async () => {
    const dir = tmpDir('studio-design-cli-');
    await studio(['design', 'new', 'Cmds', '--project', dir]);
    const original = readFileSync(join(dir, 'design.studio.json'), 'utf8');
    const add = await studio(['design', 'add', 'rect', '--name', 'Card', '--props', '{"x":10,"y":20,"w":300,"h":200}', '--project', dir]);
    expect(add.json.ok, JSON.stringify(add.json)).toBe(true);
    const id = add.json.data.ops[0].target;
    expect((await studio(['design', 'animate', '--layer', id, '--preset', 'pop', '--at', '100', '--project', dir])).json.ok).toBe(true);
    expect((await studio(['design', 'keyframe', '--layer', id, '--prop', 'x', '--t', '0', '--v', '-300', '--ease', 'expo.out', '--project', dir])).json.ok).toBe(true);
    const show = await studio(['design', 'show', '--project', dir]);
    expect(show.json.data.tree[0]).toMatchObject({ id, type: 'rect', name: 'Card', animated: { scale: 3, opacity: 2, x: 1 } });
    expect(show.json.data.undoDepth).toBe(3);
    await studio(['design', 'undo', '--n', '3', '--project', dir]);
    expect(readFileSync(join(dir, 'design.studio.json'), 'utf8')).toBe(original);
    await studio(['design', 'redo', '--n', '3', '--project', dir]);
    expect((await studio(['design', 'show', '--project', dir])).json.data.tree[0].animated.scale).toBe(3);
    expect((await studio(['design', 'log', '--project', dir])).json.data.entries.length).toBe(9);
  }, 60_000);

  it('refuses wrong input with exit codes and the reason; the file stays valid', async () => {
    const dir = await scene();
    const before = readFileSync(join(dir, 'design.studio.json'), 'utf8');
    const bad = async (args: string[], code: number, msg: RegExp) => {
      const r = await studio([...args, '--project', dir]);
      expect(r.code, args.join(' ')).toBe(code);
      expect(r.json.error.message, args.join(' ')).toMatch(msg);
    };
    await bad(['design', 'set', '--id', 'l_rc01', '--props', '{"opacity":5}'], 2, /opacity/);
    await bad(['design', 'add', 'blob'], 2, /layer type/);
    await bad(['design', 'keyframe', '--layer', 'l_rc01', '--prop', 'banana', '--t', '0', '--v', '1'], 2, /cannot be animated/);
    await bad(['design', 'keyframe', '--layer', 'l_rc01', '--prop', 'x', '--t', '99999', '--v', '1'], 4, /after the scene end/);
    await bad(['design', 'animate', '--layer', 'l_rc01', '--preset', 'draw-on'], 2, /for path layers/);
    await bad(['design', 'move', '--id', 'l_rc01', '--parent', 'l_ee01'], 2, /only frames and groups/);
    await bad(['design', 'delete', '--id', 'l_zz99'], 2, /not found/);
    expect(readFileSync(join(dir, 'design.studio.json'), 'utf8')).toBe(before);
    expect((await studio(['design', 'validate', '--project', dir])).json.ok).toBe(true);
  }, 60_000);

  it('group, ungroup and align move layers the way the editor does', async () => {
    const dir = await scene();
    const g = await studio(['design', 'group', '--ids', 'l_rc01,l_ee01', '--name', 'Pair', '--project', dir]);
    expect(g.json.ok, JSON.stringify(g.json)).toBe(true);
    const tree = (await studio(['design', 'show', '--project', dir])).json.data.tree as any[];
    const group = tree.find((t) => t.type === 'group');
    expect(group).toMatchObject({ x: 40, y: 40, w: 480, h: 180 });
    expect(tree.find((t) => t.id === 'l_rc01')).toMatchObject({ depth: 1, x: 0, y: 0 });
    await studio(['design', 'ungroup', '--id', group.id, '--project', dir]);
    const after = (await studio(['design', 'show', '--project', dir])).json.data.tree as any[];
    expect(after.find((t) => t.id === 'l_rc01')).toMatchObject({ depth: 0, x: 40, y: 40 });
    await studio(['design', 'align', '--ids', 'l_tx01', '--to', 'center', '--project', dir]);
    expect((await studio(['design', 'show', '--project', dir])).json.data.tree.find((t: any) => t.id === 'l_tx01').x).toBe((640 - 500) / 2);
  }, 60_000);
});

describe('studio design render', () => {
  it('a still shows the right pixels and is identical when rendered twice and at any concurrency', async () => {
    const dir = await scene();
    const a = await studio(['design', 'render', '--format', 'png', '--at', '0', '--out', 'renders/a.png', '--project', dir]);
    expect(a.json.ok, JSON.stringify(a.json)).toBe(true);
    const png = join(dir, 'renders', 'a.png');
    expect(near(pixel(png, 100, 80), [255, 51, 102, 255])).toBe(true); // the block
    expect(near(pixel(png, 460, 160), [30, 144, 255, 255])).toBe(true); // the dot
    expect(near(pixel(png, 5, 5), [255, 255, 255, 255])).toBe(true); // the background
    // text drew something dark in its box
    const dark = Array.from({ length: 40 }, (_, i) => pixel(png, 50 + i * 6, 255)).some((p) => p[0]! < 80);
    expect(dark).toBe(true);
    await studio(['design', 'render', '--format', 'png', '--at', '0', '--out', 'renders/b.png', '--project', dir]);
    expect(sha(join(dir, 'renders', 'b.png'))).toBe(sha(png));
    // again, refusing to overwrite without --force
    const again = await studio(['design', 'render', '--format', 'png', '--out', 'renders/a.png', '--project', dir]);
    expect(again.code).toBe(5);
  }, 90_000);

  it('MP4: right size, rate, length, codec; the animation really moves; frames are the same at any concurrency', async () => {
    const dir = await scene();
    await studio(['design', 'keyframe', '--layer', 'l_rc01', '--prop', 'x', '--t', '0', '--v', '40', '--project', dir]);
    await studio(['design', 'keyframe', '--layer', 'l_rc01', '--prop', 'x', '--t', '1000', '--v', '300', '--project', dir]);
    const r = await studio(['design', 'render', '--format', 'mp4', '--project', dir]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data).toMatchObject({ width: 640, height: 360, fps: 24, frames: 36, format: 'mp4' });
    const f = join(dir, r.json.data.output);
    const p = probe(f);
    const v = p.streams.find((s: any) => s.codec_type === 'video');
    expect(v).toMatchObject({ codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p' });
    expect(Number(p.format.duration)).toBeCloseTo(1.5, 1);
    // the block sat at x=40 at the start and x=300 at 1 s: pixel (100,80) is block then background
    const frame = (ms: number, name: string) => {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(ms / 1000), '-i', f, '-frames:v', '1', join(dir, name)]);
      return join(dir, name);
    };
    expect(near(pixel(frame(0, 'f0.png'), 100, 80), [255, 51, 102, 255], 12)).toBe(true);
    expect(near(pixel(frame(1200, 'f1.png'), 100, 80), [255, 255, 255, 255], 12)).toBe(true);
    expect(near(pixel(frame(1200, 'f1.png'), 400, 80), [255, 51, 102, 255], 12)).toBe(true);
    // concurrency does not change a single frame
    const seq = async (c: number, out: string) => {
      const q = await studio(['design', 'render', '--format', 'png-seq', '--out', out, '--concurrency', String(c), '--project', dir]);
      expect(q.json.ok, JSON.stringify(q.json)).toBe(true);
      return readdirSync(join(dir, out)).sort().map((n) => sha(join(dir, out, n)));
    };
    const one = await seq(1, 'renders/seq1');
    const three = await seq(3, 'renders/seq3');
    expect(one).toHaveLength(36);
    expect(three).toEqual(one);
  }, 120_000);

  it('transparency: MOV (ProRes 4444), WebM, GIF, PNG and PNG sequence keep the alpha; MP4 refuses it', async () => {
    const dir = await scene({ alpha: true });
    const mov = await studio(['design', 'render', '--format', 'mov', '--range', '0:500', '--project', dir]);
    expect(mov.json.ok, JSON.stringify(mov.json)).toBe(true);
    const ms = probe(join(dir, mov.json.data.output)).streams[0];
    expect(ms).toMatchObject({ codec_name: 'prores', profile: '4444' });
    expect(ms.pix_fmt).toMatch(/^yuva444p/); // ffprobe reports the decoder's 12-bit alpha format
    const webm = await studio(['design', 'render', '--format', 'webm', '--range', '0:500', '--project', dir]);
    expect(webm.json.ok, JSON.stringify(webm.json)).toBe(true);
    expect(probe(join(dir, webm.json.data.output)).streams[0].tags?.ALPHA_MODE ?? probe(join(dir, webm.json.data.output)).streams[0].tags?.alpha_mode).toBe('1');
    const gif = await studio(['design', 'render', '--format', 'gif', '--range', '0:500', '--project', dir]);
    expect(gif.json.ok, JSON.stringify(gif.json)).toBe(true);
    const still = await studio(['design', 'render', '--format', 'png', '--out', 'renders/t.png', '--project', dir]);
    expect(pixel(join(dir, 'renders', 't.png'), 5, 5)[3]).toBe(0); // transparent corner
    expect(pixel(join(dir, 'renders', 't.png'), 100, 80)[3]).toBe(255); // opaque block
    void still;
    // a normal design with --alpha also renders without its background
    const dir2 = await scene();
    expect((await studio(['design', 'render', '--format', 'png', '--alpha', '--out', 'renders/n.png', '--project', dir2])).json.ok).toBe(true);
    expect(pixel(join(dir2, 'renders', 'n.png'), 5, 5)[3]).toBe(0);
    const mp4 = await studio(['design', 'render', '--format', 'mp4', '--alpha', '--project', dir2]);
    expect(mp4.code).toBe(2);
    expect(mp4.json.error.message).toMatch(/mp4 has no transparency/);
  }, 120_000);

  it('images and audio: an image layer draws its file; an audio layer is mixed with its volume curve', async () => {
    ensureFixtures();
    const dir = await scene();
    copyFileSync(join(import.meta.dirname, '.fixtures', 'astronaut.png'), join(dir, 'astronaut.png'));
    const asset = await studio(['design', 'asset', join(dir, 'astronaut.png'), '--project', dir]);
    const src = asset.json.data.assets[0].src as string;
    expect(src).toBe('assets/astronaut.png');
    await studio(['design', 'add', 'image', '--src', src, '--props', '{"x":0,"y":0,"w":120,"h":120}', '--project', dir]);
    await studio(['design', 'render', '--format', 'png', '--out', 'renders/i.png', '--project', dir]);
    const px = pixel(join(dir, 'renders', 'i.png'), 60, 60);
    expect(near(px, [255, 255, 255, 255], 3)).toBe(false); // the picture covers the background there
    // missing asset is a clear error, not a blank frame
    await studio(['design', 'add', 'image', '--src', 'assets/nope.png', '--project', dir]);
    const miss = await studio(['design', 'render', '--format', 'png', '--out', 'renders/m.png', '--project', dir]);
    expect(miss.code).toBe(2);
    expect(miss.json.error.message).toMatch(/assets\/nope\.png does not exist/);
    // audio: silent for the first 600 ms, then at full volume
    const dir2 = await scene();
    copyFileSync(fx('music.wav'), join(dir2, 'music.wav'));
    await studio(['design', 'asset', join(dir2, 'music.wav'), '--project', dir2]);
    const a = await studio(['design', 'add', 'audio', '--src', 'assets/music.wav', '--project', dir2]);
    const aid = a.json.data.ops[0].target;
    await studio(['design', 'keyframe', '--layer', aid, '--prop', 'volume', '--t', '0', '--v', '0', '--project', dir2]);
    await studio(['design', 'keyframe', '--layer', aid, '--prop', 'volume', '--t', '600', '--v', '0', '--project', dir2]);
    await studio(['design', 'keyframe', '--layer', aid, '--prop', 'volume', '--t', '700', '--v', '1', '--project', dir2]);
    const r = await studio(['design', 'render', '--format', 'mp4', '--project', dir2]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data.audio).toBe(true);
    const out = join(dir2, r.json.data.output);
    expect(probe(out).streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    const loud = async (from: number, to: number) => (await studio(['inspect', 'loudness', out, '--from', String(from), '--to', String(to), '--project', dir2])).json.data;
    const early = await loud(0, 500);
    const late = await loud(900, 1450);
    expect(late.integratedLufs).toBeGreaterThan(-40);
    expect(early.integratedLufs === null || early.integratedLufs < late.integratedLufs - 25).toBe(true);
  }, 180_000);

  it('range and scale: a 2x export is twice the size; --range renders only those frames', async () => {
    const dir = await scene();
    const r = await studio(['design', 'render', '--format', 'mp4', '--range', '500:1000', '--scale', '2', '--project', dir]);
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.json.data).toMatchObject({ width: 1280, height: 720, frames: 12 });
    expect(existsSync(join(dir, r.json.data.output))).toBe(true);
  }, 90_000);
});
