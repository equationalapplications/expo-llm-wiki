# Ledger — PR 2a: shortlist builder + `shortlist-recall` benchmark

Status line: implementation LANDED (PR #439, merge `96e82271`), extended by the
distractor-variants lane (PR #447, head `48842848`+). Spec is owner-ruled
(rulings folded 2026-11-21); T6 cleanup (Status flip + prune) rides PR #448.
Transient files — deleted by the cleanup commit; durable records live in the PR body.

## Tasks

- [x] T1 — Core shortlist module (`packages/core/src/utils/shortlist.ts` + unit tests)
- [x] T2 — Distractor generator + deterministic pools (extended 2026-11-21: fourth pool `distractor-variants`, 50 title-variant hard negatives, PR #447)
- [x] T3 — Recall runner: scoring, recall@k, baselines, result file
- [x] T4 — CLI `shortlist-recall` dispatch branch + lazy embed factory + guards
- [x] T5 — Real run (`bench shortlist-recall --yes`), determinism double-run, result file commit (re-run 2026-11-21 on #447: `shortlist-recall-9.8.0-2026-11-21.json`; old pools byte-identical; double-run byte-identity verified)
- [ ] T6 — Closeout: cleanup commit flips spec Status to IMPLEMENTED, deletes plan + ledger (**in flight as PR #448**)

## What's in flight

Variant-pool extension (#447): T1.5-style internal review + CI + CodeRabbit done;
T3 Opus review round 1 (2026-11-21, $1.15, "Approve with changes") — 1 MAJOR +
7 MINOR findings, all verified and folded in this ledger's parent branch
(SEED_ROWS single source, comment honesty, four-pool spec prose, byte-identity
wording, 53-row evidence caveat, test coverage, type-index consistency).

## Evidence

| Task | Evidence | Tick |
|---|---|---|
| T1 | `packages/core/src/utils/shortlist.ts` + `packages/core/__tests__/shortlist.test.ts` (PR #439, `96e82271`) | ☑ |
| T2 | `packages/benchmarks/src/shortlistRecall.ts` generators; extension commit(s) on #447 | ☑ |
| T3 | `runShortlistRecall` + `packages/benchmarks/results/shortlist-recall-9.5.3-2026-11-21.json` | ☑ |
| T4 | `runShortlistRecallCommand` in `packages/benchmarks/src/cli.ts` + `shortlistRecallCli.test.ts` | ☑ |
| T5 | `packages/benchmarks/results/shortlist-recall-9.8.0-2026-11-21.json` (zero LLM tokens; double-run byte-identical) | ☑ |
| T6 | PR #448 | ☐ |
