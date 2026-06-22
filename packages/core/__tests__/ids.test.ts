import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateId } from '../src/utils/ids';

describe('generateId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when available', () => {
    const id = generateId('evt_');
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
  });

  it('falls back to crypto.getRandomValues when randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    const id = generateId('evt_');
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
  });

  it('throws when no cryptographically secure random source is available', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateId('evt_')).toThrow(/cryptographically secure/);
  });
});
