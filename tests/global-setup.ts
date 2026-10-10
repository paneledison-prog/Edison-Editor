import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build the CLI bundle once for the whole run. Test files must not rebuild it: a rebuild deletes dist while other files use it. */
export default function setup() {
  // Every temporary folder a test makes goes under one folder for this run, removed when the run ends: the suite makes hundreds
  // of projects, some with caches of hundreds of MB, and left in /tmp they fill the disk (7,500 folders, 27 GB, in one session).
  const runRoot = mkdtempSync(join(tmpdir(), 'studio-run-'));
  process.env['TMPDIR'] = runRoot;
  // The UI bundle is built once here too: several test files serve apps/ui/dist, and a build empties it.
  execFileSync('pnpm', ['-C', 'apps/ui', 'build'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  execFileSync('pnpm', ['-C', 'apps/design', 'build'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build-motion.mjs')], {
    stdio: 'pipe',
  });
  execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build-design.mjs')], {
    stdio: 'pipe',
  });
  execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build-cli.mjs')], {
    stdio: 'pipe',
  });
  return () => rmSync(runRoot, { recursive: true, force: true });
}
