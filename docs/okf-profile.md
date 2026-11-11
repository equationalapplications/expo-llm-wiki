# The llm-wiki OKF Profile, Version 1

**Status:** Normative
**Profile identifier:** `llm-wiki/1`
**Builds on:** [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
**Reference implementation:** [`@equationalapplications/core-okf`](../packages/okf) (primitives) and [`@equationalapplications/core-llm-wiki`](../packages/core) (`formatOkfBundle` / `parseOkfBundle`)
**Design record:** `docs/superpowers/specs/2026-07-05-okf-profile-design.md`

This document defines how llm-wiki memory — entities, facts, tasks, graph edges, and episodic events — is serialized to and parsed from an OKF bundle. It is the interoperability contract between every producer and consumer in the ecosystem, currently Clanker (TypeScript, via `expo-llm-wiki`) and Curated Thoughts (Rust + TypeScript). A bundle that conforms to this profile MUST be readable by any conforming consumer regardless of which application produced it.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

## 0. Versioning and Profile Detection

- The root `index.md` frontmatter MUST carry `okf_version: 0.1`. A producer claiming conformance to this profile MUST also carry `profile: llm-wiki/1` — without it, consumers are entitled to treat the bundle as legacy.
- Consumers MUST treat a bundle whose root index lacks a `profile` key as **profile 0 (legacy)**: no `## Related` sections, no event ids, no summary prose are expected, and the legacy fallbacks in §6–§8 apply.
- Versioning policy: additive changes (new optional frontmatter keys, new informative sections) stay within the same major profile version. Changes that alter the meaning of existing constructs or remove them require a major bump (`llm-wiki/2`). Consumers MUST accept unknown minor additions within a major version they support.

## 1. Bundle Layout

A bundle is a set of UTF-8 text files (usually zipped). The normative layout:

```text
index.md                                  # root catalog (REQUIRED)
entities/{entity-dir}/index.md            # per-entity catalog (REQUIRED per entity)
entities/{entity-dir}/log.md              # episodic event log (REQUIRED per entity; MAY be empty)
entities/{entity-dir}/facts/{concept}.md  # one file per fact (OPTIONAL)
entities/{entity-dir}/tasks/{concept}.md  # one file per task (OPTIONAL)
```

- Producers MUST NOT emit files outside this layout, with one exception: a `README.md` at bundle root MAY be added for human readers. Consumers MUST ignore any file that does not match the layout above — including bundle-root `README.md`, which naive concept-routing otherwise mis-parses as a fact (a real, reproduced bug; see §8).
- A bundle MAY contain multiple entities. Consumers that support only single-entity import MUST reject multi-entity bundles explicitly rather than silently merging entities.

## 2. Filename Grammar

Directory and concept filenames are **derived, not authoritative**. The authoritative identifiers are the `id` and `entity_id` values in frontmatter (§5). Consumers MUST NOT reconstruct ids from filenames.

- `{entity-dir}` = `sanitize(entity_id)`; `{concept}` = `sanitize(concept_id)`, where `sanitize` produces only characters in `[A-Za-z0-9._-]`, never begins with `.`, never ends with `.` or a space, is at most ~220 characters, avoids Windows reserved device names, and appends `-<16 lowercase hex chars>` (a hash of the original value) whenever the sanitized form differs from the original or collides with a reserved name. Concept filenames additionally MUST NOT be `index` or `log` (case-insensitive); the hash suffix rule applies.
- Because this alphabet contains no spaces or URL-significant characters, link paths (§4, §6, §7) do not require percent-encoding. Producers MUST emit link paths verbatim in this grammar. Consumers SHOULD percent-decode link paths defensively before resolving them, to tolerate foreign tools that encode conservatively.

## 3. Root `index.md`

```markdown
---
okf_version: 0.1
profile: llm-wiki/1
---

## Entities

* [{entity_id}](entities/{entity-dir}/index.md)
```

Entry titles are the raw `entity_id` (or a display name, if the producer has one); the link path is the derived directory. Consumers MUST discover entities by scanning `entities/*/index.md` paths, not by trusting the root index exclusively — the root index is a catalog, not an access-control list.

## 4. Entity `index.md`

```markdown
{summary prose — zero or more markdown blocks}

## Facts

* [{fact title}](facts/{concept}.md)

## Tasks

* [{task description}](tasks/{concept}.md)

[Event log](./log.md)
```

**Summary prose (new in profile 1):** everything from the top of the file (after optional frontmatter and an optional leading H1 title) up to the first `##` heading **or end-of-file** is the entity's summary. Producers SHOULD emit it when the entity has summary content (e.g. Curated Thoughts' entity summary); producers with no summary concept (e.g. Clanker) emit none and remain conformant. Consumers MUST preserve the summary block on round-trip: parse it into their entity-summary field if they have one, otherwise carry it through to re-export unchanged. The empty-state boundary is explicit: an entity with no facts and no tasks has no `##` sections, so the summary runs to EOF (or to the `[Event log]` link line, which consumers MUST NOT treat as summary content).

Section headings `## Facts` and `## Tasks` are normative strings. Absent sections mean zero items.

## 5. Concept Documents

A concept document is YAML frontmatter (§8 grammar) followed by a markdown body.

### 5.1 Fact files (`facts/*.md`)

| Key | Type | Required | Semantics |
|---|---|---|---|
| `type` | string | REQUIRED | `fact`, or a custom OKF type carried through from `okf_type` |
| `title` | string | REQUIRED | Human-readable fact title |
| `tags` | string list | OPTIONAL | Block-style list; `[]` when empty |
| `timestamp` | string | REQUIRED | ISO 8601 of last update (`updated_at`) |
| `resource` | string | OPTIONAL | Source reference (`source_ref`) |
| `id` | string | REQUIRED | Raw fact id — authoritative (§2) |
| `entity_id` | string | REQUIRED | Raw owning-entity id — authoritative |
| `confidence` | string | REQUIRED | `certain` \| `inferred` |
| `source_type` | string | REQUIRED | `immutable_document` \| `user_confirmed` \| `librarian_inferred` |
| `source_hash` | string \| null | OPTIONAL | Content hash of the source, when known |
| `created_at` | number | REQUIRED | Unix epoch **milliseconds** |
| `access_count` | number | OPTIONAL | Consumer MAY ignore |
| `last_accessed_at` | number \| null | OPTIONAL | Epoch ms; consumer MAY ignore |
| `deleted_at` | number \| null | OPTIONAL | Non-null = soft-deleted; consumers SHOULD preserve, MUST NOT resurrect as live |

**Body:** the fact content itself, verbatim markdown — excluding the `## Related` section (§6), which is edge data, not body content.

### 5.2 Task files (`tasks/*.md`)

| Key | Type | Required | Semantics |
|---|---|---|---|
| `type` | string | REQUIRED | `task`, or custom carried `okf_type` |
| `title` | string | REQUIRED | The task description |
| `timestamp` | string | REQUIRED | ISO 8601 of last update |
| `id` / `entity_id` | string | REQUIRED | Authoritative ids |
| `status` | string | REQUIRED | e.g. `pending`, `done`, `archived` (producer's vocabulary; consumers preserve verbatim) |
| `priority` | number | REQUIRED | Producer-defined ordering |
| `created_at` | number | REQUIRED | Epoch ms |
| `resolved_at` / `deleted_at` | number \| null | OPTIONAL | Epoch ms |

**Body:** empty in profile 1 (aside from `## Related`, §6). Consumers MUST tolerate non-empty task bodies from future or foreign producers; consumers that model task bodies SHOULD preserve them on round-trip, but consumers without a task-body field MAY drop them.

Unknown frontmatter keys in either file type MUST be preserved on round-trip where the consumer re-exports, and MUST NOT cause a parse failure.

## 6. Edges: the `## Related` Section

Graph edges are serialized inline in the source concept's file, as the **final** section of the document:

```markdown
## Related

- [{edge_type}](./{target-concept}.md)
- [{edge_type}](../tasks/{target-concept}.md)
```

- **Producers MUST emit** one list item per edge whose `source_id` is this concept, linking to the target concept's file by relative path (same directory: `./x.md`; cross-type within the entity: `../facts/x.md` or `../tasks/x.md`). Profile 1 edges are intra-entity: both endpoints belong to the same entity bundle. An edge whose target is absent from the bundle (dangling) MUST be skipped, not written broken.
- **Consumers MUST parse** the trailing `## Related` section into edges `(source_id, target_id, edge_type)` — resolving `target_id` via the target file's frontmatter `id`, never from the filename — and MUST **strip the section from the stored body**. (Profile 0 consumers passed it through verbatim, so a re-imported fact permanently contained its own edge links as text; profile 1 closes that wart. When parsing a profile-0 bundle, consumers SHOULD still strip a trailing `## Related` section that matches this grammar.)
- **Fidelity:** only `source_id`, `target_id`, and `edge_type` survive the round trip. Edge row ids and `created_at` are regenerated on import. Nothing in this profile may depend on edge identity persisting across an export/import cycle.

## 7. Event Log (`log.md`)

Events are date-grouped, newest date first:

```markdown
## 2026-07-05

- (approved) [Approved: 3 facts added to Project X](./facts/fact_abc.md) <!-- id: evt_01hxyz -->
- (synthesized) Learned from meeting-notes.pdf <!-- id: evt_01hxyw -->
```

Line grammar: `- ({event_type}) {summary}` with two optional parts — the summary MAY be a markdown link to the related fact file when the event has a `related_entry_id`, and the line SHOULD end with a **stable id comment** (new in profile 1):

- Id comment grammar: `<!-- id: {event_id} -->` at end of line. Consumers MUST tolerate arbitrary whitespace between the summary/link, the comment opener, the `id:` token, the value, and the closer (`/<!--\s*id:\s*(\S+)\s*-->\s*$/`). Markdown formatters may strip or move HTML comments; a missing or unparseable id comment MUST degrade gracefully, never fail the line.
- Summary text MUST have `\`, `[`, `]` escaped and newlines collapsed to spaces (matching index-entry escaping). Consumers unescape them in both the linked and the plain form (clarified 2026-11-11; the reference consumer unescaped only the linked form before then).
- Date granularity is the `## YYYY-MM-DD` heading; intra-day ordering is not preserved. The heading is the UTC day of the event's `occurred_at` when that is a usable past date (a number in years 0000–9999, not later than `created_at`), otherwise of `created_at`. Consumers that parse the heading into `created_at` therefore receive the real-world day for events that carry one. (Amended 2026-11-11 by PR #364; earlier producers always used `created_at`. Golden fixtures are unaffected, because they carry no `occurred_at`.)

**Idempotency (normative consumer behavior):**

1. When an event line carries an id, the consumer MUST use it as the event's identity: importing an event whose id already exists is a no-op.
2. When the id is absent (profile 0 bundles, stripped comments), the consumer SHOULD deduplicate by the tuple `(event_type, summary, UTC-day)` against its existing events, where UTC-day is the heading's day: `occurred_at`'s when the producer used it, per the date rule above — the granularity this format actually preserves. This is the documented fix for the duplicate-events-on-every-restore failure in profile 0.

   A consumer SHOULD assign an id-less event the derived id defined below. Importing it again is then a no-op under rule 1, for as long as the earlier copy is still stored. Where the two rules differ (identical lines under one date), the derived id governs: each line is stored. (Amended 2026-11-11 by `specs/import-followups/spec.md` §3, #365. A consumer that stored id-less events under other ids before adopting the derivation gets one duplicate per event on the next import of the same log, and none after.)

**Derived event ids (added 2026-11-11).** For a log line with no valid id comment:

- **Fields**, in order: the tag `llm-wiki/event-id/1`; the id of the entity being imported into (not a bundle directory name); the heading's date text `YYYY-MM-DD` as written; the event type as stored (an unknown type stored as `observation` is hashed as `observation`); the summary as stored, after unescaping `\`, `[` and `]`, with no Unicode normalization; the occurrence, in decimal.
- **Occurrence:** walk the log in file order, counting only id-less lines that produce an event (the line parses and its date is valid). A line's occurrence is the number of earlier such lines in the same log with the same date, event type and summary (compared as encoded, so lone surrogates count as U+FFFD); the first is `0`. Lines with an explicit id do not count, and two headings with the same date share one count.
- **Taken ids:** first collect the explicit ids of every line in the log that produces an event. If a line's derived id is already taken, by one of those or by an id derived for an earlier line, the line takes the next occurrence number until its id is free, and the count for that date, type and summary continues after the number used. So a line added by hand next to an identical exported line is stored, wherever the two lines sit.
- **Encoding:** each field as its UTF-8 byte length in decimal, `:`, the UTF-8 bytes, then `,`, concatenated with nothing between. A lone UTF-16 surrogate encodes as U+FFFD (`EF BF BD`).
- **Id:** `evt_okf1_` followed by the first 32 lowercase hex characters of the SHA-256 digest of those bytes. The id fits the id-comment alphabet, so it survives an export as an ordinary id comment.
- Not hashed: the linked fact, the time of day, the line's position.

Example (first id-less line of `legacy-profile-0`, imported as entity `demo`):

```text
bytes: 19:llm-wiki/event-id/1,4:demo,10:2026-07-05,11:observation,15:Linked to alpha,1:0,
id:    evt_okf1_02dd42bf329719f258ab93b373f44506
```

Test vectors:

| entity id | date | event type | summary | occurrence | id |
|---|---|---|---|---|---|
| `demo` | `2026-07-05` | `observation` | `Linked to alpha` | 0 | `evt_okf1_02dd42bf329719f258ab93b373f44506` |
| `demo` | `2026-07-05` | `decision` | `Chose path B` | 0 | `evt_okf1_9a70e3a388247f9c27f96fc3855b3975` |
| `demo` | `2026-07-05` | `decision` | `Chose path B` | 1 | `evt_okf1_549570648f50f8a88e414df0285d1de9` |
| `other` | `2026-07-05` | `decision` | `Chose path B` | 0 | `evt_okf1_0a2faa6618933c9e9d106a5b164bab90` |
| `user-123` | `2023-11-14` | `observation` | `Café ☕ visit — see [docs]` | 0 | `evt_okf1_bb987e1897dec93aec0ac282799ebc58` |
| (empty) | `2026-01-01` | `action` | (empty) | 0 | `evt_okf1_a24645f15c6bdc6a079fb283dfc059eb` |

Taken-id case: under `## 2026-07-05` in entity `demo`, the line `- (decision) Chose path B <!-- id: evt_okf1_9a70e3a388247f9c27f96fc3855b3975 -->` followed by the id-less line `- (decision) Chose path B` gives the id-less line `evt_okf1_549570648f50f8a88e414df0285d1de9` (occurrence 1), because occurrence 0's id is taken.

The reference implementation is `deriveEventId` in `@equationalapplications/core-okf`. An explicit id always wins and is never recomputed. Deduplication by derived id holds only while the earlier copy is stored: an event deleted by a prune is stored again by a later import of the same log.

## 8. Consumer Robustness Requirements

**Frontmatter YAML subset.** The frontmatter grammar is the subset emitted by `serializeFrontmatter`: scalar string/number/boolean/null values, double- or single-quoted strings with the documented escapes, and block-style string lists (`- item`). It is NOT general YAML.

- For profile `llm-wiki/1` (this section's normative scope), producers MUST NOT emit flow collections (`[...]`, `{...}` — except the literal empty list `[]`), block scalars (`|`, `>`), anchors, aliases, or tags (`&`, `*`, `!!`). Anchor/alias expansion is the vector for billion-laughs payload amplification and remains forbidden in every profile. Profile `llm-wiki/2` §11.4 widens the flow-collection rule for the small set of v0.2 canonical shapes it requires (`generated`, `verified`, `sources`, `usage_window`, per-source objects), still bounded and still anchor/alias-free.
- Consumers MUST NOT run frontmatter through a general-purpose YAML parser with anchor/alias expansion enabled. A conforming consumer either uses the subset parser (which treats unrecognized shapes as skipped lines or opaque scalars — the reference `parseFrontmatter` behavior) or a general parser hardened to reject the constructs above.
- Unrecognized lines MUST be skipped, not thrown on: a foreign bundle degrades in fidelity, never crashes the import.

**Path allow-list.** Before routing any file to concept parsing, consumers MUST filter to the exact layout of §1. This structurally excludes bundle-root `README.md` and any other stray markdown, which default concept-routing would otherwise mis-parse as a fact.

**Untrusted archives (informative).** When the bundle arrives as a zip from an untrusted source, consumers are advised to: cap total entry count (thousands, not hundreds of thousands); treat each entry's declared uncompressed size as an attacker-controlled pre-filter only, enforcing the real cap on a running total of actual decompressed bytes; and reject multi-entity bundles when only single-entity import is supported. See the Clanker import design (2026-07-04) for a worked implementation.

## 9. Conformance

**Producer checklist:** emits only §1 paths (plus optional root README) · filenames in §2 grammar · root index with `okf_version` + `profile` · raw ids in frontmatter · required fields of §5 · `## Related` per edge with dangling-skip · event lines with id comments · summary prose only in the §4 position · no YAML constructs outside the §8 subset.

**Consumer checklist:** path allow-list before parsing · ids from frontmatter, never filenames · unknown keys preserved, unknown lines skipped · `## Related` parsed into edges and stripped from body · event id dedup with tuple fallback · summary block parsed or carried through, using the first-`##`-or-EOF boundary · profile-0 fallbacks when the root `profile` key is absent · link paths percent-decoded defensively before resolution · subset-safe YAML handling.

**Round-trip fidelity table:**

| Data | Survives round trip? |
|---|---|
| Fact/task ids, entity_id, bodies, tags, confidence, source_type, timestamps | Yes (frontmatter/body) |
| Entity summary prose | Yes (profile ≥ 1) |
| Edge `(source, target, type)` | Yes (profile ≥ 1 producer, or profile-0 bundle with call-site `## Related` augmentation) |
| Edge row id, edge `created_at` | No — regenerated on import |
| Event identity | Yes with id comment (profile ≥ 1); derived from the line otherwise (§7) |
| Intra-day event ordering | No — date granularity only |
| access_count / last_accessed_at | Carried, consumer MAY ignore |
| Ontology / entity manifests | Not serialized in profile 1 |

**Golden fixtures.** The canonical conformance bundles live at `packages/okf/fixtures/golden-v1/` (profile 1: one entity, facts with intra- and cross-type edges, tasks, events with id comments, summary prose) and `packages/okf/fixtures/legacy-profile-0/` (no profile key, no `## Related` sections, no event id comments, no summary prose). A conforming implementation round-trips `golden-v1` losslessly per the table above and imports `legacy-profile-0` using every fallback path. Non-TypeScript implementations (Curated Thoughts' Rust backend) vendor checksummed copies of these fixtures.

## 10. Known Limitations and Deferred Work

- **Ontology manifests** (`llm_wiki_entity_manifests`) are not serialized. Deferred to profile 2, when ontology editing exists in some producer and there is a real shape to standardize.
- **Id remapping on clone** (importing a bundle as a *new* entity while the source entity still exists locally) is application behavior, not format: the format guarantees raw ids in frontmatter so applications *can* remap. See the Clanker import design (2026-07-04) for the collision-guard rationale.
- **Replace-mode event clearing** is likewise application behavior; this profile only guarantees event identity (§7) so applications can implement any replace/merge policy without duplication.
- **Cross-entity edges** are out of scope for profile 1.

## 11. llm-wiki/2 — OKF v0.2 Conformance

**Profile identifier:** `llm-wiki/2`
**Builds on:** [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (upstream)
**Design record:** `docs/superpowers/specs/2026-08-14-okf-v02-upgrade-design.md`
**Default export:** yes — `formatOkfBundle()` emits `okf_version: 0.2` + `profile: llm-wiki/2` unless the caller passes `{ profile: 'llm-wiki/1' }`.

`llm-wiki/2` adds three first-class concerns to the wire format, while staying round-trip compatible with `llm-wiki/1` and profile-0 bundles:

### 11.1 New frontmatter families

| Key | Type | Required | Semantics |
| --- | --- | --- | --- |
| `generated` | `{ by: string, at: string }` | OPTIONAL | Producer actor + ISO 8601 timestamp. Maps to `updated_at` on import. |
| `verified` | `[{ by: string, at: string }]` OR bare `{ by, at }` | OPTIONAL | Chronological list of verifiers. Bare mapping = one-element list (v0.2 §5.2). Trust tier derived on read. |
| `status` | `'draft' \| 'stable' \| 'deprecated'` | OPTIONAL | Lifecycle state. On tasks, the v0.2 wire `status` is the lifecycle state (see §11.3). |
| `stale_after` | `YYYY-MM-DD` | OPTIONAL | Absolute cutoff; a fact is `isStale` when `today >= stale_after`. |
| `sources` | `[{ id?, resource, title?, author?, usage_count?, last_modified?, usage_window? }]` | OPTIONAL | Provenance with per-source credibility signals. |
| `usage_window` | `{ from: YYYY-MM-DD, to: YYYY-MM-DD }` | OPTIONAL | Sibling of `sources`. Per-entry `usage_window` overrides. |
| `valid_from` | `number` | OPTIONAL | Optional; epoch ms; temporal validity, see core README → Temporal facts. |
| `valid_to` | `number` | OPTIONAL | Optional; epoch ms; temporal validity, see core README → Temporal facts. |
| `superseded_by` | `string` | OPTIONAL | Optional; id (of the superseding fact); temporal validity, see core README → Temporal facts. |
| `superseded_at` | `number` | OPTIONAL | Optional; epoch ms; temporal validity, see core README → Temporal facts. |

**`timestamp` still rides along.** `llm-wiki/2` export emits `timestamp` alongside `generated.at` on every concept, not only on the `llm-wiki/1` path — a deliberate, permanent back-compat choice so a naive v0.1-only reader stays fully functional against a v0.2 bundle without understanding flow-mapping syntax at all. `generated.at` is canonical; if a document somehow carries both with different values (a hand-edited or transitional bundle), `generated.at` wins on import.

**Absent, not empty.** `verified` and `sources` are omitted entirely when there is nothing to report, never emitted as `verified: []` / `sources: []` — an empty list is not the same shape as "no `verified` key" (OKF v0.2 §5.3 derives the `unverified` trust tier specifically from key absence). The same applies to `generated`: if a fact has no recorded `generated_by` actor, the `generated` key is omitted rather than defaulting to a fabricated actor like `process:llm-wiki`.

### 11.2 Actor convention (v0.2 §7)

- `agent`: `<producer>/<version>` — e.g. `reference_agent/gemini-2.5-pro`.
- `human`: `human:<id>` — e.g. `human:ahormati`.
- `process`: `process:<id>` — e.g. `process:finance-nightly`.

The trust tier (`unverified` / `machine-confirmed` / `human-reviewed`) is derived from the `verified` list at read time. If any verifier actor starts with `human:`, the tier is sticky `human-reviewed`.

### 11.3 The `status` rename rule (no two consumers fight over one key)

Profile-1 §5.2 requires `status` on tasks for **execution** state. OKF v0.2 wants `status` for **lifecycle** state. The reader/writer contract:

- **DB column** `tasks.status` keeps its execution meaning (no rename). A new `lifecycle_status TEXT NOT NULL DEFAULT 'stable'` column carries the OKF v0.2 lifecycle.
- **Wire (v0.2) — tasks:** `status` = lifecycle (imported into `lifecycle_status`); `execution_status` = execution (imported into `tasks.status`).
- **Wire (v0.1 / profile 0) — tasks:** `status` = execution (imported into `tasks.status`); lifecycle is implicit `'stable'`.
- **Wire (v0.2) — facts:** `status` = lifecycle (no execution state on facts). The `facts.status` column does not exist; only `lifecycle_status`.

### 11.4 YAML flow collections (at most one level of nesting)

The `core-okf` subset parser recognizes flow mappings (`{ k: v, k: v }`) and flow sequences (`[ a, b, c ]`) needed for v0.2 canonical shapes (`generated`, `verified`, `usage_window`, per-source objects, `executor.receipt`). Strict guard rails:

- **No anchor or alias expansion.** `&name` and `*name` are never recognized outside quoted strings (a quoted value like a URL query string, `"https://x/a?p=1&q=2"`, is not an anchor). Any unquoted `&`/`*` inside a flow value is rejected outright. This preserves the billion-laughs safety that motivated profile-1 §8.
- **At most one level of nesting inside a flow mapping value.** `{ a: { b: 1 } }` parses; `{ a: { b: { c: 1 } } }` does not (the key is preserved with a `null` value rather than silently dropped). This is what makes `sources[].usage_window` and `executor.receipt` parse — v0.2's own canonical shapes need exactly one level. A flow *sequence's* items being mappings (`sources: [ {...}, {...} ]`, the base "array of objects" shape) does not consume this budget by itself.
- **`sources`, `verified` (list form), and `parameters` are always emitted as a single-line flow sequence.** Never as a legacy block-list whose items happen to be flow mappings (`key:\n  - { ... }`) — that shape cannot round-trip through the block-sequence parser, which predates flow-collection support and has no way to flow-parse a `- ...` line's contents.

### 11.5 Footnotes

Bodies MAY carry footnote attribution via `[^id]` markers whose label joins to `sources[].id`. Bodies are preserved verbatim on round-trip. Producers MUST NOT synthesize footnote markers on export.

### 11.6 Attested Computation (deferred to a future profile)

A concept of `type: Attested Computation` is imported as a generic `okf_type` fact. Its `status`/`generated`/`verified`/`stale_after`/`sources`/`usage_window` round-trip exactly like any other v0.2 concept. Its runtime-specific contract fields — `runtime`, `parameters`, `computation`, `executor`, `attester` — do **not** round-trip: `core-llm-wiki` has no generic column for arbitrary unrecognized frontmatter keys, so these are silently dropped on import, the same as any other unrecognized key on any concept type. (§5's blanket "unknown frontmatter keys MUST be preserved on round-trip" is a pre-existing profile-1 contract that `core-llm-wiki` does not fully implement today; `llm-wiki/2` does not close that gap, only documents it against this specific concept type where it's most visible.) No executor, no attester, no receipt runtime is implemented in `llm-wiki/2`. A future profile (`llm-wiki/3`?) takes both on.

## 12. v0.1 → v0.2 Migration Cheat-Sheet

For producers upgrading from `llm-wiki/1` to `llm-wiki/2`:

| v0.1 wire | v0.2 wire | Where it lands |
| --- | --- | --- |
| `timestamp` (ISO 8601) | `generated.at` (ISO 8601) | `updated_at` (ms). v0.1 `timestamp` is still accepted; `generated.at` wins if both are present. |
| body `# Citations` list | `sources: [...]` | `okf_sources` (JSON). v0.1 body citations become one synthetic source entry per citation URL — a list of three URLs produces three sources, each `{ resource: <url> }` with no `id` and no credibility signals. |
| `status` on tasks (execution) | `status` (lifecycle) + `execution_status` (execution) | Tasks: `lifecycle_status` + `tasks.status`. |
| `tags` block list | unchanged | unchanged |
| `## Related` section | unchanged | unchanged |
| event id comments | unchanged | unchanged |

For consumers reading a v0.2 bundle:

- Read `status` as **lifecycle**; read `execution_status` as **execution**.
- A task bundle without `execution_status` (foreign producer) → fall back to `'pending'`.
- A fact bundle with `status: 'stable'` is the default; do not require it.
- Trust tier is derived: any `human:*` verifier → `human-reviewed` (sticky).
- `isStale = (today >= stale_after)`. NULL `stale_after` → never stale.

## Changelog

- **2026-11-11** (no profile change, `llm-wiki/2` stays): §7 adds derived ids for id-less event lines (SHOULD), with test vectors and a taken-id rule, says the derived id governs over the tuple rule where they differ, and states that consumers unescape plain summaries as well as linked ones.
- **llm-wiki/2** (2026-08-14): OKF v0.2 conformance. New frontmatter families (`sources`, `generated`, `verified`, `status`, `stale_after`, `usage_window`). Hand-rolled flow-mapping parser (no anchor/alias expansion). Hybrid DB schema (discrete + JSON). `status` rename rule for tasks (`status` = lifecycle, `execution_status` = execution). `generated.at` mapped onto existing `updated_at` with strict DAO discipline. `Attested Computation` deferred. Footnotes verbatim on round-trip (no synthesis). `isStale` and trust tier surfaced on read, never auto-filtered.
- **llm-wiki/1** (2026-07-05): first normative profile. Additions over the de-facto profile 0: `profile` root key; `## Related` moves from call-site convention to producer-MUST with consumer strip-on-parse; event id comments; entity summary prose block; explicit YAML-subset and robustness requirements.
