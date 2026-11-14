# LEDGER — source pointers on librarian facts (#377 / PR #385)

Owner: Tessera (expo-llm-wiki lane session). Spec: `spec.md` (Reviewed, rev 13).
Started: 2026-11-14, on the owner's spec stop.

| # | Date | Entry | Evidence |
|---|------|-------|----------|
| 1 | 2026-11-14 | Spec converged rev 9–13; independent re-gate PASS (rev 12, nits rev 13); issue #386 filed + cited | branch commits ee42e30f…93fa8d1a; gate transcripts in `.sdd/` (controller workspace, not committed) |
| 2 | 2026-11-14 | Implementation complete: schema v16, ops/legacy write paths, OKF round-trip, dump import presence-flag, prune semantics, INTENT/ROADMAP/glossary/README | tests 1–14 pass (18/18 sourcePointers.test.ts); core suite 2447/2447; workspace typecheck + `pnpm test` exit 0; CI green (test/analyze/CodeQL/rust-test) |
