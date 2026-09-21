import type { OkfVerifiedEntry } from '@equationalapplications/core-okf';
import type { GroundingConfig } from '../types';
import { MAX_EVIDENCE_QUOTES, safeSlice } from './pure';

export type GroundingWriter = 'ingest' | 'librarian' | 'heal';

export interface ResolvedGrounding {
  writers: ReadonlySet<GroundingWriter>;
  minEvidenceChars: number;
  maxEvidence: number;
  maxEvidenceChars: number;
}

/** Actor recorded in `okf_verified` for a fact that passed the check. `process:` keeps the trust tier at machine-confirmed. */
export const GROUNDING_VERIFIER = 'process:grounding-check';

const WRITERS: readonly GroundingWriter[] = ['ingest', 'librarian', 'heal'];

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** `null` means grounding is off: no prompt change, no checks, no status or trust writes (spec §6.5). */
export function resolveGrounding(config: GroundingConfig | undefined): ResolvedGrounding | null {
  if (!config || config.mode !== 'draft') return null;
  const writers: GroundingWriter[] = Array.isArray(config.writers)
    ? config.writers.filter((w): w is GroundingWriter => WRITERS.includes(w as GroundingWriter))
    : ['ingest'];
  return {
    writers: new Set(writers),
    minEvidenceChars: positiveInt(config.minEvidenceChars, 20),
    maxEvidence: positiveInt(config.maxEvidence, 3),
    maxEvidenceChars: positiveInt(config.maxEvidenceChars, 300),
  };
}

/** Spec §6.4 step 1: NFKC, collapse every whitespace run to one space, trim. Case is preserved. */
export function normalizeForGrounding(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Build the normalized corpus from the raw in-memory values the model was
 * shown (spec §6.3). Never pass serialized prompt text: JSON escapes would
 * cause false `quote_not_found`. Non-string parts are ignored.
 */
export function buildGroundingCorpus(parts: readonly unknown[]): string {
  return normalizeForGrounding(parts.filter((p): p is string => typeof p === 'string').join('\n'));
}

export type GroundingReason = 'no_evidence' | 'evidence_too_short' | 'quote_not_found' | 'too_many_quotes';

export type GroundingVerdict =
  | { status: 'grounded'; retained: string[] }
  | { status: 'missing'; reason: 'no_evidence' | 'evidence_too_short' }
  | { status: 'failed'; reason: 'quote_not_found' | 'too_many_quotes' };

/**
 * Deterministic check (spec §6.2, §6.4). `evidence` is `validateFact`'s
 * normalized list; `normalizedCorpus` comes from {@link buildGroundingCorpus}.
 * Every quote is checked before any retention cap applies.
 */
export function checkGrounding(
  evidence: readonly string[] | undefined,
  normalizedCorpus: string,
  cfg: ResolvedGrounding,
): GroundingVerdict {
  const quotes = evidence ?? [];
  if (quotes.length > MAX_EVIDENCE_QUOTES) return { status: 'failed', reason: 'too_many_quotes' };
  if (quotes.length === 0) return { status: 'missing', reason: 'no_evidence' };
  const qualifying = quotes.map(normalizeForGrounding).filter((q) => q.length >= cfg.minEvidenceChars);
  if (qualifying.length === 0) return { status: 'missing', reason: 'evidence_too_short' };
  if (qualifying.some((q) => !normalizedCorpus.includes(q))) return { status: 'failed', reason: 'quote_not_found' };
  return {
    status: 'grounded',
    retained: qualifying.slice(0, cfg.maxEvidence).map((q) => safeSlice(q, 0, cfg.maxEvidenceChars)),
  };
}

/** Insert-time trust fields. Spread onto a new `WikiFact`; `EntryRepository.upsert` writes them on INSERT only. */
export interface GroundingTrust {
  lifecycle_status: 'stable' | 'draft';
  okf_verified?: OkfVerifiedEntry[];
  last_verified_at?: number;
  last_verified_by?: string;
}

export interface GroundingOutcome {
  trust: GroundingTrust;
  /** Present exactly when the fact lands as a draft. */
  diagnostic?: { code: 'grounding_missing' | 'grounding_failed'; reason: GroundingReason };
}

/** Spec §6.5. */
export function groundingOutcome(verdict: GroundingVerdict, now: number): GroundingOutcome {
  if (verdict.status === 'grounded') {
    return {
      trust: {
        lifecycle_status: 'stable',
        okf_verified: [{ by: GROUNDING_VERIFIER, at: new Date(now).toISOString() }],
        last_verified_at: now,
        last_verified_by: GROUNDING_VERIFIER,
      },
    };
  }
  return {
    trust: { lifecycle_status: 'draft' },
    diagnostic: { code: verdict.status === 'missing' ? 'grounding_missing' : 'grounding_failed', reason: verdict.reason },
  };
}
