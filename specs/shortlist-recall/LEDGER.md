# Ledger — PR 2a: shortlist builder + `shortlist-recall` benchmark

Status line: plan authored 2026-11-21; implementation not started. Spec is
APPROVED (owner rulings folded 2026-11-21); plan.md + LEDGER.md added per the
house lifecycle (`specs/README.md` step 2). Transient files — deleted by the
cleanup commit; durable records live in the PR body.

## Tasks

- [ ] T1 — Core shortlist module (`packages/core/src/utils/shortlist.ts` + unit tests)
- [ ] T2 — Distractor generator + three deterministic pools
- [ ] T3 — Recall runner: scoring, recall@k, baselines, result file
- [ ] T4 — CLI `shortlist-recall` dispatch branch + lazy embed factory + guards
- [ ] T5 — Real run (`bench shortlist-recall --yes`), determinism double-run, result file commit
- [ ] T6 — Closeout: cleanup commit flips spec Status to IMPLEMENTED, deletes plan + ledger

## What's in flight

Plan review ladder in progress: T1.5 haiku rung done (APPROVE WITH NITS,
findings folded 2026-11-21, $0.0084); T3 Opus rung pending.

## Evidence

| Task | Evidence | Tick |
|---|---|---|
| T1 | pending | ☐ |
| T2 | pending | ☐ |
| T3 | pending | ☐ |
| T4 | pending | ☐ |
| T5 | pending | ☐ |
| T6 | pending | ☐ |
