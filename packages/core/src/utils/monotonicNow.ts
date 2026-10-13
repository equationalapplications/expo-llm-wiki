/** Monotonic clock (ms): a wall-clock step must not stretch or skip a deadline or a cooldown. */
export const monotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
