import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version?: string };

const shared: Options = {
  format: ['cjs', 'esm'],
  sourcemap: true,
  treeshake: true,
  shims: true,
  define: { __PKG_VERSION__: JSON.stringify(pkg.version ?? '0.0.0-dev') },
};

export default defineConfig([
  { ...shared, entry: ['src/index.ts'], dts: true, clean: true },
  { ...shared, entry: ['src/cli.ts'], dts: false, clean: false, banner: { js: '#!/usr/bin/env node' } },
]);
