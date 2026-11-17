# Docs site refresh — v9.2.0 alignment, erasure-guide handoff, and the Glossary page

**Status: rev 2 — spec APPROVED by owner (Kurt, Discord msg 1572310398869311610,
2026-11-17). Implementation gated on plan approval (plan.md written, caps announced).**
**Issue:** none filed (lane opened by owner directive, Discord msg 1572305016348483625) ·
**Handoff (content obligations):** vault `records/handoffs/2026-11-17-handoff-expo-llm-wiki-docs-lane-content-inherit.md`
(owner ruling 2: #404 ships code + INTENT + JSDoc only; all `apps/docs` edits move to this docs lane) ·
**Investigation:** [`investigation.md`](./investigation.md) (docs-vs-v9.2.0 audit, every gap verified against `git show v9.2.0`)

## Problem

The GitHub Pages docs site (`apps/docs`, Starlight, published to
`equationalapplications.github.io/expo-llm-wiki/`) is three releases behind the engine:

1. **The source store (v9.2.0's headline feature) has zero docs coverage.** No page
   mentions `storeSource`, `getStoredSource`, `listStoredSources`, the `sources` read
   option, `config.sourceStore`, the `stored` field on `listSourceRefs` rows, dump
   `skippedSources`, or any `source_store_*` diagnostic code. Worse, existing pages make
   now-wrong claims: `reference/wiki-memory.md` says `importDump()` returns
   `Promise<void>` (it returns `Promise<ImportDumpResult>` with `skippedSources`), and its
   `listSourceRefs` row predates the three-state `stored` field and `sourceHash: string | null`.
2. **The erasure docs obligation moved here.** Owner ruling 2 (2026-11-17) moved
   forget-erasure's T9 guide work from PR #404 to this lane, item for item: the deleting-data
   guide must teach the erasure recipe (`forget` → `erase()`), erase-time scoping, what
   survives erase, and the copy census. #404 now touches no files under `apps/docs`, so the
   two PRs are file-disjoint.
3. **No Glossary.** The owner directed (2026-11-17): the site gains a Glossary built from
   the EA glossary (`ea-glossary-of-terms`, vault) and the memory-layer terminology —
   explicitly including **Intuitive Wisdom**, the memory model terms (**Fact, Working
   Memory, Wisdom, Episodic Memory**), and the memory verbs including the new GDPR-driven
   **erase()** (and Expire). None of this vocabulary exists on the site today.

## Root cause (with evidence)

The site was last aligned at 9.0.0 (`project/upgrading-9`). The 9.1.0 (source pointers)
and 9.2.0 (source store) lanes shipped without a docs task in their plans. The full
page-by-page gap list — with file:line citations for every wrong or missing claim, and the
"verified correct, don't touch" list — is in [`investigation.md`](./investigation.md).
Every claim there was checked against `git show v9.2.0:<path>` (the working tree's
`apps/docs` is byte-identical to v9.2.0; `git diff v9.2.0 -- apps/docs/src/content/docs`
is empty).

## The decisions

### 1. New guide: `guides/source-store.md` (the missing v9.2.0 page)

One guide covering, in plain language with runnable examples, all verified at v9.2.0
(`packages/core/src`):

- **Why:** facts are condensed; sometimes the host needs the verbatim text back —
  grounding quotes, exact passage windows, provenance. The store keeps original source
  documents (`source_documents`) and passage cuts (`source_passages`, migration v17).
- **Write:** `storeSource(entityId, { sourceRef, sourceHash, text })` → `StoreSourceResult`
  (discriminated union: `{ stored: true, sourceRef, sourceHash, charCount, passageCount,
  storedAt }` or `{ stored: false, diagnostics }` — refusals return, they don't throw; only
  busy-lock throws `WikiBusyError`). Passage index cuts passages automatically
  (offset-tracking cutter) and syncs on every write path.
- **Read:** `getStoredSource`, `listStoredSources` → `StoredSource` / `StoredSourceSummary`;
  `listSourceRefs` three-state `stored` field (`{ charCount, staleHash? } | null`) with
  `staleHash` meaning hash drift; `read()`'s `sources` option (`{ query, maxPassages? (8),
  charBudget? (4000 UTF-16 units) }`) → `MemoryBundle.sources: SourcePassage[]` with
  UTF-16 `startOffset`/`endOffset`, per-entity groups, never merged across entities.
- **Limits:** `config.sourceStore: { maxCharsPerSource (200,000), maxTotalChars (5,000,000) }`
  — owner-gated refusal guards, not targets; the five `source_store_*` diagnostic codes.
- **Delete & dump:** `forget({ sourceRef })` deletes the stored text and syncs the passage
  index; dump export embeds per-entity `storedSources`; `importDump` re-cuts passages,
  re-derives `text_hash`, ignores dump passages, and reports refusals in
  `ImportDumpResult.skippedSources`.
- Pointer to the glossary for the Sources layer term.

### 2. Reference fixes (mechanical, verified against v9.2.0)

- `reference/wiki-memory.md`: `importDump` return type row; `listSourceRefs` row shape
  (`stored?` field, `sourceHash: string | null`); new Source-store method rows
  (`storeSource`, `getStoredSource`, `listStoredSources`); forget row notes the
  stored-text deletion; short prose on the three-state `stored` semantics.
- `reference/types.md`: `MemoryBundle.sources`, `ReadOptions.sources`; new types
  `SourcePassage`, `StoreSourceResult`, `StoredSource`, `StoredSourceSummary`,
  `StoredSourceDump`, `ImportDumpResult` (+`skippedSources`), `MemoryDumpEntity.storedSources`;
  rephrase the `librarian_watermark` line per the engine's own
  "(Not the source text store)" naming note.
- `reference/configuration.md`: the `config.sourceStore` row with defaults and
  refusal-guard framing.
- `reference/errors.md`: one-line pointer — `storeSource` refusals return
  `{ stored: false, diagnostics }` instead of throwing; only the busy lock throws.
- `guides/diagnostics.md`: the five `source_store_*` codes with operation `sourceStore`.
- `guides/okf.md`: dump round-trip section notes the `ImportDumpResult.skippedSources`
  return and that dump entities may carry `storedSources` (import re-cuts passages).
- `guides/ingest-documents.md`: the "Reproduce chunk boundaries" recipe now points to
  `ReadOptions.sources` offsets (the manual `chunkText` reproduction predates the passage
  index); mention `storeSource` as the way to keep the text itself.
- `concepts/how-it-works.md`: the store keeps **four** kinds of records (facts, tasks,
  events, + stored source documents/passages).
- `concepts/trust-and-provenance.md`: the source store named as the mechanism that retains
  quoted text (the passage index is the provenance payoff of grounding).

### 3. Inherited obligation 1: `guides/deleting-data.md` erasure content

Exactly the handoff's item list, sourced from `specs/forget-erasure/spec.md` §6 (+§8) and
plan T9 on branch `specs/forget-erasure`:

- Erasure recipe: `forget` → `erase()` — **no standalone `runPrune` step** (erase's step 1
  already prunes with `retainSoftDeletedFor: 0` and `retainEventsFor: null`; a standalone
  prune with defaults would delete events older than 30 days and contradict the
  events-kept framing).
- Erasure happens at **erase time, not forget time**, with the `pruneSupersededAfter`
  caveat (facts soft-deleted during this erase hard-delete at the *next* erase, and only
  for entities erase enumerated).
- Stored documents **survive erase**; `forget({ sourceRef })` is their erasure path — the
  host calls it per document on an erasure request (owner ruling E).
- Host-connection pragma requirement: any connection that writes wiki tables must set the
  pragma itself.
- Copy census: events kept unless `clearAll({ includeEvents: true })` (ruling D carve-out);
  drain the outbox; host-stored documents survive unless `forget({ sourceRef })`; manifest
  stays; exports bring data back.
- VACUUM temp-db residue window; host guidance `PRAGMA temp_store=MEMORY` for the erase call.
- No-opt-out `secure_delete` statement — **the pragma value is `ON`**. CRITICAL (handoff
  errata, folded in commit `cc696a59`): the literal `PRAGMA secure_delete=FULL` is NOT
  valid SQLite and silently reads back 0 — never publish "FULL" as a pragma value. Full
  zeroing = `ON` (reads back `1`).
- Ruling D sentences: events follow the host's `retainEventsFor` — each host publishes its
  own value.
- A "handling an erasure request" recipe naming `forget({ eventId })` (#386) as the
  prerequisite path for retained quotes.

### 4. Inherited obligation 2: `guides/diagnostics.md` erase rows

Four `erase_*` codes from the #404 branch (`packages/core/src/utils/diagnostics.ts`,
severity/message verbatim): `erase_secure_delete_off` (error), `erase_entity_skipped`
(warn), `erase_registry_sweep_skipped` (info), `erase_retired_vtab_undroppable` (warn).
Handoff caveat honored: the last two names are implementation-introduced and may be
renamed in dual review — **publish-time check**: re-read the code rows on branch
`specs/forget-erasure` immediately before writing these rows, and again at PR-ready time.

### 5. New page: `reference/glossary.md` — the Glossary (owner directive)

A plain-language Glossary page in the Reference section (autogen sidebar; `sidebar.order`
after the types/errors pages), built from the EA glossary (`ea-glossary-of-terms`, RATIFIED
v1.0) plus the memory-model rulings. Three groups:

**The memory model (layers):**
- **Fact** — a librarian-extracted statement stored as a wiki entry; the engine's anchor
  truth. Since 9.0.0 statements carry a content-defined kind: rule, decision, lesson, trap.
- **Working memory** — session-scoped notes and handoffs: searchable, but never turned into
  facts, and they age out of search (host-side layer; ~90-day host judgement in the EA
  memory model).
- **Wisdom** — what the Librarian condenses raw input into: librarian-curated, interlinked,
  exportable knowledge. Curation means it passed through librarian synthesis and the
  correction path, not raw or raw-indexed.
- **Episodic memory** — the engine's event log: one row per `wiki.write()`, surfaced as
  `MemoryBundle.events`; the raw material for librarian and heal passes and the audit
  trail; hard lifetime via `pruneEventsAfter` (default 30 days).
- **Sources** — the original material, searched as-is. Since 9.2.0 the engine can also
  *store* source text and return verbatim passages (see the source store guide).

**The memory lifecycle and verbs** (owner-ratified 2026-11-17; erase/expire ship with the
forget-erasure release and are marked as such):
- **Memory fact states** — live / superseded / forgotten / gone. **Erased** is not a fifth
  state: it is the engine's verified claim that the bytes are unrecoverable, delivered in
  an `erase()` report.
- **Forget** — removes a fact from recall immediately (soft-delete). "Gone from recall now,
  gone from disk at erase" — an instruction, not destruction.
- **Prune (`runPrune`)** — applies the host's retention windows: superseded ages into
  forgotten, forgotten ages into gone, on the host's schedule.
- **Erase** — takes every forgotten fact in scope past gone: bytes unrecoverable, verified
  by reading the database file back, with an erasure report. Always-on; no opt-out.
  *(Ships with the forget-erasure release.)*
- **Expire** — ends a fact's validity without a replacement (an archive, not a deletion);
  the fact becomes superseded. *(Planned, unreleased.)*
- **Heal** — the consistency/repair pass over already-stored knowledge.

**EA vocabulary:**
- **Intuitive Wisdom** — knowing the curated wisdom fact *at the time it is relevant*. The
  test is temporal, not mechanical: the right fact present in context when it matters — not
  merely retrievable if the agent thinks to ask.
- **Curated Wisdom** — knowledge that passed through curation machinery (librarian
  synthesis + proposals/supersession + human reconciliation), not raw.
- **Wisdom layer** — the curated, graph-interlinked semantic memory tier; the first-class
  context source. Design bar: *structure does the work, not model cleverness* — recall must
  succeed even for a lesser agent.
- **Active Librarian** — the background engine that condenses raw input into curated
  knowledge; two named functions: ingest (understanding) and repair (consistency/heal).
- **Anchor truth** — facts-layer content treated as ground truth.
- **OKF (Open Knowledge Format)** — YAML frontmatter + body; the fact format the engine
  stores and exports.
- **schema-software-org** — the published ontology schema (node/edge types) agent memories
  follow.
- **core-llm-wiki / expo-llm-wiki** — the open-source TypeScript engine and its monorepo;
  all packages release in lockstep.
- **Data sovereignty** — the raw SQLite file is always the user's: exportable, portable,
  no vendor lock-in.

**Adaptation rules for every entry (owner rulings 2026-11-17, this lane):**
1. Self-contained, plain language, PM-readable; no vault-internal citations (`*Src:` lines
   are stripped); no vault jargon (ISF, chunk tiers, harness names).
2. **No private-repo names** (owner scrub ruling — issue #405): entries written from
   SynapseTree-sourced glossary text are genericized ("the hosted cloud service", "hosts").
3. Definitions stay faithful to the EA glossary wording; where the glossary cites engine
   INTENT rules, the entry states the behavior, not the rule number.
4. Unreleased vocabulary is marked honestly (see Erase/Expire), never presented as shipped.

### 6. Out of scope (guarded)

- The private-repo scrub — **issue #405's lane**. This PR touches none of the six files
  that still carry `SynapseTree` mentions (index.mdx, start/introduction.md,
  start/ecosystem.mdx, recipes/coding-agent-mcp.mdx, guides/serverless-hosting.md,
  packages/mcp-server.md) and adds zero new mentions anywhere.
- `project/upgrading-9` rewrite (9.1/9.2 are additive minors; the guide's intro notes
  "added in 9.1/9.2" per feature instead).
- Start pages, recipes, packages pages (audit: no wrong claims).
- mcp-server docs and package READMEs (#405 scope).

## Files touched

- `apps/docs/src/content/docs/guides/source-store.md` (new)
- `apps/docs/src/content/docs/reference/glossary.md` (new)
- `apps/docs/src/content/docs/guides/deleting-data.md` (inherited obligation 1)
- `apps/docs/src/content/docs/guides/diagnostics.md` (5 source-store codes + 4 erase rows)
- `apps/docs/src/content/docs/reference/wiki-memory.md`
- `apps/docs/src/content/docs/reference/types.md`
- `apps/docs/src/content/docs/reference/configuration.md`
- `apps/docs/src/content/docs/reference/errors.md`
- `apps/docs/src/content/docs/guides/okf.md`
- `apps/docs/src/content/docs/guides/ingest-documents.md`
- `apps/docs/src/content/docs/concepts/how-it-works.md`
- `apps/docs/src/content/docs/concepts/trust-and-provenance.md`

No `astro.config.mjs` change: both new pages sit in autogenerate directories
(`guides/`, `reference/`) and order via frontmatter `sidebar.order`.

## Sequencing and merge order

**Owner-ruled 2026-11-17 (Discord msg 1572312605224075315):** after the Tier-1.5
pre-check cycle converges on this lane, this branch merges INTO `specs/forget-erasure`
(PR #404) so #404 is reviewed as a whole (code + INTENT + JSDoc + docs together). Until
then PR #406 stays open as the docs half's staging branch; implementation commits land
here and sync-merge into `specs/forget-erasure` at checkpoints (this lane never commits
in the sibling lane's worktree). The default "merge after #404" ordering below is
SUPERSEDED by the owner ruling; the erase()-forward-documentation concern is moot under
whole-PR review (docs and the API ship in one PR).

This PR is file-disjoint from #404 (ruling 2) and is built on `origin/main` (not stacked).
The erase()/expire() vocabulary documents an API that ships with #404. Two orderings:

- **(a) Recommended — hold the merge:** PR goes ready now; merges after #404 lands. No
  stale-docs window, no forward-dating markers needed in the deleting-data guide. The
  handoff's "do not wait on it" is honored: the docs work is not blocked, only the merge.
- (b) Merge first with explicit "ships in the next release" markers on the erase recipe —
  kept only if the owner wants the glossary live sooner.

Owner decides at the merge gate; default is (a).

## Test plan

1. **Build:** `astro build` in `apps/docs` succeeds (baseline: 53 pages, ~10 s; +2 pages).
2. **Identifier accuracy:** every method name, signature, type name, config key, default,
   and diagnostic code written by this PR matches `git show v9.2.0:packages/core/src/...`
   (source-store rows) or branch `specs/forget-erasure` (erase rows, publish-time re-check).
3. **Obligation checklist:** deleting-data.md contains every §6 sentence in the handoff
   list; the recipe has no standalone-prune step; `grep -i "secure_delete=FULL"` over the
   tree returns nothing.
4. **Scrub guard:** `git diff main -- apps/docs | grep -i synapsetree` returns nothing.
5. **Link hygiene:** new internal links follow the `/expo-llm-wiki/<section>/<page>/`
   base-path pattern with `trailingSlash: 'always'`.
6. **Review ladder** (spec-bearing PR): Tier-4 Fable review → Opus delta review, findings
   adjudicated against source before folding; ladder rows land in the LEDGER.

## Release

Docs-only. No package version bump (site is not npm-published). Merge order per the
Sequencing section (default: after #404).

## Non-goals

- No engine code changes, no test changes, no dependency changes.
- No #405 scrub work, no upgrading-guide rewrites, no SEO/analytics changes (the
  GoatCounter/Bing head config is untouched).
