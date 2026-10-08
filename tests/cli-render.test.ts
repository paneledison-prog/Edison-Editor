import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, fx } from './fixtures.js';
import { projectWith } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'studio.js');
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
const studio = (args: string[]): Promise<Out> =>
  new Promise((resolve) =>
    execFile('node', [BIN, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: err ? ((err as any).code as number) : 0, json, stdout, stderr });
    }),
  );

async function timeline(files = ['clean.mp4', 'tone.mp4']) {
  const p = await projectWith(files.map(fx));
  const [a, b] = files;
  p.store.apply([
    { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
    {
      type: 'clip.add',
      args: {
        clip: { id: 'c_01', track: 't_v1', asset: p.ids[a!], start: 0, dur: 3000, srcIn: 0 },
      },
    },
    {
      type: 'clip.add',
      args: {
        clip: {
          id: 'c_02',
          track: 't_v1',
          asset: p.ids[b ?? a!],
          start: 3000,
          dur: 3000,
          srcIn: 500,
        },
      },
    },
  ]);
  return p;
}
const renders = (dir: string) =>
  readdirSync(join(dir, 'renders')).filter((f) => /\.(mp4|png|gif)$/.test(f));

describe('studio render', () => {
  it('--explain prints the plan and exact ffmpeg args and writes nothing', async () => {
    const { dir } = await timeline();
    const r = await studio(['render', '--explain', '--project', dir]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data).toMatchObject({
      backend: 'ffmpeg',
      preset: 'youtube-1080p',
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 6000,
      encoder: 'libx264',
    });
    expect(r.json.data.ffmpegArgs).toContain('-filter_complex');
    expect(r.json.data.ffmpegArgs).toContain('+faststart');
    expect(r.json.data.reason).toMatch(/cuts, concat/);
    expect(existsSync(join(dir, 'renders'))).toBe(true); // created by init
    expect(renders(dir)).toEqual([]);
    expect(r.json.warnings.join()).toMatch(/upscaled 3\.00x/);
  });

  it('renders, versions names (v1, v2), refuses to overwrite a named output, --force overwrites', async () => {
    const { dir } = await timeline();
    const a = await studio(['render', '--preview', '--project', dir]);
    expect(a.json.ok, a.stdout).toBe(true);
    expect(a.json.data.output).toBe('renders/p1-preview-v1.mp4');
    const b = await studio(['render', '--preview', '--project', dir]);
    expect(b.json.data.output).toBe('renders/p1-preview-v2.mp4');
    expect(a.json.data).toMatchObject({
      width: 640,
      height: 360,
      streamCopy: false,
      acodec: 'aac',
      loudness: { mode: 'none' },
    });
    const c = await studio(['render', '--preview', '--out', 'mine', '--project', dir]);
    expect(c.json.ok).toBe(true);
    const d = await studio(['render', '--preview', '--out', 'mine', '--project', dir]);
    expect(d.code).toBe(5);
    expect(d.json.error.code).toBe('WOULD_OVERWRITE');
    const e = await studio(['render', '--preview', '--out', 'mine', '--force', '--project', dir]);
    expect(e.json.ok).toBe(true);
    for (const f of ['p1-preview-v1', 'mine']) {
      expect(existsSync(join(dir, 'renders', `render-${f}.project.json`))).toBe(true);
      expect(existsSync(join(dir, 'renders', `render-${f}.report.json`))).toBe(true);
    }
    expect(readdirSync(join(dir, 'renders', '.tmp'))).toEqual([]);
  }, 120_000);

  it('final render has loudness measured twice-pass, correct tags, and passes qc end to end', async () => {
    const { dir } = await timeline();
    const r = await studio(['render', '--preset', 'square-1080', '--project', dir]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data.loudness).toMatchObject({ mode: 'two-pass', targetI: -14, targetTP: -1.5 });
    expect(Number(r.json.data.loudness.measured.input_i)).toBeLessThan(0);
    expect(r.json.data).toMatchObject({ width: 1080, height: 1080, fps: 30, vcodec: 'h264' });
    const q = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
    expect(q.json.ok, q.stdout).toBe(true);
    const by = Object.fromEntries(q.json.data.checks.map((c: any) => [c.id, c]));
    expect(by.loudness.status).toBe('pass');
    expect(by.duration.status).toBe('pass');
    expect(by.container.value.moovAtStart).toBe(true);
    expect(by.captions.status).toBe('skipped'); // skipped is reported, not passed
    expect(by.joins.status).toBe('pass'); // the 3.0 s join between two audio clips was click-checked
    expect(q.json.data.summary.fail).toBe(0);
  }, 120_000);

  it('--range and --still render a part and a frame', async () => {
    const { dir } = await timeline();
    const r = await studio(['render', '--preview', '--range', '2000:4500', '--project', dir]);
    expect(r.json.data.durationMs).toBe(2500);
    const s = await studio(['render', '--still', '3500', '--preview', '--project', dir]);
    expect(s.json.data.output).toMatch(/p1-still-v1\.png$/);
    expect(statSync(join(dir, s.json.data.output)).size).toBeGreaterThan(1000);
    expect((await studio(['render', '--range', '0:99999', '--project', dir])).code).toBe(2);
    expect((await studio(['render', '--still', '99999', '--project', dir])).json.error.code).toBe(
      'INVALID_INPUT',
    );
  }, 120_000);

  it('gif-small: palette GIF at most 720 px wide, 12 fps, no audio', async () => {
    const { dir } = await timeline();
    const r = await studio(['render', '--preset', 'gif-small', '--project', dir]);
    expect(r.json.ok, r.stdout).toBe(true);
    expect(r.json.data).toMatchObject({ vcodec: 'gif', acodec: null, fps: 12, loudness: null });
    expect(r.json.data.output).toMatch(/\.gif$/);
    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        join(dir, r.json.data.output),
      ]).toString(),
    );
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0].width).toBeLessThanOrEqual(720);
    console.log(
      `GIF ${probe.streams[0].width}x${probe.streams[0].height}, ${(r.json.data.bytes / 1024).toFixed(0)} KB for 6 s`,
    );
  }, 60_000);

  it('router: keyframes need Remotion, so it fails loudly instead of ignoring them', async () => {
    const { dir, store } = await timeline();
    store.apply([{ type: 'kf.set', args: { clip: 'c_01', prop: 'scale', t: 500, v: 1.5 } }]);
    const r = await studio(['render', '--preview', '--project', dir]);
    expect(r.code).toBe(3);
    expect(r.json.error.message).toMatch(/c_01: keyframes/);
    expect(r.json.error.message).toMatch(/Remotion backend, which is not implemented yet/);
    expect(renders(dir)).toEqual([]);
  });

  it('empty timeline and unknown preset are rejected', async () => {
    const dir = (await projectWith([])).dir;
    expect((await studio(['render', '--project', dir])).json.error.code).toBe('INVALID_INPUT');
    const { dir: d2 } = await timeline();
    const r = await studio(['render', '--preset', 'tiktok-9', '--project', d2]);
    expect(r.ok === undefined && r.code !== 0).toBe(true);
    expect(r.json.error.message).toMatch(/unknown preset "tiktok-9"/);
  });
});

describe('qc exit codes and planted defects through the CLI', () => {
  it('exits 4 with failing checks and values when a black section is present; allows it when planned', async () => {
    const { dir, store, ids } = await projectWith([fx('blackmid.mp4')]);
    store.apply([
      { type: 'track.add', args: { id: 't_v1', type: 'video', name: 'V' } },
      {
        type: 'clip.add',
        args: {
          clip: {
            id: 'c_01',
            track: 't_v1',
            asset: ids['blackmid.mp4'],
            start: 0,
            dur: 6000,
            srcIn: 0,
          },
        },
      },
    ]);
    const r = await studio(['render', '--preview', '--project', dir]);
    const bad = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
    expect(bad.code).toBe(4);
    expect(bad.json.error.code).toBe('QC_FAILED');
    expect(bad.json.error.details.checks.find((c: any) => c.id === 'black-frames')).toMatchObject({
      status: 'fail',
    });
    const ok = await studio([
      'inspect',
      'qc',
      r.json.data.output,
      '--planned-black',
      '1900:2600',
      '--project',
      dir,
    ]);
    expect(ok.json.ok, ok.stdout).toBe(true);
  }, 120_000);

  it('inspect frame / sheet / loudness / silence work through the CLI and report paths', async () => {
    const { dir } = await timeline();
    const r = await studio(['render', '--preview', '--project', dir]);
    const f = await studio([
      'inspect',
      'frame',
      r.json.data.output,
      '--at',
      '0,2900,3100',
      '--width',
      '320',
      '--project',
      dir,
    ]);
    expect(f.json.data.frames).toHaveLength(3);
    expect(existsSync(join(dir, f.json.data.frames[0].path))).toBe(true);
    const sh = await studio([
      'inspect',
      'sheet',
      r.json.data.output,
      '--fps',
      '1',
      '--project',
      dir,
    ]);
    expect(sh.json.data.sheets[0].tiles).toHaveLength(6);
    const l = await studio(['inspect', 'loudness', r.json.data.output, '--project', dir]);
    expect(l.json.data.hasAudio).toBe(true);
    const si = await studio(['inspect', 'silence', fx('noisy.wav'), '--project', dir]);
    expect(si.json.data.count).toBeGreaterThanOrEqual(1);
    expect(si.json.warnings[0]).toMatch(/noise floor .* \+ 8 dB/);
  }, 120_000);
});

describe('resilience (acceptance test B): killed renders leave no finished-looking output', () => {
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    it(`${sig} mid-render, then a clean re-run`, async () => {
      const { dir } = await timeline();
      // 4K is slow enough to be killed mid-encode.
      const child = spawn('node', [BIN, 'render', '--preset', 'youtube-4k', '--project', dir], {
        stdio: 'ignore',
      });
      const tmp = join(dir, 'renders', '.tmp');
      for (let i = 0; i < 100; i++) {
        if (existsSync(tmp) && readdirSync(tmp).some((f) => f.endsWith('.partial'))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        existsSync(tmp) && readdirSync(tmp).some((f) => f.endsWith('.partial')),
        'render reached the encode stage',
      ).toBe(true);
      child.kill(sig);
      await new Promise((r) => child.on('close', r));
      await new Promise((r) => setTimeout(r, 300));
      expect(renders(dir), 'no finished-looking output').toEqual([]);
      if (sig === 'SIGTERM')
        expect(readdirSync(tmp).filter((f) => f.endsWith('.partial'))).toEqual([]); // cleaned on signal
      // re-run succeeds and clears stale partials
      const r = await studio(['render', '--preview', '--project', dir]);
      expect(r.json.ok, r.stdout).toBe(true);
      expect(renders(dir)).toEqual(['p1-preview-v1.mp4']);
      expect(readdirSync(tmp)).toEqual([]);
      const q = await studio(['inspect', 'qc', r.json.data.output, '--project', dir]);
      expect(q.json.data.checks.find((c: any) => c.id === 'duration').status).toBe('pass');
    }, 120_000);
  }
});

describe('tools registry', () => {
  it('lists render and inspect commands, with no stubs for later phases', async () => {
    const r = await studio(['tools']);
    const names: string[] = r.json.data.commands.map((c: any) => c.name);
    for (const n of [
      'render',
      'inspect frame',
      'inspect sheet',
      'inspect waveform',
      'inspect loudness',
      'inspect silence',
      'inspect black',
      'inspect qc',
    ])
      expect(names).toContain(n);
    for (const absent of ['captions transcribe', 'motion render', 'demo build'])
      expect(names).not.toContain(absent);
    expect(readFileSync(join(ROOT, 'packages/cli/src/registry.ts'), 'utf8')).not.toMatch(
      /not implemented|TODO/,
    );
  });
});
