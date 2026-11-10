# Targeted diagnostics — ledger

In flight: nothing

- [x] 1. Determinism harness — evidence: 9502267, determinism.test.ts 5/5
- [x] 2. LongMemEval ingest honours maintenance flag — evidence: a42e1ea, ingest.test.ts 6/6
- [x] 3. Supersession parity + version label — evidence: 0b5d690, package 117/117
- [x] 4. Prompt-volume ledger — evidence: a148cc0, promptVolume.test.ts 9/9
- [x] 5. Strategy-aware dry-run estimate — evidence: 60fe6f8, cli.test.ts, 0.93x the ledger
- [x] 6. Gate decision log — evidence: bc86485, gateDecisions.test.ts 6/6, calibrate CLI smoke
- [x] 7. Retrieval miss attribution — evidence: cf5242b, retrievalAttribution.test.ts 5/5 in 42 s
- [x] 8. Docs + full verification — evidence: root pnpm test green in 1:33 (benchmarks +~41 s), pnpm -r typecheck exit 0

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
  - Under the scripted provider, legacy-auto sent 75,857 user characters
    in 3 calls, about 20x the raw event text. Before the Task 5 tail fix the
    reading was 132,556 in 4 calls.
  - ops-deferred sent 8,175 in 3 calls.
  - Caveat: the scripted provider returns one fact per event, which inflates
    legacy's fact-row context. This is prompt volume, not billed tokens.
- 2026-11-10 (Task 6). **The gate's duplicate threshold has almost no headroom.**
  - At production thresholds the real `gateCandidates` misroutes the same 2
    rows calibration found (`mixed-1::1`, `mixed-1::2`, labelled ADD, routed
    to resolve). Both errors go in the safe direction.
  - The ambiguous row `job-1` sits 0.001 below `dupThreshold` (cosine
    0.889).
  - Three true duplicates clear 0.89 by only 0.009 to 0.028.
  - A small change to the embedding model or the embed text flips NOOP to
    resolve, or resolve to NOOP. This is a tuning lever.
- 2026-11-10 (Task 7). **Retrieval: the shipped default is pure vector, and a 0.5 blend hurts.**
  - With `hybridWeight` unset, the default is pure semantic search
    (`core types.ts` WikiConfig.hybridWeight). The integration reports label
    this "hybrid".
  - Default NDCG@10 is 0.7200 on SciFact and MRR@10 is 0.7017 on FinanceBench,
    reproducing the integration numbers exactly.
  - Keyword-only gives 0.6917 and 0.4367.
  - A 0.5 blend gives 0.7170 and 0.5135: 24 of 150 FinanceBench queries
    (and 18 of 300 SciFact) that vector search ranks in the top 10 fall out
    once keyword is blended in.
  - Keyword search never rescues a vector miss on either set (`vector-miss`
    0).
  - Hard misses (`both-miss`): 25 on SciFact and 2 on FinanceBench.
  - Lever: anyone setting `hybridWeight` should know it costs accuracy on
    both sets. The keyword score normalisation (`getKeywordScores` divides
    by max(1, top)) is the first suspect.

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
- Task 5. Ruling: the ledger's auto tail pass now runs only when events remain past `memory_checkpoint`, as `ingest.ts` does. The baseline was regenerated (legacy-auto went from 4 calls to 3).
  - Why: an unconditional tail added a pass the real harness never makes.
  - Cost if wrong: none.
- Task 5. Ruling: the legacy estimate models a 190-char event-row overhead and a 700-char fact row, both measured from the legacy prompt. The plan had only a 200-char fact allowance. The estimate is 0.93x the ledger.
  - Cost if wrong: the estimate overstates legacy when a real model extracts fewer facts than there are turns. That is conservative.
- Task 6. Ruling: in-batch duplicates are logged as `noop` rows with `inBatchDuplicate: true`, since `gateCandidates` drops them before neighbour lookup.
  - Why: this keeps one row per candidate.
  - Cost if wrong: none.
- Task 7. Ruling: the modes are keyword (`hybridWeight` 0), default (unset, which is pure vector) and a 0.5 blend. `AttributionReport.vectorOnly` became `defaultMode`.
  - Why: weight 1 and unset both mean vector, so a "vector-only" mode would duplicate the default.
  - Cost if wrong: another blend weight may behave differently. The 0.5 blend is one point, not a sweep.
- Task 7. Ruling: the guards exclude the `hit` class.
  - Why: an upper bound on hits would fail an improvement.
  - Cost if wrong: none.

## Discrepancies
