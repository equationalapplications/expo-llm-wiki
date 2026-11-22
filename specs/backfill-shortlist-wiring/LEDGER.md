# LEDGER — PR 2b (backfill shortlist wiring)

What's in flight: implementation T1-T5 ticked (below); Opus T3 CODE rung
returned REQUEST CHANGES (M1 late shortlistK validation; m1-m5) — fix
fold in flight (task 6 landed `b6823bbc` for plan-ladder-era findings;
delta r2 found M1/m1-m6, fold child task 7 dispatched). CORRECTION:
commit `8257e2ee` claimed the ledger in-flight fix but its string
replace no-op'd and only spec.md changed — this line is the real fix
(opus delta m1).

- [x] T1 — `shortlistK` knob + resolver (commit: `feat(core): shortlistK config knob…`)
  Evidence: commit `56e16692`; controller re-ran gates at head: engineDefaults 19/19, typecheck exit 0, core suite `Tests  2947 passed (2947)` (253 files); RED evidence in `.superpowers/sdd/2b-backfill-shortlist/task-1-report.md`.
- [x] T2 — per-fact candidate renderer (commit: `feat(core): per-fact candidate section renderer…`)
  Evidence: commit `e321b98a`; controller re-ran gates at head: PromptService.test 48/48, typecheck exit 0, core suite `Tests  2953 passed (2953)`; RED evidence in `task-2-report.md`.
- [x] T3 — scoring rows query reads `body` (commit: `feat(core): shortlist scoring rows query…`)
  Evidence: commit `ce1a40a7`; controller re-ran gates at head: ontologyBackfill.test 33/33, typecheck exit 0, core suite `Tests  2954 passed (2954)`; RED evidence in `task-3-report.md`.
- [x] T4 — PromptService candidate sections (commit: `feat(core): backfill prompt carries per-fact candidate sections…`)
  Evidence: commit `f19382e4`; controller re-ran per-file gate 48/48 + typecheck exit 0 at head; full suite 2 failed / 2952 passed — the 2 failures are the PREDICTED interim breakage (ontologyBackfill.test.ts catalog assertions, fixed by T5), verified controller-side. RED evidence in `task-4-report.md`.
- [x] T5 — MaintenanceService wiring (commit: `feat(core): shortlist wiring in the ontology backfill pass…`)
  Evidence: commit `d781b492`; controller re-ran gates at head: ontologyBackfill.test 39/39, typecheck exit 0, core suite `Tests  2960 passed (2960)`. Fold follow-up (plan gap found by gates): the benchmarks harness ride-through test pinned the retired system-prompt catalog shape — fixed test-only in the commit above, benchmarks suite back to `206 passed (206)` controller-side. RED evidence in `task-5-report.md`.
- [ ] T6 — gates green at final head; cleanup commit (spec → `Implemented`, prune plan/LEDGER, write ROADMAP step 8 done mark, `gh pr ready`)
  Evidence: 

## Review ladder

- [x] T1.5 plan review: haiku depth-high → sonnet effort-high/depth-xhigh → haiku depth-max
  Evidence: rung 1 haiku-high **APPROVE WITH NITS** $0.0055/3 turns
  (`~/.hermes/cache/scratch/2b-plan-t15-r1.md`); folds committed 6a79c0f4.
  Rung 2 sonnet effort-high/depth-xhigh **ALL FINDINGS RESOLVED**
  $0.1144/4 turns (`2b-plan-t15-r2.md`). Rung 3 haiku depth-max
  **PARTIALLY RESOLVED** $0.0057/8 turns (`2b-plan-t15-r3.md`) — one
  off-by-one cite left (WikiFact.body 566→567); fixed in 66c7d506.
- [x] Opus T3 plan review (r1)
  Evidence: **REQUEST CHANGES** — 3 MAJOR (M1 roadmap step-8 done mark
  missing from T6; M2 zero-pool spec/plan conflict; M3 resolver throw
  precedent + WikiConfig signature) + 8 MINOR. $0.5392/7 turns
  (`2b-plan-opus-r1.json`). All findings grep-verified real and folded
  into spec.md/plan.md in 6518c069.
- [x] Opus T3 delta (verification round)
  Evidence: **REQUEST CHANGES** — 1 MAJOR (the fold's invented 8000-char
  sections budget: catalog CHAR_BUDGET rationale does not carry over to
  per-batch sections; would wrongly truncate multi-fact batches) + 5
  MINOR (renderer owns the zero-pool footer; comment-block cite
  2268–2282; runBatched call cite :2300; OQ3 ruling clarification note;
  ledger fold hash). $0.4780/7 turns (`2b-plan-opus-r2.json`), range
  66c7d506..6518c069. All folded in the final ladder commit; per the
  announced ladder shape (one delta max), the ladder closes here —
  every delta finding is a fold of round-1/r2 material, no new design
  surface.

## Spend

- Rung 1 (haiku-high): $0.0055
- Rung 2 (sonnet high/xhigh): $0.1144
- Rung 3 (haiku max): $0.0057
- Opus T3 r1 (medium): $0.5392
- Opus T3 delta (medium): $0.4780
- Plan-ladder total: $1.1428 (house cap $5 — under cap)

### Code-stage review (announced separately: $3.00/rung, one delta max)

- Internal same-model review (delegated leaf): APPROVE-WITH-NITS, 3 MINOR
  folded `15d76c81` — $0.00
- Opus code r1 (medium): **REQUEST CHANGES** — M1 non-exclusive footer
  lost, M2 buildPrompt re-scores per call; m1 zero-pool "TITLE CATALOG:"
  relabel, m2 footer repetition, m3 types doc wording, m4 ledger (fixed
  8257e2ee — see correction above), m5 validity-window scope (deliberate,
  documented in spec). $0.6478 (`2b-code-opus-r1.json`); folds
  `8257e2ee` + `b6823bbc`.
- Opus code delta r2 (medium, r1 verdict as context): **REQUEST CHANGES**
  — M1 shortlistK validated late (auto+escalation can throw after the
  classifier committed); m1 this ledger's stale in-flight line, m2 this
  spend section, m3 stale harness comment run.ts:123, m4 zero-score rows
  under a "may relate" header, m5 wasted scoring under placeholder
  overrides, m6 T6 status-flip reminder. $0.7436
  (`2b-code-opus-r2.json`).
- Paid total so far: $2.5342 (all rungs); implementation dispatches ran
  inside their announced per-task caps.
