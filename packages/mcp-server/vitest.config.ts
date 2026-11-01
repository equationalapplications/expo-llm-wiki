import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    // auth --revoke's unreachable case waits out the client's real retry backoff (~6 s).
    testTimeout: 15_000,
  },
});
