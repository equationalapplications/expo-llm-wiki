import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
});
