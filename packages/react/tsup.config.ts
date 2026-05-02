import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/js.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', '@equationalapplications/core-llm-wiki'],
});
