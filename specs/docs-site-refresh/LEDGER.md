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
