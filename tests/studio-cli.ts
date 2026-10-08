/** Helpers for tests that drive the built `studio` CLI as a separate process, the way an agent does. */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { tmpDir } from './helpers.js';

export const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'studio.js');

export const run = (args: string[]): Promise<{ code: number; json: any }> =>
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

/** The data of a successful command; fails the test with the whole answer otherwise. */
export const ok = (r: { json: any }) => {
  expect(r.json?.ok, JSON.stringify(r.json)).toBe(true);
  return r.json.data;
};

export interface Shot {
  dir: string;
  clip: string;
  asset: string;
  input: string;
}

/** A project with one video clip that plays the whole file. */
export async function shotProject(video: string, o: { width: number; height: number; fps: number; frames: number }): Promise<Shot> {
  const d = tmpDir('studio-shot-');
  ok(await run(['init', 't', '--width', String(o.width), '--height', String(o.height), '--fps', String(o.fps), '--project', d]));
  ok(await run(['ingest', video, '--no-derive', '--project', d]));
  const p = JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8'));
  const asset = Object.keys(p.assets)[0]!;
  const t = ok(await run(['tl', 'add-track', '--type', 'video', '--name', 'V', '--project', d])).ops[0].target;
  ok(await run(['tl', 'add-clip', '--track', t, '--asset', asset, '--start', '0', '--dur', String(Math.round((o.frames * 1000) / o.fps)), '--project', d]));
  return { dir: d, clip: JSON.parse(readFileSync(join(d, 'project.studio.json'), 'utf8')).clips[0].id, asset, input: video };
}
