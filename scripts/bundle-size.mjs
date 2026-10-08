// Gzipped JS size of the UI shell vs the 250 KB budget, and vs the recorded baseline (fails on >10% growth).
// Lazy chunks (Remotion Player, graph editor) will be listed in LAZY and excluded from the shell total.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'apps/ui/dist/assets';
const BASELINE = 'apps/ui/bundle-baseline.json';
const BUDGET = 250 * 1024;
const LAZY = [/^lazy-/];

if (!existsSync(DIST)) {
  console.error('apps/ui/dist missing: run `pnpm -C apps/ui build` first');
  process.exit(1);
}
const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));
let shell = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(join(DIST, f)), { level: 9 }).length;
  const lazy = LAZY.some((r) => r.test(f));
  if (!lazy) shell += gz;
  console.log(`${lazy ? 'lazy ' : 'shell'} ${f.padEnd(32)} ${(gz / 1024).toFixed(2)} KB gzip`);
}
console.log(`shell total ${(shell / 1024).toFixed(2)} KB gzip (budget ${BUDGET / 1024} KB)`);
let bad = false;
if (shell > BUDGET) {
  console.error('FAIL: shell JS is over budget');
  bad = true;
}
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ shellGzipBytes: shell }, null, 2) + '\n');
  console.log(`baseline updated to ${shell} bytes`);
} else if (existsSync(BASELINE)) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).shellGzipBytes;
  const growth = (shell - base) / base;
  console.log(`vs baseline ${(base / 1024).toFixed(2)} KB: ${(growth * 100).toFixed(1)}%`);
  if (growth > 0.1) {
    console.error('FAIL: grew more than 10% over baseline; justify and rerun with --update');
    bad = true;
  }
}
process.exit(bad ? 1 : 0);
