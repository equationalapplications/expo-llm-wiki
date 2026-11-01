import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // The live integration suite writes to a real SynapseTree account; run it
    // only on explicit opt-in (SYNAPSETREE_LIVE_TESTS=1), never in `pnpm test`.
    exclude: process.env.SYNAPSETREE_LIVE_TESTS === '1' ? [] : ['**/*.integration.test.ts'],
    environment: 'node',
    // auth --revoke's unreachable case waits out the client's real retry backoff (~6 s).
    testTimeout: 15_000,
  },
});
