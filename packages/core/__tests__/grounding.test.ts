import { describe, it, expect } from 'vitest';
import {
  resolveGrounding, normalizeForGrounding, buildGroundingCorpus, checkGrounding, groundingOutcome,
  GROUNDING_VERIFIER, type ResolvedGrounding,
} from '../src/utils/grounding';
import { validateFact, normalizeEvidence, MAX_EVIDENCE_QUOTES } from '../src/utils/pure';

const cfg = resolveGrounding({ mode: 'draft' }) as ResolvedGrounding;

describe('resolveGrounding', () => {
  it('is null when absent or off', () => {
    expect(resolveGrounding(undefined)).toBeNull();
    expect(resolveGrounding({ mode: 'off', writers: ['ingest', 'librarian', 'heal'] })).toBeNull();
  });

  it('applies defaults', () => {
    expect(cfg.minEvidenceChars).toBe(20);
    expect(cfg.maxEvidence).toBe(3);
    expect(cfg.maxEvidenceChars).toBe(300);
    expect([...cfg.writers]).toEqual(['ingest']);
  });

  it('keeps only known writers and honors an explicit empty list', () => {
    const r = resolveGrounding({ mode: 'draft', writers: ['heal', 'bogus' as never, 'librarian'] })!;
    expect([...r.writers].sort()).toEqual(['heal', 'librarian']);
    expect([...resolveGrounding({ mode: 'draft', writers: [] })!.writers]).toEqual([]);
  });

  it('falls back to defaults for non-finite or sub-1 numbers', () => {
    const r = resolveGrounding({ mode: 'draft', minEvidenceChars: Number.NaN, maxEvidence: 0, maxEvidenceChars: -5 })!;
    expect([r.minEvidenceChars, r.maxEvidence, r.maxEvidenceChars]).toEqual([20, 3, 300]);
    expect(resolveGrounding({ mode: 'draft', minEvidenceChars: 7.9 })!.minEvidenceChars).toBe(7);
  });
});

describe('normalizeForGrounding / buildGroundingCorpus', () => {
  it('applies NFKC, collapses whitespace runs and trims, case preserved', () => {
    expect(normalizeForGrounding('  The ﬁrst  engine\n\n\tran  ')).toBe('The first engine ran');
  });

  it('joins string parts with a newline and ignores non-strings', () => {
    expect(buildGroundingCorpus(['alpha  beta', 42, undefined, 'gamma\ndelta'])).toBe('alpha beta gamma delta');
  });
});

describe('checkGrounding', () => {
  const corpus = buildGroundingCorpus(['The Analytical Engine was designed by Charles Babbage in 1837.']);

  it('grounds when every qualifying quote is found', () => {
    expect(checkGrounding(['designed by Charles Babbage in 1837'], corpus, cfg)).toEqual({
      status: 'grounded', retained: ['designed by Charles Babbage in 1837'],
    });
  });

  it('is missing with no evidence', () => {
    expect(checkGrounding(undefined, corpus, cfg)).toEqual({ status: 'missing', reason: 'no_evidence' });
    expect(checkGrounding([], corpus, cfg)).toEqual({ status: 'missing', reason: 'no_evidence' });
  });

  it('treats quotes shorter than minEvidenceChars as absent, not as passes', () => {
    expect(checkGrounding(['Babbage'], corpus, cfg)).toEqual({ status: 'missing', reason: 'evidence_too_short' });
    // A short fabricated quote is absent, so it neither fails nor grounds.
    expect(checkGrounding(['Lovelace', 'designed by Charles Babbage in 1837'], corpus, cfg).status).toBe('grounded');
  });

  it('fails on a fabricated quote, even beside a real one', () => {
    expect(checkGrounding(['designed by Ada Lovelace in 1843'], corpus, cfg)).toEqual({ status: 'failed', reason: 'quote_not_found' });
    expect(checkGrounding(['designed by Charles Babbage in 1837', 'designed by Ada Lovelace in 1843'], corpus, cfg))
      .toEqual({ status: 'failed', reason: 'quote_not_found' });
  });

  it('is case-sensitive and whitespace/NFKC-insensitive', () => {
    expect(checkGrounding(['the analytical engine was designed'], corpus, cfg).status).toBe('failed');
    expect(checkGrounding(['designed  by\nCharles Babbage'], corpus, cfg).status).toBe('grounded');
  });

  it('fails with too_many_quotes above the ceiling, counting short quotes too', () => {
    const eleven = ['designed by Charles Babbage in 1837', ...Array.from({ length: 10 }, () => 'x')];
    expect(checkGrounding(eleven, corpus, cfg)).toEqual({ status: 'failed', reason: 'too_many_quotes' });
    expect(checkGrounding(eleven.slice(0, 10), corpus, cfg).status).toBe('grounded');
  });

  it('caps what is retained, never what is checked', () => {
    const tight = resolveGrounding({ mode: 'draft', maxEvidence: 1, maxEvidenceChars: 25 })!;
    const r = checkGrounding(['The Analytical Engine was designed', 'Charles Babbage in 1837'], corpus, tight);
    expect(r).toEqual({ status: 'grounded', retained: ['The Analytical Engine was'] });
  });
});

describe('groundingOutcome', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  it('maps grounded to stable plus a process verifier', () => {
    expect(groundingOutcome({ status: 'grounded', retained: [] }, now)).toEqual({
      trust: {
        lifecycle_status: 'stable',
        okf_verified: [{ by: GROUNDING_VERIFIER, at: '2026-09-21T12:00:00.000Z' }],
        last_verified_at: now,
        last_verified_by: GROUNDING_VERIFIER,
      },
    });
  });
  it('maps missing and failed to draft plus a diagnostic', () => {
    expect(groundingOutcome({ status: 'missing', reason: 'no_evidence' }, now)).toEqual({
      trust: { lifecycle_status: 'draft' }, diagnostic: { code: 'grounding_missing', reason: 'no_evidence' },
    });
    expect(groundingOutcome({ status: 'failed', reason: 'too_many_quotes' }, now)).toEqual({
      trust: { lifecycle_status: 'draft' }, diagnostic: { code: 'grounding_failed', reason: 'too_many_quotes' },
    });
  });
});

describe('evidence validation', () => {
  it('trims, drops non-strings and empties, stops one past the ceiling', () => {
    expect(normalizeEvidence(['  a quote  ', 5, null, '   ', 'b'])).toEqual(['a quote', 'b']);
    expect(normalizeEvidence('not an array')).toBeUndefined();
    const many = Array.from({ length: 50 }, (_, i) => `q${i}`);
    expect(normalizeEvidence(many)).toHaveLength(MAX_EVIDENCE_QUOTES + 1);
  });

  it('validateFact carries normalized evidence and removes a non-array one', () => {
    const base = { title: 'T', body: 'B', tags: [], confidence: 'certain' };
    expect(validateFact({ ...base, evidence: [' q ', 3] })?.evidence).toEqual(['q']);
    const v = validateFact({ ...base, evidence: 'nope' });
    expect(v).not.toBeNull();
    expect(v && 'evidence' in v).toBe(false);
  });
});
