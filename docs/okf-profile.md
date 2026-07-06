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
- Summary text MUST have `\`, `[`, `]` escaped and newlines collapsed to spaces (matching index-entry escaping).
- Date granularity is the `## YYYY-MM-DD` heading (UTC of `created_at`); intra-day ordering is not preserved.

**Idempotency (normative consumer behavior):**

1. When an event line carries an id, the consumer MUST use it as the event's identity: importing an event whose id already exists is a no-op.
2. When the id is absent (profile 0 bundles, stripped comments), the consumer SHOULD deduplicate by the tuple `(event_type, summary, UTC-day)` against its existing events — the granularity this format actually preserves. This is the documented fix for the duplicate-events-on-every-restore failure in profile 0.

## 8. Consumer Robustness Requirements

**Frontmatter YAML subset.** The frontmatter grammar is the subset emitted by `serializeFrontmatter`: scalar string/number/boolean/null values, double- or single-quoted strings with the documented escapes, and block-style string lists (`- item`). It is NOT general YAML.

- Producers MUST NOT emit flow collections (`[...]`, `{...}` — except the literal empty list `[]`), block scalars (`|`, `>`), anchors, aliases, or tags (`&`, `*`, `!!`). This is a hard requirement: anchor/alias expansion is the vector for billion-laughs payload amplification.
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
| Event identity | Yes with id comment (profile ≥ 1); tuple-approximated otherwise |
| Intra-day event ordering | No — date granularity only |
| access_count / last_accessed_at | Carried, consumer MAY ignore |
| Ontology / entity manifests | Not serialized in profile 1 |

**Golden fixtures.** The canonical conformance bundles live at `packages/okf/fixtures/golden-v1/` (profile 1: one entity, facts with intra- and cross-type edges, tasks, events with id comments, summary prose) and `packages/okf/fixtures/legacy-profile-0/` (no profile key, no `## Related` sections, no event id comments, no summary prose). A conforming implementation round-trips `golden-v1` losslessly per the table above and imports `legacy-profile-0` using every fallback path. Non-TypeScript implementations (Curated Thoughts' Rust backend) vendor checksummed copies of these fixtures.

## 10. Known Limitations and Deferred Work

- **Ontology manifests** (`llm_wiki_entity_manifests`) are not serialized. Deferred to profile 2, when ontology editing exists in some producer and there is a real shape to standardize.
- **Id remapping on clone** (importing a bundle as a *new* entity while the source entity still exists locally) is application behavior, not format: the format guarantees raw ids in frontmatter so applications *can* remap. See the Clanker import design (2026-07-04) for the collision-guard rationale.
- **Replace-mode event clearing** is likewise application behavior; this profile only guarantees event identity (§7) so applications can implement any replace/merge policy without duplication.
- **Cross-entity edges** are out of scope for profile 1.

## Changelog

- **llm-wiki/1** (2026-07-05): first normative profile. Additions over the de-facto profile 0: `profile` root key; `## Related` moves from call-site convention to producer-MUST with consumer strip-on-parse; event id comments; entity summary prose block; explicit YAML-subset and robustness requirements.
