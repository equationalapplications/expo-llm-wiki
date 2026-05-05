import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@equationalapplications/core-llm-wiki': resolve(__dirname, '../core/src/index.ts'),
      // fastembed ESM build does `import tar from 'tar'` which fails because tar ESM v7 has no
      // default export. Force the CJS build which uses require('tar') successfully.
      'fastembed': resolve(__dirname, '../../node_modules/fastembed/lib/cjs/index.js'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
