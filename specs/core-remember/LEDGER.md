# `WikiMemory.remember()` — ledger

In flight: nothing (spec is Draft; implementation has not started)

Baseline (2026-11-01 @ `51ff55a`): core suite 185 files / 2002 tests passed; `typecheck` exit 0. Known on 2026-11-01 @ `5ecd716`: `__tests__/supersede.test.ts` 13/13 green, `typecheck` exit 0.

- [x] 1. `assertEntityId` helper shared by `write()` and `remember()` — evidence: entityId+write+deferredWrite 3 files/13 tests green; typecheck 0
- [x] 2. `RememberInput` type and the pure normalizer — evidence: rememberInput 24/24 green; typecheck 0
- [x] 3. `RememberService` and `WikiMemory.remember()` — storage, read-back, `valid_from`, `okf_type` — evidence: remember.test.ts 8/8 green x3 runs; typecheck 0
- [ ] 4. Behaviour guarantees — no maintenance, searchable, embedding, outbox, temporal interplay — evidence:
- [ ] 5. Docs and the published surface — evidence:
- [ ] 6. Final cleanup commit (owner-gated) — evidence:

## Discrepancies

- Task 3: plan's test asserted `fact.updated_at === fact.created_at`, but `EntryRepository.upsert` re-stamps `updated_at` with its own `Date.now()` (same as `supersede()`), so it is racy. Relaxed the new test to `updated_at >= created_at`; no spec text changed (spec §3.3 only says the literal is built with both = now). Code untouched.
