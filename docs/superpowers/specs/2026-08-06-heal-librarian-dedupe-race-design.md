# Spec: Heal/Librarian Dedupe Race

**Date:** 2026-08-06
**Status:** Approved, not implemented
**Issue:** [#69](https://github.com/equationalapplications/expo-llm-wiki/issues/69)
**Packages:** `@eq/wiki-core`

---

## Problem

`librarian` and `heal` may run concurrently on the same entity. Both passes end by
synthesizing new facts behind a "skip if a very similar fact already exists" Jaccard
check. Heal reads that dedupe corpus **outside** its write transaction, so a librarian
insert landing during heal's LLM round-trip is invisible to heal's check, and heal can
insert a near-duplicate of it.

The two passes are not symmetrical about when they snapshot the corpus:

- Librarian opens its transaction at `MaintenanceService.ts:391` and reads the corpus
  at `:407`, passing `tx`. Its exposure is a few statements.
- Heal reads the corpus at `MaintenanceService.ts:630-632` **without** `tx`, and does
  not open its transaction until `:634`. Its exposure spans the entire LLM call.

Nothing errors. Both passes write in transactions; the corpus quietly accumulates
redundant facts.

This is reasoned from the code, not an observed failure. It is the same defect class as
the bug fixed in #68 (`a2ba9ca`), where heal's dedupe snapshot went stale against heal's
*own* same-pass deletions. That one was single-threaded and demonstrable; this one is a
race.

### The concurrency is intentional

`JobManager.acquireLock` (`JobManager.ts:123-133`) handles `librarian`, `heal`, and
`ontologyBackfill` in one branch that blocks each against its own key plus
prune/reembed/import/forget — but never against each other. `jobs.test.ts:82` asserts
it: *"runHeal does not block runLibrarian for same entity after mutex split"*. This is a
deliberate mutex split, not a missing lock, and this spec preserves it.

---

## Key finding: transactions are globally serialized

`withSerializedTransactions` (`packages/core/src/db/serializedAdapter.ts:57`) wraps
`withTransactionAsync` in a promise-chain mutex so transactions on the single shared
connection run strictly one at a time. This was added by the
[2026-07-09 transaction serialization spec](./2026-07-09-transaction-serialization-spec.md).

This changes the conclusion issue #69 reached. The issue assumed moving heal's dedupe
read inside its transaction would only *shrink* the stale window from "one LLM
round-trip" to "a few statements," leaving a residual race that might justify full
mutual exclusion.

It does not. It **closes** the race. With transactions serialized end to end, a
librarian transaction either commits entirely before heal's transaction begins or
entirely after it ends. There is no interleaving point at which librarian can insert a
fact that heal's in-transaction snapshot missed but heal's insert would duplicate.

Two facts make the change cheap:

- `findInferredTitlesByEntityId(entityId, tx?)` (`EntryRepository.ts:1064`) already
  accepts a `tx` parameter. No signature change.
- Its `WHERE` clause already filters `deleted_at IS NULL`, so reading it *after*
  `softDeleteByIds` reproduces the `safeDeletedSet` filter from #68 naturally.

---

## Solution

Three changes, in one commit.

### 1. Move heal's dedupe read inside its transaction

`MaintenanceService.ts:630-632` moves into the transaction, after the soft delete:

```ts
await this.db.withTransactionAsync(async (tx) => {
  await this.entryRepo.downgradeByIds(safeDowngraded, entityId, tx);
  await this.entryRepo.softDeleteByIds(safeDeleted, entityId, tx);

  const healFactsForDedupe = await this.entryRepo.findInferredTitlesByEntityId(entityId, tx);
```

The `.filter(f => !safeDeletedSet.has(f.id))` is dropped. Ordering is load-bearing: the
read must follow `softDeleteByIds`, or rows this pass retires are still in the corpus
and a delete-plus-restate — heal's normal output shape — would match the row it replaces,
drop the replacement, and leave the fact gone entirely. That is the #68 regression,
guarded by `healBounding.test.ts:195` — *"does not dedupe a replacement against the fact
deleted in the same pass"* — which must still pass unchanged.

That test's explanatory comment (`:197-199`) describes the corpus as "read before the
pass's" deletions and needs updating alongside the code. The assertions do not change;
only the rationale text, which would otherwise describe a mechanism that no longer
exists.

The comment block at `:621-629` is rewritten. The "read before the transaction
soft-deletes" rationale is now obsolete and would contradict the code. The full-breadth
rationale at `:621-624` stays — it is still true and still load-bearing.

`healFactsForDedupe` keeps its declared type `Array<{ id: string; title: string }>`,
which the query already returns.

### 2. Correct the false guarantee in WriteService

`WriteService.ts:119-121` currently claims:

> Guarded by `isBlocked('librarian')` so heal still never overlaps a librarian pass

That guarantee does not hold. `maybeRunHeal` (`:145`) awaits `getCheckpoint` before
reaching `tryAcquireAutoHealLock` (`JobManager.ts:257`), which only checks the heal key,
so a librarian pass can start in the gap.

**The check stays; only the comment changes.** The check is redundancy avoidance, not a
safety rule — a librarian pass already calls `maybeRunHeal` when it finishes
(`runLibrarianThenMaybeHeal`, `:126`), so losing the race costs a duplicate pass, not
correctness.

The corrected comment states what is actually true: heal and librarian can overlap, the
check only reduces redundant passes, and correctness rests on heal's dedupe read being
transactional (change 1).

This correction ships with change 1 rather than separately. The dedupe fix does **not**
make the old comment true — heal and librarian still run concurrently afterward; only
the data race is closed. Shipping the fix and leaving the comment would leave a false
statement that actively misleads the next reader into believing the overlap is
impossible.

### 3. Regression test

Per the issue's "before acting" note, confirm the failure is real rather than designing
against a hypothesis.

**The test must be demonstrated failing on current `main` before the fix lands.** A test
that passes both before and after proves nothing.

Shape:

1. Mock LLM provider with a controllable delay on heal's `generateText`.
2. While heal is inside that call, commit a librarian pass inserting a
   `librarian_inferred` fact.
3. Heal's mocked output synthesizes a fact whose title is within `FUZZY_THRESHOLD`
   Jaccard of the librarian fact, with both titles at or above `MIN_TOKENS_TO_QUALIFY`
   tokens.
4. Assert exactly one matching fact exists.

Before the fix: two facts. After: one.

---

## Behavior changes

Dropping the `safeDeletedSet` filter is **not a pure no-op**, and is not being shipped
as "removed redundant code."

In the normal case the two are equivalent: `softDeleteByIds` runs first and the query
filters `deleted_at IS NULL`, so those rows leave the corpus either way.

They diverge when `softDeleteByIds` does not actually delete a row it was asked to —
the id belongs to another entity, or the row was already deleted. Old behavior: filtered
out of the corpus regardless. New behavior: stays in the corpus.

The new behavior is more correct. If a row is still live, a synthesized replacement
*should* dedupe against it, because the fact is not gone. This is the exact failure #68
protected against, and the new ordering protects against it more precisely — it keys off
what the database actually contains rather than what the model asked for.

No public API changes. `runHeal` and `runLibrarian` keep their current signatures and
blocking behavior. Ships as a `fix:` patch release.

---

## Costs

Moving a full-breadth read into the transaction puts it inside the globally serialized
critical section, where it blocks every other transaction for its duration.

Acceptable: two columns, single entity, and librarian already does exactly this at
`MaintenanceService.ts:407`. `EntryRepository.ts:1062` documents the query as "full
breadth, two columns, cheap." Named here as a considered tradeoff rather than a free
change.

---

## Out of scope

**Mutual exclusion between librarian and heal.** Considered and rejected. It was only
justified if option A left a residual race — it does not, given transaction
serialization. It would reverse the deliberate mutex split, make `wiki.runHeal()` throw
`WikiBusyError` while a librarian pass runs (breaking for hosts), and risk starving
heal: librarian fires every `autoLibrarianThreshold` (default 20) events, while heal is
bounded to `HEAL_BATCH_SIZE` (25) facts per pass and needs many passes to sweep a
corpus. On a write-heavy entity heal could fall permanently behind. Strictly worse for
zero remaining benefit.

**Changing the `isBlocked('librarian')` check itself.** Per the issue: it "should not be
'fixed' in isolation." It stays as redundancy avoidance; only its documentation is
corrected.

**The `healCandidates` read, also outside the transaction.** It selects candidates
rather than gating inserts, so a stale entry costs a wasted candidate, not a duplicate
fact. Different exposure, not addressed here.

---

## Verification

- New regression test: red on `main`, green after the fix.
- `healBounding.test.ts:195` (delete-plus-restate) still passes — guards the ordering
  requirement in change 1.
- `healBounding.test.ts:159` (dedupe outside the candidate window) still passes —
  guards the full-breadth property, which the move must not narrow.
- `jobs.test.ts:82` still passes — confirms the mutex split is preserved.
- Full `packages/core` suite passes.

Constants cited above, verified against `MaintenanceService.ts`: `FUZZY_THRESHOLD` 0.5
(`:20`), `MIN_TOKENS_TO_QUALIFY` 3 (`:21`), `HEAL_BATCH_SIZE` 25 (`:48`);
`autoLibrarianThreshold` defaults to 20 (`WriteService.ts:77`).
