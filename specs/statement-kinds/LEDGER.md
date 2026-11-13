# LEDGER — statement kinds + areas (9.0.0)

Spec: `specs/statement-kinds/spec.md` (Reviewed 2026-11-13).
Plan: `specs/statement-kinds/plan.md`.

**In flight:** C3 brief staged
(`.superpowers/sdd/statement-kinds-9/task-3-brief.md`); dispatch
blocked at the command-approval gate (consent timed out, nothing ran).
Needs Kurt's go to launch.

## Tasks

- [x] C1 — schema manifest: 6 nodes, 4 edges, removals, counts 21/42
      (tests: manifest.test.ts items 1-3) — commit 6d933cdb; RED
      10/40 → GREEN 40/40 (task-1-red.log, task-1-report.md);
      controller-verified: counts, order, zero removed-type refs.
- [x] C2 — core: librarianSystemPrompt removal + notice + builder
      export (tests: items 4-5; goldens byte-identical) — commit
      3a67ded3; RED 6 files/7 tests → GREEN 212 files/2428 tests, 0
      failed; typecheck 0; golden exit 0 (2 retired entries only);
      controller-verified. Deviation: brief's inline-manifest wording
      corrected by implementer per spec (handoff absent so strict
      remember() rejects it).
- [x] C3 — schema: prompt-plumbing test + README statements section —
      commit 8bb87097; GREEN 2 files / 46 tests, typecheck 0;
      controller-verified (counts both README sites, catalog rows,
      human-reviewed caution present). Note: stale core dist rebuilt
      by implementer (the documented stale-dist trap).
- [x] C4 — benchmarks: classification-fixture subcommand + fixture —
      commit 1fb27086; GREEN 16 files / 153 tests (baseline 15/148),
      typecheck 0, dry-run zero-token (28 statements, estimate
      printed, no results written). DEVIATION SUSTAINED: remember()
      has no LLM step; runner classifies via runOntologyBackfill (LLM
      classifier, buildPromptContext-internal) — spec test-plan
      sentence amended in the same PR, flagged for the merge ask.
- [x] C5 — docs site + 8 sibling README count rows + ROADMAP mark +
      INTENT amendment — commit be81d260; astro build OK (53 pages),
      no stale counts; controller-verified. Notes for merge ask:
      ROADMAP done-mark format newly applied (verify wording); docs
      sidebar entry added for upgrading-9.md.
- [ ] C6 — measured rule/decision run (dry-run → announced budget →
      --yes) + Errata record
- [ ] C7 — cleanup: Status → Implemented, delete plan/LEDGER, pr ready

## Evidence

(each tick links the verifying run output or commit)
