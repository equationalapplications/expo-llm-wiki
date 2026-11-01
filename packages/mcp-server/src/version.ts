declare const __PKG_VERSION__: string | undefined;

/** Injected by tsup `define` at build time; `0.0.0-dev` under vitest and tsc. */
export const VERSION: string = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
