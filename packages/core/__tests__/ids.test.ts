import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureRandomSource, generateId } from '../src/utils/ids';

describe('generateId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureRandomSource(null);
  });

  it('uses crypto.randomUUID when available', () => {
    const realCrypto = globalThis.crypto;
    const randomUUID = vi.fn(() => '12345678-1234-1234-1234-1234567890ab');
    vi.stubGlobal('crypto', {
      ...realCrypto,
      randomUUID,
    });

    const id = generateId('evt_');
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('falls back to crypto.getRandomValues when randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    const id = generateId('evt_');
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
  });

  it('uses configureRandomSource when global crypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    configureRandomSource((bytes) => {
      bytes.fill(0xab);
      return bytes;
    });

    expect(generateId('evt_')).toBe('evt_' + 'ab'.repeat(12));
  });

  it('throws when no cryptographically secure random source is available', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateId('evt_')).toThrow(/cryptographically secure/);
  });
});
