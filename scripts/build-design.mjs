// Bundles the browser side of the design export into one self-contained file; its hash is part of the cache identity.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('packages/design/dist-page', { recursive: true });
await build({
  entryPoints: { page: 'packages/design/src/page.ts' },
  outdir: 'packages/design/dist-page',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  logLevel: 'warning',
});
