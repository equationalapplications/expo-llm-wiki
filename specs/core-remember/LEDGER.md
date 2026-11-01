# `WikiMemory.remember()` — ledger

In flight: Task 6 (owner-gated cleanup commit) only. Tasks 1-5 are complete and ticked below; the implementation is on this branch.

Baseline (2026-11-01 @ `51ff55a`): core suite 185 files / 2002 tests passed; `typecheck` exit 0. Known on 2026-11-01 @ `5ecd716`: `__tests__/supersede.test.ts` 13/13 green, `typecheck` exit 0.

- [x] 1. `assertEntityId` helper shared by `write()` and `remember()` — evidence: commit cbaeee2; entityId+write+deferredWrite 3 files/13 tests green; typecheck 0
- [x] 2. `RememberInput` type and the pure normalizer — evidence: commit d88da97; rememberInput 24/24 green; typecheck 0
- [x] 3. `RememberService` and `WikiMemory.remember()` — storage, read-back, `valid_from`, `okf_type` — evidence: commit e87245e; remember.test.ts 8/8 green x3 runs; typecheck 0
- [x] 4. Behaviour guarantees — no maintenance, searchable, embedding, outbox, temporal interplay — evidence: commit cc25a2f; remember.test.ts 17/17; core suite 188 files / 2049 tests green; typecheck 0
- [x] 5. Docs and the published surface — evidence: commit 2c404c5; build 0; dist d.ts has remember + RememberInput; typecheck 0; pnpm test 0 (core 188/2049)
- [ ] 6. Final cleanup commit (owner-gated) — evidence:

## Discrepancies

- Task 3: plan's test asserted `fact.updated_at === fact.created_at`, but `EntryRepository.upsert` re-stamps `updated_at` with its own `Date.now()` (same as `supersede()`), so it is racy. Relaxed the new test to `updated_at >= created_at`; no spec text changed (spec §3.3 only says the literal is built with both = now). Code untouched.
- Task 4: events-empty assertion counts `llm_wiki_events` via SQL instead of the plan's `(local as any).eventRepo.getRecent` (same check, no private access). Tests passed first run, no production change.
