import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Tests resolve workspace deps to SOURCE, not built dist output. Without this,
// vitest inherits vite.config.ts, resolves these packages through their
// `exports` maps into dist/, and the suite fails on a fresh clone until the
// whole workspace is built (#122). Aliasing also removes stale-dist false
// positives, where a suite passes against a dist/ older than its src/.
//
// NOTE: a dedicated vitest.config.ts REPLACES vite.config.ts for test runs
// rather than merging with it. That intentionally drops the PWA and
// sql-wasm-copy plugins, which are build concerns with no role in tests. Any
// future test-relevant Vite setting must be repeated here.
export default defineConfig({
  resolve: {
    alias: {
      '@equationalapplications/core-llm-tools': resolve(
        __dirname,
        '../../packages/core-llm-tools/src/index.ts',
      ),
      '@equationalapplications/core-llm-wiki': resolve(
        __dirname,
        '../../packages/core/src/index.ts',
      ),
      // Transitive: packages/core's source imports core-okf, so without this
      // alias the suite still resolves okf through its exports map into the
      // missing dist/ once the first two aliases pull core in from source.
      '@equationalapplications/core-okf': resolve(
        __dirname,
        '../../packages/okf/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'node',
  },
})
