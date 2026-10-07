import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@studio/core': src('./packages/core/src/index.ts'),
      '@studio/engines': src('./packages/engines/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'] },
});
