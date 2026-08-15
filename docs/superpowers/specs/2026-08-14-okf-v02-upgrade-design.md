# Spec: OKF v0.1 → v0.2 Upgrade for the llm-wiki Monorepo — Design Record

**Date:** 2026-08-14
**Status:** Implemented (2026-08-15) — see PR for the OKF v0.1 → v0.2 upgrade branch.
**Deliverables:**
- `docs/okf-profile.md` — updated to add `llm-wiki/2` profile, `status`/`lifecycle_status`/`execution_status` rename rule, v0.2 import fallbacks
- `packages/okf/src/frontmatter.ts` — extended flow-mapping/flow-sequence parser
- `packages/okf/src/types.ts` — v0.2 type surface
- `packages/okf/fixtures/golden-v2/` — new conformance fixture
- `packages/core/src/db/schema.ts` — additive migration on `facts` and `tasks`
- `packages/core/src/utils/formatOkfBundle.ts`, `parseOkfBundle.ts` — v0.2 default + auto-detection
- `packages/core/__tests__/` — new v0.2 conformance + back-compat regression tests

**Builds on:**
- [OKF v0.2 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (upstream)
- [`docs/okf-profile.md`](../../okf-profile.md) (existing `llm-wiki/1` profile, normative)
- `2026-07-05-okf-profile-design.md` (preceding design record, already implemented)

**Related:** `2026-06-18-okf-export-design.md`, `2026-06-22-okf-import-design.md`

---

## 1. Problem

The reference OKF spec is at v0.2 (released 2026); `core-okf` and `core-llm-wiki` are still on v0.1. The v0.2 spec is a **minor** version bump under §12 except for two deliberate breaking changes (`timestamp` → `generated.at`; body `# Citations` list → frontmatter `sources`). It also adds three first-class concerns that an LLM-maintained memory corpus needs:

1. **Provenance** — `sources` with per-source credibility signals (`author`, `usage_count`, `last_modified`, `usage_window`), and footnote-keyed per-claim attribution so reordering doesn't silently misattribute.
2. **Trust** — `generated` and `verified` with the v0.2 actor convention (`<producer>/<version>`, `human:<id>`, `process:<id>`), and trust tiers (`unverified` / `machine-confirmed` / `human-reviewed`) derived from `verified`.
3. **Lifecycle** — `status` (`draft` | `stable` | `deprecated`) and `stale_after` (an absolute date, not a relative TTL) so consumers can answer "is this still true" without knowing when the concept was read.

Plus a new concept type, `Attested Computation`, with its own contract fields (`runtime`, `parameters`, `computation`, `executor`, `attester`) and a new conventional body heading `# Computation`. We defer that concept type and the executor/attester runtime to a later profile; see §10.

Two implementation realities force the design:

- The existing subset YAML parser in `packages/okf/src/frontmatter.ts` deliberately rejects flow collections (`[...]`, `{...}`) — security-driven (the billion-laughs anchor/alias vector, profile-1 §8) and simplicity-driven. v0.2 canonical examples use flow mappings everywhere (`generated: { by: ..., at: ... }`, `usage_window: { from: ..., to: ... }`, `verified: { by: ..., at: ... }`). A path is required.
- The existing `llm-wiki/1` profile defines `status` as a **required task field for execution state** (`pending`, `done`, `archived` — section 5.2). OKF v0.2 wants `status` for **lifecycle state** (`draft`, `stable`, `deprecated`). Same key, different meanings. A rename rule is required.

---

## 2. Decisions Made During Brainstorming

### 2.1 Scope: Option 2 (Medium) — v0.2 round-trip + new profile, no Attested Computation runtime

Rejects Option 1 (read-only — leaves the most valuable v0.2 surface on the table) and Option 3 (full Attested Computation runtime — pushes us into deterministic execution/sandboxing territory that does not belong in an episodic memory library). Specifically:

- Read and write v0.2 frontmatter families (`sources`, `generated`, `verified`, `status`, `stale_after`, `usage_window`).
- Plumb the new families through `WikiFact` and `WikiTask` (additive DB migration) so round-trip is lossless.
- Auto-detect profile on import; default `llm-wiki/2` on export.
- Persist trust, freshness, and provenance signals so the LLM-authored knowledge graph becomes genuinely trustable.
- **No executor / attester / receipt runtime.** v0.2's `Attested Computation` concept type is imported as a generic `okf_type` fact with the unsupported keys preserved as opaque frontmatter. The door stays open; the runtime does not arrive in this profile.

### 2.2 Profile layering: coexist, auto-detect

- `llm-wiki/1` (v0.1-backed) — **unchanged**. Existing fixtures, existing semantics, existing call sites.
- `llm-wiki/2` (v0.2-backed) — **new**. Default producer output; v0.2 fields; v0.1 import fallbacks per spec §13.1 (`timestamp` ⇄ `generated.at`; body `# Citations` ⇄ frontmatter `sources`).
- `formatOkfBundle` defaults to `okf_version: "0.2"` + `profile: "llm-wiki/2"`. Optional override parameter to force `llm-wiki/1` for back-compat export.
- `parseOkfBundle` reads `profile` from the bundle's root index frontmatter:
  - `profile === "llm-wiki/2"` → v0.2 path
  - `profile === "llm-wiki/1"` (or absent `profile` key on a bundle declaring `okf_version: "0.1"`) → v0.1 path with `## Related` strip
  - `profile === undefined` and `okf_version` absent → **profile 0 (legacy)** per existing profile-1 §0 — tuple dedup, no summary, no `## Related` parsed
- One wire-format break to flag: bundles exported today and re-imported after this upgrade will gain `okf_version: "0.2"` and `profile: llm-wiki/2` on re-export. v0.1 producers (downstream) keep reading the v0.1 fields per their existing fallback rules.

### 2.3 The `status` collision — rename rule (no two consumers fight over one key)

Profile-1 §5.2 requires `status` on tasks for execution state. OKF v0.2 wants `status` for lifecycle state. Resolution:

- **DB schema:** keep the existing `status` column on `tasks` as **execution state** (`pending`, `in_progress`, `done`, `abandoned`). Add a new discrete column `lifecycle_status TEXT NOT NULL DEFAULT 'stable'` for v0.2 lifecycle state (`draft`, `stable`, `deprecated`).
- **Wire format on tasks:** OKF v0.2's `status` key carries the **lifecycle state**. The internal execution state is emitted under a **renamed custom key** — `execution_status` — to avoid colliding with the v0.2 lifecycle key. Consumers reading a profile-1 task bundle see `status` (execution); consumers reading a profile-2 task bundle see `status` (lifecycle) and `execution_status` (execution). The profile doc spells out the rename rule and the migration story for profile-1 readers.
- **Wire format on facts:** v0.2 has no execution state, so facts simply emit `status: <lifecycle>` and import into `lifecycle_status` directly. The existing `status` column on `facts` (if any) is renamed to `lifecycle_status` to match; or, if the facts table has no `status` column today, only the new column is added. (Confirmed during brainstorming: `tasks.status` exists, `facts.status` does not — see §4.5 and §4.6.)
- **Reader contract:** when importing a profile-2 bundle, the consumer MUST read `status` as **lifecycle** and `execution_status` as **execution**; when importing a profile-1 bundle, the consumer MUST read `status` as **execution** and treat lifecycle as `stable` (the spec default).
- **Writer contract:** profile-2 emits `status: <lifecycle>` and (for tasks only) `execution_status: <execution>`; profile-1 emits `status: <execution>` (lifecycle stays implicit `stable` per spec §5.4).

### 2.4 `generated.at` ↔ existing `updated_at` (with DAO discipline)

v0.2's `generated.at` semantically equals llm-wiki's existing `updated_at` — "the content's last meaningful change" (v0.2 §5.2). We do **not** add a new column.

DAO discipline requirement (see §8 for the full list): only knowledge-content writes may bump `updated_at`. Touching a row to increment `access_count`, update `last_accessed_at`, or write a new `verified` entry MUST NOT touch `updated_at`. The existing code path that increments `access_count` already does not bump `updated_at` (we verified); the new trust/provenance write paths inherit this discipline.

Import fallbacks: a v0.1 bundle's `timestamp` maps to `updated_at`. A v0.2 bundle's `generated.at` maps to `updated_at`. If both are present (a malformed transitional bundle), `generated.at` wins.

### 2.5 Schema: hybrid (discrete + JSON), symmetric across facts and tasks

Discrete columns for the scalars we will filter or render:

| Column              | Type      | Default        | Notes                                                            |
|---------------------|-----------|----------------|------------------------------------------------------------------|
| `lifecycle_status`  | TEXT      | `'stable'`     | OKF v0.2 lifecycle (`draft` / `stable` / `deprecated`).          |
| `stale_after`       | INTEGER   | NULL           | Epoch ms of `YYYY-MM-DD`. NULL = never stale.                    |
| `generated_by`      | TEXT      | NULL           | Actor string per v0.2 §7 (`<producer>/<version>`, `human:<id>`, `process:<id>`). |

JSON columns for the structured lists:

| Column          | Type | Shape                                                                |
|-----------------|------|----------------------------------------------------------------------|
| `okf_sources`   | TEXT | JSON array: `[{id, resource, title, author, usage_count, last_modified, usage_window}]` |
| `okf_verified`  | TEXT | JSON array: `[{by, at}]` — full fidelity (chronological history)     |
| `okf_usage_window` | TEXT | JSON `{from, to}` — sibling of `sources`; persisted as a single object even when per-entry overrides exist (the override is folded into the entry's JSON). |

Convenience discrete columns extracted from `okf_verified` (the latest verifier), so we don't `json_extract` on every read:

| Column               | Type    | Default | Notes                          |
|----------------------|---------|---------|--------------------------------|
| `last_verified_at`   | INTEGER | NULL    | Epoch ms of the latest verifier's `at`. |
| `last_verified_by`   | TEXT    | NULL    | Actor string of the latest verifier.     |

**Symmetric across facts and tasks** — verified on tasks too. Rationale: a hallucinated "email the CEO about the stapler" task and a human-verified "submit the Q3 OKR" task are precisely the trust distinction an autonomous agent needs to gate its own actions; symmetry also keeps the DAO layer clean.

### 2.6 YAML flow-mapping parser: hand-rolled, single-level, anchor/alias-safe

Extend the existing subset parser in `packages/okf/src/frontmatter.ts` to recognize:

- **Flow mappings** of the form `{ key: value, key2: value2 }` — needed for `generated`, `verified` (single-element form), `usage_window`, and the per-entry shape of `sources`/`executor`/`attester` when those happen to be emitted in flow form.
- **Flow sequences** of the form `[ a, b, c ]` — needed for `parameters[].type` style data and `executor.receipt: [job_id, executed_sql, result]`.

Strict guard rails:

- **No anchor or alias expansion.** `&name` and `*name` are never recognized *outside quoted strings*; any unquoted `&`/`*` in a flow value is treated as opaque (the whole value degrades to `null`, never crashes). This preserves the billion-laughs safety that motivated profile-1 §8's hard requirement, while not misfiring on an ordinary quoted value that happens to contain `&` (for example a `resource` URL with a query string, `"https://x/a?p=1&q=2"`). The anchor/alias scan runs on the flow value with quoted-string spans excluded.
- **Exactly one level of nesting is allowed inside a flow mapping value; no deeper.** `{ a: { b: 1 } }` parses; `{ a: { b: { c: 1 } } }` does not. This is a deliberate widening from the original "single-level only" rule: v0.2's own canonical shapes require one level of nesting — a `sources[]` entry's per-entry `usage_window: { from, to }` (§5.1), and `executor: { resource, receipt: [...] }` (§10.2) both nest a flow mapping or sequence one level inside an outer flow mapping. A hand-rolled recursive-descent parser bounded to one level of recursion carries the same complexity and safety properties as the single-level version (still no anchors/aliases at any depth, still a fixed recursion bound so there is no unbounded-expansion vector) while actually covering the spec's canonical shapes. A flow collection nested two or more levels deep is treated as opaque: the **key is preserved on the frontmatter object with a `null` value**, never silently dropped, and the round-trip contract for that key rests entirely on the producer regenerating it from its typed model rather than passing through raw text.
- **No flow collections inside block sequences** that are already supported by our existing parser, except at the top level of the value. This keeps round-trip parity for the existing subset and avoids accidentally introducing ambiguity. Note this governs *legacy block-sequence syntax* (`key:\n  - item`) only — it does not apply to `sources`/`verified`/`parameters`, which v0.2 always emits as a top-level flow sequence (`sources: [ {...}, {...} ]`), never as a legacy block list of flow-mapping items.
- **Producer MUST emit block-form for nested structures** if a future v0.x spec demands more than one level of nesting — the profile doc spells this out. For v0.2, every flow shape we encounter needs at most one level.

Result: zero new runtime dependencies; the `core-okf` package stays zero-dep. Round-trip parity is guaranteed for every v0.2 shape we emit (single-level and the one-level-nested shapes above). Foreign bundles using a flow shape we don't recognize (nested two+ levels, or containing an unquoted anchor/alias) degrade to a preserved key with a `null` value per the existing robustness contract — same behavior as today for unknown frontmatter lines.

### 2.7 Trust tiers — derive on demand, never persist

We don't store the trust tier string. We provide a helper function `deriveTrustTier(verifiedList: {by, at}[]): 'unverified' | 'machine-confirmed' | 'human-reviewed'` per spec §5.3. The consumer reads the tier off `okf_verified` at query time. Storing the tier would invite staleness (the tier changes the moment a new verifier is added), and v0.2 is explicit: tiers are derived signals, not stored fields. Rule: if **any** verifier's actor starts with `human:`, return `human-reviewed` (human review is sticky — once a human has verified, the tier stays at `human-reviewed` even if subsequent machine verifications are appended). Otherwise, if at least one verifier exists, return `machine-confirmed`. Otherwise `unverified`.

`read()` returns `isStale: boolean` per fact/task (today, ≥ `stale_after`). It never auto-filters stale rows — the host application decides display policy. The spec's `today >= stale_after` check is a single epoch comparison; the helper `isStaleAfter(staleAfter: string | number | null, now: number): boolean` is exported from `core-okf`. The wire-format input is the v0.2 `YYYY-MM-DD` string, but the helper also accepts an epoch ms number (useful for tests and for callers that have already parsed the date) and `null` (treated as never-stale).

### 2.8 Footnotes — verbatim on round-trip, never synthetic

Per OKF v0.2 §5.1, footnote attribution uses `[^id]` markers whose label joins to `sources[].id`. Our existing `extractMarkdownLinks` handles ordinary markdown links; we add a parallel `extractFootnotes(body): { id, body }[]` to `core-okf`. **Footnotes are preserved verbatim on round-trip** — if the body has `[^ga4-schema]`, the import side records the fact that this body carries footnote attribution but does not reconstruct footnote text or break the body apart; the export side writes the body as-is. **We do not synthesize footnotes on export.** Rationale: footnote attribution is the author's choice; an LLM that didn't write `[^id]` shouldn't be forced into one on export. v0.2's spec language — "SHOULD be used when applicable" — supports this.

### 2.9 Attested Computation: imported as generic `okf_type`, deferred

A concept of `type: Attested Computation` arriving in a v0.2 bundle is imported as:

- `type` → stored as `okf_type` (preserved verbatim).
- `status`, `generated`, `verified`, `stale_after`, `sources`, `usage_window` → tracked exactly like any other v0.2 concept, since these are the fields `core-llm-wiki` has columns for (§2.5).
- `runtime`, `parameters`, `computation`, `executor`, `attester` → **NOT preserved** on round-trip in this profile. `docs/okf-profile.md` §5's "unknown frontmatter keys MUST be preserved on round-trip where the consumer re-exports" is a pre-existing profile-1 contract, but `core-llm-wiki`'s `WikiFact`/`WikiTask` have no field for storing arbitrary unrecognized keys today — there is no generic opaque-passthrough column, and this profile does not add one (adding a catch-all "extra frontmatter" JSON column is real scope, not implied by "defer the Attested Computation runtime," and is left to whichever future profile actually needs opaque-key fidelity for *any* concept type, not just this one). Import silently drops these five keys the same way import already silently drops any other unrecognized key from any other concept type today. A caller that needs the discarded keys must read them from the original bundle text directly (the OKF files are typically kept in version control), not from `WikiFact`.
- The concept's body, including the `# Computation` section if present, is preserved verbatim (bodies are always stored whole, regardless of frontmatter key recognition — this is unaffected by the point above).

We do not implement executors, attesters, receipts, or the §10.5 attestation lifecycle. A future profile (`llm-wiki/3`?) takes that on, and is the profile that adds an opaque-passthrough column for arbitrary unrecognized frontmatter keys — that profile closes the gap for *all* concept types, not just `Attested Computation`. For now, an `Attested Computation` concept round-trips through our system as a generic fact with its runtime-specific contract fields (`runtime`/`parameters`/`computation`/`executor`/`attester`) lost on import — this is a known, accepted limitation for v0.2, not silently-broken behavior a reader would need to discover independently. (Earlier revisions of this section and a few adjacent bullets said "preserved as opaque frontmatter"; that phrasing was aspirational and is corrected here so the spec matches the shipped behavior. The conformance test asserts the keys are dropped — see `packages/core/__tests__/okfProfileConformance.test.ts` `f_attested`.)

### 2.10 Conformance fixtures — `golden-v2` alongside existing

Three committed fixture bundles under `packages/okf/fixtures/`:

- `legacy-profile-0/` (existing) — no profile key, no `## Related`, no event id comments, no summary. Exercises every profile-0 fallback.
- `golden-v1/` (existing) — full profile-1 feature coverage. Untouched.
- `golden-v2/` (new) — full profile-2 feature coverage: every new family populated (`sources` with credibility signals + per-entry usage_window override; `generated`; `verified` with multiple verifiers; `status`; `stale_after`; footnote attribution in the body; one `Attested Computation` concept imported as a generic fact); one concept deliberately past `stale_after` so the staleness check has a non-trivial case; the `status`/`execution_status` collision exercised on a task.

A `fixtures/README.md` describes each bundle's purpose.

### 2.11 Versioning & package bump

This repo releases via semantic-release on conventional-commit messages (`.github/workflows/release.yml`; see the `chore(release): 5.3.1 (#89)` pattern in history) — `package.json` versions are **never hand-edited**. The work in this profile does not set a version number; it sets the commit-message expectations that drive whatever semantic-release computes:

- `@equationalapplications/core-okf`: every commit touching `packages/okf/` uses a `feat(okf):` prefix (additive inside the package; v0.2 is additive per spec §12, the breaking-change fallbacks live in our reader), which semantic-release resolves to a minor bump.
- `@equationalapplications/core-llm-wiki`: every commit touching `packages/core/` uses a `feat(core):` prefix (additive schema migration; new exported helpers), likewise a minor bump.
- `@equationalapplications/expo-llm-wiki`, `@equationalapplications/react-llm-wiki`: no commits touch these packages for this profile, so semantic-release does not bump them (no API surface changes; downstream consumers don't see anything new unless they read the OKF helpers directly).
- README updates (`packages/okf/README.md`, `packages/core/README.md`) describing v0.2 conformance ride along in the same `feat(...)` commits, or use `docs(...)` if split out — either way, no manual version edit.
- The profile doc, `docs/okf-profile.md`, gains a §11 *llm-wiki/2* section and a v0.1→v0.2 migration cheat-sheet, committed with `docs(spec):` per the plan's commit-prefix convention. The existing `llm-wiki/1` content stays.

---

## 3. Architecture

```
                  ┌────────────────────────────────────────┐
                  │  packages/core-okf (zero-dep primitives) │
                  │                                        │
                  │  frontmatter.ts  (subset + flow maps)   │
                  │  types.ts        (v0.2 type surface)    │
                  │  concept.ts                             │
                  │  index-md.ts     (root + per-directory) │
                  │  entity-index-md.ts                    │
                  │  log-md.ts                              │
                  │  related-section.ts                    │
                  │  path-allowlist.ts                     │
                  │  markdown-links.ts                     │
                  │  footnotes.ts       (NEW)              │
                  │  v02-helpers.ts     (NEW)              │
                  │   - deriveTrustTier                    │
                  │   - isStaleAfter                       │
                  │   - extractFootnotes                   │
                  │   - buildVerifiedFromMap               │
                  │   - buildSourcesFromJson               │
                  └────────────────────────────────────────┘
                                     │
                                     ▼
                  ┌────────────────────────────────────────┐
                  │  packages/core-llm-wiki (DB + adapter)  │
                  │                                        │
                  │  db/schema.ts  (additive migration)    │
                  │  types.ts      (WikiFact, WikiTask + new fields)
                  │  utils/formatOkfBundle.ts              │
                  │  utils/parseOkfBundle.ts               │
                  │                                        │
                  │  DAO discipline in:                     │
                  │    read.ts (no-op on read)             │
                  │    access-tracking.ts (no update_at)   │
                  │    okf-trust-writes.ts (NEW; no update_at)
                  └────────────────────────────────────────┘
                                     │
                                     ▼
                  ┌────────────────────────────────────────┐
                  │  Test layer                             │
                  │                                        │
                  │  core-okf unit tests (flow mapping,     │
                  │     trust tier, staleness, footnotes)  │
                  │  conformance: golden-v2 round-trip     │
                  │  conformance: golden-v1 back-compat     │
                  │  conformance: legacy-profile-0 still ok│
                  │  DAO discipline: spot-check via grep   │
                  └────────────────────────────────────────┘
```

The split is deliberate: `core-okf` is the format-level primitive; `core-llm-wiki` is the database adapter that knows about rows, columns, and DAO discipline. Profile-2 helpers live in `core-okf` because the format owns them; the SQL schema and DAO wiring live in `core-llm-wiki`.

---

## 4. Components & Files Touched

### 4.1 `packages/okf/src/frontmatter.ts` — extend parser + serializer

- Add `parseFlowMapping(text: string): Record<string, OkfFrontmatterValue> | null` and `parseFlowSequence(text: string): OkfFrontmatterValue[] | null`. Single-level only; treat anchors/aliases as opaque.
- In the main `parseFrontmatter` loop: when a value starts with `{` or `[`, attempt the flow parser; if it returns `null`, fall back to the existing scalar path (treat as opaque scalar).
- In `serializeFrontmatter`: when a value is a plain object, emit as flow mapping; when a value is an array, emit as block sequence (existing behavior). For single-element arrays, keep block sequence (consistent with current behavior). For the empty list `[]`, keep existing.
- New helper `serializeActorString(s: string)` that quotes actor strings containing `/` (the v0.2 examples `reference_agent/gemini-2.5-pro`, `human:ahormati`, `process:finance-nightly` would otherwise round-trip through YAML as ambiguous scalars).
- No anchors, no aliases, no nested flows, no block scalars (`|`, `>`). Document this in the parser's JSDoc.

### 4.2 `packages/okf/src/types.ts` — v0.2 type surface

Add the v0.2 families, keeping every existing field unchanged. Specifically:

```typescript
export type OkfStatus = 'draft' | 'stable' | 'deprecated';
export type OkfActorKind = 'agent' | 'human' | 'process';

export interface OkfGenerated {
  by: string;        // actor per §7
  at: string;        // ISO 8601 datetime
}

export interface OkfVerifiedEntry {
  by: string;        // actor per §7
  at: string;        // ISO 8601 datetime
}

export type OkfVerified = OkfVerifiedEntry[]; // bare mapping = 1-element list per §5.2

export interface OkfSourceUsageWindow {
  from: string;      // YYYY-MM-DD
  to: string;        // YYYY-MM-DD
}

export interface OkfSource {
  id?: string;
  resource: string;  // absolute URL, bundle-relative path, or scope descriptor
  title?: string;
  author?: string;   // actor per §7
  usage_count?: number;
  last_modified?: string; // YYYY-MM-DD
  usage_window?: OkfSourceUsageWindow; // per-entry override of the sibling usage_window
}

export interface OkfFrontmatterV02 {
  // Carry the v0.1 fields for back-compat (title, description, resource, tags, etc.)
  // Add the v0.2 families:
  generated?: OkfGenerated;
  verified?: OkfVerified;
  status?: OkfStatus;
  stale_after?: string;            // YYYY-MM-DD
  sources?: OkfSource[];
  usage_window?: OkfSourceUsageWindow; // sibling of sources

  // Attested Computation keys (deferred to runtime; parsed, not executed):
  runtime?: string;                 // 'bigquery' | 'postgres' | 'dbt' | 'python' | 'Looker' | ...
  parameters?: Array<{ name: string; type: string; required: boolean }>;
  computation?: string;             // path per §6.2
  executor?: { resource: string; receipt: string[] };
  attester?: { resource: string };

  // ... existing extension slot
}
```

The legacy `timestamp` field stays on `OkfFrontmatter` for v0.1 import. The new fields are additive.

### 4.3 `packages/okf/src/v02-helpers.ts` — new module

- `deriveTrustTier(verified: OkfVerified | undefined): 'unverified' | 'machine-confirmed' | 'human-reviewed'`. If any verifier's `by` starts with `human:`, return `human-reviewed` (sticky — see §2.7). Else if at least one verifier, return `machine-confirmed`. Else `unverified`. Pure function; tested.
- `isStaleAfter(staleAfter: string | number | null, now: number): boolean`. Accepts the v0.2 `YYYY-MM-DD` string or an epoch ms number; returns `today >= stale_after`. Treats `null` as never-stale.
- `extractFootnotes(body: string): OkfFootnote[]`. Parses `[^id]: text` lines at the body tail. Returned shape is opaque text — we don't try to interpret which body span uses which footnote; the body is the source of truth and is preserved verbatim.
- `parseVerifiedFlexible(value: OkfFrontmatterValue | undefined): OkfVerified`. Implements §5.2 "bare mapping = one-element list" — accepts either an array of `{by, at}` or a single `{by, at}` mapping.
- `formatSourcesJson(sources: OkfSource[], sharedWindow?: OkfSourceUsageWindow): string`. Produces the JSON we store in `okf_sources` (and folds the shared window into entries that lack one).
- `formatVerifiedJson(entries: OkfVerified): string`. Produces the JSON we store in `okf_verified`, sorted by `at` ascending so the latest is last.
- `latestVerified(entries: OkfVerified): { by: string; at: number } | null`. Pure helper used by `core-llm-wiki` to populate the convenience columns.

### 4.4 `packages/okf/src/footnotes.ts` — new module

- `extractFootnotes(body): OkfFootnote[]` (declared in `v02-helpers.ts` for export, but implemented here).
- `serializeFootnotes(footnotes): string` — only used to round-trip if the body was authored with footnote definitions; we always write bodies verbatim so this is a no-op today, but the helper exists for future use.

### 4.5 `packages/core/src/db/schema.ts` and `packages/core/src/db/migrations.ts` — additive migration

The physical table backing "facts" is `{prefix}entries` (see `schema.ts`; `WikiFact` is the row's TypeScript shape, but the SQL table name is `entries`, not `facts`). A new migration step runs after the current latest (v9) against both `{prefix}entries` and `{prefix}tasks`:

```sql
ALTER TABLE {prefix}entries ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE {prefix}entries ADD COLUMN stale_after INTEGER;          -- nullable
ALTER TABLE {prefix}entries ADD COLUMN generated_by TEXT;             -- nullable
ALTER TABLE {prefix}entries ADD COLUMN last_verified_at INTEGER;      -- nullable
ALTER TABLE {prefix}entries ADD COLUMN last_verified_by TEXT;         -- nullable
ALTER TABLE {prefix}entries ADD COLUMN okf_sources TEXT;              -- JSON array
ALTER TABLE {prefix}entries ADD COLUMN okf_verified TEXT;             -- JSON array
ALTER TABLE {prefix}entries ADD COLUMN okf_usage_window TEXT;         -- JSON object

ALTER TABLE {prefix}tasks ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE {prefix}tasks ADD COLUMN stale_after INTEGER;
ALTER TABLE {prefix}tasks ADD COLUMN generated_by TEXT;
ALTER TABLE {prefix}tasks ADD COLUMN last_verified_at INTEGER;
ALTER TABLE {prefix}tasks ADD COLUMN last_verified_by TEXT;
ALTER TABLE {prefix}tasks ADD COLUMN okf_sources TEXT;
ALTER TABLE {prefix}tasks ADD COLUMN okf_verified TEXT;
ALTER TABLE {prefix}tasks ADD COLUMN okf_usage_window TEXT;
```

Indexes (for the queries we expect):

```sql
CREATE INDEX {prefix}entries_lifecycle_status_idx ON {prefix}entries(lifecycle_status);
CREATE INDEX {prefix}entries_stale_after_idx ON {prefix}entries(stale_after);
CREATE INDEX {prefix}entries_last_verified_at_idx ON {prefix}entries(last_verified_at);
-- mirrors for tasks; index names follow the existing `{prefix}<table>_<col>_idx` convention
-- (see entries_entity_idx, entries_updated_idx in schema.ts), not a new idx_ prefix.
```

The `access_count` and `last_accessed_at` columns stay as they are. The `updated_at` column stays (no rename, no new column).

**Both places, not just the migration.** `WikiMemory.setup()` skips every entry in `MIGRATIONS` for a brand-new database — it stamps `schema_version = CURRENT_SCHEMA_VERSION` directly and only runs migrations against a database whose `entries` table already existed before `setup()` was called (see the `entriesExistedBeforeSetup` branch). A fresh install therefore never executes migration v10's `ALTER TABLE` statements; it only ever sees whatever `schema.ts`'s `CREATE TABLE` produces. The eight columns and their indexes MUST be added to the `CREATE TABLE {prefix}entries` / `CREATE TABLE {prefix}tasks` statements in `schema.ts` as well as to migration v10 in `migrations.ts` — the same pattern already used for `okf_type`, `ontology_checked_at`, and `heal_checked_at`, each of which appears in both `schema.ts` (for fresh installs) and a migration (for upgrades of an existing database).

### 4.6 `packages/core/src/types.ts` — `WikiFact` and `WikiTask` extension

```typescript
export interface WikiFact {
  // ... existing fields unchanged ...
  lifecycle_status: 'draft' | 'stable' | 'deprecated';   // default 'stable'
  stale_after: number | null;                              // epoch ms
  generated_by: string | null;                             // actor string per §7
  okf_sources: OkfSource[];                                // full nested list
  okf_verified: OkfVerified;                               // chronological
  okf_usage_window: OkfSourceUsageWindow | null;
  last_verified_at: number | null;                         // convenience
  last_verified_by: string | null;
}

export interface WikiTask {
  // ... existing fields unchanged ...
  // status stays as execution state (no rename on the DB column, see §2.3)
  lifecycle_status: 'draft' | 'stable' | 'deprecated';
  stale_after: number | null;
  generated_by: string | null;
  okf_sources: OkfSource[];
  okf_verified: OkfVerified;
  okf_usage_window: OkfSourceUsageWindow | null;
  last_verified_at: number | null;
  last_verified_by: string | null;
}
```

`WikiEdge` and `WikiEvent` are unchanged. `MemoryDump` is unchanged.

### 4.7 `packages/core/src/utils/formatOkfBundle.ts` — v0.2 default emission

- Replace `'0.1'` with `'0.2'` in `buildRootIndexMd`. Replace `LLM_WIKI_PROFILE = 'llm-wiki/1'` with `LLM_WIKI_PROFILE_V2 = 'llm-wiki/2'`.
- Add an optional `options?: { profile?: 'llm-wiki/1' | 'llm-wiki/2' }` parameter; default `llm-wiki/2`. When `llm-wiki/1`, emit profile-1 fields only (`timestamp` for facts/tasks; no `generated`/`verified`/`status`/`stale_after`/`sources`); the reader path unchanged.
- For profile-2:
  - Emit `generated: { by: <fact.generated_by>, at: <iso(updated_at)> }` **only when `generated_by` is non-null**. When `generated_by` is null (never set — e.g. a hand-authored fact that predates this profile, or an import that hit the "generated present without by" fallback), omit the `generated` key entirely rather than fabricate an actor. Per §4.8 the import side never invents a `generated_by`; the export side must not either, or a round-trip through export→import silently manufactures provenance that was never asserted. (`process:llm-wiki` remains available as an explicit default a *caller* may set on `generated_by` at write time — e.g. `runLibrarian` populating a freshly-generated fact — but `formatOkfBundle` itself does not backfill it.)
  - Emit `verified: [...okf_verified]` **only when the list is non-empty**; omit the key otherwise. An emitted `verified: []` is not equivalent to an absent key — §5.3 derives `unverified` from "no `verified` key", and a present-but-empty list is a stranger shape that round-trips awkwardly through the bare-mapping fallback.
  - Emit `status: <lifecycle_status>` for both facts and tasks (always present; `lifecycle_status` defaults to `'stable'` at the DB layer, so this is never null).
  - Emit `stale_after: <YYYY-MM-DD>` if non-null, for both facts and tasks (symmetric — see below).
  - Emit `sources: [...okf_sources]` **only when non-empty**, and `usage_window: <okf_usage_window>` **only when set**; omit otherwise, for the same reason as `verified`.
  - For tasks only, emit `execution_status: <status>` (the existing execution state). Profile-1 path keeps emitting `status: <execution>`.
  - **`timestamp` is also emitted alongside `generated.at`** (not just on the v0.1 path) as a deliberate, permanent back-compat convenience — an `llm-wiki/2` bundle is still readable by a naive consumer that only understands the v0.1 `timestamp` key, without that consumer needing to know the v0.2 flow-mapping shape at all. This is a scoped exception to "v0.1 fields are v0.1-only": `timestamp` is superseded per spec §13.1, but re-derivable losslessly from `generated.at` (`new Date(updated_at).toISOString()`), so duplicating it costs nothing and buys the widest possible reader compatibility. On import, §2.4's "`generated.at` wins when both present" rule is what makes this safe: the duplicate never becomes a second source of truth.
- Footnote body preserved verbatim (no synthesis).

**Task `stale_after` is symmetric with facts**, per the hybrid-schema table in §2.5: `taskFrontmatterV2` emits `stale_after` from `WikiTask.stale_after` exactly like `factFrontmatterV2` does, and `frontmatterToTask` on import populates `WikiTask.stale_after` from the wire `stale_after` field exactly like `frontmatterToFact` does — it is not hardcoded to `null`. A hallucinated task is exactly the kind of content §2.5 says needs a staleness signal as much as a fact does.

**The `# Citations` → `sources` fallback (§13.1) captures every URL, not just the first.** A v0.1 body's `# Citations` section commonly lists multiple references; `parseCitationsList` already returns the full array (§4.3), so the fallback maps each returned URL to its own synthetic `sources` entry (`{ resource: url }`, no `id`, no credibility signals) rather than keeping only `urls[0]`.

### 4.8 `packages/core/src/utils/parseOkfBundle.ts` — auto-detect + v0.2 path

- Read `profile` and `okf_version` from root index. The detection order is:
  1. `profile === 'llm-wiki/2'` → v0.2 path (explicit).
  2. `profile === 'llm-wiki/1'` → v0.1 path (explicit).
  3. `profile === undefined && okfVersion === '0.1'` → v0.1 path (isLegacyV1).
  4. `profile === undefined && okfVersion === undefined` → profile-0 (treated as v0.1 for status-rename + citations fallback; legacy edge-link extraction still applies).
  5. `profile === undefined && okfVersion === '0.2'` → v0.2 path (version-only fallback).
  6. Any other `profile` value (unknown profile key) with `okfVersion === '0.2'` → v0.2 path (unknown-profile fallback).
- v0.2 path:
  - For each concept: extract `generated.by`/`generated.at`, `verified` (handle bare-mapping form), `status` (lifecycle), `stale_after`, `sources`, `usage_window` from frontmatter. Map them into the new `WikiFact` / `WikiTask` fields.
  - Fallbacks (per spec §13.1): if `generated` absent but `timestamp` present, treat `timestamp` as `generated.at` with `by = null`. If `sources` absent but body has `# Citations` list, parse it into a synthetic source **per URL** (no `id`, no credibility signals) — every URL is preserved, not just the first. Mark these as fallback-derived (e.g., a transient `generated_by` default of `null` rather than inventing one).
  - For tasks: extract `execution_status` (v0.2) or `status` (v0.1 profile) into the task's execution `status`. Map v0.2 `status` (lifecycle) into `lifecycle_status`.
  - Update the JSON columns: write `okf_sources`, `okf_verified`, `okf_usage_window`; compute `last_verified_at`/`last_verified_by` via the helper.
  - Footnotes: parse but don't reconstruct body; carry the body verbatim.
- v0.1 path: unchanged.
- Tests must cover each detection branch (explicit v0.2, version-only v0.2, unknown-profile v0.2, explicit v0.1, isLegacyV1, profile-0).

### 4.9 `packages/core/src/WikiMemory.ts` — DAO discipline enforcement

- Confirm (and add a unit test) that the read-side `access_count` increment does NOT touch `updated_at`.
- New write paths for trust/provenance (`writeOkfTrust(entryId, verified)`, `writeOkfSources(entryId, sources)`, `setLifecycleStatus(entryId, status)`, `setStaleAfter(entryId, date)`) MUST NOT touch `updated_at`. They use direct `UPDATE` statements that explicitly omit `updated_at`.
- A small `okf-trust-writes.ts` module under `src/db/` houses these DAO methods. Each method has a comment explaining why `updated_at` is excluded and a Vitest snapshot of the SQL it issues.

### 4.10 `docs/okf-profile.md` — add `llm-wiki/2` section

- §11: "**llm-wiki/2 — OKF v0.2 conformance**". Lists the new frontmatter families, the actor convention, the `status` rename rule, the staleness surface, the deferred Attested Computation policy.
- §12 (new): "v0.1 → v0.2 migration cheat-sheet" — table of fields and how each maps.
- Changelog entry at the bottom: "llm-wiki/2 (2026-08-14): v0.2 conformance; `status` rename rule; Attested Computation deferred."

---

## 5. Data Flow

### 5.1 Export (write path)

```
WikiMemory rows
   │
   ├── fact/task object (with lifecycle_status, stale_after, okf_sources, okf_verified, etc.)
   │
   ▼
formatOkfBundle(dump, { profile: 'llm-wiki/2' })
   │
   ├── for each fact/task: frontmatter object
   │     ├── type, title, description, resource, tags (existing)
   │     ├── generated: { by: generated_by, at: iso(updated_at) }  (emitted only when generated_by is non-null; absent when null)
   │     ├── verified: okf_verified  (JSON-deserialized)
   │     ├── status: lifecycle_status
   │     ├── stale_after: YYYY-MM-DD (if set)
   │     ├── sources: okf_sources  (JSON-deserialized)
   │     └── usage_window: okf_usage_window  (JSON-deserialized)
   │
   ├── for each task: ALSO emit execution_status: <task.status>
   │
   ▼
serializeFrontmatter(frontmatter)
   │
   ├── scalars: serializeScalarString
   ├── flow mappings: emit {k: v, k: v}
   ├── block sequences: emit - item
   ├── actor strings: serializeActorString (quotes '/' in v0.2 actor strings)
   │
   ▼
.md file content (per concept) + index.md + log.md
```

### 5.2 Import (read path)

```
.md files (OkfFile[])
   │
   ▼
parseRootIndexMd → { okf_version, profile }
   │
   ├── profile === 'llm-wiki/2'  → v0.2 path
   ├── profile === 'llm-wiki/1'  → v0.1 path (unchanged)
   └── profile === undefined     → profile 0 path (unchanged)
   │
   ▼
v0.2 path: per-concept frontmatter → WikiFact / WikiTask
   │
   ├── generated → WikiFact.generated_by + updated_at (= generated.at)
   ├── verified (list or bare mapping) → okf_verified JSON + last_verified_at / last_verified_by
   ├── status → lifecycle_status
   ├── stale_after → WikiFact.stale_after (epoch ms)
   ├── sources → okf_sources JSON
   ├── usage_window → okf_usage_window JSON
   ├── body → WikiFact.body (verbatim; footnotes parsed but not extracted)
   │
   ├── for tasks: status (v0.2 wire) → lifecycle_status
   │              execution_status (v0.2 wire) → task execution status
   │              status (v0.1 wire, if profile is v0.1) → task execution status
   │
   ├── v0.1 fallback: timestamp → generated.at → updated_at
   ├── v0.1 fallback: body "# Citations" list → synthetic sources entry
   │
   ▼
SQLite: INSERT INTO facts (...) VALUES (..., lifecycle_status, stale_after, generated_by,
            last_verified_at, last_verified_by, okf_sources, okf_verified, okf_usage_window)
```

### 5.3 Read path (semantic retrieval)

```
wiki.read(entityId, query)
   │
   ▼
   SQLite query (existing schema + new indexes on lifecycle_status, stale_after)
   │
   ▼
   for each returned fact/task: hydrate
       │
       ├── isStale = isStaleAfter(stale_after, now)        ← §2.7 helper
       ├── trustTier = deriveTrustTier(okf_verified)       ← §2.7 helper
       │
       ▼
   MemoryBundle.facts[] with new fields populated + isStale / trustTier surfaced
       │
       ▼
   Application decides display policy (we never auto-filter)
```

---

## 6. Error Handling

| Failure                                                | Behavior                                                                                                    |
|--------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Frontmatter is not valid YAML                          | Treat as opaque; skip the unrecognized line. Per profile-1 §8 robustness.                                   |
| Flow mapping contains an anchor or alias               | The line is treated as opaque (skipped). NEVER expand. Per §2.6 guard rail.                                |
| Flow collection nested two or more levels deep (beyond the one level §2.6 supports) | Treated as opaque. The key is preserved, the value is `null` on the parsed side; on round-trip, the producer regenerates it from the typed model, not from the raw text. |
| Unquoted `&`/`*` anywhere in a flow value (anchor/alias-shaped) | The whole flow value is rejected (`null`), never expanded. A `&`/`*` **inside a quoted string** (e.g. a URL query string) is not an anchor/alias and does not trigger this — the scan excludes quoted spans. |
| Bare-mapping `verified` (one verifier, no list)        | `parseVerifiedFlexible` returns a one-element list. Per spec §5.2 MUST.                                     |
| `generated` present without `at` or `by`               | Skip the `generated` block on import; fall back to `updated_at`. Surface a non-throwing warning.            |
| `stale_after` is not a `YYYY-MM-DD`                    | Skip on import; do not store. Non-throwing.                                                                  |
| `okf_sources` JSON is malformed                        | Skip on import; leave the column NULL. Non-throwing.                                                        |
| Foreign concept type not in our known set              | Routed by directory path (`facts/` → fact, `tasks/` → task). Type preserved as `okf_type`.                  |
| `Attested Computation` concept                         | Imported as a generic `okf_type` fact (per §2.9). `runtime`/`parameters`/etc. dropped on import (no opaque-passthrough column in v0.2; deferred to a future profile). |
| Profile key absent but `okf_version` is `"0.2"`        | Treated as profile 2 path (v0.2 with no `profile` line is best-effort consumable per spec §12).              |
| `profile` key is unknown (e.g. `llm-wiki/3`)           | Best-effort: assume profile 2 unless `profile === 'llm-wiki/1'` or profile-0 markers are detected.          |

Errors never throw on import. The robustness contract is unchanged.

---

## 7. Testing Strategy

### 7.1 `core-okf` unit tests (new file `__tests__/v02-frontmatter.test.ts`)

- Flow mapping parse: round-trip a `generated` block, a `verified` block (list and bare-mapping), a `usage_window` block, an `executor` block, an `attester` block.
- Flow sequence parse: round-trip `parameters: [...]` and `executor.receipt: [job_id, executed_sql, result]`.
- Anchor/alias rejection: frontmatter containing `&` or `*` is parsed without expanding (test that the line is preserved or skipped, never thrown on).
- `serializeActorString` round-trips `reference_agent/gemini-2.5-pro`, `human:ahormati`, `process:finance-nightly`.
- `deriveTrustTier` covers all four branches: empty (`unverified`), process-only (`machine-confirmed`), agent-only (`machine-confirmed`), human (`human-reviewed`), human-then-process (still `human-reviewed`).
- `isStaleAfter` covers: null (never stale), past date (stale), future date (not stale), exactly today (stale per spec).

### 7.2 Conformance tests (`packages/core/__tests__/okfProfileConformance.test.ts`, extended)

- New test: `golden-v2` round-trip — import `golden-v2`, export `golden-v2`, re-import, compare the lossless fields from the fidelity table.
- New test: `golden-v2` profile detection — `profile === 'llm-wiki/2'` triggers v0.2 path; the v0.1 path is not invoked.
- New test: `golden-v2` fact with `sources` + `generated` + `verified` + `status` + `stale_after` + footnote body round-trips losslessly.
- New test: `golden-v2` task with `status` (lifecycle) + `execution_status` (execution) — the rename rule is exercised; round-trip preserves both keys.
- New test: `golden-v2` `Attested Computation` concept — imported as a generic fact with `okf_type: 'Attested Computation'`. v0.2 computation keys (`runtime`/`parameters`/`computation`/`executor`/`attester`) are dropped on import per §2.9; future-profile opaque-passthrough is the work item that revisits this.
- Existing tests: `golden-v1` round-trip unchanged (regression guard); `legacy-profile-0` import unchanged (regression guard); README trap test unchanged.

### 7.3 Backward-compat / cross-version tests (new `__tests__/okfVersionInterop.test.ts`)

- A bundle written by profile-1 (`okf_version: "0.1"`, `profile: llm-wiki/1`) imports cleanly under the v0.2 path with `timestamp` mapped to `updated_at`.
- A v0.2 bundle (`okf_version: "0.2"`, `profile: llm-wiki/2`) imports cleanly under the v0.2 path with `generated.at` mapped to `updated_at`.
- A bundle with a `# Citations` body list (legacy v0.1) imports via the fallback path into `okf_sources` as a synthetic entry.
- A v0.1 task with `status: done` imports with `execution_status === 'done'` (the renamed field); a v0.2 task with `status: stable` + `execution_status: in_progress` imports with both intact.

### 7.4 DAO discipline test (new `__tests__/daoDiscipline.test.ts`)

- Calling `access_count`-incrementing code does NOT modify `updated_at` (snapshot the SQL via a logging adapter and assert `updated_at` is absent from the SET clause).
- Calling `writeOkfTrust(...)` does NOT modify `updated_at`.
- Calling `writeOkfSources(...)` does NOT modify `updated_at`.
- Calling `setLifecycleStatus(...)` does NOT modify `updated_at`.
- Calling `setStaleAfter(...)` does NOT modify `updated_at`.
- A direct UPDATE that legitimately modifies content (e.g. `runHeal` rewriting body) DOES modify `updated_at` (positive control).

### 7.5 Fixture-level checks

- `fixtures/golden-v2/` ships with a `fixtures/golden-v2/SHA256SUMS` file. A test loads the sums at build time and asserts the committed fixtures haven't drifted.
- A lint step in CI asserts that no `.md` file inside `golden-v2/` contains `&` or `*` (anchor/alias ban enforcement).

### 7.6 Spot-check grep

- A repo-level grep for `updated_at = ` in `packages/core/src/` excludes the legitimate content-mutation paths (writer SQL) and confirms the absence in trust/provenance/access paths.

---

## 8. DAO Discipline Checklist (the heart of the spec)

The OKF v0.2 `generated.at` semantic is "last meaningful content change". We bind it to `updated_at`. The discipline is therefore: **only knowledge-content writes may bump `updated_at`.** Every other mutation must NOT touch it.

| Site                                                  | Touches `updated_at`? | Why                                                                                |
|-------------------------------------------------------|-----------------------|------------------------------------------------------------------------------------|
| `runLibrarian` writing a new fact                     | YES                   | New knowledge content.                                                              |
| `runLibrarian` rewriting a fact body / title / tags   | YES                   | Knowledge content changed.                                                          |
| `ingestDocument` rewriting a fact body                | YES                   | Source content changed.                                                             |
| `runHeal` downgrading / rewriting                     | YES                   | Knowledge content changed.                                                          |
| `forget(...)` (soft delete)                           | NO                    | `deleted_at` is the signal; knowledge is not "changed".                              |
| `access_count` increment (read tracking)              | NO                    | Already correct; verified during planning.                                          |
| `last_accessed_at` update                             | NO                    | Already correct.                                                                    |
| `writeOkfTrust(entryId, verified)` — NEW              | NO                    | Adding a verification event does not change knowledge content.                      |
| `writeOkfSources(entryId, sources)` — NEW             | NO                    | Provenance update does not change knowledge content.                                |
| `setLifecycleStatus(entryId, status)` — NEW           | NO                    | Lifecycle is a metadata signal, not a content change.                              |
| `setStaleAfter(entryId, date)` — NEW                  | NO                    | Freshness is a metadata signal, not a content change.                               |
| `setGeneratedBy(entryId, actor)` — NEW (rare)         | NO                    | Provenance update; not a content change.                                             |
| `updateEmbedding(...)`                                | NO                    | Vector recomputation is not a content change.                                       |

Implementation rule: every DAO method names itself by intent (`writeOkfTrust`, `accessCount++`), and the test in §7.4 asserts the SQL it issues against this table. A reviewer who adds a new write site must consult this checklist before merging.

**Outbox/transaction scope — a deliberate, separate decision from `updated_at`.** `EntryRepository.upsert` requires a `tx` parameter and pushes an outbox event for every write, because outbox delivery is how content changes replicate to downstream sync consumers. The five new `okf-trust-writes.ts` methods (`writeOkfTrust`, `writeOkfSources`, `setLifecycleStatus`, `setStaleAfter`, `setGeneratedBy`, and their task variants) do **not** go through the outbox and accept an optional `tx` rather than requiring one. This mirrors the `updated_at` distinction one layer down: outbox delivery exists for *content* sync, and trust/provenance/lifecycle metadata is deliberately not content per §8's table. A downstream sync consumer that never sees a `writeOkfTrust` outbox event will not learn about a new verifier until the next full re-export/re-import of the bundle — that staleness window is accepted for v0.2. A future profile MAY revisit this if trust/provenance sync latency becomes a real requirement; it is out of scope here (see §10).

---

## 9. Rollout

1. **Phase 1 — `core-okf` parser and types** (no schema, no DB)
   - Extend `frontmatter.ts` with the flow-mapping/flow-sequence parser.
   - Extend `types.ts` with the v0.2 surface (additive).
   - Add `v02-helpers.ts` and `footnotes.ts`.
   - Add `__tests__/v02-frontmatter.test.ts`.
   - Internal `core-okf` release as a minor bump. `parseOkfBundle` in `core-llm-wiki` is **not yet** wired to use the new helpers — they exist but are inert.

2. **Phase 2 — schema migration**
   - Add the additive migration in `db/schema.ts`. Migration is forward-only; rollback is a no-op (`ALTER TABLE ADD COLUMN` is safe to leave in place).
   - Extend `WikiFact` and `WikiTask` types.
   - Add DAO methods `writeOkfTrust`, `writeOkfSources`, `setLifecycleStatus`, `setStaleAfter`, `setGeneratedBy` in `okf-trust-writes.ts`.
   - DAO discipline tests (§7.4).
   - `core-llm-wiki` release as a minor bump. No behavior change for callers; the new fields exist but are unset.

3. **Phase 3 — adapter wiring (export default flip)**
   - `formatOkfBundle` defaults to `llm-wiki/2` + `okf_version: "0.2"`. Profile-1 export remains available via the `options.profile` override.
   - `parseOkfBundle` adds the v0.2 branch with fallbacks.
   - `golden-v2/` fixture committed; conformance test added.
   - README of `core-okf` updated to mention v0.2 support; README of `core-llm-wiki` updated to mention `llm-wiki/2` default.

4. **Phase 4 — profile doc**
   - `docs/okf-profile.md` gains §11 (`llm-wiki/2`) and §12 (migration cheat-sheet).
   - Changelog entry.

5. **Phase 5 — release**
   - `@equationalapplications/core-okf` minor bump (e.g. `5.4.0`).
   - `@equationalapplications/core-llm-wiki` minor bump.
   - `@equationalapplications/expo-llm-wiki` and `@equationalapplications/react-llm-wiki` no API change → no bump.
   - `@equationalapplications/core-llm-tools` — no change.
   - Other packages — no change.

6. **Phase 6 — communication**
   - This is an additive upgrade with backward compatibility baked in. The CHANGELOG entry highlights the default export version flip and the new `status` rename rule so downstream readers (Curated Thoughts Rust implementation, anyone holding a profile-1 bundle) get a clean migration story.

---

## 10. Deferred to a Future Profile (explicitly not in this work)

- **Attested Computation runtime.** `type: Attested Computation` is imported as a generic `okf_type` fact. Its v0.2 keys (`runtime`, `parameters`, `computation`, `executor`, `attester`) are dropped on import per §2.9 — there is no opaque-passthrough column in v0.2, so any caller that needs those keys must read them from the bundle text directly. No executor, no attester, no receipt, no verdict is implemented.
- **`# Computation` body section handling.** Bodies are preserved verbatim; we do not extract the inline computation into a separate field. A future profile can address this if the LLM-authored memory use-case starts demanding it.
- **Cross-entity edges.** Out of scope today; out of scope in this profile.
- **Per-source usage_count / last_modified harvesting.** The fields are stored; the harvesting pipeline (turning BigQuery job counts into `usage_count`) is application behavior.
- **`okf_version` negotiation in import.** Today we trust the declared profile + version. A future profile may add `Accept-Profile`-style negotiation if it becomes a real consumer need.

---

## 11. Changelog (this spec)

- **llm-wiki/2 (2026-08-14):** OKF v0.2 conformance. New frontmatter families (`sources`, `generated`, `verified`, `status`, `stale_after`, `usage_window`). Hand-rolled flow-mapping parser (no anchor/alias expansion). Hybrid DB schema (discrete + JSON). `status` rename rule for tasks (`status` = lifecycle, `execution_status` = execution). `generated.at` mapped onto existing `updated_at` with strict DAO discipline. `Attested Computation` deferred. Footnotes verbatim on round-trip (no synthesis). `isStale` and trust tier surfaced on read, never auto-filtered.