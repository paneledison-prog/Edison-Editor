import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@studio/core': src('./packages/core/src/index.ts'),
      '@studio/engines/images': src('./packages/engines/src/images.ts'),
      '@studio/engines': src('./packages/engines/src/index.ts'),
      '@studio/motion/ease': src('./motion/src/ease.ts'),
      '@studio/motion': src('./motion/src/specs.ts'),
      '@studio/inspect': src('./packages/inspect/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    // The job governor limits how many heavy commands run at once on a machine (a few). Test files already run in
    // parallel and must not queue behind each other; tests/workspaces.test.ts sets real limits for the governor itself.
    env: { STUDIO_MAX_JOBS: '64' },
    globalSetup: ['tests/global-setup.ts'],
    // Several files run at once on 4 cores, so single tests get a generous default.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
