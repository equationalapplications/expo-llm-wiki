# `WikiMemory.remember()` — ledger

In flight: nothing (spec is Draft; implementation has not started)

Baseline (2026-11-01 @ `51ff55a`): core suite 185 files / 2002 tests passed; `typecheck` exit 0. Known on 2026-11-01 @ `5ecd716`: `__tests__/supersede.test.ts` 13/13 green, `typecheck` exit 0.

- [x] 1. `assertEntityId` helper shared by `write()` and `remember()` — evidence: entityId+write+deferredWrite 3 files/13 tests green; typecheck 0
- [x] 2. `RememberInput` type and the pure normalizer — evidence: rememberInput 24/24 green; typecheck 0
- [ ] 3. `RememberService` and `WikiMemory.remember()` — storage, read-back, `valid_from`, `okf_type` — evidence:
- [ ] 4. Behaviour guarantees — no maintenance, searchable, embedding, outbox, temporal interplay — evidence:
- [ ] 5. Docs and the published surface — evidence:
- [ ] 6. Final cleanup commit (owner-gated) — evidence:

## Discrepancies

- (none yet)
