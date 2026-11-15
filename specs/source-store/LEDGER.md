# LEDGER — source store (single-PR lane, PR #396)

Spec: `specs/source-store/spec.md` (head at plan-write: `11e62583`).
Plan: `specs/source-store/plan.md`. Baseline logs:
`.superpowers/sdd/source-store/` (gitignored scratch, absolute path
`/home/kv-thinkpad-t420-ubuntu/code/github/equationalapplications/expo-llm-wiki/.superpowers/sdd/source-store/`).

**Baseline:** GREEN (2026-11-15, run2 after clearing a stale shared
`node_modules/.vitest-cache` — ENOTEMPTY race, environment not code):
`pnpm test` full suite EXIT=0, 286 test files passed / 286, **3253 tests
passed / 3253**, zero failures. Log:
`.superpowers/sdd/source-store/baseline-test-run2.log`. Install:
`pnpm install --frozen-lockfile` clean.

**In flight:** T2 dispatched (JobManager `store` op; Claude Code sonnet/low,
brief `briefs/t2.md`, cap $0.90).

## Tasks

- [x] T1 schema + migration v17 (§3; test items 2–3) — **DONE 2026-11-15**.
      Two runs (t1 stopped on ledger-dirty guard — correct; t1b completed).
      Commit `ddd092d7` (6 files; DDL matches §3 exactly: two plain UNIQUE
      indexes incl. entity_id, no deleted_at, no passage text column;
      v17 pre-check aborts on rows/column-mismatch, empty expected-state
      passes; no-op backfill; CURRENT_SCHEMA_VERSION derives). Version-pin
      cascade folded: sourceRefNormalize/fts5RenameRetire/setupBudget
      16→17 post-migration pins (pre-migration fixtures untouched).
      Controller re-verified: typecheck EXIT=0, core suite 214 files /
      2457 tests EXIT=0 (/tmp/t1-verify-{tc,test}.log). Implementer spend
      $0.3053 (t1) + $0.2569 (t1b).
- [x] T2 `store` OperationType + conflict matrix (§10, §7; item 7) — **DONE
      2026-11-15**. Commit `f72d0b54`: `'store'` in OperationType +
      WikiBusyOperation; `_storeKey`/`_isStoreActiveFor`/lockKeyFns entry;
      store case in acquireLock + isBlocked; BOTH directions wired (14
      `_isStoreActiveFor` refs: prune, librarian/heal/ontologyBackfill,
      reembed key-suffix section, global_import, store itself);
      `releaseLock('store')` clears. New jobManagerStoreLock.test.ts (20
      tests: both-direction WikiBusyError, serialize, different-entity
      non-conflict, entity-wide ingest). Controller re-verified: TC=0,
      215 files / 2477 tests EXIT=0 (/tmp/t2-{tc,test}.log). Spend $0.3802.
- [x] T3 sha256 hasher + diagnostic codes (§3, §9) — **DONE 2026-11-15**.
      Commit `77328e32`: new pure `utils/sha256.ts` (`sha256Hex`, no deps,
      vectors match node crypto — controller verified 'abc' against
      crypto ground truth); five `source_store_*` codes in
      WikiDiagnosticCode; WikiDiagnosticOperation gains `'sourceStore'`
      (camelCase per `externalDeletion` neighbor). 216 files / 2482 tests
      EXIT=0 controller-verified (/tmp/t3-{tc,test}.log). Spend $0.3046.
- [x] T4 store write path — SourceStoreService + Maintenance deletes (§5, §7, §9; items 4, 7) — **DONE 2026-11-15**.
      Commit `ba86744c`: new SourceStoreService (`storeSource` full refusal
      matrix — invalid-arg throw, surrogate/NUL, mismatch no-op rules,
      duplicate-hash vs store + LIVE `source_ref_index` rows with
      `deleted_at IS NULL AND source_ref <> ?`, budget re-read INSIDE the
      write transaction, changed-copy hard delete, `TODO(task-6)` passage
      marker inside the transaction); MaintenanceService forget/clearAll
      hard-delete store rows in existing transactions (6 refs); 13 tests.
      Beyond-brief choices recorded: used registered
      `source_store_source_too_large` (brief typo); config read
      structurally (types.ts off-limits — add `sourceStore` to WikiConfig
      when types.ts next opens, T7/T8); refusals also fire onDiagnostic;
      budget total excludes the replaced copy; forget({sourceHash}) also
      deletes store rows. One timing flake observed (idThreading.test.ts,
      passed alone + on re-run) — watch. Controller re-verified: TC=0,
      217 files / 2495 tests EXIT=0 (/tmp/t4-{tc,test}.log). Spend $0.6004.
- [x] T5 store read paths + listSourceRefs three-state (§4; items 4, 6) — **DONE 2026-11-15**.
      Commit `433ab9bc`: getStoredSource/listStoredSources (plain reads, no
      write lock); listSourceRefs LEFT-JOINs source_documents on
      (entity_id, source_ref) → `{ charCount }` / `{ charCount,
      staleHash: true }` / `null`; WikiMemory listSourceRefs region only
      (types.ts untouched — result type is inline). 8 new read tests + 3
      exact-shape listSourceRefs assertions gained `stored: null` (§4
      requires null, not omitted). ⚠️ OPEN SPEC-VS-CODE GAP (see handoff):
      the forgotten-ref test deletes store rows via SQL because the real
      `forget({ sourceRef })` ALSO soft-deletes the facts, so a real
      forget drops the ref from listSourceRefs — contradicting §4's
      "stays listed with stored: null" (a delta-verified ruling from the
      T3-Opus fix round). Resolution needed at T9 or via spec amendment
      (options recorded in handoff). One idThreading timeout flake again
      (passed on re-runs) — second occurrence, watch. Controller
      re-verified: TC=0, 218 files / 2503 tests EXIT=0
      (/tmp/t5-{tc,test}.log). Spend $0.4055.
- [x] T6 passage index, both strategies (§6; item 5) — **DONE 2026-11-15**.
      Commit `e4e8cbd1`: offset-tracking cutter
      `utils/passageCutter.ts` (≤12,000 UTF-16 units, whitespace ends the
      passage, pair-safe hard cut, no trim/overlap, NOT chunkText);
      SourceStoreService inserts offset-only `source_passages` rows inside
      the write transaction (TODO(task-6) slot consumed; passage text never
      stored); FTS5 `source_passages_fts` virtual table + map + ledger +
      triggers created by strategy init (pre-v17 guard; once-only backfill
      enqueue); `drainPassages` reads the ONE drained document's text into
      JS and slices at stored offsets (§6's stated departure,
      maxCharsPerSource-bounded); `searchPassages` joins live
      `source_passages` rows (stalled-drain guard); MiniSearch second
      in-heap instance with `reindexSourcePassages` post-commit sync.
      Choices beyond brief (all disclosed): passage FTS objects use
      `doc_id` (migration17.test reserves `document_id`); drain slices at
      stored offsets rather than re-cutting; `drain()` untouched —
      **⚠️ T9 CARRIER: `drainPassages` (FTS5) and `reindexSourcePassages`
      (fallback, incl. after forget/clearAll) are NOT yet called from
      service wiring — T9 must wire drain()+drainPassages on the FTS5
      path and reindex after strategy pick + removal sync**; 5 existing
      tests updated (placeholder passageCount / hand-inserted rows /
      trigger counts scoped to entries_fts) — no test-only logic changes.
      Controller re-verified: TC=0, 219 files / 2513 tests EXIT=0
      (runs/t6-controller-gates.log). Spend $0.9836.
- [x] T7 `sources` read option + offsets/hard-cut (§7; items 4–5) —
      **DONE 2026-11-15**. Commit `da65d81a`: types.ts opened
      (`WikiConfig.sourceStore` typing — T4's deferred item, cast in
      limits() left as T11 cleanup candidate; `ReadOptions.sources`;
      `MemoryBundle.sources?`; `SourcePassage`); `searchPassages?` on the
      strategy contract (Unavailable → empty, no throw); FTS5 +
      MiniSearch hits hydrated in JS (slice at offsets, no SQL substr);
      SearchService.searchPassages route (one call per entity);
      RetrievalService._readSources with the §7 window semantics
      (earliest-literal ASCII-ci anchor, whitespace-run window,
      surrogate-safe hard-cut from match start, match never dropped for
      size, truncated flags per §7, true document offsets,
      option-absent = zero passage work). Choices beyond brief (all
      disclosed): matched terms = the query's tokens (strategies return
      no matched-term list); "narrowest whitespace-bounded window" =
      the whitespace-delimited run holding the match; **charBudget read
      as PER-ITEM (never-drop-for-size), not a per-entity shared total —
      §7/§9 ambiguity, flagged for the review ladder**; empty query →
      `sources: []`. T9 carrier stands: production read returns no
      passages until drainPassages/reindexSourcePassages are wired
      (implementer confirmed they left the read path non-draining per
      brief). Controller re-verified: TC=0, 220 files / 2526 tests
      EXIT=0 (runs/t7-controller-gates.log). Spend $0.8796.
- [x] T8 dump import/export + skippedSources (§8; item 8) — **DONE
      2026-11-15**. Commit `ad269686` (t8 follow-up commit after a
      correct guardrail stop): types.ts `StoredSourceDump` /
      `ImportDumpResult` / `MemoryDumpEntity` (storedSources is
      dump-only; MemoryBundle unchanged); export writes per-scope,
      absent when nothing stored; import one-source-at-a-time inside
      the import transaction — re-computes text_hash, re-cuts passages
      (dump's passages array ignored), all four typed refusals with
      skip-and-list, same-ref replace (budget excludes the replaced
      ref's old count), merge:false wipe-then-write in-tx (wipes even
      with no storedSources in dump); malformed entry throws+rolls
      back; WikiMemory delta = the one-line importDump return widening
      only. 5 existing importDump assertions widened to
      `{ skippedSources: [] }` (diagnosticsEmbedding x3, importDump,
      vectorRemovalRev5). Choices disclosed, controller-verified vs §8.
      **⚠️ Naming delta for review ladder / T11 sweep: spec §9 proposed
      `source_store_too_large`, T4 landed `source_store_source_too_large`
      — reconcile (amend spec text or rename code) before merge.**
      Controller re-verified: TC=0, 221 files / 2537 tests EXIT=0
      (runs/t8-controller-gates.log). Spend $0.8035 + $0.1747 (t8b).
- [x] T9 WikiMemory wiring + formatContext (§7; items 1, 5–6) — **DONE
      2026-11-15**. Commit `2bea0425`: public `storeSource` /
      `getStoredSource` / `listStoredSources` passthroughs (locks stay
      in the service); `SearchService.syncPassages` runs the passage
      sync at 5 sites — open/strategy-pick (§6 fallback re-index at
      open), post-search-re-init, post-`forget` (finally, skips
      dryRun, clearAll syncs all entities), post-`storeSource` (only
      when stored), and post-`importDump` (necessary extension: T8's
      imported rows must index); FTS5 → drainPassages, fallback →
      reindexSourcePassages, via a structural cast (IndexStrategy
      interface extension = T11 cleanup candidate); formatContext
      prints `### Sources` (markdown) / `SOURCES:` (plain) last, only
      when present, `(excerpt)` on truncated, entity ID per
      includeEntityIds; read() already forwarded options (untouched).
      14 wiring tests, both strategies. **§4 post-forget listing
      assertion intentionally omitted — TODO(owner-ruling-§4) marker
      in test; t9b will add it + any §4 amendment once the owner
      rules.** Controller re-verified: TC=0, 222 files / 2551 tests
      EXIT=0 (runs/t9-controller-gates.log). Spend $0.5601.
- [x] T10 INTENT rule 5 reword (§1) — **DONE 2026-11-15**. Commit
      `a1dd1b6e`, controller-applied in-session (hook-protected file,
      spec + owner approval on record, per plan): rule 5 heading and
      body now exactly spec §1's proposed wording — store paragraph
      added, Planned paragraph's store commitments removed,
      source-pointer shipped-status line + roadmap cross-reference
      kept, *Why* and `Status: Built.` kept; Amendments entry added
      dated 2026-11-15 (PR #396, `specs/source-store/`). No test
      asserts on INTENT.md; docs-only commit, no gate exposure.
- [x] T9b resolve §4 forgotten-ref gap + §9 code-name reconciliation.
      Spec §4 and test-plan item 6 amended to engine-conform semantics:
      a real `forget({ sourceRef })` soft-deletes the ref's facts too, so
      the ref drops OUT of `listSourceRefs`; `stored: null` describes only
      listed refs whose store holds nothing for the pair. Owner-flagged
      for the review ladder. `sourceStoreWiring.test.ts` now asserts the
      ref is absent after a real forget (TODO marker removed). §9 proposed
      code `source_store_too_large` → landed `source_store_source_too_large`
      (second commit, "docs(specs): reconcile §9 ..."; SHAs in `git log`
      — a commit cannot cite its own hash). Gates: core test 222 files /
      2551 tests green; typecheck clean.
- [ ] T11 full-suite sweep + cleanup commit (Status → Implemented, delete plan/LEDGER, roadmap mark)

## Run record

- 2026-11-15 T6 landed (`e4e8cbd1`) and controller-verified (219/2513,
  TC=0, $0.9836). Passage drain/reindex wiring deliberately deferred —
  carried as a T9 obligation in the T6 ledger entry above; T9's brief
  MUST include it.
- 2026-11-15 lane pivoted to SINGLE-PR delivery (owner msgs
  `1571548310672769026` / `1571548355681853451`): spec merges together
  with implementation on this branch; ready-flip and cleanup commit are
  last. PR was briefly ready; converted back to draft.
- Deviations: none yet.
