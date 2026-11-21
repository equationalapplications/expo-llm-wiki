import { describe, expect, it } from 'vitest';

import { buildShortlist, shortlistScore, type ShortlistRow } from '../src/utils/shortlist';

const row = (title: string, body?: string, okf_type = 'area'): ShortlistRow => ({ title, body, okf_type });

describe('shortlistScore', () => {
  it('returns 0 when both token sets are empty (0/0 case)', () => {
    // "ab cd" drops to zero tokens (< 3 chars each) on the fact side; a row
    // with only short tokens drops to zero on the row side.
    expect(shortlistScore('ab cd', 'xy', row('qq rr'))).toBe(0);
    expect(shortlistScore('', '', row('', ''))).toBe(0);
  });

  it('drops tokens shorter than 3 characters', () => {
    // Only "alpha" survives tokenization on both sides → Jaccard 1.
    expect(shortlistScore('ab alpha', '', row('alpha cd'))).toBe(1);
    // "of to" tokens are all < 3 chars → no shared tokens.
    expect(shortlistScore('of', 'to', row('of to'))).toBe(0);
  });

  it('scores against the union of fact title and body tokens', () => {
    // Body-only shared tokens.
    expect(shortlistScore('unrelated title', 'orchard harvest', row('x', 'orchard harvest yield'))).toBeGreaterThan(0);
    // Title-only shared tokens.
    expect(shortlistScore('orchard', 'nothing shared here', row('orchard lanes'))).toBeGreaterThan(0);
  });
});

describe('buildShortlist', () => {
  it('returns top-k rows ordered by descending score', () => {
    const rows = [
      row('weak', 'sparse tokens only'),
      row('strong match', 'orbit deploy acme labs'),
      row('medium match', 'orbit deploy'),
    ];
    const top = buildShortlist({ title: '', body: 'orbit deploy acme labs' }, rows, 2);
    expect(top.map((r) => r.title)).toEqual(['strong match', 'medium match']);
  });

  it('dedupes by normalizeTitleKey keeping the LAST row', () => {
    const rows = [
      row('  ACME   labs ', 'first variant', 'area'),
      row('Acme Labs', 'second variant', 'organization'),
    ];
    const out = buildShortlist({ title: '', body: 'acme labs' }, rows, 5);
    expect(out).toHaveLength(1);
    // The key folds case/whitespace only, so both rows collide; the survivor
    // is the last one, with its own okf_type.
    expect(out[0].okf_type).toBe('organization');
    expect(out[0].body).toBe('second variant');
  });

  it('breaks score ties by UTF-16-earlier title, regardless of input order', () => {
    const a = row('Alpha Node', 'identical body tokens here');
    const b = row('Beta Node', 'identical body tokens here');
    const fact = { title: '', body: 'identical body tokens' };
    expect(buildShortlist(fact, [a, b], 2).map((r) => r.title)).toEqual(['Alpha Node', 'Beta Node']);
    expect(buildShortlist(fact, [b, a], 2).map((r) => r.title)).toEqual(['Alpha Node', 'Beta Node']);
  });

  it('returns the whole deduped pool when k exceeds it', () => {
    const rows = [row('one'), row('Two'), row('two')]; // 'Two'/'two' collide on the key
    expect(buildShortlist({ title: '', body: 'x' }, rows, 99)).toHaveLength(2);
  });

  it('returns [] for k <= 0 and throws for non-integer or NaN k', () => {
    const rows = [row('one'), row('two')];
    expect(buildShortlist({ title: '', body: 'x' }, rows, 0)).toEqual([]);
    expect(buildShortlist({ title: '', body: 'x' }, rows, -3)).toEqual([]);
    expect(() => buildShortlist({ title: '', body: 'x' }, rows, 1.5)).toThrow();
    expect(() => buildShortlist({ title: '', body: 'x' }, rows, Number.NaN)).toThrow();
  });

  it('skips rows with an empty title', () => {
    const rows = [row('', 'no title'), row('real', 'tokens')];
    const out = buildShortlist({ title: '', body: 'tokens' }, rows, 5);
    expect(out.map((r) => r.title)).toEqual(['real']);
  });

  it('skips empty-okf_type rows BEFORE dedupe so they cannot replace a valid row with the same key', () => {
    const valid: ShortlistRow = { title: 'Orbit', okf_type: 'software_application' };
    const invalid: ShortlistRow = { title: 'Orbit', okf_type: '' };
    const out = buildShortlist({ title: '', body: 'orbit' }, [valid, invalid], 5);
    expect(out).toEqual([valid]);
    expect(out[0].okf_type).toBe('software_application');
  });

  it('uses the injected score function (stub flips the ranking)', () => {
    const rows = [row('aaa'), row('bbb')];
    const fact = { title: '', body: 'x' };
    const flipped = buildShortlist(fact, rows, 2, (_f, r) => (r.title === 'aaa' ? 0 : 1));
    expect(flipped.map((r) => r.title)).toEqual(['bbb', 'aaa']);
  });
});
