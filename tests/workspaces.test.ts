import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@studio/core';
import { argvFor, listTools } from '../packages/cli/src/cmds/mcp.js';
import { COMMANDS } from '../packages/cli/src/registry.js';
import { DesignStore } from '../packages/design/src/store.js';
import { acquireLease, endLease, readLease, SLOT_LIMIT } from '../packages/workspace/src/index.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
interface Out {
  code: number;
  json: any;
}
const run = (args: string[], env: Record<string, string> = {}): Promise<Out> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 1 << 28, env: { ...process.env, ...env } }, (err, stdout) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      resolve({ code: err ? ((err as any).code as number) : 0, json });
    }),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (r: Out) => {
  expect(r.json?.ok, JSON.stringify(r.json)).toBe(true);
  return r.json.data;
};

async function open(root: string, kind: 'media' | 'design', extra: string[] = []) {
  return ok(await run(['ws', 'open', '--kind', kind, '--root', root, ...extra])).workspaces as { slot: string; name: string; dir: string }[];
}
let n = 0;
const addTrack = (dir: string, extra: string[] = []) => run(['tl', 'add-track', '--type', 'video', '--name', `T${++n}`, '--project', dir, ...extra]);
const lease = async (dir: string) => ok(await run(['work', 'status', '--project', dir])).lease;

/** Reads slot files in the jobs folder while commands run, and reports the most that were ever held at once. */
function watchSlots(dir: string) {
  let peak = 0;
  const t = setInterval(() => {
    try {
      peak = Math.max(peak, readdirSync(dir).filter((f) => f.startsWith('slot-')).length);
    } catch {
      /* folder not there yet */
    }
  }, 8);
  return () => (clearInterval(t), peak);
}
const mkVideo = (file: string, seconds: number, color: string) =>
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
const duration = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
/** One pixel of an image or the first frame of a video, as [r,g,b]. */
const pixel = (file: string, x: number, y: number): number[] => {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return [out[0]!, out[1]!, out[2]!];
};
const near = (a: number[], b: number[], tol = 14) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('workspaces: five per editor, no more', () => {
  it('opens media and design slots independently, names what is in use when a sixth is asked for, and exits 5', async () => {
    const root = tmpDir('studio-ws-');
    const media = await open(root, 'media', ['--count', '5', '--name', 'Cut']);
    expect(media.map((w) => w.slot)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(media.map((w) => w.name)).toEqual(['Cut 1', 'Cut 2', 'Cut 3', 'Cut 4', 'Cut 5']);
    for (const w of media) expect(existsSync(join(w.dir, 'project.studio.json'))).toBe(true);

    const sixth = await run(['ws', 'open', '--kind', 'media', '--root', root]);
    expect(sixth.code).toBe(5);
    expect(sixth.json.error.code).toBe('WORKSPACE_LIMIT');
    expect(sixth.json.error.message).toMatch(/5 of 5 media workspaces are in use/);
    expect(sixth.json.error.message).toMatch(/m3 "Cut 3"/);
    expect(sixth.json.error.fix).toMatch(/ws close/);

    // design has its own five
    const design = await open(root, 'design', ['--count', '5', '--name', 'Card', '--width', '320', '--height', '180']);
    expect(design.map((w) => w.slot)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    for (const w of design) expect(existsSync(join(w.dir, 'design.studio.json'))).toBe(true);
    expect((await run(['ws', 'open', '--kind', 'design', '--root', root])).json.error.code).toBe('WORKSPACE_LIMIT');

    const list = ok(await run(['ws', 'list', '--root', root]));
    expect(list.limit).toBe(SLOT_LIMIT);
    expect(list.media).toEqual({ used: 5, free: 0 });
    expect(list.design).toEqual({ used: 5, free: 0 });
    expect(list.workspaces).toHaveLength(10);
  }, 120_000);

  it('is race-free: eight processes asking at the same moment are granted exactly five slots', async () => {
    const root = tmpDir('studio-ws-race-');
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => run(['ws', 'open', '--kind', 'media', '--name', `R${i}`, '--root', root])));
    const granted = rs.filter((r) => r.code === 0);
    const refused = rs.filter((r) => r.code !== 0);
    expect(granted).toHaveLength(5);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.json.error.code).toBe('WORKSPACE_LIMIT');
    const slots = granted.map((r) => r.json.data.workspaces[0].slot).sort();
    expect(slots).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']); // five different slots, none twice
    const l = ok(await run(['ws', 'list', '--root', root]));
    expect(l.workspaces.map((w: any) => w.state)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']); // none left half-made
  }, 120_000);

  it('a batch is all or nothing, an abandoned claim is reused, and a half-made slot with files is never taken over', async () => {
    const root = tmpDir('studio-ws-batch-');
    await open(root, 'media', ['--count', '3']);
    const tooMany = await run(['ws', 'open', '--kind', 'media', '--count', '3', '--root', root]);
    expect(tooMany.json.error.code).toBe('WORKSPACE_LIMIT');
    expect(readdirSync(join(root, 'workspaces')).sort()).toEqual(['m1', 'm2', 'm3']); // nothing leaked from the failed batch
    expect((await open(root, 'media', ['--count', '2'])).map((w) => w.slot)).toEqual(['m4', 'm5']);

    const r2 = tmpDir('studio-ws-ab-');
    mkdirSync(join(r2, 'workspaces', 'm1'), { recursive: true }); // a claim whose process died: empty, old
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(r2, 'workspaces', 'm1'), old, old);
    mkdirSync(join(r2, 'workspaces', 'm2'), { recursive: true }); // someone's folder with files in it
    writeFileSync(join(r2, 'workspaces', 'm2', 'keep.txt'), 'mine');
    utimesSync(join(r2, 'workspaces', 'm2'), old, old);
    const got = await open(r2, 'media', ['--count', '1']);
    expect(got[0]!.slot).toBe('m1');
    const next = await open(r2, 'media', ['--count', '1']);
    expect(next[0]!.slot).toBe('m3'); // m2 is occupied, whatever it is
    expect(readFileSync(join(r2, 'workspaces', 'm2', 'keep.txt'), 'utf8')).toBe('mine');
  }, 120_000);

  it('close moves the folder aside (nothing deleted), frees the slot, and refuses while an agent holds it', async () => {
    const root = tmpDir('studio-ws-close-');
    const [w1, w2] = await open(root, 'media', ['--count', '2']);
    expect((await addTrack(w1!.dir)).json.ok).toBe(true);
    ok(await run(['work', 'begin', '--agent', 'a1', '--project', w1!.dir]));
    const busy = await run(['ws', 'close', 'm1', '--root', root]);
    expect(busy.code).toBe(5);
    expect(busy.json.error.code).toBe('WORKSPACE_BUSY');
    expect(existsSync(w1!.dir)).toBe(true);
    ok(await run(['work', 'end', '--agent', 'a1', '--project', w1!.dir]));

    const closed = ok(await run(['ws', 'close', 'm1', '--root', root]));
    expect(existsSync(w1!.dir)).toBe(false);
    expect(closed.archivedTo).toContain(join('workspaces', '.closed', 'm1-'));
    const kept = JSON.parse(readFileSync(join(closed.archivedTo, 'project.studio.json'), 'utf8'));
    expect(kept.tracks).toHaveLength(1); // the work is all there
    expect(existsSync(w2!.dir)).toBe(true); // the other one is untouched

    expect((await open(root, 'media'))[0]!.slot).toBe('m1'); // the lowest free slot comes back
    expect((await run(['ws', 'close', 'm9', '--root', root])).json.error.code).toBe('INVALID_ARGS');
    expect((await run(['ws', 'close', 'm4', '--root', root])).json.error.code).toBe('NOT_FOUND');
  }, 120_000);

  it('`ws list` works from inside a workspace folder, so a subagent can see its siblings', async () => {
    const root = tmpDir('studio-ws-inside-');
    const ws = await open(root, 'media', ['--count', '2']);
    const inside = ok(await run(['ws', 'list', '--project', ws[1]!.dir]));
    expect(inside.workspaces.map((w: any) => w.slot)).toEqual(['m1', 'm2']);
  }, 60_000);
});

describe('agent leases: one agent per workspace, and the person waits', () => {
  it('begin, status, end; another agent is refused; the owner and unnamed writes pass; every write renews', async () => {
    const root = tmpDir('studio-ws-lease-');
    const [w] = await open(root, 'media');
    const dir = w!.dir;
    expect(await lease(dir)).toBeNull();

    const begun = ok(await run(['work', 'begin', '--agent', 'cut-agent', '--note', 'trimming the intro', '--ttl', '30', '--project', dir]));
    expect(begun.editorLocked).toBe(true);
    expect(begun.lease).toMatchObject({ agent: 'cut-agent', note: 'trimming the intro', ttlS: 30 });

    const other = await addTrack(dir, ['--agent', 'other-agent']);
    expect(other.code).toBe(5);
    expect(other.json.error.code).toBe('WORKSPACE_BUSY');
    expect(other.json.error.message).toMatch(/cut-agent holds this workspace/);
    const beginOther = await run(['work', 'begin', '--agent', 'other-agent', '--project', dir]);
    expect(beginOther.json.error.code).toBe('WORKSPACE_BUSY');
    expect(new ProjectStore(dir).load().project.tracks).toHaveLength(0); // the refused write wrote nothing

    const before = (await lease(dir)).expires;
    await sleep(1100);
    expect((await addTrack(dir, ['--agent', 'cut-agent'])).json.ok).toBe(true);
    expect((await addTrack(dir)).json.ok).toBe(true); // an unnamed write while leased is allowed...
    const after = await lease(dir);
    expect(after.expires).toBeGreaterThan(before + 800); // ...and both renewed it
    expect(after.agent).toBe('cut-agent');

    const wrongEnd = await run(['work', 'end', '--agent', 'other-agent', '--project', dir]);
    expect(wrongEnd.json.error.code).toBe('WORKSPACE_BUSY');
    expect(ok(await run(['work', 'end', '--agent', 'cut-agent', '--project', dir]))).toMatchObject({ released: true, editorLocked: false });
    expect(await lease(dir)).toBeNull();
    expect(ok(await run(['work', 'end', '--agent', 'cut-agent', '--project', dir])).released).toBe(false); // ending twice is harmless
  }, 120_000);

  it('a write that names an agent takes the workspace by itself; the lease runs out when the agent goes quiet', async () => {
    const root = tmpDir('studio-ws-auto-');
    const [w] = await open(root, 'media');
    const r = await addTrack(w!.dir, ['--agent', 'quick-agent']);
    expect(r.json.ok).toBe(true);
    expect(await lease(w!.dir)).toMatchObject({ agent: 'quick-agent', ttlS: 120 });
    ok(await run(['work', 'end', '--agent', 'quick-agent', '--project', w!.dir]));

    ok(await run(['work', 'begin', '--agent', 'brief-agent', '--ttl', '1', '--project', w!.dir]));
    expect(await lease(w!.dir)).not.toBeNull();
    await sleep(1400);
    expect(await lease(w!.dir)).toBeNull(); // nobody has to clean up after a crashed agent
    expect((await run(['work', 'begin', '--agent', 'next-agent', '--project', w!.dir])).json.ok).toBe(true);
    expect((await run(['work', 'begin', '--agent', 'bad name!', '--project', w!.dir])).json.error.code).toBe('INVALID_ARGS');
  }, 60_000);

  it('the stores refuse a person (actor ui) while an agent holds the workspace, media and design, and never refuse the agent', async () => {
    const root = tmpDir('studio-ws-store-');
    const [m] = await open(root, 'media');
    const [d] = await open(root, 'design');
    const ms = new ProjectStore(m!.dir);
    const ds = new DesignStore(d!.dir);
    const mediaOp = { type: 'track.add', args: { type: 'video', name: 'UI track' } } as any;
    const designOp = { type: 'layer.add', args: { layer: { type: 'rect', id: 'l_aa01', x: 0, y: 0, w: 10, h: 10 } } } as any;
    ms.apply([mediaOp], { actor: 'ui' }); // free: a person edits
    ds.apply([designOp], { actor: 'ui' });

    acquireLease(m!.dir, 'agent-m');
    acquireLease(d!.dir, 'agent-d');
    const mBefore = readFileSync(ms.projectPath, 'utf8');
    const dBefore = readFileSync(ds.file, 'utf8');
    for (const f of [() => ms.apply([mediaOp], { actor: 'ui' }), () => ms.undo({ actor: 'ui' }), () => ms.redo({ actor: 'ui' })])
      expect(f).toThrowError(/agent-m is working here/);
    for (const f of [() => ds.apply([{ type: 'layer.delete', args: { id: 'l_aa01' } } as any], { actor: 'ui' }), () => ds.undo({ actor: 'ui' }), () => ds.redo({ actor: 'ui' })])
      expect(f).toThrowError(/agent-d is working here/);
    expect(readFileSync(ms.projectPath, 'utf8')).toBe(mBefore);
    expect(readFileSync(ds.file, 'utf8')).toBe(dBefore); // the refusals wrote nothing

    ms.apply([mediaOp], { actor: 'agent' }); // the agent is never blocked
    ds.apply([{ type: 'layer.delete', args: { id: 'l_aa01' } } as any], { actor: 'agent' });
    expect(endLease(m!.dir, 'agent-m')).toBe(true);
    expect(endLease(d!.dir, 'agent-d')).toBe(true);
    expect(readLease(m!.dir)).toBeNull();
    ms.apply([mediaOp], { actor: 'ui' }); // and the person is back in
    ds.undo({ actor: 'ui' });
  }, 60_000);
});

describe('parallel work: five at once, without overloading the machine', () => {
  it('five agents edit five videos at the same time; each workspace keeps its own result and at most 2 heavy commands run together', async () => {
    const root = tmpDir('studio-ws-par-');
    const jobs = tmpDir('studio-jobs-');
    const env = { STUDIO_MAX_JOBS: '2', STUDIO_JOBS_DIR: jobs };
    const ws = await open(root, 'media', ['--count', '5', '--name', 'Edit', '--width', '640', '--height', '360']);
    const input = tmpDir('studio-ws-in-');
    const plan = [
      { s: 2, c: '#c62828' }, { s: 3, c: '#1565c0' }, { s: 4, c: '#2e7d32' }, { s: 5, c: '#f9a825' }, { s: 6, c: '#6a1b9a' },
    ];
    plan.forEach((p, i) => mkVideo(join(input, `v${i}.mp4`), p.s, p.c));

    const stop = watchSlots(jobs);
    const t0 = Date.now();
    const outs = await Promise.all(
      ws.map(async (w, i) => {
        const f = ['--project', w.dir, '--agent', `${w.slot}-agent`];
        ok(await run(['work', 'begin', '--agent', `${w.slot}-agent`, '--note', `edit ${i + 1}`, '--project', w.dir], env));
        ok(await run(['ingest', join(input, `v${i}.mp4`), '--no-derive', ...f], env));
        const proj = JSON.parse(readFileSync(join(w.dir, 'project.studio.json'), 'utf8'));
        const asset = Object.keys(proj.assets)[0]!;
        const track = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', ...f], env)).ops[0].target;
        ok(await run(['tl', 'add-clip', '--track', track, '--asset', asset, '--start', '0', '--dur', String(plan[i]!.s * 1000), ...f], env));
        const r = ok(await run(['render', '--width', '640', '--no-normalize', '--out', `final-${i}`, ...f], env));
        ok(await run(['work', 'end', '--agent', `${w.slot}-agent`, '--project', w.dir], env));
        return join(w.dir, r.output as string);
      }),
    );
    const wall = Date.now() - t0;
    const peak = stop();
    console.log(`PARALLEL media: 5 workspaces, ingest + edit + render each, ${wall} ms wall; most heavy commands at once: ${peak} (limit 2)`);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2); // and the limit was actually used: they did overlap
    outs.forEach((file, i) => {
      expect(Math.abs(duration(file) - plan[i]!.s)).toBeLessThan(0.2); // its own length, not a neighbour's
      expect(near(pixel(file, 320, 180), hex(plan[i]!.c))).toBe(true); // its own picture
    });
    const l = ok(await run(['ws', 'list', '--root', root]));
    expect(l.workspaces.map((w: any) => [w.state, w.items, w.assets])).toEqual(Array(5).fill(['idle', 1, 1]));
    expect(readdirSync(jobs).filter((f) => f.startsWith('slot-'))).toEqual([]); // every slot was handed back
  }, 600_000);

  it('five designs export at the same time: each keeps its own pixels', async () => {
    const root = tmpDir('studio-ws-dpar-');
    const jobs = tmpDir('studio-jobs-');
    const env = { STUDIO_MAX_JOBS: '2', STUDIO_JOBS_DIR: jobs };
    const colours = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#6a1b9a'];
    const ws = [];
    for (const c of colours) ws.push((await open(root, 'design', ['--width', '320', '--height', '180', '--background', c, '--name', c]))[0]!);
    const stop = watchSlots(jobs);
    const t0 = Date.now();
    const outs = await Promise.all(
      ws.map(async (w, i) => {
        const f = ['--project', w.dir, '--agent', `${w.slot}-agent`];
        ok(await run(['design', 'add', 'rect', '--props', JSON.stringify({ x: 100, y: 60, w: 120, h: 60, fill: { type: 'solid', color: '#ffffff' } }), ...f], env));
        ok(await run(['design', 'still', '--at', '0', '--out', `renders/s${i}.png`, ...f], env));
        ok(await run(['work', 'end', '--agent', `${w.slot}-agent`, '--project', w.dir], env));
        return join(w.dir, 'renders', `s${i}.png`);
      }),
    );
    const wall = Date.now() - t0;
    const peak = stop();
    console.log(`PARALLEL design: 5 workspaces, add + export each, ${wall} ms wall; most heavy commands at once: ${peak} (limit 2)`);
    expect(peak).toBeLessThanOrEqual(2);
    outs.forEach((file, i) => {
      expect(near(pixel(file, 5, 5), hex(colours[i]!), 8)).toBe(true); // its own background
      expect(near(pixel(file, 160, 90), [255, 255, 255], 8)).toBe(true); // its own rectangle
    });
  }, 600_000);
});

describe('the job governor: control', () => {
  it('without a limit the same five exports all run at once, so the limit of 2 above is what held them back', async () => {
    const root = tmpDir('studio-ws-ctl-');
    const jobs = tmpDir('studio-jobs-');
    const env = { STUDIO_MAX_JOBS: '64', STUDIO_JOBS_DIR: jobs };
    const ws = await open(root, 'design', ['--count', '5', '--width', '320', '--height', '180']);
    const stop = watchSlots(jobs);
    const t0 = Date.now();
    const rs = await Promise.all(ws.map((w, i) => run(['design', 'still', '--at', '0', '--out', `renders/c${i}.png`, '--project', w.dir], env)));
    const wall = Date.now() - t0;
    const peak = stop();
    console.log(`CONTROL design: 5 exports, no limit, ${wall} ms wall; most heavy commands at once: ${peak}`);
    for (const r of rs) expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(peak).toBeGreaterThanOrEqual(3);
  }, 300_000);
});

describe('the job governor', () => {
  const designWith = async () => {
    const root = tmpDir('studio-ws-gov-');
    const [w] = await open(root, 'design', ['--width', '160', '--height', '90', '--background', '#336699']);
    return w!.dir;
  };

  it('waits while a live process holds the only slot, and goes on as soon as it is released', async () => {
    const dir = await designWith();
    const jobs = tmpDir('studio-jobs-');
    const slot = join(jobs, 'slot-0');
    writeFileSync(slot, JSON.stringify({ pid: process.pid, label: 'held by the test', t: Date.now() }));
    const child = spawn('node', [BIN, 'design', 'still', '--at', '0', '--out', 'renders/g.png', '--project', dir], { env: { ...process.env, STUDIO_MAX_JOBS: '1', STUDIO_JOBS_DIR: jobs }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const done = new Promise<number | null>((r) => child.on('close', r));
    await sleep(2500);
    expect(child.exitCode).toBeNull(); // still waiting: Chromium was not started
    expect(existsSync(join(dir, 'renders', 'g.png'))).toBe(false);
    rmSync(slot);
    expect(await done).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
    expect(existsSync(join(dir, 'renders', 'g.png'))).toBe(true);
    expect(readdirSync(jobs)).toEqual([]);
  }, 120_000);

  it('takes over a slot whose holder is gone (a killed render must not block the machine for ever)', async () => {
    const dir = await designWith();
    const jobs = tmpDir('studio-jobs-');
    const dead = spawn('node', ['-e', '0']);
    await new Promise((r) => dead.on('close', r));
    writeFileSync(join(jobs, 'slot-0'), JSON.stringify({ pid: dead.pid, label: 'killed', t: Date.now() }));
    const r = await run(['design', 'still', '--at', '0', '--out', 'renders/g.png', '--project', dir], { STUDIO_MAX_JOBS: '1', STUDIO_JOBS_DIR: jobs });
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(readdirSync(jobs)).toEqual([]);
  }, 120_000);

  it('a heavy command that runs another heavy command does not wait for itself, even with a single slot', async () => {
    const root = tmpDir('studio-ws-nest-');
    const [w] = await open(root, 'media', ['--width', '640', '--height', '360']);
    const input = tmpDir('studio-ws-in-');
    mkVideo(join(input, 'v.mp4'), 2, '#2e7d32');
    const f = ['--project', w!.dir];
    ok(await run(['ingest', join(input, 'v.mp4'), '--no-derive', ...f]));
    const asset = Object.keys(JSON.parse(readFileSync(join(w!.dir, 'project.studio.json'), 'utf8')).assets)[0]!;
    const track = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', ...f])).ops[0].target;
    ok(await run(['tl', 'add-clip', '--track', track, '--asset', asset, '--start', '0', '--dur', '2000', ...f]));
    const clip = JSON.parse(readFileSync(join(w!.dir, 'project.studio.json'), 'utf8')).clips[0].id;
    const jobs = tmpDir('studio-jobs-');
    // `color analyze` takes a slot, and renders a frame through `studio render`, which also asks for one
    const r = await run(['color', 'analyze', '--clip', clip, ...f], { STUDIO_MAX_JOBS: '1', STUDIO_JOBS_DIR: jobs });
    expect(r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(readdirSync(jobs)).toEqual([]);
  }, 120_000);
});

describe('the agent surface', () => {
  it('every tool takes `agent` and `project`; the workspace tools exist; `agent` becomes --agent', () => {
    const names = listTools().map((t) => t.name);
    for (const t of ['studio_ws_open', 'studio_ws_list', 'studio_ws_close', 'studio_work_begin', 'studio_work_end', 'studio_work_status']) expect(names).toContain(t);
    for (const t of listTools()) {
      expect(Object.keys((t.inputSchema as any).properties)).toEqual(expect.arrayContaining(['agent', 'project']));
    }
    const open_ = listTools().find((t) => t.name === 'studio_ws_open')!;
    expect(Object.keys((open_.inputSchema as any).properties)).toEqual(expect.arrayContaining(['kind', 'count', 'name', 'slot', 'root']));
    const m = COMMANDS.find((c) => c.name === 'tl.add-track')!;
    const built = argvFor(m, { type: 'video', name: 'V', agent: 'm2-agent', project: '/x' }) as { argv: string[] };
    expect(built.argv).toEqual(expect.arrayContaining(['--agent', 'm2-agent']));
    expect('error' in (argvFor(m, { type: 'video', name: 'V', agent: 5 }) as object)).toBe(true);
  });
});
