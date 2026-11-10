/**
 * Determinism harness for zero-token diagnostics (spec
 * `specs/targeted-diagnostics/spec.md` §1).
 *
 * While installed, the wall clock and the crypto random source are
 * replaced so two runs with the same parameters and the same call sequence
 * produce byte-identical prompts and fact tables:
 *
 *   - `Date.now()`, zero-argument `new Date()` and `performance.now()` read
 *     a stepping clock (`startMs + stepMs` per read). Time always moves
 *     forward, so deadline and timeout loops still terminate.
 *   - `crypto.randomUUID()` and `crypto.getRandomValues()` draw from a
 *     seeded mulberry32 PRNG.
 *
 * Test-only: installed by suites and replay tools in this package, never by
 * core. Not re-entrant — install once, restore once.
 */

export interface DeterminismOptions {
  seed?: number;
  startMs?: number;
  stepMs?: number;
}

// mulberry32, as in src/searchParity/buildFixture.ts.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function installDeterminism(opts: DeterminismOptions = {}): () => void {
  const seed = opts.seed ?? 1;
  const startMs = opts.startMs ?? Date.UTC(2026, 0, 1);
  const stepMs = opts.stepMs ?? 1;

  const RealDate = globalThis.Date;
  const perf = globalThis.performance;
  const realPerfNow = perf.now;
  const cryptoObj = globalThis.crypto;
  const uuidDesc = Object.getOwnPropertyDescriptor(cryptoObj, 'randomUUID');
  const grvDesc = Object.getOwnPropertyDescriptor(cryptoObj, 'getRandomValues');

  let next = startMs;
  const tick = (): number => {
    const v = next;
    next += stepMs;
    return v;
  };

  const rand = mulberry32(seed);
  const fill = <T extends ArrayBufferView | null>(arr: T): T => {
    if (arr) {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
    }
    return arr;
  };

  class SteppingDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(tick());
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return tick();
    }
  }

  globalThis.Date = SteppingDate as DateConstructor;
  perf.now = () => tick() - startMs;
  Object.defineProperty(cryptoObj, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: fill,
  });
  Object.defineProperty(cryptoObj, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => {
      const b = fill(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });

  return () => {
    globalThis.Date = RealDate;
    perf.now = realPerfNow;
    // Own-property overrides shadow the prototype methods; drop them, or
    // restore the original own descriptors where they existed.
    if (uuidDesc) Object.defineProperty(cryptoObj, 'randomUUID', uuidDesc);
    else delete (cryptoObj as unknown as Record<string, unknown>).randomUUID;
    if (grvDesc) Object.defineProperty(cryptoObj, 'getRandomValues', grvDesc);
    else delete (cryptoObj as unknown as Record<string, unknown>).getRandomValues;
  };
}

export async function withDeterminism<T>(opts: DeterminismOptions, fn: () => Promise<T>): Promise<T> {
  const restore = installDeterminism(opts);
  try {
    return await fn();
  } finally {
    restore();
  }
}
