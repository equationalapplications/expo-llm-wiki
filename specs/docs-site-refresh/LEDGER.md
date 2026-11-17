# LEDGER — docs-site-refresh

Branch `specs/docs-site-refresh` · baseline main `27f8e5e9` (v9.2.0 + cooldown sweep) ·
worktree `/mnt/kv-work/build/worktrees/expo-llm-wiki/docs-site-refresh` (primary checkout
held by PR #402's lane; forget-erasure worktree — both untouched).
SDD progress ledger (live): `.superpowers/sdd/docs-site-refresh/progress.md` (gitignored).

Content obligations inherited from the forget-erasure lane per owner ruling 2 — vault
handoff `records/handoffs/2026-11-17-handoff-expo-llm-wiki-docs-lane-content-inherit.md`.
Glossary directive + memory-layer term set (Fact, Working Memory, Wisdom, Episodic
Memory) added by owner, 2026-11-17.

| Date | Step | Artifact | Spend |
|---|---|---|---|
| 2026-11-17 | Lane pickup: #404/#402 ownership re-derived from vault + live PR state; no collision (ruling 2: #404 touches no apps/docs) | session record (vault, end of block) | — |
| 2026-11-17 | step-0 investigation: docs-vs-v9.2.0 audit (subagent, read-only, every gap cited against `git show v9.2.0`); build verified 53 pages; scrub guard mapped | `investigation.md` rev 1 | — |
| 2026-11-17 | spec rev 1 draft + PR opened (draft) | `spec.md`, this LEDGER | — |
| 2026-11-17 | **SPEC APPROVED** (Kurt, Discord msg 1572310398869311610); spec status → rev 2; plan.md written with announced caps (Fable r1 ≤$6, delta ≤$4/round, ladder ≤$18, lane ≤$20) | `plan.md` | — |
| 2026-11-17 | **PLAN APPROVED + SEQUENCING RULED** (Kurt, Discord msg 1572312605224075315): run Tier-1.5 convergence cycle HERE NOW as a pre-check; after it converges, merge `specs/docs-site-refresh` into `specs/forget-erasure` (PR #404) so #404 is reviewed as a whole. Implementation then proceeds on this branch with checkpoint sync-merges into #404 (single-writer per branch per worktree; no direct commits to the sibling lane's checkout). PR #406 becomes the staging branch for the docs half of #404. | LEDGER, plan Sequencing | — |
| 2026-11-17 | T1.5 r1 sonnet-high range review 27f8e5e9..f15f1246: **APPROVE WITH NITS** ($0.1334). 2 MAJOR + 3 MINOR: M1 stale status line, M2 contradictory merge-order text — both REAL, folded; m1 scrub-grep shape REAL (adopted `-U0 \| grep '^+'`); m2 machine-local paths in LEDGER DECLINED (house convention, sibling LEDGER identical shape); m3 T1–T8 checkboxes REAL, added. r1 independently re-verified spec's v9.2.0 facts against `git show v9.2.0` — all match. Dispositions: scratch `docs-lane-t15/sonnet-r1-dispositions.md` | spec rev 3 + plan T8/Release fixes | $0.1334 |
| 2026-11-17 | T1.5 r1 fold commit `5e2c33a8` — spec rev 3 + plan T8/Release rewrite + LEDGER checklist (fixes for r1 M1/M2/m1/m3; m2 declined) | fold commit | — |
| 2026-11-17 | T1.5 r2 sonnet-high delta 27f8e5e9..5e2c33a8: **APPROVE WITH NITS** ($0.1304), 0 MAJOR, 4 MINOR — all REAL, folded: m1 secure_delete grep scoped to `apps/docs`; m2 sidebar.order made satisfiable (guide 3.5 fractional, glossary 6); m3 dead "Two orderings" lead-in deleted; m4 this fold-commit row added. Reviewer re-verified v9.2.0 facts (codes/config/defaults) — all match. Dispositions: scratch `docs-lane-t15/` (r2 notated in this row) | spec/plan r2 folds | $0.1304 |

## T1–T8 checklist (tick only after the task's verification passes)

- [ ] T1 — `guides/source-store.md` (AC1 identifiers vs v9.2.0; AC2 frontmatter/links; AC3 feature-intro notes)
- [ ] T2 — reference fixes (wiki-memory / types / configuration / errors)
- [ ] T3 — guides fixes (diagnostics source_store rows / okf dump / ingest offsets)
- [ ] T4 — concepts fixes (how-it-works four surfaces / trust-and-provenance)
- [ ] T5 — deleting-data.md inherited obligation 1 (handoff bullets; no FULL pragma; no standalone-prune step)
- [ ] T6 — erase diagnostic rows (publish-time re-read of `specs/forget-erasure` diagnostics.ts recorded)
- [ ] T7 — reference/glossary.md (owner term set; adaptation rules; faithful-to-glossary diff check)
- [ ] T8 — build green + test-plan checks 1–5 + Fable → Opus delta ladder → #404 whole-PR review
