# Spec: llm-wiki OKF Profile — Design Record

**Date:** 2026-07-05
**Status:** Implemented
**Deliverable:** `docs/okf-profile.md` (the normative profile document)
**Related:** Clanker `2026-07-03-okf-export-design.md` and `2026-07-04-okf-import-support-design.md`; Curated Thoughts `2026-07-05-okf-backend-migration-design.md` and `2026-07-05-ux-vision-okf-native-design.md`

## Problem

The OKF bundle format was defined implicitly: by `formatOkfBundle`/`parseOkfBundle` internals in `core-llm-wiki`, by call-site conventions in Clanker (edge augmentation, event dedup tuples, zip safeguards), and by design decisions scattered across four app-level specs in two repos. Two applications (Clanker and Curated Thoughts) now stay wire-compatible through this format, and Curated Thoughts is adding a second implementation language (Rust, phase 6 of its UX vision). Implicit formats drift; a versioned normative document plus mechanical fixtures prevent that.

## Decisions Made During Brainstorming

- **Nature:** normative profile spec ("llm-wiki OKF profile") with RFC-2119 language, layered over the external upstream OKF v0.1 — not a descriptive snapshot, not a standalone format RFC duplicating upstream.
- **Location:** both the profile doc and this design record live in `expo-llm-wiki` (the monorepo housing `core-okf` and `core-llm-wiki`) — the format lives where its reference implementation lives. App repos link to it.
- **Normative gap fixes in v1** (each was previously a per-app workaround or undefined):
  1. **Edges:** `## Related` emission moves from Clanker's call-site augmentation into `formatOkfBundle` (producer MUST); consumers parse it into edges and strip it from the stored body — also fixing the profile-0 wart where re-imported facts permanently contained their edge links as body text.
  2. **Event identity:** log lines gain a trailing `<!-- id: evt_x -->` comment; consumers dedup by id when present, falling back to the `(event_type, summary, UTC-day)` tuple for legacy bundles. Fixes duplicate-events-on-every-restore at the format level.
  3. **Entity summary prose:** defined as the block between frontmatter/H1 and the first `##` heading or EOF in entity `index.md`. Unblocks Curated Thoughts' `curated_entities.summary` mapping; Clanker emits none and stays conformant.
- **Deferred (not v1):** ontology-manifest serialization (`mode: 'off'` everywhere today — nothing real to standardize), cross-entity edges, id-remap-on-clone semantics (application behavior; the format only guarantees raw ids in frontmatter to make remapping possible).
- **Wire version marker:** root index frontmatter gains `profile: llm-wiki/1`; absence = profile 0 (legacy) and triggers all fallback paths. Additive changes stay in-major; breaking changes bump the major.
- **Conformance mechanism:** golden fixture bundles committed at `packages/okf/fixtures/` — `golden-v1/` (full profile-1 feature coverage) and `legacy-profile-0/` (every fallback path). Rust implementations vendor checksummed copies.

## Review Findings Folded In

- **Filename grammar over URL-encoding:** inspection of `sanitizeForFilename`/`sanitizeConceptId` showed the output alphabet is `[A-Za-z0-9._-]` with hash-suffix collision handling — spaces are impossible, so the profile states the filename grammar normatively and requires producers to emit paths verbatim; consumers percent-decode defensively (SHOULD) for foreign tools.
- **HTML-comment fragility:** the event-id comment's parse boundary is specified as an exact whitespace-tolerant regex, and a stripped/missing comment MUST degrade to tuple dedup, never fail the line (markdown formatters strip comments).
- **Summary block empty state:** boundary is "first `##` **or EOF**", with the `[Event log]` link line explicitly excluded from summary content.
- **YAML hardening:** producer MUST NOT emit flow collections/block scalars/anchors/aliases; consumers MUST NOT expand anchors (billion-laughs vector). The reference subset parser already satisfies this; the profile makes it binding on any future general-parser implementation.

## Rollout (implementation plans to follow, per repo)

1. **expo-llm-wiki:** `formatOkfBundle` emits `## Related`, event id comments, `profile` key, and (pass-through) summary prose; `parseOkfBundle`/`parseLogMd` read all four incl. body-strip of `## Related`; golden fixtures + round-trip conformance tests; package minor bump (additive within profile major); READMEs of `core-okf` and `core-llm-wiki` link to the profile doc.
2. **Clanker:** delete the call-site edge-augmentation pass once the bumped package ships (its output is now redundant); adopt id-based event dedup with tuple fallback retained for old backups.
3. **Curated Thoughts (phase 6):** Rust export/import implemented against the profile doc + vendored fixtures; entity summary maps `curated_entities.summary` ⇄ entity `index.md` prose.

## Testing Strategy

- Round-trip test: `golden-v1` through export→import→export, byte-comparing where the fidelity table promises losslessness.
- Fallback test: `legacy-profile-0` import exercises tuple dedup, missing-summary, missing-edges, no-profile-key paths.
- Negative tests: root `README.md` excluded by the allow-list; anchor/alias frontmatter rejected or treated opaque; dangling `## Related` link skipped.
- Fixture checksum test in Rust repo detects silent fixture drift between repos.
