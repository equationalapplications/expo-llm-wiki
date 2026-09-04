import { describe, it, expect } from 'vitest';
import { AUTHORIZED_SCOPES, isAuthorizedScope } from '../src/scopes';

describe('AUTHORIZED_SCOPES', () => {
  it('is non-empty and contains the always-on core scope', () => {
    expect(AUTHORIZED_SCOPES.length).toBeGreaterThan(0);
    expect(AUTHORIZED_SCOPES).toContain('core');
  });

  it('isAuthorizedScope accepts every listed scope', () => {
    for (const scope of AUTHORIZED_SCOPES) {
      expect(isAuthorizedScope(scope)).toBe(true);
    }
  });

  it('isAuthorizedScope rejects scopes not in the list', () => {
    expect(isAuthorizedScope('memory:write')).toBe(false);
    expect(isAuthorizedScope('totally:unknown')).toBe(false);
    expect(isAuthorizedScope('')).toBe(false);
  });
});