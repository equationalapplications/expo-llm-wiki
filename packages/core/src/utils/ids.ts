type GetRandomValues = (bytes: Uint8Array) => Uint8Array;

let _injectedGetRandomValues: GetRandomValues | null = null;

/**
 * Inject a platform-specific `getRandomValues` implementation.
 * Call this once at module load time from the platform adapter
 * (e.g. expo-crypto's getRandomValues) when the global `crypto` API is
 * absent — Hermes / React Native being the primary case.
 * Pass `null` to clear a previously injected source.
 */
export function configureRandomSource(fn: GetRandomValues | null): void {
  _injectedGetRandomValues = fn;
}

/**
 * Generate a random ID with an optional prefix.
 * Resolution order:
 *   1. crypto.randomUUID (Web / Node 19+)
 *   2. crypto.getRandomValues (Web / Node / polyfilled global)
 *   3. injected source via configureRandomSource (e.g. expo-crypto in RN)
 * Throws if none is available — record IDs must always be cryptographically random.
 */
export function generateId(prefix: string = ''): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return prefix + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
  }
  if (_injectedGetRandomValues) {
    const bytes = new Uint8Array(16);
    _injectedGetRandomValues(bytes);
    return prefix + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
  }
  throw new Error(
    'generateId: no cryptographically secure random source available ' +
      '(crypto.randomUUID and crypto.getRandomValues are both missing, and no configureRandomSource() injection was provided).',
  );
}
