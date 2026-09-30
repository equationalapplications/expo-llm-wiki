import type { LibrarianGateConfig } from '../../../types';

const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export function resolveGateConfig(cfg?: LibrarianGateConfig): Required<LibrarianGateConfig> {
  const kRaw = cfg?.k;
  const k = typeof kRaw === 'number' && Number.isFinite(kRaw) ? Math.min(20, Math.max(1, Math.trunc(kRaw))) : 5;
  const dupThreshold = clamp01(cfg?.dupThreshold, 0.97);
  const novelThreshold = clamp01(cfg?.novelThreshold, 0.55);
  if (novelThreshold > dupThreshold) throw new TypeError('librarian.gate: novelThreshold must be <= dupThreshold');
  return { k, dupThreshold, novelThreshold };
}