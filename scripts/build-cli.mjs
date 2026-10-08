// Bundles the CLI with code splitting: each command module is a lazy chunk, so `studio tools`
// loads neither zod nor the ffmpeg adapter.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('packages/cli/dist', { recursive: true, force: true });
const r = await build({
  entryPoints: { studio: 'packages/cli/src/main.ts' },
  outdir: 'packages/cli/dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  external: ['sharp', 'playwright-core'], // native module: resolved from node_modules at run time
  target: 'node20',
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
  logLevel: 'warning',
});
const out = Object.entries(r.metafile.outputs).map(
  ([f, o]) => `${f.replace('packages/cli/dist/', '')} ${o.bytes}`,
);
console.error(out.join('\n'));
