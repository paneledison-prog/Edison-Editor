import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Build the CLI bundle once for the whole run. Test files must not rebuild it: a rebuild deletes dist while other files use it. */
export default function setup() {
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
}
