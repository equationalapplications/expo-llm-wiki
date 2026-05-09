# Source Type Rename for Clarity

**Date:** 2026-05-08  
**Status:** Implemented  
**Breaking Change:** Yes

## Overview

Rename `source_type` enum values in `WikiFact` to improve semantic clarity and explicitly communicate immutability constraints.

## Motivation

The current `user_document` naming is ambiguous:
- Doesn't communicate that these facts are immutable by the system
- Users must read implementation code to understand librarian/heal won't modify them
- "user_document" suggests user ownership, not immutability

Similarly, `agent_inferred` is vague about which agent component creates these facts.

## Scope

Rename two `source_type` enum values:
- `user_document` → `immutable_document`
- `agent_inferred` → `librarian_inferred`

Keep unchanged:
- `user_stated`
- `user_confirmed`

This is a **breaking change** — existing databases are incompatible without manual SQL UPDATE.

## Design

### Type Changes

**File:** `packages/core/src/types.ts`

Update `WikiFact.source_type` enum:

```typescript
/**
 * Source type of this fact.
 * - 'immutable_document': From ingestDocument(), cannot be modified by system (librarian/heal).
 *   Only removable via forget() or replaced via re-ingest.
 * - 'librarian_inferred': Created by runLibrarian() from events and by runHeal() when synthesizing healed facts.
 * - 'user_stated': Direct user statement.
 * - 'user_confirmed': User-confirmed fact.
 */
source_type: 'user_stated' | 'librarian_inferred' | 'user_confirmed' | 'immutable_document';
```

### Code Changes

**File:** `packages/core/src/db/schema.ts`

Update column DEFAULT:

```sql
source_type TEXT NOT NULL DEFAULT 'librarian_inferred',
```

Note: `CREATE TABLE IF NOT EXISTS` means existing databases retain old DEFAULT. All current writes pass `source_type` explicitly, so DEFAULT change is forward-only.

**File:** `packages/core/src/WikiMemory.ts`

Update 8 references (line numbers approximate — use grep anchors before editing):

1. Librarian dedup check — `existing.source_type !== 'agent_inferred'` → `'librarian_inferred'`
2. Librarian INSERT (validFacts loop) — `'agent_inferred'` literal in params → `'librarian_inferred'`
3. Orphan-prune WHERE — `source_type != 'user_document'` → `'immutable_document'`
4. Stale-downgrade WHERE — `source_type != 'user_document'` → `'immutable_document'`
5. Heal candidates filter — `f.source_type !== 'user_document'` → `'immutable_document'`
6. Document anchors filter — `f.source_type === 'user_document'` → `'immutable_document'`
7. Second librarian INSERT site (~line 1899) — `'agent_inferred'` → `'librarian_inferred'`
8. ingestDocument INSERT — `'user_document'` literal in params → `'immutable_document'`

Verify with: `grep -n "user_document\|agent_inferred" packages/core/src/WikiMemory.ts` — should return zero after edits.

**Test Files / Scripts:**

Update all fixtures and assertions:
- `packages/integration/__tests__/maintenance.test.ts`
- `packages/integration/__tests__/config.test.ts`
- `packages/integration/__tests__/exportImport.test.ts`
- `packages/integration/__tests__/pipeline.test.ts`
- `packages/integration/__tests__/recall.test.ts`
- `packages/core/__tests__/importDump.test.ts`
- `packages/core/__tests__/formatMemoryDump.test.ts`
- `packages/core/__tests__/formatContext.test.ts`
- `packages/core/__tests__/migration2.test.ts` — verify migration test still meaningful; if it tests a prior schema migration, leave old enum names intact for historical accuracy
- `packages/integration/scripts/embed-scifact.ts`

Replace:
- `'user_document'` → `'immutable_document'`
- `'agent_inferred'` → `'librarian_inferred'`

### Documentation Changes

**README.md:**
- Replace all `user_document` references with "immutable documents" in prose
- Update Security section (line ~697) to use new terminology
- Emphasize: "Facts from ingested documents are immutable — the system cannot modify them. Only explicit user actions (forget, re-ingest) can change or remove them."

**Specification Files:**

1. `docs/superpowers/specs/2026-04-29-memory-hardening.md`:
   - Line 10: Update "heal pass can be trusted to protect `user_document` entries"
   - Line 103: Section heading "user_document Facts as Read-Only Anchors"
   - Lines 105-114: Update all code samples and prose
   - Line 160: "Both rules skip `source_type = 'user_document'` entries"

2. `docs/superpowers/specs/2026-04-29-internal-inference-engine.md`:
   - Lines 143-144: UPDATE WHERE clause guards
   - Line 147: Invariant documentation
   - Line 192: ingestDocument INSERT statement

3. `docs/superpowers/specs/2026-05-04-integration-test-spec.md`:
   - Lines 124-137: Test scenario descriptions

4. `docs/superpowers/specs/2026-05-04-retrieval-tuning.md` — update enum references
5. `docs/superpowers/specs/2026-05-03-embedding-retrieval.md` — update enum references

(Historical specs may be left unchanged if they describe state-at-time. Decide per-file.)

**Terminology:**
- Code: Use literal `'immutable_document'` in string literals and SQL
- Prose: Use "immutable documents" in natural language
- Emphasis: Always clarify that immutability means "system cannot modify, only user-initiated forget/re-ingest"

**Release notes / CHANGELOG:**

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release) with the changelog plugin — **`CHANGELOG.md` is generated at release time. Do not hand-edit it.** Contributors should land a **conventional commit** whose body includes a `BREAKING CHANGE:` footer (and migration guidance). The release notes will pick that up automatically.

Example footer content to include in the commit message (not pasted into `CHANGELOG.md`):

```text
BREAKING CHANGE: source_type enum strings renamed: user_document → immutable_document,
agent_inferred → librarian_inferred. Existing DBs need manual SQL or wipe/re-ingest; see migration guide.

Migration SQL (adjust table prefix to match WikiMemory tablePrefix):
UPDATE <prefix>entries SET source_type = 'immutable_document' WHERE source_type = 'user_document';
UPDATE <prefix>entries SET source_type = 'librarian_inferred' WHERE source_type = 'agent_inferred';
```

### Testing Strategy

**Enum rename:** Existing tests validate immutability behavior:
- `maintenance.test.ts` — verifies heal/librarian skip immutable documents
- `config.test.ts` — verifies stale downgrade skips immutable documents  
- `exportImport.test.ts` — verifies immutable documents export/import correctly

**Retention boundaries:** Separate from the rename, prune/heal retention uses inclusive threshold comparisons (`<=`) for zero-day retention. Add or keep **boundary-focused tests** (mocked time, equality at cutoff) so inclusive cutoff behavior does not regress — this is not “no new tests”; it documents real behavior beyond the rename.

**Verification:**
1. Run full test suite after rename
2. Confirm all tests pass
3. Visual inspection of changed files to verify no missed references

## Implementation Checklist

- [ ] Update `packages/core/src/types.ts` enum definition + JSDoc
- [ ] Update `packages/core/src/db/schema.ts` DEFAULT value
- [ ] Update `packages/core/src/WikiMemory.ts` (8 locations)
- [ ] Update all test fixtures (10 files; check `migration2.test.ts` historical intent)
- [ ] Update README.md documentation
- [ ] Update 5 specification files (or document why historical specs left untouched)
- [ ] Ship breaking change via conventional commit + `BREAKING CHANGE:` footer (no manual `CHANGELOG.md` edit)
- [ ] Run full test suite
- [ ] Grep verify: `grep -rn "user_document\|agent_inferred" packages/ docs/ README.md` returns only intentional historical refs

## Migration Guide

For users with existing databases:

**Option 1: Wipe and re-ingest**
```typescript
await wiki.forget('entity-id', { clearAll: true });
// Re-ingest all documents
```

**Option 2: Manual SQL migration**
```sql
-- Update source types (adjust prefix if needed)
UPDATE llm_wiki_entries 
SET source_type = 'immutable_document' 
WHERE source_type = 'user_document';

UPDATE llm_wiki_entries 
SET source_type = 'librarian_inferred' 
WHERE source_type = 'agent_inferred';
```

**Verification:**
```sql
SELECT DISTINCT source_type FROM llm_wiki_entries;
-- Should return: immutable_document, librarian_inferred, user_stated, user_confirmed
```

## Risks and Mitigations

**Risk:** Users miss migration and database queries fail  
**Mitigation:** Clear BREAKING CHANGE notice in CHANGELOG, migration guide in README

**Risk:** Third-party code hardcodes old enum values  
**Mitigation:** This is a breaking change — acceptable per requirements

**Risk:** Incomplete find-replace misses occurrences  
**Mitigation:** Grep verification step in implementation checklist

## Non-Goals

- **No automatic in-place DB migration** — the library does not rewrite existing rows on open; users with legacy `source_type` strings in SQLite must run manual SQL or wipe/re-ingest. **`setup()` / `importDump()` fail fast** if the database still contains legacy values, with copy-pastable migration SQL (prefix-aware).
- **Dump compatibility (narrow):** `importDump()` **normalizes legacy `source_type` strings on write** so older exports do not silently violate immutability semantics. That is not a “live DB migration”; it only affects data path through import.
- No changes to `user_stated` or `user_confirmed` enum values
