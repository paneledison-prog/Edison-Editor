// Bundles the browser side of the motion renderer into one self-contained file; its hash is part of every cache key.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('motion/dist', { recursive: true });
await build({
  entryPoints: { page: 'motion/src/page.ts' },
  outdir: 'motion/dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  minify: false,
  logLevel: 'warning',
});
