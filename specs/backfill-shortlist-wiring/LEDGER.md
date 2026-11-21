# LEDGER — PR 2b (backfill shortlist wiring)

What's in flight: plan-review ladder (T1.5 complete; Opus T3 r1 returned
findings, folded). No implementation tasks started.

- [ ] T1 — `shortlistK` knob + resolver (commit: `feat(core): shortlistK config knob…`)
  Evidence: 
- [ ] T2 — per-fact candidate renderer (commit: `feat(core): per-fact candidate section renderer…`)
  Evidence: 
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
  into spec.md/plan.md (fold commit: see git log, `docs(spec): fold opus-t3…`).
- [ ] Opus T3 delta (verification round)
  Evidence: 

## Spend

- Rung 1 (haiku-high): $0.0055
- Rung 2 (sonnet high/xhigh): $0.1144
- Rung 3 (haiku max): $0.0057
- Opus T3 r1 (medium): $0.5392
- Running total: $0.6648 (house cap $5 for this ladder)
