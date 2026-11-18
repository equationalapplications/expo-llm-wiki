# Plan — docs-site-refresh (PR #406)

Branch `specs/docs-site-refresh` · baseline main `27f8e5e9` · spec rev 2 (owner-APPROVED
2026-11-17, Discord msg 1572310398869311610). Doc-only lane: no engine code, no tests, no
deps. Every fact written into pages comes from `git show v9.2.0:packages/core/src/...`
(source-store rows) or branch `specs/forget-erasure` (erase rows, publish-time re-check) —
never from memory.

## Spend caps (announced)

Ladder = Tier-4 Fable (architectural, spec-bearing PR) → Opus delta review.
- Fable r1: ≤ $6 · Opus delta rounds: ≤ $4 each · ladder total cap: ≤ $18
- Whole-lane cap (reviews + fixes): ≤ $20 — stop and re-ask Kurt if any round exceeds its cap.
- Fold discipline: every finding adjudicated against source before folding (standing rule).

## Tasks

### T1 — New guide `guides/source-store.md`
Files: `apps/docs/src/content/docs/guides/source-store.md` (new).
Sections: why (verbatim text back — grounding quotes, passage windows, provenance),
write (`storeSource` + `StoreSourceResult` union, refusals return/don't-throw, busy-lock
throws), read (`getStoredSource`, `listStoredSources`, three-state `listSourceRefs.stored`,
`read()`'s `sources` option → `MemoryBundle.sources: SourcePassage[]`, UTF-16 offsets,
per-entity groups never merged), limits (`config.sourceStore` defaults 200k/5M, refusal
guards, 5 codes), delete & dump (`forget({ sourceRef })` drops text + syncs index; dump
embeds `storedSources`; import re-cuts, returns `skippedSources`).
Acceptance:
- AC1: every identifier/signature/default matches v9.2.0 source (spot-checked against
  `git show v9.2.0:packages/core/src`).
- AC2: frontmatter `title`/`description`/`sidebar.order` — the guide takes
  `sidebar.order: 3.5` (fractional insert between ingest-documents=3 and the next
  integer; Starlight orders numerically); the glossary takes `sidebar.order: 6`
  (free slot in `reference/`); internal links use `/expo-llm-wiki/...` base pattern.
- AC3: intro notes "added in 9.1/9.2" per feature; no `runPrune`-as-erasure claims; links
  to the glossary for the Sources layer term.

### T2 — Reference fixes
Files: `reference/wiki-memory.md`, `reference/types.md`, `reference/configuration.md`,
`reference/errors.md`.
- wiki-memory.md: `importDump` → `Promise<ImportDumpResult>`; `listSourceRefs` row shape
  (`stored?`, `sourceHash: string | null`); new method rows (`storeSource`,
  `getStoredSource`, `listStoredSources`); forget row notes stored-text deletion; short
  three-state `stored` prose.
- types.md: `MemoryBundle.sources`, `ReadOptions.sources`, `SourcePassage`,
  `StoreSourceResult`, `StoredSource`, `StoredSourceSummary`, `StoredSourceDump`,
  `ImportDumpResult`(+`skippedSources`), `MemoryDumpEntity.storedSources`;
  `librarian_watermark` "(Not the source text store)" naming note.
- configuration.md: `config.sourceStore` row (defaults, refusal-guard framing).
- errors.md: one-line pointer (storeSource refusals return `{ stored: false, diagnostics }`;
  only busy lock throws).
Acceptance: AC1 identifier match vs v9.2.0; AC2 no other rows touched.

### T3 — Guides fixes (source-store side)
Files: `guides/diagnostics.md` (5 `source_store_*` rows, operation `sourceStore`),
`guides/okf.md` (dump round-trip: `skippedSources` return + `storedSources` re-cut note),
`guides/ingest-documents.md` (chunk-boundary recipe → `ReadOptions.sources` offsets;
`storeSource` mention).
Acceptance: AC1 codes verbatim from types.ts:893-899; AC2 existing prose otherwise
unchanged.

### T4 — Concepts fixes
Files: `concepts/how-it-works.md` (three → four kinds of records: + stored source
documents/passages, migration v17), `concepts/trust-and-provenance.md` (source store named
as the retained-quote mechanism).
Acceptance: AC1 additions are additive — no rewording of existing correct claims.

### T5 — Inherited obligation 1: `guides/deleting-data.md`
Content: the handoff list verbatim (spec §3): erasure recipe (`forget` → `erase()`, NO
standalone `runPrune` step), erase-time-not-forget-time + `pruneSupersededAfter` caveat
(enumerated entities only), stored documents survive erase + `forget({ sourceRef })` as
their erasure path, host-connection pragma requirement, copy census (events kept unless
`clearAll({ includeEvents: true })`; drain the outbox; manifest stays; exports bring data
back), VACUUM temp-db residue + `PRAGMA temp_store=MEMORY` guidance, no-opt-out
`secure_delete=ON` statement (never "FULL"), ruling-D sentences (events follow host
`retainEventsFor`), "handling an erasure request" recipe naming `forget({ eventId })`.
Acceptance:
- AC1: every handoff bullet present; grep `secure_delete=FULL` over apps/docs → empty.
- AC2: recipe shows no standalone `runPrune` step.

### T6 — Inherited obligation 2: erase diagnostic rows
Files: `guides/diagnostics.md` (second commit of T3's file).
Publish-time check FIRST: re-read `packages/core/src/utils/diagnostics.ts` on branch
`specs/forget-erasure` immediately before writing (codes may have renamed under dual
review), and re-check at ready-flip time. Rows: `erase_secure_delete_off` (error),
`erase_entity_skipped` (warn), `erase_registry_sweep_skipped` (info),
`erase_retired_vtab_undroppable` (warn) — severity/message verbatim from the branch.
Acceptance: AC1 names/severities match the branch AT WRITE TIME, diff-recorded in LEDGER.

### T7 — New page `reference/glossary.md`
Content: spec §5 verbatim — three groups (memory model: Fact, Working Memory, Wisdom,
Episodic Memory, Sources; lifecycle verbs: Memory Fact States, Forget, Prune, Erase
*(ships with forget-erasure)*, Expire *(planned)*, Heal; EA vocabulary: Intuitive Wisdom,
Curated Wisdom, Wisdom Layer, Active Librarian, Anchor Truth, OKF, schema-software-org,
core-llm-wiki/expo-llm-wiki, Data Sovereignty). Adaptation rules 1–4 (plain language, no
private-repo names, faithful to EA glossary, unreleased marked).
Acceptance:
- AC1: all four owner-named memory-layer terms present (Fact, Working Memory, Wisdom,
  Episodic Memory) + Intuitive Wisdom + Erase/Expire.
- AC2: `grep -iE "synapsetree|vault|ISF|librarian chunk" reference/glossary.md` → only
  permitted hits (no vault jargon, no private repos).
- AC3: definitions faithful to the EA glossary source text (diff-checked against the vault
  glossary during the ladder).

### T8 — Verification + handoff to the #404 lane (scope amendment, owner ruling 2026-11-17 msg 1572316502831407295; superseded same day by lane consolidation, owner msg 1572320813875597334 — the docs session was stopped and the #404 controller absorbed this lane; single controller owns both PRs)
- `astro build` green (+2 pages); test-plan checks 1–5 of the spec; scrub guard
  (added-lines-only grep, r1-m1 shape).
- **CONSOLIDATED (owner, msg 1572320813875597334): the docs session was stopped; the
  #404 controller owns BOTH lanes.** The T1–T4 draft verification, T3/T4 completion,
  T5/T6/T7 acceptance, and the build gate were executed by the #404 controller's
  verifier subagent; the controller commits and checkpoint-merges. The whole-PR review
  ladder (Fable → Opus), ready-flip, and merge gate run on #404 under the same
  controller.
- Verification receipts: `.superpowers/sdd/forget-erasure/docs-verify-report.md` on the
  forget-erasure worktree (per-file verdicts, publish-time diagnostics SHA
  `c8af61e8`, build exit 0 re-confirmed by the controller).

## Execution order

T1 → T2 → T3 → T4 (content build-up) → T5 → T6 (publish-time check) → T7 → T8.
Parallelizable: T1–T4 read-only wrt each other; single implementer session (subagents for
drafting per file batch), one commit series on the lane branch.
