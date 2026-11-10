# Targeted diagnostics — ledger

In flight: nothing

- [ ] 1. Determinism harness — evidence:
- [ ] 2. LongMemEval ingest honours maintenance flag — evidence:
- [ ] 3. Supersession parity + version label — evidence:
- [ ] 4. Prompt-volume ledger — evidence:
- [ ] 5. Strategy-aware dry-run estimate — evidence:
- [ ] 6. Gate decision log — evidence:
- [ ] 7. Retrieval miss attribution — evidence:
- [ ] 8. Docs + full verification — evidence:

## Findings

- 2026-11-10 (Task 4). **ops + auto skips the first auto batch on a fresh entity.**
  - `WriteService.ts:126` sets `memory_checkpoint` to the write count inside
    the trigger transaction, before the pass runs.
  - The ops pass then calls `seedLibrarianWatermark`
    (`MaintenanceService.ts:760`). That function exists to migrate legacy
    databases, and here it anchors the watermark at event 20.
  - Result: events 1-20 are never extracted, and no LLM call is made.
  - Reproduced with the real clock, so the determinism harness is not the
    cause.
  - The 8.0.0 default (ops + deferred) is not affected; it sees all 56
    events.
  - Fixing it is a core change, out of scope here; file an issue. The
    baseline pins `eventsSeen` at 40, so the fix will flip this test.
- 2026-11-10 (Task 4). **legacy + deferred sees only the newest 50 events.**
  - `legacy.ts:35` uses `getRecent(entityId, 50)`.
  - On a 60-event backlog, events 1-10 are never seen (`eventsSeen` 50 of
    56).
- 2026-11-10 (Task 4). **Legacy prompt volume.**
  - Under the scripted provider, legacy-auto sent 132,556 user characters
    in 4 calls, about 34x the raw event text.
  - ops-deferred sent 8,175 in 3 calls.
  - Caveat: the scripted provider returns one fact per event, which inflates
    legacy's fact-row context. This is prompt volume, not billed tokens.

## Rulings

- Task 2. Ruling: tested the config through an exported `engineConfigFor(flags)` instead of spying on the WikiMemory constructor.
  - Why: spies on ESM constructors are brittle, and the helper is the code path `ingestQuestion` uses.
  - Cost if wrong: none.
- Task 4. Ruling: `createScriptedProvider(stream)` takes the stream, so the legacy librarian can match events by their summaries.
  - Why: legacy prompts carry no `eN` labels.
  - Cost if wrong: none.
- Task 4. Ruling: replaced the absolute 1.25 extract-ratio cap with per-site baseline checks.
  - Why: the cap came from long turns, and short events have a ratio near 1.6. Revision recorded in spec §3.
  - Cost if wrong: a slow extract-prompt bloat that stays within 10% per run could go unflagged.

## Discrepancies
