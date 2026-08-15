import { describe, it, expect } from 'vitest';
import {
  deriveTrustTier,
  isStaleAfter,
  parseVerifiedFlexible,
  formatSourcesJson,
  formatVerifiedJson,
  latestVerified,
  parseCitationsList,
} from '../src/v02-helpers';

describe('deriveTrustTier', () => {
  it('returns unverified for undefined / empty', () => {
    expect(deriveTrustTier(undefined)).toBe('unverified');
    expect(deriveTrustTier([])).toBe('unverified');
  });
  it('returns machine-confirmed for agent or process verifier', () => {
    expect(deriveTrustTier([{ by: 'reference_agent/gemini-2.5-pro', at: '2026-01-01T00:00:00Z' }])).toBe('machine-confirmed');
    expect(deriveTrustTier([{ by: 'process:finance-nightly', at: '2026-01-01T00:00:00Z' }])).toBe('machine-confirmed');
  });
  it('returns human-reviewed for any human:* verifier', () => {
    expect(deriveTrustTier([{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }])).toBe('human-reviewed');
  });
  it('human tier is sticky — appended machine verifications do not downgrade', () => {
    expect(
      deriveTrustTier([
        { by: 'human:ahormati', at: '2026-01-01T00:00:00Z' },
        { by: 'process:cron-nightly', at: '2026-02-01T00:00:00Z' },
      ]),
    ).toBe('human-reviewed');
  });
});

describe('isStaleAfter', () => {
  it('null never stale', () => {
    expect(isStaleAfter(null, 1_700_000_000_000)).toBe(false);
  });
  it('accepts YYYY-MM-DD string and returns true when today >= stale_after', () => {
    const cutoff = new Date('2026-01-01T00:00:00Z').getTime();
    const before = new Date('2025-12-31T00:00:00Z').getTime();
    const after = new Date('2026-02-01T00:00:00Z').getTime();
    expect(isStaleAfter('2026-01-01', cutoff)).toBe(true); // exactly today == stale
    expect(isStaleAfter('2026-01-01', before)).toBe(false); // before cutoff — not yet stale
    expect(isStaleAfter('2026-01-01', after)).toBe(true); // well past cutoff — stale
  });
  it('accepts epoch ms number', () => {
    const t = new Date('2026-01-01T00:00:00Z').getTime();
    expect(isStaleAfter(t, t + 86_400_000)).toBe(true);
    expect(isStaleAfter(t, t - 1)).toBe(false);
  });
  it('treats malformed string as never-stale (non-throwing)', () => {
    expect(isStaleAfter('not-a-date', 1_700_000_000_000)).toBe(false);
  });
});

describe('parseVerifiedFlexible', () => {
  it('returns the array as-is when given a list', () => {
    const list = [{ by: 'a', at: '2026-01-01T00:00:00Z' }, { by: 'b', at: '2026-02-01T00:00:00Z' }];
    expect(parseVerifiedFlexible(list)).toEqual(list);
  });
  it('wraps a bare mapping into a one-element list', () => {
    const mapping = { by: 'human:ahormati', at: '2026-01-01T00:00:00Z' };
    expect(parseVerifiedFlexible(mapping)).toEqual([mapping]);
  });
  it('returns empty list for undefined', () => {
    expect(parseVerifiedFlexible(undefined)).toEqual([]);
  });
  it('returns empty list for unrecognized shape', () => {
    expect(parseVerifiedFlexible('not-a-shape' as any)).toEqual([]);
  });
});

describe('formatVerifiedJson', () => {
  it('produces JSON sorted by at ASC (latest last)', () => {
    const json = formatVerifiedJson([
      { by: 'b', at: '2026-02-01T00:00:00Z' },
      { by: 'a', at: '2026-01-01T00:00:00Z' },
    ]);
    expect(JSON.parse(json)).toEqual([
      { by: 'a', at: '2026-01-01T00:00:00Z' },
      { by: 'b', at: '2026-02-01T00:00:00Z' },
    ]);
  });
});

describe('formatSourcesJson', () => {
  it('folds sharedWindow into entries that lack usage_window', () => {
    const shared = { from: '2026-01-01', to: '2026-12-31' };
    const json = formatSourcesJson(
      [{ resource: 'https://example.com' }, { resource: 'https://other.com', usage_window: { from: '2025-01-01', to: '2025-12-31' } }],
      shared,
    );
    const parsed = JSON.parse(json);
    expect(parsed[0].usage_window).toEqual(shared);
    expect(parsed[1].usage_window).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});

describe('latestVerified', () => {
  it('returns null for empty / undefined', () => {
    expect(latestVerified(undefined, new Date('2026-01-01T00:00:00Z').getTime())).toBeNull();
    expect(latestVerified([], new Date('2026-01-01T00:00:00Z').getTime())).toBeNull();
  });
  it('returns the verifier with the latest at as epoch ms', () => {
    const now = new Date('2026-06-01T00:00:00Z').getTime();
    expect(
      latestVerified(
        [
          { by: 'a', at: '2026-01-01T00:00:00Z' },
          { by: 'b', at: '2026-05-01T00:00:00Z' },
        ],
        now,
      ),
    ).toEqual({ by: 'b', at: new Date('2026-05-01T00:00:00Z').getTime() });
  });
});

describe('parseCitationsList', () => {
  it('extracts URLs from a # Citations section', () => {
    const body = 'Some prose.\n\n# Citations\n\n- https://example.com/a\n- https://example.com/b\n\n## Related\n\n- [x](./x.md)';
    expect(parseCitationsList(body)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });
  it('returns empty when # Citations is absent', () => {
    expect(parseCitationsList('No citations here.')).toEqual([]);
  });
  it('skips non-URL lines', () => {
    const body = '# Citations\n\n- https://example.com/a\n- Not a url\n';
    expect(parseCitationsList(body)).toEqual(['https://example.com/a']);
  });
});