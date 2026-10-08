import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');
beforeAll(() => {
  // the CLI bundle is built once by tests/global-setup.ts
  ensureFixtures();
}, 120_000);

interface Out {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
}
function studio(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [BIN, ...args],
      { env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code as number) : 0;
        let json: any;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
        resolve({ code, json, stdout, stderr });
      },
    );
  });
}
const proj = async (name = 'cli') => {
  const dir = tmpDir('studio-cli-');
  const r = await studio(['init', name, '--project', dir]);
  expect(r.json.ok).toBe(true);
  return dir;
};
const bytes = (dir: string) => readFileSync(join(dir, 'project.studio.json'));

describe('output contract', () => {
  it('stdout is exactly one JSON object; progress goes to stderr', async () => {
    const dir = await proj();
    const r = await studio(['ingest', fx('clean.mp4'), '--sync', '--project', dir]);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.json).toMatchObject({ ok: true, command: 'ingest' });
    expect(r.stderr).toMatch(/probing/);
    expect(Object.keys(r.json)).toEqual([...Object.keys(r.json)].sort()); // sorted keys
  });

  it('studio tools is generated from the registry and lists only implemented commands', async () => {
    const r = await studio(['tools', '--json']);
    const names: string[] = r.json.data.commands.map((c: any) => c.name);
    expect(names).toContain('ingest');
    expect(names).toContain('tl add-clip');
    for (const absent of ['captions transcribe', 'demo build']) {
      expect(names).not.toContain(absent);
    }
    expect(r.json.data.commands.every((c: any) => c.example && c.usage && c.summary)).toBe(true);
  });

  it('exit codes: 2 unknown command / bad flag / bad input, 4 validation, 5 overwrite, 3 missing engine', async () => {
    const dir = await proj();
    expect((await studio(['bogus'])).code).toBe(2);
    expect((await studio(['tl', 'split', '--nope', '1', '--project', dir])).code).toBe(2);
    expect(
      (await studio(['tl', 'split', '--id', 'c_x', '--project', dir])).json.error.message,
    ).toMatch(/missing required flag --at/);
    expect((await studio(['init', 'again', '--project', dir])).code).toBe(5);
    expect((await studio(['project', 'show', '--project', tmpDir()])).code).toBe(2);
    const noff = await studio(['doctor'], { env: { PATH: dirname(process.execPath) } });
    expect(noff.code).toBe(3);
    expect(noff.json.error).toMatchObject({ code: 'ENGINE_MISSING' });
    expect(noff.json.error.fix).toMatch(/install ffmpeg/);
  });

  it('cold start of a non-media command is under 300 ms (median of 10)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await studio(['tools']);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[5]!;
    console.log(
      `COLD START tools: median ${median.toFixed(0)} ms, min ${times[0]!.toFixed(0)} ms, max ${times[9]!.toFixed(0)} ms`,
    );
    expect(median).toBeLessThan(300);
  });
});

describe('P0 exit criterion through the CLI', () => {
  it('ingest a fixture, apply 10 ops, undo 10: project is byte-identical; undo the ingest too: back to init', async () => {
    const dir = await proj();
    const empty = bytes(dir);
    const ing = await studio(['ingest', fx('clean.mp4'), '--sync', '--project', dir]);
    const aid: string = ing.json.data.ingested[0].id;
    expect(ing.json.data.ingested[0].probe).toMatchObject({ durMs: 6000, fps: 30, vfr: false });
    const afterIngest = bytes(dir);

    const steps: string[][] = [
      ['tl', 'add-track', '--type', 'video', '--name', 'Screen', '--id', 't_v1'],
      ['tl', 'add-track', '--type', 'graphics', '--name', 'Overlays', '--id', 't_g1'],
      [
        'tl',
        'add-clip',
        '--track',
        't_v1',
        '--asset',
        aid,
        '--start',
        '0',
        '--dur',
        '5000',
        '--src-in',
        '500',
        '--id',
        'c_01',
      ],
      [
        'tl',
        'keyframe',
        '--clip',
        'c_01',
        '--prop',
        'scale',
        '--t',
        '1000',
        '--v',
        '1',
        '--ease',
        'expo.inOut',
      ],
      [
        'tl',
        'keyframe',
        '--clip',
        'c_01',
        '--prop',
        'scale',
        '--t',
        '1600',
        '--v',
        '1.8',
        '--ease',
        'expo.inOut',
      ],
      ['tl', 'split', '--id', 'c_01', '--at', '2500'],
      [
        'tl',
        'add-clip',
        '--track',
        't_g1',
        '--comp',
        'lower-third',
        '--start',
        '2000',
        '--dur',
        '3500',
        '--props',
        '{"title":"Ada"}',
        '--id',
        'c_02',
      ],
      ['tl', 'marker', '--t', '5000', '--label', 'Click: Save'],
      ['tl', 'set', '--id', 'c_02', '--patch', '{"transform":{"opacity":0.5}}'],
      ['tl', 'trim', '--id', 'c_02', '--dur', '3000'],
    ];
    for (const s of steps) {
      const r = await studio([...s, '--project', dir]);
      expect(r.json.ok, `${s.join(' ')}: ${r.stdout}`).toBe(true);
    }
    expect(bytes(dir).equals(afterIngest)).toBe(false);
    expect((await studio(['project', 'show', '--project', dir])).json.data).toMatchObject({
      clips: 3,
      markers: 1,
      tracks: [{ clips: 2 }, { clips: 1 }],
    });

    const u = await studio(['project', 'undo', '--n', '10', '--project', dir]);
    expect(u.json.ok).toBe(true);
    expect(u.json.data.steps).toHaveLength(10);
    expect(bytes(dir).equals(afterIngest)).toBe(true);
    await studio(['project', 'undo', '--project', dir]); // the ingest itself is an op
    expect(bytes(dir).equals(empty)).toBe(true);

    const log = await studio(['project', 'log', '--limit', '50', '--project', dir]);
    expect(log.json.data.total).toBe(1 + 10 + 10 + 1); // ingest, 10 ops, 10 undos, 1 undo
    const redo = await studio(['project', 'redo', '--n', '1', '--project', dir]);
    expect(bytes(dir).equals(afterIngest)).toBe(true);
    expect(redo.json.ok).toBe(true);
    expect((await studio(['project', 'validate', '--project', dir])).json.data.valid).toBe(true);
  }, 120_000);
});

describe('writes are safe', () => {
  it('--dry-run reports the result and changes nothing', async () => {
    const dir = await proj();
    const before = bytes(dir);
    const r = await studio([
      'tl',
      'add-track',
      '--type',
      'video',
      '--name',
      'V',
      '--dry-run',
      '--project',
      dir,
    ]);
    expect(r.json).toMatchObject({ ok: true, dryRun: true });
    expect(bytes(dir).equals(before)).toBe(true);
    const ing = await studio(['ingest', fx('clean.mp4'), '--dry-run', '--project', dir]);
    expect(ing.json.data.wouldIngest[0]).toMatchObject({ kind: 'video' });
    expect(readdirSync(join(dir, 'assets'))).toEqual([]);
    expect(readFileSync(join(dir, 'ops.log.jsonl'), 'utf8')).toBe('');
  });

  it('ops apply is atomic: one bad op means none applied, exit 4 with the reason', async () => {
    const dir = await proj();
    const before = bytes(dir);
    const f = join(dir, 'ops.json');
    writeFileSync(
      f,
      JSON.stringify([
        { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
        { type: 'clip.delete', args: { id: 'c_missing' } },
      ]),
    );
    const r = await studio(['ops', 'apply', f, '--project', dir]);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.message).toMatch(/^op 1 clip\.delete: clip c_missing not found/);
    expect(bytes(dir).equals(before)).toBe(true);

    writeFileSync(
      f,
      JSON.stringify({
        label: 'two tracks',
        ops: [
          { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
          { type: 'track.add', args: { id: 't_a1', type: 'audio', name: 'A' } },
        ],
      }),
    );
    const ok = await studio(['ops', 'apply', f, '--project', dir]);
    expect(ok.json.data.ops).toHaveLength(2);
    expect((await studio(['project', 'log', '--project', dir])).json.data.entries[0].label).toBe(
      'two tracks',
    );
  });

  it('validation failures exit 4 and carry issues', async () => {
    const dir = await proj();
    const ing = await studio(['ingest', fx('clean.mp4'), '--no-derive', '--project', dir]);
    const aid = ing.json.data.ingested[0].id;
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
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      aid,
      '--start',
      '0',
      '--dur',
      '3000',
      '--project',
      dir,
    ]);
    const bad = await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      aid,
      '--start',
      '2000',
      '--dur',
      '3000',
      '--project',
      dir,
    ]);
    expect(bad.code).toBe(4);
    expect(bad.json.error.issues[0].code).toBe('OVERLAP');
    const tooLong = await studio([
      'tl',
      'add-clip',
      '--track',
      't_v1',
      '--asset',
      aid,
      '--start',
      '4000',
      '--dur',
      '5000',
      '--src-in',
      '3000',
      '--project',
      dir,
    ]);
    expect(tooLong.json.error.issues[0].code).toBe('SRC_BOUNDS');
  });

  it('ingest is idempotent for identical content, and never touches the original file', async () => {
    const dir = await proj();
    const before = readFileSync(fx('clean.mp4'));
    await studio(['ingest', fx('clean.mp4'), '--no-derive', '--project', dir]);
    const again = await studio(['ingest', fx('clean.mp4'), '--no-derive', '--project', dir]);
    expect(again.json.data.ingested).toEqual([]);
    expect(again.json.data.skipped).toHaveLength(1);
    expect((await studio(['project', 'show', '--project', dir])).json.data.assets).toHaveLength(1);
    expect(readFileSync(fx('clean.mp4')).equals(before)).toBe(true);
    expect(readFileSync(join(dir, 'assets', 'clean.mp4')).equals(before)).toBe(true);
  });

  it('flags a project file edited outside ops', async () => {
    const dir = await proj();
    await studio(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', dir]);
    const p = JSON.parse(readFileSync(join(dir, 'project.studio.json'), 'utf8'));
    p.meta.name = 'hand edit';
    writeFileSync(join(dir, 'project.studio.json'), JSON.stringify(p, null, 2));
    const r = await studio(['project', 'validate', '--project', dir]);
    expect(r.json.ok).toBe(true);
    expect(r.json.warnings[0]).toMatch(/edited outside ops/);
  });
});

describe('hostile inputs through ingest (acceptance test C)', () => {
  it('ingests VFR, rotated, 44.1 kHz, 48 kHz and no-audio files correctly in one command', async () => {
    const dir = await proj();
    const r = await studio([
      'ingest',
      fx('vfr.mp4'),
      fx('rotated.mp4'),
      fx('audio44.wav'),
      fx('audio48.wav'),
      fx('noaudio.mp4'),
      fx('still.png'),
      '--sync',
      '--project',
      dir,
    ]);
    expect(r.json.ok, r.stdout).toBe(true);
    const by = Object.fromEntries(
      r.json.data.ingested.map((i: any) => [i.assetPath.replace('assets/', ''), i]),
    );
    expect(by['vfr.mp4'].probe.vfr).toBe(true);
    expect(by['vfr.mp4'].workingCopy.path).toMatch(/cfr\.mp4$/);
    expect(existsSync(join(dir, by['vfr.mp4'].workingCopy.path))).toBe(true);
    expect(by['rotated.mp4'].probe.rotation).toBe(270);
    expect(by['audio44.wav'].probe.audio.sr).toBe(44100);
    expect(by['audio48.wav'].probe.audio.sr).toBe(48000);
    expect(by['noaudio.mp4'].probe.audio).toBeNull();
    expect(by['still.png'].kind).toBe('image');
    const w = r.json.warnings.join('\n');
    expect(w).toMatch(/variable frame rate/);
    expect(w).toMatch(/rotation 270/);
    expect(w).toMatch(/44100 Hz/);
    expect(w).toMatch(/no audio stream/);
  }, 120_000);

  it('rejects corrupt and empty files with precise reasons and ingests nothing', async () => {
    const dir = await proj();
    const before = bytes(dir);
    const r = await studio([
      'ingest',
      fx('clean.mp4'),
      fx('corrupt.mp4'),
      fx('empty.mp4'),
      '--sync',
      '--project',
      dir,
    ]);
    expect(r.code).toBe(2);
    expect(r.json.error.details.rejected).toHaveLength(2);
    expect(r.json.error.details.rejected[0].reason).toMatch(/corrupt\.mp4: Invalid data/);
    expect(r.json.error.details.rejected[1].reason).toMatch(/empty \(0 bytes\)/);
    expect(bytes(dir).equals(before)).toBe(true);
    expect(readdirSync(join(dir, 'assets'))).toEqual([]);
  });
});

describe('background derivation', () => {
  it('ingest returns immediately; a detached `cache build` finishes the proxy, thumbs, and peaks', async () => {
    const dir = await proj();
    const r = await studio(['ingest', fx('clean.mp4'), '--project', dir]);
    expect(r.json.data.derive.mode).toBe('background');
    const hex = r.json.data.ingested[0].hash.split(':')[1];
    const cdir = join(dir, '.studio', 'cache', hex);
    const want = ['peaks.json', 'proxy.mp4', 'thumbs.jpg'];
    for (let i = 0; i < 100 && !want.every((f) => existsSync(join(cdir, f + '.key'))); i++)
      await new Promise((r) => setTimeout(r, 200));
    expect(want.every((f) => existsSync(join(cdir, f)))).toBe(true);
    expect(readdirSync(cdir).filter((f) => f.endsWith('.partial') || f === '.lock')).toEqual([]);
    const again = await studio(['cache', 'build', '--project', dir]);
    const reports = Object.values(again.json.data.assets)[0] as any[];
    expect(reports.every((x) => x.status === 'cached')).toBe(true);
  }, 60_000);
});
