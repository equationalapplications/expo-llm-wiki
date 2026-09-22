# PR 3 — Grounding Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, deterministic evidence check. LLM-authored facts that cannot quote the source the model was shown land as `draft`. Grounded facts land `stable` with a `process:grounding-check` verifier. Nothing changes by default.

**Architecture:**
- **Pure core.** A new `utils/grounding.ts` resolves the config, builds a normalized corpus, checks quotes, and maps a verdict to the trust fields and the diagnostic.
- **Prompt block and corpus.** `PromptService` owns the resolved config. It appends the evidence block only for writers in `grounding.writers`. For heal it also adds clipped anchor bodies to the prompt and returns the corpus built from exactly what that prompt showed.
- **Ingest, librarian and heal** check each fact against its own corpus and write the status and trust **at insert**, in the fact's own transaction. Grounding diagnostics go through each operation's existing `DiagnosticBuffer`.
- **Ingest trust side channel.** Ingest passes trust into `upsertGraphCore` through a side channel keyed by node id (`opts.nodeTrust`). The public `upsertGraph` never passes it, so host nodes can never be grounded or smuggle a status in.

**Tech Stack:** TypeScript 5.9 (strict), vitest, pnpm workspace, better-sqlite3 in tests.

**Spec:** `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md`, **rev 7** (committed on this branch as `0138f33`). §6 is this PR; REQ-COMPAT-01 and REQ-DIAG-02/03 apply. If this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Worktree: `.worktrees/pr3-grounding`, branch `feat/grounding-check`, based on `main` @ `0515831` (PRs 1, 2 and 4 merged). Run every command from the worktree root.
- One-time setup (already done by the plan author; re-run if `node_modules` is missing): `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`. The baseline is 1413/1413 core tests.
- Run one test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`. Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- **Default off:** `WikiConfig.grounding` absent, or with `mode: 'off'`, gives byte-identical prompts, no evidence checks and no status or trust writes (§6.5).
- **Writer scope:** `grounding.writers` defaults to `['ingest']`. A writer outside the list gets no evidence block, no check, and its facts are written exactly as today (§6.2).
- **Corpus (§6.3, rev 7):**
  - ingest: the chunk text;
  - librarian: event `summary` values;
  - heal: the `summary` values of the events in that exact prompt, plus the clipped bodies of the **non-draft** anchors in that exact prompt.
  - Never serialized prompt text, never fact bodies, never identifiers.
- **Check (§6.4):**
  - Normalize both sides the same way: NFKC, then collapse each whitespace run to one space, then trim. Case-sensitive.
  - More than 10 non-empty string quotes → `grounding_failed` / `too_many_quotes`, checked first.
  - Quotes shorter than `minEvidenceChars` (measured after normalization) count as absent.
  - Grounded iff at least one qualifying quote exists and none fails.
- **Outcomes (§6.5):**
  - grounded → `lifecycle_status: 'stable'`, `okf_verified: [{ by: 'process:grounding-check', at: <ISO> }]`, `last_verified_by` / `last_verified_at` set to match;
  - missing → `draft` plus `grounding_missing` (warn);
  - failed → `draft` plus `grounding_failed` (warn).
  - Evidence quotes are **not** persisted.
- **Diagnostics (REQ-DIAG-03):** `detail` carries IDs and reason slugs only, never quotes or bodies.
  - Ingest: `{ factId, sourceRef, chunkIndex, itemIndex, reason }`.
  - Librarian and heal: `{ factId, itemIndex, reason }`.
  - Reasons: `no_evidence`, `evidence_too_short`, `quote_not_found`, `too_many_quotes`.
  - Never aggregated.
- **Heal anchor bodies (rev 7):** only when heal is a grounding writer. Each anchor is shown as `{ id, title, source_ref, body }`, with `body` clipped to `HEAL_ANCHOR_BODY_CHARS` = 800 by `safeSlice`. `lifecycle_status` is never shown.
- **Don't break pinned call shapes.** PR 2's review found exact-arity `toHaveBeenCalledWith` assertions.
  - Call `findAnchorRowsByIds` with the extra options argument **only** when bodies are wanted.
  - Pass `nodeTrust` to `upsertGraphCore` only from ingest.
- Commits: conventional commits. End every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** start a body line with `BREAKING CHANGE`. This PR is a `feat` minor release.
- Merge convention: regular merge commit, never squash. Do not merge the PR yourself.
- Don't edit the series spec beyond rev 7 (already committed). If a new spec conflict appears, stop and ask.
- **Never put `expect` inside a fake `generateText`.** Core catches provider errors (a heal call error becomes `heal_skipped`), so a failed assertion there is swallowed. Capture prompts into a variable and assert after the operation resolves.
- Never use bare `git stash`; use WIP commits.

## File map

| File | Change |
|---|---|
| `packages/core/src/utils/grounding.ts` | **new**: `resolveGrounding`, `normalizeForGrounding`, `buildGroundingCorpus`, `checkGrounding`, `groundingOutcome`, types |
| `packages/core/src/utils/pure.ts` | `MAX_EVIDENCE_QUOTES`, `normalizeEvidence`; `validateFact` normalizes `evidence` |
| `packages/core/src/types.ts` | `GroundingConfig`, `WikiConfig.grounding`, `ExtractedFact.evidence` |
| `packages/core/src/prompts.ts` | `groundingEvidenceBlock(writer, cfg)` |
| `packages/core/src/utils/healConstants.ts` | `HEAL_ANCHOR_BODY_CHARS` |
| `packages/core/src/services/PromptService.ts` | grounding ctor arg, `groundingFor`, block append, heal anchor bodies and `groundingCorpus` |
| `packages/core/src/WikiMemory.ts` | pass `resolveGrounding(config.grounding)` to `PromptService` |
| `packages/core/src/services/IngestionService.ts` | per-chunk verdicts, ledger, `nodeTrust`, partial path, fallback `PromptService` wiring |
| `packages/core/src/services/BoundedLlmCall.ts` | `parse` receives the `prompts` object as a third argument |
| `packages/core/src/repositories/EntryRepository.ts` | `findAnchorRowsByIds(..., opts?: { withBody?: boolean })` |
| `packages/core/src/services/MaintenanceService.ts` | librarian grounding; heal grounding (bodies, per-prompt corpus) |
| `packages/core/__tests__/grounding*.test.ts`, `helpers/groundingHarness.ts` | **new** tests |
| `packages/core/README.md` | `## Grounding` section after `## Draft Review` |

---

### Task 1: Pure grounding module, config types, evidence validation

**Files:**
- Create: `packages/core/src/utils/grounding.ts`
- Modify: `packages/core/src/utils/pure.ts` (`validateFact` at ~line 831; new helpers directly above it)
- Modify: `packages/core/src/types.ts` (`WikiConfig`, which ends at ~line 297 after `excludeDrafts`; `ExtractedFact` at ~line 511)
- Test: `packages/core/__tests__/grounding.test.ts`

**Interfaces:**
- Produces:
  - `export interface GroundingConfig { mode: 'off' | 'draft'; writers?: Array<'ingest' | 'librarian' | 'heal'>; minEvidenceChars?: number; maxEvidence?: number; maxEvidenceChars?: number }` and `WikiConfig.grounding?: GroundingConfig` (types.ts)
  - `ExtractedFact.evidence?: string[]`
  - `pure.ts`: `export const MAX_EVIDENCE_QUOTES = 10`; `export function normalizeEvidence(raw: unknown): string[] | undefined`
  - `grounding.ts`:
    - `type GroundingWriter = 'ingest' | 'librarian' | 'heal'`
    - `interface ResolvedGrounding { writers: ReadonlySet<GroundingWriter>; minEvidenceChars: number; maxEvidence: number; maxEvidenceChars: number }`
    - `GROUNDING_VERIFIER = 'process:grounding-check'`
    - `resolveGrounding(config: GroundingConfig | undefined): ResolvedGrounding | null`
    - `normalizeForGrounding(text: string): string`
    - `buildGroundingCorpus(parts: readonly unknown[]): string`
    - `type GroundingVerdict`
    - `checkGrounding(evidence: readonly string[] | undefined, normalizedCorpus: string, cfg: ResolvedGrounding): GroundingVerdict`
    - `interface GroundingTrust`
    - `interface GroundingOutcome { trust: GroundingTrust; diagnostic?: { code: 'grounding_missing' | 'grounding_failed'; reason: GroundingReason } }`
    - `groundingOutcome(verdict: GroundingVerdict, now: number): GroundingOutcome`

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/grounding.test.ts`:

```ts
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
    expect(normalizeForGrounding('  The ﬁrst  engine\n\n\tran  ')).toBe('The first engine ran');
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
    expect(checkGrounding(['designed  by\nCharles Babbage'], corpus, cfg).status).toBe('grounded');
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
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/grounding.test.ts`. Expected: FAIL, because `../src/utils/grounding` does not exist.

- [ ] **Step 3: Add the types.** In `packages/core/src/types.ts`, directly above `export interface WikiConfig {`, add:

```ts
/**
 * Opt-in evidence check for LLM-authored facts (spec §6). Default off: 7.x
 * write behavior is unchanged. In `'draft'` mode, writers in `writers` must
 * quote their source; a fact whose quotes are missing or not found is stored
 * as a `draft` instead of being rejected.
 */
export interface GroundingConfig {
  mode: 'off' | 'draft';
  /** Default `['ingest']`. The librarian and heal synthesize across events; measure their pass rates before opting them in. */
  writers?: Array<'ingest' | 'librarian' | 'heal'>;
  /** Quotes shorter than this (after whitespace normalization) count as absent. Default 20. */
  minEvidenceChars?: number;
  /** Quotes retained per fact. Retention only; every quote is checked. Default 3. */
  maxEvidence?: number;
  /** Characters retained per quote. Default 300. */
  maxEvidenceChars?: number;
}
```

Inside `WikiConfig`, after the `excludeDrafts?: boolean;` member, add:

```ts
  /** Evidence check for LLM-authored facts (spec §6). Default off. */
  grounding?: GroundingConfig;
```

In `ExtractedFact`, add after `confidence`:

```ts
  /** Quotes the model copied from its source; see `WikiConfig.grounding`. Never persisted. */
  evidence?: string[];
```

- [ ] **Step 4: Add evidence validation** in `packages/core/src/utils/pure.ts`, directly above `export function validateFact`:

```ts
/** Hard ceiling on evidence quotes per fact (spec §6.2). More than this makes the fact ungrounded. */
export const MAX_EVIDENCE_QUOTES = 10;

/**
 * Normalize a fact's raw `evidence`: an array of strings, each trimmed, with
 * non-strings and empty entries ignored. Collection stops one entry past the
 * ceiling, which is enough to decide `too_many_quotes` without trimming an
 * unbounded array. Returns undefined when `raw` is not an array.
 */
export function normalizeEvidence(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length > MAX_EVIDENCE_QUOTES) break;
  }
  return out;
}
```

Replace the body of `validateFact` with:

```ts
export function validateFact(fact: any): ExtractedFact | null {
  if (typeof fact?.title !== 'string' || typeof fact?.body !== 'string') return null;
  const title = clip(fact.title, 80);
  const body = clip(fact.body, 800);
  if (!title || !body) return null;

  let confidence = fact.confidence;
  if (confidence !== 'certain' && confidence !== 'tentative') confidence = 'inferred';

  const valid: ExtractedFact = {
    ...fact,
    title,
    body,
    confidence,
    tags: validateTags(fact.tags)
  };
  const evidence = normalizeEvidence(fact.evidence);
  if (evidence) valid.evidence = evidence;
  else delete valid.evidence;
  return valid;
}
```

- [ ] **Step 5: Create `packages/core/src/utils/grounding.ts`:**

```ts
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
```

If the `OkfVerifiedEntry` import from `@equationalapplications/core-okf` fails typecheck, import it the way `types.ts` does (its line 2–6 import block) and report the change.

- [ ] **Step 6: Run the test and confirm it passes.** Same command as Step 2. Expected: PASS. Then run the full core suite. Expected: 1413 + the new tests, all green. `validateFact` callers only see a normalized `evidence` key.

- [ ] **Step 7: Typecheck.** Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`. Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/utils/grounding.ts packages/core/src/utils/pure.ts packages/core/src/types.ts packages/core/__tests__/grounding.test.ts
git commit -m "feat(core): add grounding config, evidence validation and deterministic check

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Evidence prompt block, heal anchor bodies and the heal corpus

**Files:**
- Modify: `packages/core/src/prompts.ts` (append a function at the end)
- Modify: `packages/core/src/utils/healConstants.ts` (append a constant)
- Modify: `packages/core/src/services/PromptService.ts` (constructor at line 16; `buildIngestPrompt` 55–72; `buildLibrarianPrompt` 74–95; `buildHealPrompt` 119–177)
- Modify: `packages/core/src/WikiMemory.ts:127` and `packages/core/src/services/IngestionService.ts:60` (constructor wiring)
- Test: `packages/core/__tests__/groundingPrompt.test.ts`

**Interfaces:**
- Consumes: `ResolvedGrounding`, `GroundingWriter`, `resolveGrounding`, `buildGroundingCorpus` (Task 1).
- Produces:
  - `groundingEvidenceBlock(writer: GroundingWriter, cfg: ResolvedGrounding): string` (prompts.ts)
  - `HEAL_ANCHOR_BODY_CHARS = 800`
  - `new PromptService(globalOverrides?: PromptOverrides, grounding?: ResolvedGrounding | null)`
  - `PromptService.groundingFor(writer: GroundingWriter): ResolvedGrounding | null`
  - `buildHealPrompt(...)` returns `{ prompts; degraded; groundingCorpus?: string }`. `groundingCorpus` is present **only** when heal is a grounding writer.
  - Heal anchors passed in may carry `body?: string` and `lifecycle_status?: string`.

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/groundingPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PromptService } from '../src/services/PromptService';
import { resolveGrounding } from '../src/utils/grounding';
import { HEAL_ANCHOR_BODY_CHARS } from '../src/utils/healConstants';
import type { OntologyPromptContext } from '../src/types';

const MARK = 'EVIDENCE REQUIREMENT';
const all = resolveGrounding({ mode: 'draft', writers: ['ingest', 'librarian', 'heal'] });
const ingestOnly = resolveGrounding({ mode: 'draft' });
const ctx = { ontologyManifest: '{}', ontologyModeInstructions: 'ONTOLOGY MODE TEXT' } as OntologyPromptContext;

const candidates = [{ id: 'c1', title: 'Candidate', body: 'candidate body text that is long enough' }];
const events = [{ id: 'evt_1', event_type: 'observation', summary: 'Operator observed the engine printing tables', created_at: 1 }];
const anchors = [
  { id: 'a1', title: 'Stable anchor', source_ref: 'doc.md', body: 'x'.repeat(HEAL_ANCHOR_BODY_CHARS + 200), lifecycle_status: 'stable' },
  { id: 'a2', title: 'Draft anchor', source_ref: 'doc.md', body: 'draft anchor body sentence here', lifecycle_status: 'draft' },
];

function allPrompts(svc: PromptService) {
  return [
    svc.buildIngestPrompt('chunk', undefined, ctx),
    svc.buildIngestPrompt('chunk', 'Custom {{documentChunk}}', null),
    svc.buildLibrarianPrompt(events, [], undefined, ctx),
    svc.buildLibrarianPrompt(events, [], 'Lib {{events}}', null),
    svc.buildHealPrompt(candidates, anchors.map(({ id, title, source_ref }) => ({ id, title, source_ref })), [], events, undefined, 0),
    svc.buildHealPrompt(candidates, [], [], events, 'Heal {{healCandidates}}', 0),
    svc.buildOntologyBackfillPrompt([], undefined, ctx),
  ];
}

describe('grounding prompt block', () => {
  it('off, or on with no writers, is byte-identical to no config', () => {
    const baseline = allPrompts(new PromptService());
    expect(allPrompts(new PromptService(undefined, null))).toEqual(baseline);
    expect(allPrompts(new PromptService(undefined, resolveGrounding({ mode: 'draft', writers: [] })))).toEqual(baseline);
    expect(allPrompts(new PromptService(undefined, resolveGrounding({ mode: 'off', writers: ['ingest', 'librarian', 'heal'] })))).toEqual(baseline);
  });

  it('appends the block last for in-scope writers, after overrides and ontology context', () => {
    const svc = new PromptService({ ingestSystemPrompt: 'Custom ingest.' }, all);
    const ingest = svc.buildIngestPrompt('chunk', undefined, ctx).systemPrompt;
    expect(ingest.startsWith('Custom ingest.\n\nONTOLOGY MODE TEXT\n\n')).toBe(true);
    expect(ingest.indexOf(MARK)).toBeGreaterThan(ingest.indexOf('ONTOLOGY MODE TEXT'));
    expect(svc.buildIngestPrompt('chunk', 'Tpl {{documentChunk}}', null).systemPrompt).toContain(MARK);
    expect(svc.buildLibrarianPrompt(events, [], undefined, null).systemPrompt).toContain(MARK);
    expect(svc.buildLibrarianPrompt(events, [], 'Lib {{events}}', ctx).systemPrompt).toContain(MARK);
    expect(svc.buildOntologyBackfillPrompt([], undefined, ctx).systemPrompt).not.toContain(MARK);
  });

  it('adds no block for writers outside grounding.writers', () => {
    const svc = new PromptService(undefined, ingestOnly);
    expect(svc.groundingFor('ingest')).not.toBeNull();
    expect(svc.groundingFor('librarian')).toBeNull();
    expect(svc.buildLibrarianPrompt(events, [], undefined, null).systemPrompt).not.toContain(MARK);
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0).prompts.systemPrompt).not.toContain(MARK);
    expect('groundingCorpus' in svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0)).toBe(false);
  });
});

describe('heal grounding prompt and corpus', () => {
  const svc = new PromptService(undefined, all);

  it('appends the block in both template branches', () => {
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0).prompts.systemPrompt).toContain(MARK);
    const placeholder = svc.buildHealPrompt(candidates, anchors, [], events, 'Heal {{documentAnchors}}', 0);
    expect(placeholder.prompts.systemPrompt).toContain(MARK);
    expect(placeholder.prompts.systemPrompt).toContain('draft anchor body sentence here');
  });

  it('shows clipped anchor bodies and never lifecycle_status', () => {
    const { prompts } = svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0);
    expect(prompts.userPrompt).toContain('"body": "' + 'x'.repeat(HEAL_ANCHOR_BODY_CHARS) + '"');
    expect(prompts.userPrompt).not.toContain('x'.repeat(HEAL_ANCHOR_BODY_CHARS + 1));
    expect(prompts.userPrompt).not.toContain('lifecycle_status');
  });

  it('builds the corpus from event summaries and non-draft anchor bodies only', () => {
    const { groundingCorpus } = svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0);
    expect(groundingCorpus).toContain('Operator observed the engine printing tables');
    expect(groundingCorpus).toContain('x'.repeat(HEAL_ANCHOR_BODY_CHARS));
    expect(groundingCorpus).not.toContain('draft anchor body');
    expect(groundingCorpus).not.toContain('candidate body text');
    expect(groundingCorpus).not.toContain('evt_1');
    expect(groundingCorpus).not.toContain('observation');
  });

  it('drops events from the corpus at L2 and above', () => {
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 1).groundingCorpus).toContain('Operator observed');
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 2).groundingCorpus).not.toContain('Operator observed');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingPrompt.test.ts`. Expected: FAIL (`HEAL_ANCHOR_BODY_CHARS` is undefined and `PromptService` ignores the second argument).

- [ ] **Step 3: Add the constant and the block text.** Append to `packages/core/src/utils/healConstants.ts`:

```ts
/**
 * Clip for a document anchor's body in the heal prompt. Bodies are shown only
 * when heal is a grounding writer (spec §6.2, rev 7). Host `upsertGraph` nodes
 * are anchors too and have no body limit, so the clip bounds the prompt.
 */
export const HEAL_ANCHOR_BODY_CHARS = 800;
```

Append to `packages/core/src/prompts.ts` (add `import type { GroundingWriter, ResolvedGrounding } from './utils/grounding';` at the top):

```ts
const GROUNDING_SOURCE: Record<GroundingWriter, { key: string; source: string }> = {
  ingest: { key: 'facts', source: 'the document chunk' },
  librarian: { key: 'facts', source: 'the "summary" text of the events' },
  heal: { key: 'newFacts', source: 'the "summary" text of the recent events or the "body" text of the document anchors' },
};

/** Evidence instruction appended to an in-scope writer's system prompt (spec §6.2). */
export function groundingEvidenceBlock(writer: GroundingWriter, cfg: ResolvedGrounding): string {
  const { key, source } = GROUNDING_SOURCE[writer];
  return `EVIDENCE REQUIREMENT: every object in "${key}" must also carry an "evidence" array of 1 to ${cfg.maxEvidence} quotes. Each quote must be an exact substring copied character-for-character from ${source} (the SOURCE section), at least ${cfg.minEvidenceChars} characters long. Do not paraphrase. Do not quote these instructions, the ontology manifest, or any existing fact. A fact whose quotes cannot be found in the SOURCE section is stored as an unreviewed draft.
"evidence": ["exact substring copied from the SOURCE section"]`;
}
```

- [ ] **Step 4: Update `PromptService`.** Imports: add `groundingEvidenceBlock` to the `../prompts` import; add `HEAL_ANCHOR_BODY_CHARS` to the `../utils/healConstants` import; add `import { buildGroundingCorpus, type GroundingWriter, type ResolvedGrounding } from '../utils/grounding';`.

Replace the constructor with:

```ts
  constructor(
    private globalOverrides?: PromptOverrides,
    private grounding: ResolvedGrounding | null = null,
  ) {}

  /** The resolved grounding config when `writer` is in `grounding.writers`; otherwise null (spec §6.2). */
  groundingFor(writer: GroundingWriter): ResolvedGrounding | null {
    return this.grounding?.writers.has(writer) ? this.grounding : null;
  }

  /** Appended after any override and after ontology context, so it is always last. */
  private appendGrounding(systemPrompt: string, writer: GroundingWriter): string {
    const cfg = this.groundingFor(writer);
    return cfg ? `${systemPrompt}\n\n${groundingEvidenceBlock(writer, cfg)}` : systemPrompt;
  }
```

In `buildIngestPrompt` and `buildLibrarianPrompt`, wrap the `systemPrompt` value of **both** `return` statements. For example, the ingest placeholder branch becomes `systemPrompt: this.appendGrounding(this.buildSystemPrompt(template, { documentChunk }, ontologyContext), 'ingest'),` and its default branch becomes `systemPrompt: this.appendGrounding(this.appendOntology(template, ontologyContext), 'ingest'),`. Do the same with `'librarian'`. Leave `buildOntologyBackfillPrompt` unchanged.

Replace `buildHealPrompt` with the following. Only the lines marked `// grounding` differ from the current method:

```ts
  buildHealPrompt(
    healCandidates: unknown[],
    documentAnchors: unknown[],
    allTasks: unknown[],
    recentEvents: unknown[],
    runtimeOverride: string | undefined,
    attemptLevel: 0 | 1 | 2 | 3,
    bodyTruncationChars: number = HEAL_MAX_FACT_BODY_CHARS_L3,
  ): { prompts: { systemPrompt: string; userPrompt: string }; degraded: DegradedRecord[]; groundingCorpus?: string } {
    // L0: all context. L1: drop allTasks. L2: also drop recentEvents.
    const effectiveTasks = attemptLevel >= 1 ? [] : allTasks;
    const effectiveEvents = attemptLevel >= 2 ? [] : recentEvents;

    const maxAnchors = Math.max(1, Math.min(HEAL_MAX_ANCHORS, healCandidates.length * HEAL_ANCHORS_PER_CANDIDATE));
    const effectiveAnchors = documentAnchors.slice(0, maxAnchors);

    // grounding: only when heal is a grounding writer do anchors show a
    // clipped body, and the corpus is built from exactly what this prompt
    // shows (spec §6.3, rev 7). lifecycle_status decides corpus membership
    // but is never shown to the model.
    const healGrounding = this.groundingFor('heal');
    const promptAnchors = healGrounding ? effectiveAnchors.map(toGroundingAnchor) : effectiveAnchors;
    const groundingCorpus = healGrounding
      ? buildGroundingCorpus([
          ...effectiveEvents.map((e) => (e as { summary?: unknown } | null)?.summary),
          ...effectiveAnchors
            .map((a, i) => ({ status: (a as { lifecycle_status?: unknown } | null)?.lifecycle_status, shown: promptAnchors[i] }))
            .filter((x) => x.status !== 'draft')
            .map((x) => (x.shown as { body?: unknown } | null)?.body),
        ])
      : null;

    const { shapedCandidates, degraded } = applyBodyTruncation(
      healCandidates,
      attemptLevel,
      bodyTruncationChars,
    );
    const corpusField = groundingCorpus !== null ? { groundingCorpus } : {}; // grounding

    const template = runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
    if (
      /\{\{\s*healCandidates\s*\}\}/.test(template) ||
      /\{\{\s*documentAnchors\s*\}\}/.test(template) ||
      /\{\{\s*allTasks\s*\}\}/.test(template) ||
      /\{\{\s*recentEvents\s*\}\}/.test(template)
    ) {
      return {
        prompts: {
          systemPrompt: this.appendGrounding(this.hydrate(template, {
            healCandidates: shapedCandidates,
            documentAnchors: promptAnchors,
            allTasks: effectiveTasks,
            recentEvents: effectiveEvents,
          }), 'heal'),
          userPrompt: 'Please heal the memory graph.',
        },
        degraded,
        ...corpusField,
      };
    }
    return {
      prompts: {
        systemPrompt: this.appendGrounding(template, 'heal'),
        userPrompt: `Heal Candidates:\n${JSON.stringify(shapedCandidates, null, 2)}\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(promptAnchors, null, 2)}\nAll Tasks:\n${JSON.stringify(effectiveTasks, null, 2)}\nRecent Events:\n${JSON.stringify(effectiveEvents, null, 2)}\nThe following document anchors are provided for contradiction detection only. Do not include them in \`downgraded\`, \`deleted\`, or \`newFacts\`.`,
      },
      degraded,
      ...corpusField,
    };
  }
```

Keep the method's existing doc comment and inline comments above the lines that are unchanged. Add this module-level helper after `applyBodyTruncation`:

```ts
/** Prompt shape of a heal anchor when heal is a grounding writer: body clipped, lifecycle_status hidden. */
function toGroundingAnchor(anchor: unknown): unknown {
  if (typeof anchor !== 'object' || anchor === null) return anchor;
  const a = anchor as { id?: unknown; title?: unknown; source_ref?: unknown; body?: unknown };
  return {
    id: a.id,
    title: a.title,
    source_ref: a.source_ref,
    body: typeof a.body === 'string' ? safeSlice(a.body, 0, HEAL_ANCHOR_BODY_CHARS) : '',
  };
}
```

- [ ] **Step 5: Wire the resolved config.**
  - `packages/core/src/WikiMemory.ts:127`: `this.promptService = new PromptService(options.config?.prompts, resolveGrounding(options.config?.grounding));`, and import `resolveGrounding` from `./utils/grounding`.
  - `packages/core/src/services/IngestionService.ts:60`: `this.promptService = promptService ?? new PromptService(this.options.config?.prompts, resolveGrounding(this.options.config?.grounding));`, and import it from `../utils/grounding`.

- [ ] **Step 6: Run the new test, then the prompt and heal suites.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingPrompt.test.ts __tests__/PromptService.test.ts __tests__/librarianPrompt.test.ts __tests__/healBounding.test.ts __tests__/healAnchorBounding.test.ts`. Expected: all PASS. The existing tests prove the grounding-off path is unchanged. If an existing test fails, the off path changed; fix the implementation, never the test.

- [ ] **Step 7: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/prompts.ts packages/core/src/utils/healConstants.ts packages/core/src/services/PromptService.ts packages/core/src/WikiMemory.ts packages/core/src/services/IngestionService.ts packages/core/__tests__/groundingPrompt.test.ts
git commit -m "feat(core): append the evidence block for grounding writers and build the heal corpus

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Ingest grounding (full and partial paths)

**Files:**
- Create: `packages/core/__tests__/helpers/groundingHarness.ts`
- Modify: `packages/core/src/services/IngestionService.ts`:
  - chunk closure 146–173;
  - collection loop 226–259;
  - the two write calls 289–307;
  - `upsertGraphCore` opts (line 462) and `wikiFact` construction (500–522);
  - `runFullUpsertGraph` 644–768;
  - `appendPartialFacts` 790–871.
- Test: `packages/core/__tests__/groundingIngest.test.ts`

**Interfaces:**
- Consumes:
  - `PromptService.groundingFor` (Task 2);
  - `buildGroundingCorpus`, `checkGrounding`, `groundingOutcome`, `GroundingVerdict`, `GroundingTrust` (Task 1).
- Produces:
  - `upsertGraphCore(..., opts?: { strict?: boolean; diag?: ...; nodeTrust?: ReadonlyMap<string, GroundingTrust> })`. Only ingest passes `nodeTrust`.
  - The test helpers `factRows(db, entityId?)` and `HASH_A`/`HASH_B` (re-exported).

- [ ] **Step 1: Create the shared test helper** `packages/core/__tests__/helpers/groundingHarness.ts`:

```ts
import type { SQLiteAdapter } from '../../src/types';
export { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A, HASH_B } from './diagnosticsHarness';

export interface FactRow {
  id: string;
  title: string;
  source_type: string;
  source_hash: string | null;
  lifecycle_status: string;
  okf_verified: Array<{ by: string; at: string }> | null;
  last_verified_by: string | null;
  last_verified_at: number | null;
}

/** Live facts for an entity with their trust columns, ordered by title. */
export async function factRows(db: SQLiteAdapter, entityId = 'e1'): Promise<FactRow[]> {
  const rows = await db.getAllAsync<Omit<FactRow, 'okf_verified'> & { okf_verified: string | null }>(
    `SELECT id, title, source_type, source_hash, lifecycle_status, okf_verified, last_verified_by, last_verified_at
       FROM llm_wiki_entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY title`,
    [entityId],
  );
  return rows.map((r) => ({ ...r, okf_verified: r.okf_verified ? JSON.parse(r.okf_verified) : null }));
}

export const GROUNDED = [{ by: 'process:grounding-check', at: expect.any(String) }];
```

Add `import { expect } from 'vitest';` at the top of that file.

- [ ] **Step 2: Write the failing tests** in `packages/core/__tests__/groundingIngest.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED, HASH_A } from './helpers/groundingHarness';
import type { OntologyManifest } from '../src/types';

const DOC = 'The Analytical Engine was designed by Charles Babbage in 1837.';
const ON = { grounding: { mode: 'draft' as const } };
const REAL = 'designed by Charles Babbage in 1837';
const FAKE = 'designed by Ada Lovelace in 1843';
const fact = (title: string, evidence?: unknown) => ({ title, body: `${title} body`, tags: [], confidence: 'certain', ...(evidence !== undefined ? { evidence } : {}) });
const respond = (...facts: object[]) => async () => JSON.stringify({ facts });

afterEach(() => vi.restoreAllMocks());

async function ingest(config: object, gen: () => Promise<string>, doc = DOC) {
  const h = await makeDiagnosticWiki({ config, generateText: gen });
  await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: doc });
  return h;
}

describe('ingest grounding (full path)', () => {
  it('grounded fact lands stable with a process verifier and no grounding diagnostic', async () => {
    const { db, diagnostics } = await ingest(ON, respond(fact('Grounded', [REAL])));
    const [row] = await factRows(db);
    expect(row).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED, last_verified_by: 'process:grounding-check' });
    expect(row.last_verified_at).toEqual(expect.any(Number));
    expect(diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it.each([
    ['no evidence', undefined, 'grounding_missing', 'no_evidence'],
    ['short evidence', ['Babbage'], 'grounding_missing', 'evidence_too_short'],
    ['fabricated quote', [FAKE], 'grounding_failed', 'quote_not_found'],
    ['mixed real and fabricated', [REAL, FAKE], 'grounding_failed', 'quote_not_found'],
    ['instruction text', ['Return ONLY a valid JSON object matching this schema'], 'grounding_failed', 'quote_not_found'],
    ['case mismatch', ['the analytical engine was designed'], 'grounding_failed', 'quote_not_found'],
    ['eleven quotes', [REAL, ...Array.from({ length: 10 }, () => 'x')], 'grounding_failed', 'too_many_quotes'],
  ])('%s → draft with %s/%s and locators, no content', async (_label, evidence, code, reason) => {
    const { db, diagnostics } = await ingest(ON, respond(fact('Other', [REAL]), fact('Target', evidence)));
    const rows = await factRows(db);
    const target = rows.find((r) => r.title === 'Target')!;
    expect(target).toMatchObject({ lifecycle_status: 'draft', okf_verified: null, last_verified_by: null });
    expect(ofCode(diagnostics, code as never)).toEqual([expect.objectContaining({
      severity: 'warn', operation: 'ingest', trigger: 'call', entityId: 'e1',
      detail: { factId: target.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason },
    })]);
    expectNoContent(diagnostics, [REAL, FAKE, 'Target body', 'Babbage']);
  });

  it('a quote of the ontology manifest text fails', async () => {
    const manifest: OntologyManifest = {
      node_types: [{ type: 'machine', description: 'A calculating machine designed by an inventor' }],
      edge_types: [],
    };
    const h = await makeDiagnosticWiki({ config: ON, generateText: respond(fact('M', ['A calculating machine designed by an inventor'])) });
    await h.wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(h.generateText.mock.calls[0][0].systemPrompt).toContain('A calculating machine designed by an inventor');
    expect((await factRows(h.db))[0].lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_failed')).toHaveLength(1);
  });

  it('normalizes NFKC and whitespace end to end', async () => {
    const { db } = await ingest(ON, respond(fact('Lig', ['The first difference engine ran'])), 'The ﬁrst   difference\nengine ran in 1991.');
    expect((await factRows(db))[0].lifecycle_status).toBe('stable');
  });

  it('ingest outside grounding.writers: no block, facts stable, trust untouched', async () => {
    const h = await ingest({ grounding: { mode: 'draft', writers: ['librarian'] } }, respond(fact('Plain')));
    expect(h.generateText.mock.calls[0][0].systemPrompt).not.toContain('EVIDENCE REQUIREMENT');
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });
});

describe('ingest grounding (partial path)', () => {
  it('grounds facts in the chunks that succeeded; source_hash stays null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = 'Babbage designed the engine in 1837.\n\nBROKEN chunk text here.';
    const h = await makeDiagnosticWiki({
      config: { ...ON, maxChunkLength: 40, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
        ? 'not json'
        : JSON.stringify({ facts: [fact('Good', ['Babbage designed the engine']), fact('Bad', [FAKE])] }),
    });
    const result = await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: doc });
    expect(result.failedChunks).toBe(1);
    const rows = await factRows(h.db);
    expect(rows.find((r) => r.title === 'Good')).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED, source_hash: null });
    const bad = rows.find((r) => r.title === 'Bad')!;
    expect(bad).toMatchObject({ lifecycle_status: 'draft', source_hash: null });
    expect(ofCode(h.diagnostics, 'grounding_failed')[0].detail).toEqual({ factId: bad.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason: 'quote_not_found' });
  });
});

describe('upsertGraph is never grounded', () => {
  it('host nodes land stable with no verifier, even with trust-looking extra properties', async () => {
    const h = await makeDiagnosticWiki({ config: { grounding: { mode: 'draft', writers: ['ingest', 'librarian', 'heal'] } } });
    await h.db.withTransactionAsync(async (tx) => {
      await h.wiki.upsertGraph('e1', {
        sourceRef: 'graph.ts', sourceHash: HASH_A,
        nodes: [{ id: 'n1', type: '', title: 'Node', body: 'b', lifecycle_status: 'draft', okf_verified: [{ by: 'human:x', at: '2020-01-01T00:00:00Z' }] } as never],
        edges: [],
      }, tx);
    });
    expect((await factRows(h.db))[0]).toMatchObject({ id: 'n1', lifecycle_status: 'stable', okf_verified: null });
    expect(h.generateText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingIngest.test.ts`. Expected: FAIL. Grounded facts are stable but have no `okf_verified`, and the draft cases are stable. The two "never grounded" / "outside writers" tests may already pass; that is expected.

- [ ] **Step 4: Compute a verdict per fact in the chunk closure.**
  - Imports:
    - add `import { buildGroundingCorpus, checkGrounding, groundingOutcome } from '../utils/grounding';`
    - add `import type { GroundingTrust, GroundingVerdict } from '../utils/grounding';`
  - After the `ontologyContext` line (135), add `const ingestGrounding = this.promptService.groundingFor('ingest');`.
  - In the chunk closure, after the `rawFacts.forEach(...)` block and before `return {`, add:

```ts
            // Spec §6.3: the ingest corpus is exactly the chunk the model was shown.
            const verdicts: GroundingVerdict[] = ingestGrounding
              ? (() => {
                  const corpus = buildGroundingCorpus([chunk]);
                  return facts.map((f) => checkGrounding(f.evidence, corpus, ingestGrounding));
                })()
              : [];
```

and add `verdicts,` to the returned `ok` object.

- [ ] **Step 5: Record each surviving fact's verdict and locators.** Directly after `const diagBase = ...` (line 234), add:

```ts
      // Keyed by fact object identity: the same objects flow through dedupe,
      // the full path and the partial path. Empty when grounding is off.
      const groundingLedger = new Map<ExtractedFact, { verdict: GroundingVerdict; chunkIndex: number; itemIndex: number }>();
```

Inside `slot.facts.forEach((fact, k) => {`, in the branch that pushes to `dedupedFacts`, add after `dedupedFacts.push(fact);`:

```ts
            if (ingestGrounding) groundingLedger.set(fact, { verdict: slot.verdicts[k], chunkIndex, itemIndex: slot.itemIndexes[k] });
```

Pass the ledger to both writers: `this.runFullUpsertGraph(entityId, sourceRef, sourceHash, orderedChunkFacts, tx, diagBuffer, groundingLedger)` and `this.appendPartialFacts(entityId, sourceRef, flat, tx, diagBuffer, groundingLedger)`.

- [ ] **Step 6: Add the `nodeTrust` side channel to `upsertGraphCore`.** Change its `opts` type to:

```ts
    opts?: {
      strict?: boolean;
      diag?: { buffer: DiagnosticBuffer; operation: 'ingest' | 'upsertGraph' };
      /** Insert-time trust by node id. Ingest-only (spec §6.5); the public upsertGraph never passes it, so host nodes are never grounded. */
      nodeTrust?: ReadonlyMap<string, GroundingTrust>;
    },
```

In the `wikiFact` literal, after `okf_type: normalized.okf_type,`, add `...opts?.nodeTrust?.get(node.id),`. Spreading `undefined` adds nothing. The trust comes only from the map, never from `node` properties.

- [ ] **Step 7: Apply trust in `runFullUpsertGraph`.** Add the parameter `groundingLedger: ReadonlyMap<ExtractedFact, { verdict: GroundingVerdict; chunkIndex: number; itemIndex: number }> = new Map()`. Before the chunk loop, add `const nodeTrust = new Map<string, GroundingTrust>();`. Inside the per-fact loop, after the `validationDrops` diagnostics loop, add:

```ts
        const grounding = groundingLedger.get(fact);
        if (grounding) {
          const outcome = groundingOutcome(grounding.verdict, now);
          nodeTrust.set(id, outcome.trust);
          if (outcome.diagnostic) {
            diagBuffer.push({
              entityId, operation: 'ingest', trigger: 'call', code: outcome.diagnostic.code,
              detail: { factId: id, sourceRef, chunkIndex: grounding.chunkIndex, itemIndex: grounding.itemIndex, reason: outcome.diagnostic.reason },
            });
          }
        }
```

In the final `upsertGraphCore` call, pass `{ strict: false, diag: { buffer: diagBuffer, operation: 'ingest' }, ...(nodeTrust.size > 0 ? { nodeTrust } : {}) }`. That keeps the opts object identical to today when grounding is off.

- [ ] **Step 8: Apply trust in `appendPartialFacts`.** Add the same `groundingLedger` parameter with the same default. After `const id = generateId('fact_');`, add:

```ts
      const grounding = groundingLedger.get(fact);
      const outcome = grounding ? groundingOutcome(grounding.verdict, now) : null;
      if (grounding && outcome?.diagnostic) {
        diagBuffer.push({
          entityId, operation: 'ingest', trigger: 'call', code: outcome.diagnostic.code,
          detail: { factId: id, sourceRef, chunkIndex: grounding.chunkIndex, itemIndex: grounding.itemIndex, reason: outcome.diagnostic.reason },
        });
      }
```

and add `...outcome?.trust,` after `okf_type: null,` in the `wikiFact` literal.

- [ ] **Step 9: Run the new test, then the ingest suites.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingIngest.test.ts __tests__/ingest.test.ts __tests__/diagnosticsIngest.test.ts __tests__/graphOwnershipIngest.test.ts`. Expected: all PASS.

- [ ] **Step 10: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 11: Commit.**

```bash
git add packages/core/src/services/IngestionService.ts packages/core/__tests__/helpers/groundingHarness.ts packages/core/__tests__/groundingIngest.test.ts
git commit -m "feat(core): ground ingest facts against their chunk and store ungrounded ones as drafts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Librarian grounding

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (`doRunLibrarian`, lines ~607–763)
- Test: `packages/core/__tests__/groundingLibrarian.test.ts`

**Interfaces:**
- Consumes: `PromptService.groundingFor('librarian')`, `buildGroundingCorpus`, `checkGrounding`, `groundingOutcome`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/groundingLibrarian.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED } from './helpers/groundingHarness';

const ON = { grounding: { mode: 'draft' as const, writers: ['librarian' as const] } };
const SUMMARY = 'Ada said "the engine weaves algebraic patterns" \\ then\nleft early';
const fact = (title: string, evidence?: unknown) => ({ title, body: `${title} body`, tags: [], confidence: 'inferred', ...(evidence !== undefined ? { evidence } : {}) });

async function librarian(config: object, facts: object[]) {
  const h = await makeDiagnosticWiki({ config, generateText: async () => JSON.stringify({ facts, tasks: [] }) });
  await h.wiki.write('e1', { event_type: 'observation', summary: SUMMARY });
  await h.wiki.runLibrarian('e1');
  return h;
}

describe('librarian grounding', () => {
  it('grounds against raw event summaries: quotes, backslashes and newlines do not cause false failures', async () => {
    const h = await librarian(ON, [
      fact('Quoted', ['Ada said "the engine weaves algebraic patterns"']),
      fact('Backslash', ['algebraic patterns" \\ then left early']),
    ]);
    const rows = await factRows(h.db);
    expect(rows.map((r) => [r.title, r.lifecycle_status])).toEqual([['Backslash', 'stable'], ['Quoted', 'stable']]);
    expect(rows[0].okf_verified).toEqual(GROUNDED);
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it('quoting the event id or event_type does not ground (identifiers are not corpus)', async () => {
    const h = await librarian({ grounding: { ...ON.grounding, minEvidenceChars: 5 } }, [fact('Ident', ['observation'])]);
    expect((await factRows(h.db))[0].lifecycle_status).toBe('draft');
  });

  it('no circular grounding: a quote copied from a current fact fails', async () => {
    let call = 0;
    const h = await makeDiagnosticWiki({
      config: ON,
      generateText: async () => {
        call++;
        return JSON.stringify({
          facts: call === 1
            ? [{ title: 'Seed fact', body: 'Babbage built the difference engine prototype', tags: [], confidence: 'inferred', evidence: ['the engine weaves algebraic patterns'] }]
            : [fact('Circular', ['Babbage built the difference engine prototype'])],
          tasks: [],
        });
      },
    });
    await h.wiki.write('e1', { event_type: 'observation', summary: SUMMARY });
    await h.wiki.runLibrarian('e1');
    await h.wiki.runLibrarian('e1');
    expect(h.generateText.mock.calls[1][0].userPrompt).toContain('Babbage built the difference engine prototype');
    const circular = (await factRows(h.db)).find((r) => r.title === 'Circular')!;
    expect(circular.lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_failed').map((d) => d.detail)).toEqual([
      { factId: circular.id, itemIndex: 0, reason: 'quote_not_found' },
    ]);
  });

  it('missing evidence → draft and grounding_missing with factId and itemIndex, no content', async () => {
    const h = await librarian(ON, [fact('Ok', ['the engine weaves algebraic patterns']), fact('Bare')]);
    const bare = (await factRows(h.db)).find((r) => r.title === 'Bare')!;
    expect(bare.lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_missing')).toEqual([expect.objectContaining({
      operation: 'librarian', trigger: 'call', entityId: 'e1', detail: { factId: bare.id, itemIndex: 1, reason: 'no_evidence' },
    })]);
    expectNoContent(h.diagnostics, ['Bare body', 'algebraic']);
  });

  it('a promptOverride without evidence wording still gets the block', async () => {
    const h = await librarian({ ...ON, prompts: { librarianSystemPrompt: 'Custom librarian.' } }, []);
    expect(h.generateText.mock.calls[0][0].systemPrompt).toMatch(/^Custom librarian\.[\s\S]*EVIDENCE REQUIREMENT/);
  });

  it('librarian outside grounding.writers: no block, facts stable, trust untouched', async () => {
    const h = await librarian({ grounding: { mode: 'draft' } }, [fact('Plain')]);
    expect(h.generateText.mock.calls[0][0].systemPrompt).not.toContain('EVIDENCE REQUIREMENT');
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingLibrarian.test.ts`. Expected: FAIL (facts land stable with no verifier). The "outside writers" test passes already.

- [ ] **Step 3: Implement.** In `MaintenanceService.ts`, add `import { buildGroundingCorpus, checkGrounding, groundingOutcome } from '../utils/grounding';`. In `doRunLibrarian`:

Replace the `buildLibrarianPrompt(events.reverse(), ...)` argument with a named value and build the corpus from it:

```ts
    const promptEvents = events.reverse();
    const librarianGrounding = this.promptService.groundingFor('librarian');
    // Spec §6.3: event summaries only; the "Current Facts" shown beside them are
    // excluded so a new inference cannot be grounded by an earlier one.
    const librarianCorpus = librarianGrounding ? buildGroundingCorpus(promptEvents.map((e) => e.summary)) : '';

    const { systemPrompt, userPrompt } = this.promptService.buildLibrarianPrompt(
      promptEvents,
      currentFacts,
      promptOverride,
      ontologyContext,
    );
```

In the insert loop, after the `validationDrops` diagnostics line, add:

```ts
        const grounding = librarianGrounding
          ? groundingOutcome(checkGrounding(fact.evidence, librarianCorpus, librarianGrounding), now)
          : null;
        if (grounding?.diagnostic) {
          diagBuffer.push({ ...diagBase, code: grounding.diagnostic.code, detail: { factId: id, itemIndex: validFactItemIndexes[k], reason: grounding.diagnostic.reason } });
        }
```

and add `...grounding?.trust,` at the end of the `factObj` literal (after `okf_type: normalized.okf_type,`).

- [ ] **Step 4: Run the new test and the librarian suites.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingLibrarian.test.ts __tests__/librarianPrompt.test.ts __tests__/diagnosticsMaintenance.test.ts`. Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/services/MaintenanceService.ts packages/core/__tests__/groundingLibrarian.test.ts
git commit -m "feat(core): ground librarian facts against event summaries when opted in

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Heal grounding (anchor bodies, per-prompt corpus)

**Files:**
- Modify: `packages/core/src/services/BoundedLlmCall.ts` (`RunBatchedArgs.parse` at ~line 125; the call `parse(responseText, batch)` at ~line 324)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (`findAnchorRowsByIds`, ~line 621)
- Modify: `packages/core/src/services/MaintenanceService.ts`:
  - `HealAnchor` at line 115 and `HealBatch` at 118;
  - `doRunHeal` 771–1060;
  - `_selectHealAnchors` ~1513.
- Test: `packages/core/__tests__/groundingHeal.test.ts`

**Interfaces:**
- Consumes: `buildHealPrompt(...).groundingCorpus` (Task 2), `PromptService.groundingFor('heal')`, `checkGrounding`, `groundingOutcome`.
- Produces:
  - `RunBatchedArgs.parse: (responseText: string, batch: TItem[], prompts: BuiltPrompt) => TResult`, which is additive; existing two-parameter parse functions still type-check.
  - `findAnchorRowsByIds(entityId, ids, tx?, opts?: { withBody?: boolean })` returns `{ id; title; source_ref; body?; lifecycle_status? }[]`.

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/groundingHeal.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED, HASH_A, HASH_B } from './helpers/groundingHarness';
import type { LLMProvider } from '../src/types';

afterEach(() => vi.restoreAllMocks());

const ANCHOR_BODY = 'Babbage designed the difference engine to tabulate polynomial functions.';
const DRAFT_ANCHOR_BODY = 'The engine design drawings were archived in London for decades.';
const EVENT = 'Operator observed the engine printing tables at dawn.';
const CANDIDATE_BODY = 'Candidate claims the engine design used steam power throughout.';
const HEAL_ON = { grounding: { mode: 'draft' as const, writers: ['heal' as const] } };
const newFact = (title: string, evidence: string[]) => ({ title, body: `${title} body`, tags: [], confidence: 'inferred', evidence });
const isHeal = (p: { userPrompt: string }) => p.userPrompt.startsWith('Heal Candidates') || p.userPrompt === 'Please heal the memory graph.';

async function healWiki(config: object, onHeal: (p: { systemPrompt: string; userPrompt: string }, n: number) => string) {
  let healCalls = 0;
  const generateText: LLMProvider['generateText'] = async (p) => {
    if (isHeal(p)) return onHeal(p, ++healCalls);
    const body = p.userPrompt.includes('drawings') ? DRAFT_ANCHOR_BODY : ANCHOR_BODY;
    const title = p.userPrompt.includes('drawings') ? 'Engine design archive' : 'Engine design history';
    return JSON.stringify({ facts: [{ title, body, tags: [], confidence: 'certain' }] });
  };
  const h = await makeDiagnosticWiki({ config, generateText });
  await h.wiki.ingestDocument('e1', { sourceRef: 'history.md', sourceHash: HASH_A, documentChunk: 'history' });
  await h.wiki.ingestDocument('e1', { sourceRef: 'archive.md', sourceHash: HASH_B, documentChunk: 'drawings' });
  const now = Date.now();
  await h.db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES ('cand', 'e1', 'Engine design notes', ?, '[]', 'inferred', 'librarian_inferred', ?, ?)`,
    [CANDIDATE_BODY, now, now],
  );
  await h.wiki.write('e1', { event_type: 'observation', summary: EVENT });
  const rows = await factRows(h.db);
  const draftAnchorId = rows.find((r) => r.title === 'Engine design archive')!.id;
  await h.wiki.setLifecycleStatus(draftAnchorId, 'e1', 'draft');
  return h;
}

const healRow = async (db: Parameters<typeof factRows>[0], title: string) => (await factRows(db)).find((r) => r.title === title)!;
const respond = (...facts: object[]) => JSON.stringify({ downgraded: [], deleted: [], newFacts: facts });

describe('heal grounding', () => {
  it('shows anchor bodies only when heal is a grounding writer', async () => {
    const seen: string[] = [];
    const off = await healWiki({}, (p) => { seen.push(p.userPrompt); return respond(); });
    await off.wiki.runHeal('e1');
    expect(seen[0]).not.toContain(ANCHOR_BODY);
    seen.length = 0;
    const on = await healWiki(HEAL_ON, (p) => { seen.push(p.userPrompt); return respond(); });
    await on.wiki.runHeal('e1');
    expect(seen[0]).toContain(ANCHOR_BODY);
    expect(seen[0]).not.toContain('lifecycle_status');
  });

  it('grounds on a non-draft anchor body and on an event summary; fails on a draft anchor and on a candidate', async () => {
    const prompts: string[] = [];
    const h = await healWiki(HEAL_ON, (p) => {
      prompts.push(p.userPrompt);
      return respond(
        newFact('Anchor quote', ['to tabulate polynomial functions']),
        newFact('Event quote', ['printing tables at dawn']),
        newFact('Draft anchor quote', ['archived in London for decades']),
        newFact('Candidate quote', ['used steam power throughout']),
      );
    });
    await h.wiki.runHeal('e1');
    expect(prompts[0]).toContain(DRAFT_ANCHOR_BODY); // shown to the model, but not corpus
    expect(await healRow(h.db, 'Anchor quote')).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect((await healRow(h.db, 'Event quote')).lifecycle_status).toBe('stable');
    const draftQuote = await healRow(h.db, 'Draft anchor quote');
    const candQuote = await healRow(h.db, 'Candidate quote');
    expect([draftQuote.lifecycle_status, candQuote.lifecycle_status]).toEqual(['draft', 'draft']);
    expect(ofCode(h.diagnostics, 'grounding_failed').map((d) => d.detail)).toEqual([
      { factId: draftQuote.id, itemIndex: 2, reason: 'quote_not_found' },
      { factId: candQuote.id, itemIndex: 3, reason: 'quote_not_found' },
    ]);
    for (const d of ofCode(h.diagnostics, 'grounding_failed')) expect(d).toMatchObject({ operation: 'heal', trigger: 'call' });
    expectNoContent(h.diagnostics, ['archived in London', 'steam power', 'Candidate quote body']);
  });

  it('at L2 and above only anchors remain in the corpus', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let l2Prompt = '';
    const h = await healWiki(HEAL_ON, (p, n) => {
      if (n <= 2) throw new Error('Model response truncated at the 16384-token limit');
      l2Prompt = p.userPrompt;
      return respond(newFact('L2 event', ['printing tables at dawn']), newFact('L2 anchor', ['to tabulate polynomial functions']));
    });
    await h.wiki.runHeal('e1');
    expect(l2Prompt).toContain(ANCHOR_BODY);
    expect(l2Prompt).not.toContain(EVENT);
    expect((await healRow(h.db, 'L2 event')).lifecycle_status).toBe('draft');
    expect((await healRow(h.db, 'L2 anchor')).lifecycle_status).toBe('stable');
  });

  it('placeholder template: block appended, bodies hydrated, grounding works', async () => {
    let system = '';
    const h = await healWiki(
      { ...HEAL_ON, prompts: { healSystemPrompt: 'Heal: {{healCandidates}} anchors {{documentAnchors}} events {{recentEvents}}' } },
      (p) => {
        system = p.systemPrompt;
        return respond(newFact('Placeholder anchor', ['to tabulate polynomial functions']));
      },
    );
    await h.wiki.runHeal('e1');
    expect(system).toContain(ANCHOR_BODY);
    expect(system).toContain('EVIDENCE REQUIREMENT');
    expect((await healRow(h.db, 'Placeholder anchor')).lifecycle_status).toBe('stable');
  });

  it('heal outside grounding.writers: new facts stable, trust untouched', async () => {
    const h = await healWiki({ grounding: { mode: 'draft' } }, () => respond(newFact('Ungated', [])));
    await h.wiki.runHeal('e1');
    expect(await healRow(h.db, 'Ungated')).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
  });
});
```

**Fixture-only adjustments allowed.** If `_selectHealAnchors`' keyword search does not return both anchors for the candidate title `Engine design notes`, adjust **only** the fixture titles so they share more tokens with the candidate, then rerun. Confirm the anchors' presence through the `ANCHOR_BODY` / `DRAFT_ANCHOR_BODY` prompt assertions. Do not weaken the assertions.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingHeal.test.ts`. Expected: FAIL. The prompt has no anchor bodies and every new fact lands stable. The "outside writers" test passes already.

- [ ] **Step 3: Pass the prompt to `parse`.** In `BoundedLlmCall.ts`, change the `parse` member of `RunBatchedArgs` to:

```ts
  /** Receives the batch so the caller can pair a response with the exact items
   * that produced it without this module knowing any domain shape, and the
   * exact prompt object that was sent (heal keys its grounding corpus to it).
   * Throwing is the signal that the response was unusable. */
  parse: (responseText: string, batch: TItem[], prompts: BuiltPrompt) => TResult;
```

and change `result = parse(responseText, batch);` to `result = parse(responseText, batch, prompts);`.

- [ ] **Step 4: Optional anchor bodies in the repository.** Replace `findAnchorRowsByIds` with:

```ts
  async findAnchorRowsByIds(
    entityId: string,
    ids: readonly string[],
    tx?: SQLiteAdapter,
    opts?: { withBody?: boolean },
  ): Promise<Array<{ id: string; title: string; source_ref: string | null; body?: string; lifecycle_status?: string }>> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    // Bodies and status are read only for heal grounding (spec §6.3, rev 7);
    // the default projection is unchanged.
    const columns = opts?.withBody ? 'id, title, source_ref, body, lifecycle_status' : 'id, title, source_ref';
    const rows: Array<{ id: string; title: string; source_ref: string | null; body?: string; lifecycle_status?: string }> = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = await executor.getAllAsync<{ id: string; title: string; source_ref: string | null; body?: string; lifecycle_status?: string }>(
        `SELECT ${columns} FROM ${this.prefix}entries
         WHERE entity_id = ? AND deleted_at IS NULL
           AND source_type = 'immutable_document'
           AND id IN (${placeholders})`,
        [entityId, ...chunk],
      );
      rows.push(...chunkRows);
    }
    return rows;
  }
```

Keep the existing doc comment and the chunking comment.

- [ ] **Step 5: Heal wiring in `MaintenanceService`.**
  - Imports: add `checkGrounding` and `groundingOutcome` to the grounding import (Task 4 added `buildGroundingCorpus`); add `import type { BuiltPrompt } from './BoundedLlmCall';`, merging it into the existing `BoundedLlmCall` import if there is one.
  - Types:
    - `type HealAnchor = { id: string; title: string; source_ref: string | null; body?: string; lifecycle_status?: string };`
    - `HealBatch` gains `/** Corpus of the prompt that produced this response; null when heal is not a grounding writer. */ corpus: string | null;`
  - `_selectHealAnchors` gains a fifth parameter `withBodies = false`. Its repository call becomes:

```ts
      const rows = withBodies
        ? await this.entryRepo.findAnchorRowsByIds(entityId, hitIds, undefined, { withBody: true })
        : await this.entryRepo.findAnchorRowsByIds(entityId, hitIds);
```

  (The two-argument form keeps `healAnchorBounding.test.ts`'s mock and its call-shape assertions unchanged.)

In `doRunHeal`, after `const diagBase = ...`, add:

```ts
    const healGrounding = this.promptService.groundingFor('heal');
    // runBatched rebuilds prompts while trimming, splitting and escalating, so
    // the corpus is keyed to the exact prompt object each response came from.
    const corpusByPrompt = new WeakMap<BuiltPrompt, string>();
```

In `buildPrompt`, pass `healGrounding !== null` as `_selectHealAnchors`' fifth argument. Then change the destructure to `const { prompts, degraded: batchDegraded, groundingCorpus } = ...` and, before `return prompts;`, add `if (groundingCorpus !== undefined) corpusByPrompt.set(prompts, groundingCorpus);`.

Change `parse` to accept `(responseText, batch, prompts)` and add `corpus: corpusByPrompt.get(prompts) ?? null,` to the object it returns.

In the results loop, add `const newFactCorpora: Array<string | null> = [];` next to `newFactItemIndexes`, and push `newFactCorpora.push(batchResult.corpus);` beside `newFactItemIndexes.push(itemIndex);`. In the validation loop, add `const validNewFactCorpora: Array<string | null> = [];` and push `validNewFactCorpora.push(newFactCorpora[k]);` in the `valid` branch.

In the insert loop, replace the `factObj` construction with:

```ts
        const id = generateId('fact_');
        // A missing corpus is treated as empty, so every quote fails: fail closed.
        const grounding = healGrounding
          ? groundingOutcome(checkGrounding(fact.evidence, validNewFactCorpora[k] ?? '', healGrounding), now)
          : null;
        if (grounding?.diagnostic) {
          diagBuffer.push({ ...diagBase, code: grounding.diagnostic.code, detail: { factId: id, itemIndex: validNewFactItemIndexes[k], reason: grounding.diagnostic.reason } });
        }
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          ...grounding?.trust,
        };
```

- [ ] **Step 6: Run the new test and the heal and batching suites.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingHeal.test.ts __tests__/healBounding.test.ts __tests__/healAnchorBounding.test.ts __tests__/BoundedLlmCall.test.ts __tests__/diagnosticsMaintenance.test.ts __tests__/heal-retention-boundary.test.ts __tests__/ontologyBackfill.test.ts`. Expected: all PASS. If a `BoundedLlmCall.test.ts` assertion pins `parse`'s exact arguments, it fails on the new third argument. Update only that expectation to add `expect.anything()` as the third argument, and record it as a ruling.

- [ ] **Step 7: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/services/BoundedLlmCall.ts packages/core/src/repositories/EntryRepository.ts packages/core/src/services/MaintenanceService.ts packages/core/__tests__/groundingHeal.test.ts
git commit -m "feat(core): ground heal facts against the events and non-draft anchor bodies each prompt showed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Mode-off baseline, README, verification, PR

**Files:**
- Test: `packages/core/__tests__/groundingOff.test.ts`
- Modify: `packages/core/README.md` (new `## Grounding` section directly after `## Draft Review`, before `## Pluggable Vector Retrieval`)

**Interfaces:** Consumes everything above; produces nothing new.

- [ ] **Step 1: Write the baseline test** in `packages/core/__tests__/groundingOff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, factRows, HASH_A } from './helpers/groundingHarness';
import type { WikiConfig } from '../src/types';

// Random ids and wall-clock timestamps differ between the two runs; mask them.
const mask = (s: string) => s
  .replace(/"(id|related_entry_id)": "[^"]*"/g, '"$1": "<id>"')
  .replace(/"([a-z_]*_at)": \d+/g, '"$1": 0');

async function run(config: WikiConfig) {
  const h = await makeDiagnosticWiki({
    config,
    generateText: async ({ userPrompt }) => userPrompt.startsWith('Heal Candidates')
      ? JSON.stringify({ downgraded: [], deleted: [], newFacts: [{ title: 'Healed', body: 'healed body', tags: [], confidence: 'inferred', evidence: ['anything at all goes here'] }] })
      : JSON.stringify({ facts: [{ title: 'Engine', body: 'engine body', tags: [], confidence: 'certain', evidence: ['not in the source at all'] }], tasks: [] }),
  });
  await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'The engine document.' });
  await h.wiki.write('e1', { event_type: 'observation', summary: 'engine event' });
  await h.wiki.runLibrarian('e1');
  await h.wiki.runHeal('e1');
  const prompts = h.generateText.mock.calls.map(([p]) => ({ systemPrompt: p.systemPrompt, userPrompt: mask(p.userPrompt) }));
  const rows = (await factRows(h.db)).map(({ id: _id, last_verified_at: _t, ...r }) => r);
  return { prompts, rows, grounding: h.diagnostics.filter((d) => d.code.startsWith('grounding_')) };
}

describe("grounding mode 'off' equals baseline", () => {
  it('prompts, stored trust columns and diagnostics are identical to no grounding config', async () => {
    const baseline = await run({});
    const off = await run({ grounding: { mode: 'off', writers: ['ingest', 'librarian', 'heal'] } });
    expect(off).toEqual(baseline);
    expect(baseline.grounding).toEqual([]);
    expect(baseline.rows.every((r) => r.lifecycle_status === 'stable' && r.okf_verified === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingOff.test.ts`. Expected: PASS. It pins behavior that Tasks 1–5 already preserve. If it fails, a task changed the off path: find it and fix the implementation. Do not loosen `mask` beyond ids and `*_at` timestamps.

- [ ] **Step 3: README.** Insert after the `## Draft Review` section. Grep every signature and default below against source before writing, and adjust the prose if one differs (repo rule: verify doc signatures against source):

````markdown
## Grounding

Opt-in, deterministic evidence check for LLM-authored facts. When on, writers you choose must quote the source they were shown. A fact whose quotes are missing or not found is stored as a `draft` (see [Draft Review](#draft-review)), not rejected. A fact whose quotes all check out is stored `stable` with a `process:grounding-check` verifier, so its `trustTier` is `machine-confirmed`. Default off: 7.x write behavior is unchanged.

```ts
new WikiMemory(db, {
  llmProvider,
  config: {
    grounding: {
      mode: 'draft',            // 'off' (default) | 'draft'
      writers: ['ingest'],      // default ['ingest']; also 'librarian', 'heal'
      minEvidenceChars: 20,     // shorter quotes count as absent
      maxEvidence: 3,           // quotes asked for per fact
      maxEvidenceChars: 300,
    },
  },
});
```

- **What counts as source.**
  - Ingest: the chunk text.
  - Librarian: the `summary` of each event in the prompt.
  - Heal: the `summary` of each recent event in the prompt, plus the bodies of non-draft document anchors. When heal is a writer, anchors are shown with their body clipped to 800 characters.
  - Instructions, the ontology manifest, existing facts and identifiers never count, so a model cannot ground a claim by quoting them.
- **The check.** Both sides are normalized with NFKC, whitespace runs collapse to one space, and matching is case-sensitive. A fact with more than 10 quotes, or any quote not found, fails.
- **Diagnostics.** `grounding_missing` (reasons `no_evidence`, `evidence_too_short`) and `grounding_failed` (reasons `quote_not_found`, `too_many_quotes`), one per fact, with the new fact's `factId`. Quotes are never included.
- **`upsertGraph`** nodes are host-supplied and never grounded.
- **Librarian and heal** synthesize across events, so their pass rates are unknown. Measure them on your own event log before opting them in.
- Evidence quotes are not stored.
````

- [ ] **Step 4: Full verification.** Run each and paste the real output into the report:
  - `pnpm --filter @equationalapplications/core-llm-wiki test`
  - `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - `pnpm -r build && pnpm test`. PR 2's report found that consumer packages resolve core through `dist/`, so build before the workspace run.

  Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/__tests__/groundingOff.test.ts packages/core/README.md
git commit -m "docs(core): document the grounding check and pin the off-mode baseline

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push and open the PR. Do not merge.**

```bash
git log --oneline origin/main..HEAD   # expect: spec rev 7, this plan, and the six task commits only
git push -u origin feat/grounding-check
gh pr create --base main --title "feat(core): opt-in grounding check for LLM-authored facts" --body "<summary, spec rev 7 note, test evidence>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Tell the user that the PR is ready, and that it merges as a merge commit, never a squash.
