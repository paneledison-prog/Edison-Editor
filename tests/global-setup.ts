import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Build the CLI bundle once for the whole run. Test files must not rebuild it: a rebuild deletes dist while other files use it. */
export default function setup() {
  execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build-motion.mjs')], {
    stdio: 'pipe',
  });
  execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build-cli.mjs')], {
    stdio: 'pipe',
  });
}
