import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/factory.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', 'expo-sqlite', '@equationalapplications/core-llm-wiki', '@equationalapplications/react-llm-wiki'],
});
