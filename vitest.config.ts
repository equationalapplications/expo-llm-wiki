import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/core/__tests__/**/*.test.ts',
      'packages/expo/__tests__/**/*.test.ts',
      'packages/core-llm-tools/__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
});
