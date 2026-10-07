import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cacheDir,
  copyIntoProject,
  deriveAll,
  doctor,
  EngineError,
  hashFile,
  planIngest,
  prepareWorkingCopy,
  probeFile,
  run,
  withLock,
} from '@studio/engines';
import { ensureFixtures, fx } from './fixtures.js';
import { tmpDir } from './helpers.js';

beforeAll(() => ensureFixtures(), 120_000);

const ffprobeJson = async (p: string) =>
  JSON.parse(
    (
      await run('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        p,
      ])
    ).stdout,
  );

describe('probe: records what editing depends on', () => {
  it('clean video', async () => {
    const r = await probeFile(fx('clean.mp4'));
    expect(r.kind).toBe('video');
    expect(r.probe).toMatchObject({
      durMs: 6000,
      w: 640,
      h: 360,
      fps: 30,
      vfr: false,
      rotation: 0,
      audio: { sr: 48000 },
    });
  });
  it('flags VFR', async () => {
    const r = await probeFile(fx('vfr.mp4'));
    expect(r.probe.vfr).toBe(true);
    expect(r.probe.rFps).toBe(30);
  });
  it('reads rotation from the display matrix as degrees clockwise to upright', async () => {
    expect((await probeFile(fx('rotated.mp4'))).probe.rotation).toBe(270);
  });
  it('no-audio video has audio:null and says so', async () => {
    const r = await probeFile(fx('noaudio.mp4'));
    expect(r.probe.audio).toBeNull();
    expect(r.warnings).toContain('no audio stream');
  });
  it('44.1 kHz audio is accepted with a warning; 48 kHz is silent', async () => {
    expect((await probeFile(fx('audio44.wav'))).warnings.join()).toMatch(/44100 Hz/);
    expect((await probeFile(fx('audio48.wav'))).warnings).toEqual([]);
  });
  it('images are images', async () => {
    expect((await probeFile(fx('still.png'))).kind).toBe('image');
  });
  it('rejects corrupt and empty input with a precise reason', async () => {
    await expect(probeFile(fx('corrupt.mp4'))).rejects.toThrow(
      /cannot read .*corrupt\.mp4: Invalid data/,
    );
    const dir = tmpDir();
    await expect(planIngest(dir, fx('empty.mp4'), {}, new Set())).rejects.toThrow(
      /empty \(0 bytes\)/,
    );
    await expect(planIngest(dir, fx('nope.mp4'), {}, new Set())).rejects.toThrow(/file not found/);
    await expect(planIngest(dir, fx('corrupt.mp4'), {}, new Set())).rejects.toBeInstanceOf(
      EngineError,
    );
  });
});

describe('hash', () => {
  it('full sha256 matches node crypto', async () => {
    const want = createHash('sha256')
      .update(readFileSync(fx('clean.mp4')))
      .digest('hex');
    expect((await hashFile(fx('clean.mp4'))).hash).toBe(`sha256:${want}`);
  });
  it('fast-hash is labeled, deterministic, and size-sensitive', async () => {
    const a = await hashFile(fx('clean.mp4'), 1000);
    expect(a.kind).toBe('fast-hash');
    expect(a.hash.startsWith('fast-hash:')).toBe(true);
    expect((await hashFile(fx('clean.mp4'), 1000)).hash).toBe(a.hash);
    const copy = join(tmpDir(), 'c.mp4');
    copyFileSync(fx('clean.mp4'), copy);
    appendFileSync(copy, 'x');
    expect((await hashFile(copy, 1000)).hash).not.toBe(a.hash);
  });
});

describe('ingest planning and working copies', () => {
  it('reuses an existing asset for identical content', async () => {
    const dir = tmpDir();
    const first = await planIngest(dir, fx('clean.mp4'), {}, new Set());
    const again = await planIngest(
      dir,
      fx('clean.mp4'),
      { a_one1: { hash: first.asset.hash, path: first.assetRelPath } },
      new Set(),
    );
    expect(again.existing).toBe('a_one1');
  });
  it('VFR gets a CFR working copy that is actually constant-rate and keeps A/V length', async () => {
    const dir = tmpDir();
    const plan = await planIngest(dir, fx('vfr.mp4'), {}, new Set());
    await copyIntoProject(dir, plan);
    expect(readFileSync(join(dir, plan.assetRelPath)).equals(readFileSync(fx('vfr.mp4')))).toBe(
      true,
    ); // original copied byte-for-byte
    await prepareWorkingCopy(dir, plan);
    expect(plan.asset.workingCopy?.path).toBe(`.studio/cache/${plan.hex}/cfr.mp4`);
    const out = join(dir, plan.asset.workingCopy!.path);
    const re = await probeFile(out);
    expect(re.probe.vfr).toBe(false);
    expect(re.probe.fps).toBe(30);
    expect(re.probe.audio?.sr).toBe(48000);
    expect(Math.abs((re.probe.durMs ?? 0) - (plan.asset.probe.durMs ?? 0))).toBeLessThanOrEqual(34);
  });
});

describe('derived cache: proxy, thumbs, peaks', () => {
  it('builds once per hash, atomically, and skips on rerun', async () => {
    const dir = tmpDir();
    const plan = await planIngest(dir, fx('clean.mp4'), {}, new Set());
    const cdir = cacheDir(dir, plan.hex);
    const src = { path: plan.src, kind: 'video' as const, durMs: 6000, hasAudio: true };
    const first = await deriveAll(cdir, src, 360);
    expect(first.map((r) => [r.artifact, r.status])).toEqual([
      ['thumbs', 'built'],
      ['proxy', 'built'],
      ['peaks', 'built'],
    ]);
    expect(readdirSync(cdir).filter((f) => f.endsWith('.partial'))).toEqual([]);
    const again = await deriveAll(cdir, src, 360);
    expect(again.every((r) => r.status === 'cached')).toBe(true);

    const proxy = await ffprobeJson(join(cdir, 'proxy.mp4'));
    const v = proxy.streams.find((s: any) => s.codec_type === 'video');
    expect([v.width, v.height]).toEqual([640, 360]);
    const peaks = JSON.parse(readFileSync(join(cdir, 'peaks.json'), 'utf8'));
    expect(peaks.levels).toHaveLength(4);
    // 6.0 s of audio plus AAC encoder delay/padding (a few ms): 600 peaks of 10 ms, up to 610.
    expect(peaks.levels[0].min.length).toBeGreaterThanOrEqual(600);
    expect(peaks.levels[0].min.length).toBeLessThanOrEqual(610);
    expect(Math.max(...peaks.levels[0].max)).toBeGreaterThan(1000);
    expect(peaks.levels[1].spp).toBe(640);
    const t = JSON.parse(readFileSync(join(cdir, 'thumbs.json'), 'utf8'));
    expect(t).toMatchObject({ intervalS: 1, cols: 10, rows: 1, count: 6 });
  });

  it('recovers from a killed build (stale .partial and stale lock)', async () => {
    const dir = tmpDir();
    const cdir = join(dir, 'c');
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, 'proxy.mp4.partial'), 'half written');
    writeFileSync(join(cdir, '.lock'), '999999'); // pid that does not exist
    const src = { path: fx('clean.mp4'), kind: 'video' as const, durMs: 6000, hasAudio: true };
    const reports = await withLock(cdir, () => deriveAll(cdir, src, 360));
    expect(reports.find((r) => r.artifact === 'proxy')?.status).toBe('built');
    expect(existsSync(join(cdir, 'proxy.mp4.partial'))).toBe(false);
    expect((await probeFile(join(cdir, 'proxy.mp4'))).probe.durMs).toBeGreaterThan(5900);
  });

  it('refuses a second concurrent build for the same hash', async () => {
    const cdir = join(tmpDir(), 'c');
    let release!: () => void;
    const held = withLock(cdir, () => new Promise<void>((r) => (release = r)));
    await expect(withLock(cdir, async () => 1)).rejects.toThrow(/already running/);
    release();
    await held;
  });

  it('rotated video: proxy is upright (360x640), not rotated twice', async () => {
    const dir = tmpDir();
    const plan = await planIngest(dir, fx('rotated.mp4'), {}, new Set());
    const cdir = cacheDir(dir, plan.hex);
    await deriveAll(cdir, { path: plan.src, kind: 'video', durMs: 4000, hasAudio: true }, 360);
    const v = (await ffprobeJson(join(cdir, 'proxy.mp4'))).streams.find(
      (s: any) => s.codec_type === 'video',
    );
    expect([v.width, v.height]).toEqual([360, 640]);
  });

  it('no-audio video: proxy has no audio stream and peaks are skipped with a reason', async () => {
    const dir = tmpDir();
    const plan = await planIngest(dir, fx('noaudio.mp4'), {}, new Set());
    const cdir = cacheDir(dir, plan.hex);
    const r = await deriveAll(
      cdir,
      { path: plan.src, kind: 'video', durMs: 4000, hasAudio: false },
      360,
    );
    expect(r.find((x) => x.artifact === 'peaks')).toMatchObject({
      status: 'skipped',
      reason: 'no audio stream',
    });
    const p = await ffprobeJson(join(cdir, 'proxy.mp4'));
    expect(p.streams.some((s: any) => s.codec_type === 'audio')).toBe(false);
  });

  it('audio and image assets get the artifacts that make sense', async () => {
    const dir = tmpDir();
    const a = await planIngest(dir, fx('audio44.wav'), {}, new Set());
    const ra = await deriveAll(
      cacheDir(dir, a.hex),
      { path: a.src, kind: 'audio', durMs: 5000, hasAudio: true },
      undefined,
    );
    expect(ra.map((r) => r.status)).toEqual(['skipped', 'skipped', 'built']);
    const i = await planIngest(dir, fx('still.png'), {}, new Set());
    const ri = await deriveAll(
      cacheDir(dir, i.hex),
      { path: i.src, kind: 'image', hasAudio: false },
      360,
    );
    expect(ri.map((r) => r.status)).toEqual(['built', 'skipped', 'skipped']);
  });
});

describe('doctor', () => {
  it('reports ffmpeg, tests encoders by encoding, and exposes failures', async () => {
    const d = await doctor(tmpDir());
    expect(d.node.ok).toBe(true);
    expect(d.ffmpeg?.encoders.find((e) => e.name === 'libx264')?.usable).toBe(true);
    for (const e of d.ffmpeg!.encoders.filter((x) => !x.usable)) expect(e.error).toBeTruthy();
    expect(d.ffmpeg?.license).toMatch(/GPL/);
  }, 60_000);
});
