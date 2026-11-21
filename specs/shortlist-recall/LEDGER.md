# Ledger — PR 2a: shortlist builder + `shortlist-recall` benchmark

Status line: implementation LANDED (PR #439, merge `96e82271`), extended by the
distractor-variants lane (PR #447; base head `48842848`, review-fold commits
`44b086dc` and `141512b5`). Spec is owner-ruled
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

Variant-pool extension (#447): T1.5-style internal review + CI + CodeRabbit done.
T3 Opus round 1 (2026-11-21, $1.15, "Approve with changes"): 1 MAJOR + 7 MINOR,
all verified and folded in `44b086dc` (SEED_ROWS single source, comment honesty,
four-pool spec prose, byte-identity wording, 53-row evidence caveat, test
coverage, type-index consistency).
T3 Opus round 2 — delta on `48842848..44b086dc` (2026-11-21, $0.39,
"Approve with changes"; reviewer was TREE-BLIND — parked-branch seat, `git show`
approval-gated — so every finding was adjudicated against the working tree):
- M1 (pool changed after the run): DISPROVEN. Empirical: post-fold real run
  (working tree at `141512b5`) fully identical to the committed
  `shortlist-recall-9.8.0-2026-11-21.json` (every key), and the post-fold double
  run is byte-identical — both outputs sha256
  `9fd33da5acb53c2a87075ec0a59f4684a6d357dc3ff9c7ccf97ad569b07591db` (2026-11-21;
  /tmp copies are ephemeral, this hash + the committed file are the record).
  Citation: variant `okf_type` reaches the report only via
  `perEntry.actualTypes` / `typeAccuracyAtK`, which read the TITLE-MATCHING hit
  row (`shortlistRecall.ts:409`, `:277` at `141512b5`+nits-fold) — always a seed
  row, since variant titles can never match a seed key (seen-key guard,
  `shortlistRecall.ts:209`).
- m1 (byte-identity wording): verified true as written — no `createdAt` or any
  timestamp field exists in either committed result (`grep -c createdAt` = 0);
  the writer serializes the report as-is.
- m2 (mutable SEED_ROWS singleton): FIXED in `141512b5` — array + rows frozen,
  `buildPools` copies per call.
- m3 (test checks the guard against itself): FIXED in `141512b5` — new test
  cross-checks every fixture expected target against SEED_ROWS keys.
- m4 (unverified caveat figures): verified against the committed file —
  `distractor-200` k=10 is lexical 1 vs embedding 0.9643. Correct as written.
- m5 (vague provenance): FIXED — this ledger now cites explicit SHAs.
T3 Opus round 3 — delta on `44b086dc..f280b952`, worktree clone seat (2026-11-21,
$0.39, **Approve with nits** — converged; no MAJOR/BLOCKER): nit 1 stale line
citations → this ledger's citations now pinned to HEAD lines + SHAs; nit 2 M1
run provenance → run SHA + output sha256 recorded above; nit 3 `as` cast hiding
literal checks → inner `as ShortlistRow[]` annotation restores field checking;
nit 4 test comment overstatement → comment now states the reverse-direction
value and defers type coverage to `groundTruthCheck`.

## Evidence

| Task | Evidence | Tick |
|---|---|---|
| T1 | `packages/core/src/utils/shortlist.ts` + `packages/core/__tests__/shortlist.test.ts` (PR #439, `96e82271`) | ☑ |
| T2 | `packages/benchmarks/src/shortlistRecall.ts` generators; extension commit(s) on #447 | ☑ |
| T3 | `runShortlistRecall` + `packages/benchmarks/results/shortlist-recall-9.5.3-2026-11-21.json` | ☑ |
| T4 | `runShortlistRecallCommand` in `packages/benchmarks/src/cli.ts` + `shortlistRecallCli.test.ts` | ☑ |
| T5 | `packages/benchmarks/results/shortlist-recall-9.8.0-2026-11-21.json` (zero LLM tokens; double-run byte-identical) | ☑ |
| T6 | PR #448 | ☐ |
