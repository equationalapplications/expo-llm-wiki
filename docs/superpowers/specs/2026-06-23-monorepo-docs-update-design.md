# Design: Monorepo Documentation Update (OKF + Ecosystem Tables)

**Status:** Implemented
**Packages:** `README.md` (root); `packages/{core,okf,expo,react,prisma-outbox,core-llm-tools}/README.md`
**Date:** 2026-06-23
**Depends on:** `2026-06-18-okf-export-design.md`, `2026-06-22-okf-import-design.md` (both Implemented, undocumented)

## Problem

At the time this spec was written, four shipped features lacked matching doc updates:

- **OKF export** (`2026-06-18-okf-export-design.md`) and **OKF import**
  (`2026-06-22-okf-import-design.md`) — fully implemented (`packages/okf` has all 8 primitives;
  `packages/core` has `formatOkfBundle`, `parseOkfBundle`, `WikiEdge`, `EdgeRepository`,
  `okf_type` column) but almost entirely undocumented. `packages/okf/README.md` was 3 lines,
  described export-only. No README mentioned import, `parseOkfBundle`, `WikiEdge`, or `okf_type`.
  The root README's package table listed five packages and omitted `core-okf` (the 6th published
  package) entirely.
- **`useEntityStatus` hook** (`2026-06-22-use-entity-status-hook-design.md`) and **Security
  Hardening Phase 2** (`2026-06-22-security-hardening-phase-2.md`) — verified already documented
  correctly (react/expo READMEs have the hook; root/core READMEs have the Prompt-Injection Trust
  Boundary section). **Out of scope for this spec** — no changes needed.

Separately, every package README had a "Monorepo Ecosystem" table (own package bolded, others
linked) so a developer landing on one package's npm page could find the sibling package that fits
their platform. The root README had an equivalent table under a differently-named heading
("Monorepo Packages") and, like every other table in the repo, was missing the `core-okf` row.

## Goals

- Document OKF import + export across the repo: full API reference in `packages/okf/README.md`,
  wiki-adapter usage (`formatOkfBundle`/`parseOkfBundle`/`WikiEdge`/`okf_type`) in
  `packages/core/README.md`, and a short top-of-file mention in root + core READMEs (OKF
  interoperability is a permanent capability, not framed as new).
- Add `core-okf` to every "Monorepo Ecosystem" table in the repo (6 files get a new row; 1 file —
  `packages/okf/README.md` — gets the table added since it has none today).
- Normalize root README's table heading to "Monorepo Ecosystem" for consistency with every package
  README, and add the missing npm version/downloads badge for `@equationalapplications/core-okf`.

## Non-Goals

- No changes to `useEntityStatus` hook docs or Security Hardening Phase 2 docs — both already
  complete and accurate.
- No changes to `packages/prisma-outbox/README.md` or `packages/core-llm-tools/README.md` beyond
  their Monorepo Ecosystem table row — OKF isn't consumed from either package.
- No code changes. Documentation only.
- No framing of OKF as a "new" feature anywhere — this is long-term reference documentation; OKF
  support is stated as a present-tense fact, not an announcement.

## Design

### 1. Root `README.md`

- **Badges (top, ~line 7-10):** add a 5th `npm version` + `npm downloads` badge pair for
  `@equationalapplications/core-okf`, matching the existing pattern for expo/react/core/core-llm-tools.
- **Karpathy section (~line 14-18):** add one line after the existing Karpathy blockquote stating
  OKF import/export is supported, linking
  https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf. Present-tense, no "now"/"new" framing.
- **`## Monorepo Packages` → `## Monorepo Ecosystem`** (~line 96): rename heading for consistency
  with every package README. Add a `core-okf` row to the existing richer table (keep the
  Purpose/Platform columns and "Choose your package" guidance — this table is intentionally more
  detailed than the package-level ones). Update "organized as a monorepo with five packages" →
  "six packages."
- **Short OKF pointer** near `## Core API`: one short subsection ("OKF Import/Export") with a
  1-2 sentence description + link to `packages/core/README.md`'s full OKF section and
  `packages/okf/README.md`. Not a full duplicate of the usage examples.

### 2. `packages/okf/README.md` — full rewrite

Current file is 3 lines, export-only. Rewrite following `packages/core-llm-tools/README.md`'s
structure (badges, links line, Overview, Features, Installation, then per-function docs):

- **Intro:** package supports both producing and parsing OKF v0.1 bundles (frontmatter,
  concept documents, `index.md`/`log.md`), zero-dependency, no knowledge of any specific data
  model.
- **API reference**, one subsection per exported function (signature + 1-2 line usage each):
  - `serializeFrontmatter` / `parseFrontmatter`
  - `buildConceptDocument` / `parseConcept`
  - `buildIndexMd` / `buildRootIndexMd`
  - `buildLogMd` / `parseLogMd`
  - `extractMarkdownLinks`
- **Pointer to the wiki adapter:** "see `@equationalapplications/core-llm-wiki`'s OKF Import/Export
  section for a ready-made `MemoryDump` ⇄ OKF bundle adapter" with a link to
  `packages/core/README.md`.
- **`## Monorepo Ecosystem` table** — new section, same 6-row format as every other package
  README, this package's row bolded.

### 3. `packages/core/README.md` — new `## OKF Import/Export` section

Insert after the existing `## Entity Status` section (mirrors its style: subsection per
capability, code example, then a short notes list).

- **Top-of-file mention:** alongside (or directly below) the existing feature bullets near the
  top of the file, one line stating OKF import/export is supported, linking to the same GCP
  knowledge-catalog OKF URL — same present-tense framing as the root README change.
- **`formatOkfBundle(dump: MemoryDump): { files: OkfFile[] }`** — export usage example (call after
  `exportDump()`, write `files` to disk/zip).
- **`parseOkfBundle(entityId, files: OkfFile[], options?: OkfImportOptions): MemoryDump`** — import
  usage example feeding into `wiki.importDump(dump, { merge: true })`. Document
  `OkfImportOptions.typeMapping`/`defaultSchema` and the 3-step routing precedence (typeMapping →
  `/facts/`-or-`/tasks/` directory convention → `defaultSchema`, default `'fact'`; `'ignore'` at
  any step skips the file).
- **`WikiEdge` / edges table / `EdgeRepository`:** what an edge represents (a markdown
  cross-link inside a concept body, resolved to a `source_id`/`target_id` pair), that it round-trips
  through export → import automatically (body markdown is the source of truth, not a separate
  edges export step), and that `MemoryBundle.edges` is included in `getFullBundle()`.
- **`okf_type` field:** nullable column on facts/tasks preserving the literal OKF `type` string
  from an imported bundle, independent of which table (`entries`/`tasks`) the concept was routed
  into; `formatOkfBundle` falls back to `'fact'`/`'task'` when absent (so non-OKF-imported rows
  export unchanged).
- Add `core-okf` row to the existing Monorepo Ecosystem table (~line 707).

### 4. `packages/expo/README.md`, `packages/react/README.md`, `packages/prisma-outbox/README.md`, `packages/core-llm-tools/README.md`

Add the `core-okf` row to each file's existing Monorepo Ecosystem table only. No other content
changes — OKF is consumed through `core`, not directly from these packages.

### 5. Consistency rules across all 6 package-level tables + root's table

- Every "Monorepo Ecosystem" table lists the same 6 packages in the same order: `core-llm-wiki`,
  `expo-llm-wiki`, `react-llm-wiki`, `prisma-outbox`, `core-llm-tools`, `core-okf`.
- Exactly one row is bolded (unlinked) per file: the package that README belongs to. All others are linked via absolute GitHub URLs to the sibling package READMEs (so links work from npm as well).
- `core-okf`'s description across all tables: "Zero-dependency Open Knowledge Format (OKF) v0.1
  primitives — parse and produce interoperable knowledge bundles."

## Testing / Acceptance

Documentation-only change; "testing" is a manual review pass, not automated:

- [ ] Every code example added (`formatOkfBundle`, `parseOkfBundle`, `OkfImportOptions`, each
      `packages/okf` function) matches the actual exported signature in source (cross-checked
      against `packages/core/src/index.ts` and `packages/okf/src/index.ts` at spec-writing time —
      re-verify if source has changed since).
- [ ] All 7 files (root + 6 packages) have a table titled exactly `## Monorepo Ecosystem` with
      identical 6-row package sets and exactly one bolded row each.
- [ ] No broken links in npm-published READMEs (absolute GitHub URLs to `packages/*/README.md`,
      anchors within README.md).
- [ ] No "new"/"now supported"/"recently added" framing anywhere referring to OKF, the hook, or
      security hardening — all stated as plain present-tense facts.
- [ ] Root README's npm badge block has 5 version+downloads pairs (expo, react, core,
      core-llm-tools, core-okf) — `prisma-outbox` is intentionally excluded today (matches existing
      badge set; not introduced by this spec).

## Open Questions

None — resolved during brainstorming: scope narrowed to OKF + ecosystem tables only (hook/security
docs already correct), `packages/okf/README.md` gets full API reference depth, OKF wiki-usage
docs live in `packages/core/README.md` only (root gets a pointer, not a duplicate).
