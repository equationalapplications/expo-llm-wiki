# LEDGER — PR 2b (backfill shortlist wiring)

What's in flight: plan-review ladder COMPLETE (T1.5 + Opus T3 r1 +
delta). No implementation tasks started.

- [x] T1 — `shortlistK` knob + resolver (commit: `feat(core): shortlistK config knob…`)
  Evidence: commit `56e16692`; controller re-ran gates at head: engineDefaults 19/19, typecheck exit 0, core suite `Tests  2947 passed (2947)` (253 files); RED evidence in `.superpowers/sdd/2b-backfill-shortlist/task-1-report.md`.
- [x] T2 — per-fact candidate renderer (commit: `feat(core): per-fact candidate section renderer…`)
  Evidence: commit `e321b98a`; controller re-ran gates at head: PromptService.test 48/48, typecheck exit 0, core suite `Tests  2953 passed (2953)`; RED evidence in `task-2-report.md`.
- [ ] T3 — scoring rows query reads `body` (commit: `feat(core): shortlist scoring rows query…`)
  Evidence: 
- [ ] T4 — PromptService candidate sections (commit: `feat(core): backfill prompt carries per-fact candidate sections…`)
  Evidence: 
- [ ] T5 — MaintenanceService wiring (commit: `feat(core): shortlist wiring in the ontology backfill pass…`)
  Evidence: 
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
- Total: $1.1428 (house cap $5 — under cap)
