// These globals are not part of the ES spec but exist in every runtime target
// (browser, RN, Node). Declaring them here avoids a dependency on the DOM lib.
declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): number;
declare function clearTimeout(id: number | undefined): void;
