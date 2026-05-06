import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const _require = createRequire(import.meta.url);

// Resolve fastembed's installed root via its package.json so this alias works
// regardless of pnpm hoisting layout.  The CJS build is forced because the ESM
// build does `import tar from 'tar'` and tar v7 ESM has no default export.
// 'fastembed/lib/cjs/index.js' is not listed in fastembed's exports map, so we
// must bypass Vite's exports enforcement by providing an absolute path.
const fastembedRoot = (() => {
  try {
    return resolve(_require.resolve('fastembed/package.json'), '..');
  } catch {
    // fastembed not installed — integration tests will be skipped anyway
    return resolve(__dirname, '../../node_modules/fastembed');
  }
})();

export default defineConfig({
  resolve: {
    alias: {
      '@equationalapplications/core-llm-wiki': resolve(__dirname, '../core/src/index.ts'),
      // fastembed ESM build does `import tar from 'tar'` which fails because tar ESM v7 has no
      // default export. Force the CJS build which uses require('tar') successfully.
      'fastembed': resolve(fastembedRoot, 'lib/cjs/index.js'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
