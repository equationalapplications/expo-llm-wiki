# NOTES — evidence for every Status claim in INTENT.md and AGENTS.md

Checked 2026-10-29 against the working tree at
`code/github/equationalapplications/expo-llm-wiki` (root `package.json`
version 7.13.1). Paths below are relative to that repo unless stated.

## Claims and evidence

| Claim | Status given | Evidence |
|---|---|---|
| Monorepo layout, pnpm 10.33.2, Node >=20, CI Node 24.22.1 | fact | root `package.json` `packageManager`; `packages/core/package.json` `engines`; `.github/workflows/test.yml:35` |
| Packages list, integration and benchmarks private | fact | Glob of `packages/*/package.json`; `packages/integration/package.json:4` `"private": true`; README monorepo table |
| Rust crate exists, shipped 7.2.0 | fact | `crates/graphrag-core/Cargo.toml`; `CHANGELOG.md:340` (7.2.0, 2026-09-18); native spec status line |
| Rule 1 BYOI: only `LLMProvider` makes model calls; keyword search without `embed` | Built | README "Key Principles" and "Retrieval Engine Internals"; `RetrievalService.ts` fallback path; `packages/core/package.json` deps |
| Core's only external runtime dep is `minisearch`; other dep is workspace `core-okf` | fact | `packages/core/package.json:62-65` |
| expo peers: expo-crypto, expo-sqlite, react; deps are workspace core + react | fact | `packages/expo/package.json:64-72` |
| react: dep workspace core; peer react | fact | `packages/react/package.json:65-73` |
| prisma-outbox: no deps; peers core + `@prisma/client` | fact | `packages/prisma-outbox/package.json:52-55` (no `dependencies` block matched) |
| okf and core-llm-tools: zero runtime deps | fact | multiline grep for `dependencies`/`peerDependencies` blocks matched neither file |
| Rust crate depends on four crates | fact | `Cargo.toml:8-12` (rusqlite, serde, serde_json, thiserror) |
| Rule 2 default prefix `llm_wiki_` | Built | `WikiMemory.ts:133`; `types.ts:279` |
| Rule 2 migrations add, never drop fact columns/tables | Built with footnotes | `packages/core/src/db/migrations.ts` v1–v15 read in full. v2 drops FTS5 table + triggers (index artifact); v12 creates new index then drops old; v9 aborts on inconsistent data with instructions. No `DROP COLUMN`; no drop of entries/tasks/events/edges |
| Rule 2 `migrations: 'refuse' \| 'auto' \| 'allow'` | Built | `packages/core/src/db/migrationGate.ts`; `WikiMemory.ts:355` |
| Rule 3 entity isolation, whole-write rejection, contextless error | Built (7.1.3) | `types.ts:1155` `WikiGraphNodeOwnershipConflict`; `IngestionService.ts:531`; `EntryRepository.ts:272,351`; spec `2026-09-17-graph-entity-isolation-design.md:5` status; `CHANGELOG.md:363` |
| Rule 3 dangling cross-entity edge does not leak | Built | native spec line 66 citing isolation spec §6 (entity-bound joins) |
| Rule 3 custom VectorRanker must filter by entity (host duty) | fact | `SECURITY.md` "Entity Isolation" section |
| Rule 4 dimension mismatch detection, fallback, callback, reembed | Built | `RetrievalService.ts:154-172`; `EmbeddingService.ts:39,95`; `EntryRepository.ts:753`; `WikiMemory.ts:727` `runReembed`; README `onRetrievalFallback` |
| Rule 5 `immutable_document` written by ingest; never superseded | Built | `IngestionService.ts:637,999`; `TemporalService.ts:31` throws `immutable_target`; `librarian/ops/apply.ts:151` |
| Rule 6 content-free diagnostics | Built | `types.ts:967`; README "Diagnostics" |
| Rule 6 drafts, promoteDraft, lint, pendingSources, getInstructions | Built | `WikiMemory.ts:508,546,556,1166,1189` |
| Rule 6 partial ingest returns result, total failure throws | Built | README "Ingest Document" (5.5.0 note) |
| Rule 7 token budget, usage meter, estimated flag | Built | `packages/core/src/utils/usage.ts`; `types.ts:466,633,1444` |
| Rule 7 deferred maintenance, llm_usage / read_budget diagnostics | Built (7.8.0) | `types.ts:373,384,821-833`; `docs/synapsetree-integration.md` §1–2; `CHANGELOG.md:131` |
| Rule 7 defaults remain legacy / auto | fact | `types.ts:374` ("Default `{ strategy: 'legacy' }`"); `types.ts:378-384` |
| Rule 7 8.0.0 flip undecided | Open decision | `2026-09-29-competitive-memory-design.md:7-8,44` |
| Rule 8 one 2026-09 spec says "zero runtime dependencies" | fact | `2026-09-29-competitive-memory-design.md:15` |
| Rule 9 14-day gate, exclusions, overrides single source | Built | `pnpm-workspace.yaml:19,27-34,36-38` |
| Rule 9 undici waiver precedent 2026-10-28 | fact | `pnpm-workspace.yaml:30-34,56-68` |
| Rule 9 audit steps: high+, allowlist, dated expiry | Built | `test.yml:65-108,156-219`; expiry `2026-11-28` for GHSA-mrhx-c7xc-m3w5 |
| Rule 9 written-waiver rule on record | fact | `2026-09-16-supply-chain-age-gate-design.md:6-16` (status revision 2026-10-29) |
| Rule 9 Dependabot security updates bypass cooldown | fact | `.github/dependabot.yml:10-16` |
| Rule 10 75/75 specs carry a Status line | Built | Grep count of `**Status` / `Status:` / `## Status` over `docs/superpowers/specs`: 75 files matched; Glob lists 75 spec files |
| Rule 10 three specs corrected 2026-10-29 | fact | status lines of native-graphrag, graph-entity-isolation, competitive-memory specs all read "(2026-10-29 correction)" |
| Rule 11 harness exists, refuses to spend without `--yes` | Partly built | `packages/benchmarks/src/cli.ts:18,23,236,329,498` |
| Rule 11 supersession results published with caveats | fact | `docs/benchmarks.md` (results, self-judge caveat, SIGABRT) |
| Rule 11 LongMemEval not measured, issue #247 | fact | `README.md:1172`; `docs/benchmarks.md` §"LongMemEval reruns are missing" |
| Rule 11 native adoption gates never run | Open decision | native spec status line 4-10; `test.yml:252-256` runs the harness as a smoke only ("timing values are NOT asserted") |
| Benchmarks open only in-memory or cache-dir SQLite | fact | `packages/benchmarks/src/db.ts:45`; `longmemeval/ingest.ts:96`; `fts5Memory.ts:39` |
| GitHub Pages playground (wiki-demo, scopelab) | fact | `.github/workflows/deploy.yml:52-80` |
| Curated Thoughts pins core 7.13.0 exact | fact | `curated-thoughts/package.json:8,48` |
| Curated Thoughts Rust startup schema guard on wiki tables | fact | `curated-thoughts/src-tauri/src/db/connection.rs:309-335` |
| Two-phase semantic-release; nobody edits CHANGELOG / version | fact | `CONTRIBUTING.md` "Releases"; `release.yml:248` |
| Merge commits for all PRs, including release PRs | fact | `release.yml:406-418,477` (`gh pr merge --auto --merge`, comment cites issue #137); specs 2026-09-02 through 2026-09-30 say "merge commit, never squash" |
| `CONTRIBUTING.md` says squash-only (stale) | conflict | `CONTRIBUTING.md:161,169-170`; written 2026-04-29 per `2026-04-29-contributing-docs.md` |
| Root `pnpm test` excludes integration from `-r`, then runs it minus scifact/financebench | fact | root `package.json:27,32,33` |
| scifact/financebench need fastembed | fact | `packages/integration/__tests__/scifact.test.ts:6`; `financebench.test.ts:7` |
| `.brain/` gitignored as CT indexer scratch | fact | `.gitignore:52-53` |
| Rust toolchain 1.96.0; CI action pinned by SHA | fact | `crates/graphrag-core/rust-toolchain.toml`; `test.yml:231-236` |
| Prompt injection is the host's responsibility | fact | `README.md` "Prompt-Injection Trust Boundary"; `SECURITY.md` "Host Application Security" |
| Ontology single-level `parent_type` | fact | README "Key Principles"; `packages/core/src/utils/ontology.ts` matches `parent_type` |

## Corrections to the dossier

- **Release PRs do not squash-merge.** The dossier said release PRs
  "squash-merge by design." `release.yml:406-410` now uses `--merge` with
  a comment explaining the switch (issue #137). CONTRIBUTING.md and the
  2026-08-07 release-hygiene spec describe the older squash flow. INTENT
  and AGENTS state "merge commits for every PR, release PRs included."
- **Integration package is not fully excluded from the normal test run.**
  It is excluded from the recursive filter and then run separately with
  the two fastembed suites excluded. Stated that way in AGENTS.
- **Integration tests run on Node with better-sqlite3**, not on a real
  Expo host (`packages/integration/package.json`). The Expo package has
  its own small vitest suite.

## Not verified in this session (marked Open decision or left out)

- **Grouped-bump rule** (tooling majors ride a grouped PR after a
  pack-diff; runtime/peer majors alone). No file in the repo records it;
  grep for "pack-diff", "grouped bump", "npm pack" found nothing relevant.
  Included in INTENT §How-changes-are-made item 6 and in AGENTS on the
  dossier's authority ("ratified by execution 2026-10-29"). It should be
  written into the supply-chain spec.
- **Git history showing merge commits on `main`.** The sandbox blocked
  `git log` in the target repo. Evidence for the merge-commit rule is the
  release workflow and the specs, not the commit graph.
- **"Review gauntlet" / review tiers.** No repo file describes the review
  tiers; INTENT says "reviews run in tiers" without naming them. If a
  spec exists elsewhere it should be linked.
- **8.0.0 defaults** and **native-engine gate scheduling** are Open
  decisions in INTENT because no ruling is on file.
- The charter's statement that the Expo package is the phone door and the
  core package is the general door is cited, not restated; the charter's
  own status ("Where the project stands") was not re-verified here.

## Stale documents found along the way (not fixed here)

- `CONTRIBUTING.md`: "Squash merge only" and "PR title becomes the squash
  merge commit message" contradict current practice and `release.yml`.
- `CONTRIBUTING.md` "Prerequisites" says Node 24+; `engines` says >=20.
- `2026-09-29-competitive-memory-design.md:15` says "zero runtime
  dependencies"; core has one external runtime dependency.
