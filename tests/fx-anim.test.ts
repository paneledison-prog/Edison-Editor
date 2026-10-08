import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

interface P {
  dir: string;
  clip: string;
}
async function project(seconds: number, audio = false): Promise<P> {
  const d = tmpDir('studio-fxa-');
  const input = join(tmpDir('studio-fxa-in-'), 'v.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=30:d=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac'] : ['-an']), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', input]);
  ok(await run(['init', 'a', '--width', '320', '--height', '180', '--fps', '30', '--project', d]));
  ok(await run(['ingest', input, '--no-derive', '--project', d]));
  const asset = Object.keys(JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).assets)[0]!;
  const t = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', d])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t, '--asset', asset, '--start', '0', '--dur', String(seconds * 1000), '--project', d]));
  return { dir: d, clip: JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).clips[0].id };
}
const still = async (p: P, t: number, name: string) =>
  join(p.dir, ok(await run(['render', '--still', String(t), '--out', name, '--width', '320', '--no-normalize', '--force', '--project', p.dir])).output as string);
/** An image or a video frame as 160x90 RGB bytes. */
const rgb = (file: string, at?: number): Buffer =>
  execFileSync('ffmpeg', ['-v', 'error', ...(at ? ['-ss', String(at / 1000)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=160:90:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
/** mean absolute difference between two pictures, in 8-bit levels */
const mad = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};
const mean = (a: Buffer) => a.reduce((s, v) => s + v, 0) / a.length;

// sine.inOut, written out so the test does not depend on the code it checks
const sineInOut = (u: number) => -(Math.cos(Math.PI * u) - 1) / 2;
/** exposure keyframes: 0 at 500 ms, 1.5 at 2000 ms, eased with sine.inOut; held outside */
const exposureAt = (t: number) => (t <= 500 ? 0 : t >= 2000 ? 1.5 : 1.5 * sineInOut((t - 500) / 1500));

let anim: P;
let ref: P;
let animNode: string;
let refNode: string;
beforeAll(async () => {
  anim = await project(3);
  ref = await project(3);
  animNode = ok(await run(['fx', 'add', '--clip', anim.clip, '--effect', 'lumetri', '--project', anim.dir])).node;
  refNode = ok(await run(['fx', 'add', '--clip', ref.clip, '--effect', 'lumetri', '--project', ref.dir])).node;
  ok(await run(['fx', 'key', '--clip', anim.clip, '--node', animNode, '--param', 'exposure', '--t', '500', '--v', '0', '--ease', 'sine.inOut', '--project', anim.dir]));
  ok(await run(['fx', 'key', '--clip', anim.clip, '--node', animNode, '--param', 'exposure', '--t', '2000', '--v', '1.5', '--project', anim.dir]));
}, 180_000);

describe('keyframes on an effect parameter', () => {
  it('follows the keyframed curve: each frame matches the effect set to that frame’s value', async () => {
    const times = [0, 300, 500, 700, 900, 1100, 1250, 1500, 1750, 1900, 2000, 2400];
    const rows: string[] = [];
    const lum: number[] = [];
    let worst = 0;
    let worstKey = 0;
    for (const t of times) {
      const a = rgb(await still(anim, t, `a-${t}`));
      ok(await run(['fx', 'set', '--clip', ref.clip, '--node', refNode, '--params', JSON.stringify({ exposure: exposureAt(t) }), '--project', ref.dir]));
      const r = rgb(await still(ref, t, `r-${t}`));
      const d = mad(a, r);
      rows.push(`${String(t).padStart(5)} ms  exposure ${exposureAt(t).toFixed(3).padStart(6)}  mean abs diff ${d.toFixed(2)} levels`);
      lum.push(mean(a));
      worst = Math.max(worst, d);
      if (t === 500 || t === 2000 || t === 0 || t === 2400) worstKey = Math.max(worstKey, d);
    }
    console.log('ANIMATED EXPOSURE vs the effect at that exact value (8-bit levels):\n' + rows.join('\n'));
    expect(worstKey).toBeLessThan(0.6); // at the keyframes (and where it holds) it is the same picture
    expect(worst).toBeLessThan(2); // between them, within a couple of levels of the exact value
    expect(lum.length).toBe(times.length);
  }, 300_000);

  it('a full render does the same: frames of the rendered video follow the curve (video against video)', async () => {
    const out = ok(await run(['render', '--out', 'anim-full', '--width', '320', '--no-normalize', '--force', '--project', anim.dir]));
    const file = join(anim.dir, out.output as string);
    let worst = 0;
    const rows: string[] = [];
    for (const t of [200, 800, 1400, 1900, 2600]) {
      // the same clip rendered whole with the effect fixed at this frame's value, through the same encoder
      ok(await run(['fx', 'set', '--clip', ref.clip, '--node', refNode, '--params', JSON.stringify({ exposure: exposureAt(t) }), '--project', ref.dir]));
      const r = ok(await run(['render', '--out', `ref-full-${t}`, '--width', '320', '--no-normalize', '--force', '--project', ref.dir]));
      const d = mad(rgb(file, t), rgb(join(ref.dir, r.output as string), t));
      rows.push(`${t} ms: ${d.toFixed(2)}`);
      worst = Math.max(worst, d);
    }
    console.log(`FULL RENDER vs a whole render at each frame's value, mean abs diff: ${rows.join(', ')}`);
    expect(worst).toBeLessThan(2);
  }, 300_000);

  it('costs more than a static effect while it is animating, and the render says so', async () => {
    const t = async (p: P) => {
      const t0 = Date.now();
      ok(await run(['render', '--preview', '--out', 'cost', '--no-normalize', '--force', '--project', p.dir]));
      return Date.now() - t0;
    };
    const r = await run(['render', '--preview', '--out', 'cost', '--no-normalize', '--force', '--project', anim.dir]);
    expect(r.json.ok).toBe(true);
    expect((r.json.warnings as string[]).join(' ')).toMatch(/is animated: it is rendered twice per slice/);
    const [ta, tr] = [await t(anim), await t(ref)];
    console.log(`RENDER TIME, 3 s clip: animated ${ta} ms, static ${tr} ms`);
    expect(ta).toBeLessThan(tr * 8 + 3000); // measured 3 to 4 times on 3 to 10 s clips; loose here, the point is the report
  }, 300_000);
});

describe('mix: how much of an effect shows', () => {
  it('a mix of 0.5 is halfway between the picture before and after the effect; keyframed mix fades the effect in', async () => {
    const p = await project(3);
    const n = ok(await run(['fx', 'add', '--clip', p.clip, '--effect', 'lumetri', '--params', '{"exposure":1.2}', '--project', p.dir])).node;
    const full = rgb(await still(p, 600, 'm-full'));
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', n, '--project', p.dir]));
    const plain = rgb(await still(p, 600, 'm-plain'));
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', n, '--off', '--project', p.dir]));
    ok(await run(['fx', 'set', '--clip', p.clip, '--node', n, '--mix', '0.5', '--project', p.dir]));
    const half = rgb(await still(p, 600, 'm-half'));
    const expect_ = Buffer.from(plain.map((v, i) => Math.round((v + full[i]!) / 2)));
    expect(mad(half, expect_)).toBeLessThan(1.5);
    expect(mean(half)).toBeGreaterThan(mean(plain) + 3);
    expect(mean(half)).toBeLessThan(mean(full) - 3);

    // fade the effect in over the first second: 0 at 0 ms, 1 at 1000 ms
    ok(await run(['fx', 'set', '--clip', p.clip, '--node', n, '--mix', '1', '--project', p.dir]));
    ok(await run(['fx', 'key', '--clip', p.clip, '--node', n, '--param', 'mix', '--t', '0', '--v', '0', '--project', p.dir]));
    ok(await run(['fx', 'key', '--clip', p.clip, '--node', n, '--param', 'mix', '--t', '1000', '--v', '1', '--project', p.dir]));
    const at0 = rgb(await still(p, 0, 'm-k0'));
    const at500 = rgb(await still(p, 500, 'm-k500'));
    const at1500 = rgb(await still(p, 1500, 'm-k1500'));
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', n, '--project', p.dir]));
    const base0 = rgb(await still(p, 0, 'm-b0'));
    const base500 = rgb(await still(p, 500, 'm-b500'));
    ok(await run(['fx', 'bypass', '--clip', p.clip, '--node', n, '--off', '--project', p.dir]));
    expect(mad(at0, base0)).toBeLessThan(0.8); // nothing of the effect at the start
    expect(mean(at500)).toBeGreaterThan(mean(base500) + 2); // some of it halfway
    expect(mean(at500)).toBeLessThan(mean(at1500) - 2); // less than once it is fully in
    expect(mean(at1500)).toBeGreaterThan(mean(base500) + 10);
  }, 300_000);
});

describe('gain keyframes', () => {
  it('a keyframed gain moves the level of the audio over time', async () => {
    const p = await project(3, true);
    const n = ok(await run(['fx', 'add', '--clip', p.clip, '--gain', '0', '--project', p.dir])).node;
    ok(await run(['fx', 'key', '--clip', p.clip, '--node', n, '--param', 'db', '--t', '0', '--v', '0', '--project', p.dir]));
    ok(await run(['fx', 'key', '--clip', p.clip, '--node', n, '--param', 'db', '--t', '2000', '--v', '-30', '--project', p.dir]));
    const out = ok(await run(['render', '--out', 'gain', '--no-normalize', '--force', '--preview', '--project', p.dir]));
    const file = join(p.dir, out.output as string);
    const mv = (a: number, b: number) => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(a), '-t', String(b - a), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)![1]);
    };
    const l0 = mv(0.1, 0.3);
    const l1 = mv(0.9, 1.1);
    const l2 = mv(1.7, 1.9);
    const l3 = mv(2.4, 2.9); // after the last keyframe: held at -30
    console.log(`GAIN KEYFRAMES 0 dB -> -30 dB over 2 s: ${l0.toFixed(1)}, ${l1.toFixed(1)}, ${l2.toFixed(1)}, held ${l3.toFixed(1)} dB`);
    // window centres 0.2, 1.0, 1.8 s sit at -3, -15, -27 dB on the curve (-15 dB per second), then it holds at -30 dB
    expect(Math.abs(l0 - l1 - 12)).toBeLessThan(1);
    expect(Math.abs(l0 - l2 - 24)).toBeLessThan(1);
    expect(Math.abs(l0 - l3 - 27)).toBeLessThan(1);
  }, 300_000);
});

describe('what is refused', () => {
  it('a keyframe on an effect that is not there, or on one that works on source frames, never renders silently', async () => {
    const p = await project(2);
    const bad = await run(['tl', 'keyframe', '--clip', p.clip, '--prop', 'fx.f_zzzz.exposure', '--t', '0', '--v', '0', '--project', p.dir]);
    expect(bad.json.ok).toBe(false);
    expect(JSON.stringify(bad.json)).toMatch(/no effect f_zzzz/);
    // a keyframe the effect cannot take (written by hand, past the fx command) is reported by validate, not left for the render
    const g = ok(await run(['fx', 'add', '--clip', p.clip, '--effect', 'glow', '--project', p.dir])).node;
    ok(await run(['tl', 'keyframe', '--clip', p.clip, '--prop', `fx.${g}.nonsense`, '--t', '0', '--v', '1', '--project', p.dir]));
    const v = await run(['project', 'validate', '--project', p.dir]);
    expect(v.json.ok).toBe(false);
    expect(v.json.error.message).toMatch(/no keyframeable parameter "nonsense"/);
    ok(await run(['fx', 'remove', '--clip', p.clip, '--node', g, '--project', p.dir])); // removing the effect takes its keyframes too
    expect((await run(['project', 'validate', '--project', p.dir])).json.ok).toBe(true);
    const n = ok(await run(['fx', 'add', '--clip', p.clip, '--effect', 'slowmo', '--project', p.dir])).node;
    ok(await run(['fx', 'key', '--clip', p.clip, '--node', n, '--param', 'mix', '--t', '0', '--v', '0', '--project', p.dir]));
    const r = await run(['render', '--explain', '--project', p.dir]);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.message).toMatch(/works on the source frames/);
  }, 120_000);
});
