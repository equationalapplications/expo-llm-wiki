# Documentation Update Summary

**Date:** 2026-08-16
**Status:** Completed
**Branch:** docs/spec-revise-ingest-parse-resilience

## Overview

Updated README files across the mono repo to document features implemented in the following specs:
- export-chunk-text-public-api (2026-08-06)
- heal-librarian-dedupe-race-design (2026-08-06)
- dependabot-concurrency-release-hygiene-design (2026-08-07)
- source-ref-lifecycle-design (2026-08-07)
- okf-v02-upgrade-design (2026-08-14)
- wikimemory-public-api-extensions-design (2026-08-14)
- ingest-parse-resilience-design (2026-08-15)

## Files Updated

### Main Repository README
**File:** `/README.md`

**New Sections Added:**
1. **Entity Enumeration** - `listEntityIds()` API
2. **Source Reference Enumeration** - `listSourceRefs()` API
3. **Direct Graph Write** - `upsertGraph()` API
4. **Batch Change Detection** - `hasChanged()` batch overload

**Existing Sections Enhanced:**
1. **Ingest Document** - Added `onDuplicateHash` option
2. **Forget** - Added dry-run mode capability
3. **Check for Changes** - Added batch overload documentation

### Core Package README
**File:** `/packages/core/README.md`

**New Sections Added:**
1. **Entity Enumeration** - `listEntityIds()` API with prefix filtering
2. **Source Reference Enumeration** - `listSourceRefs()` API for document auditing
3. **Direct Graph Write** - `upsertGraph()` API for deterministic graph ingestion
4. **Duplicate Hash Detection** - `onDuplicateHash` option documentation
5. **Batch Change Detection** - `hasChanged()` batch overload
6. **Dry-Run Deletion** - `forget()` dry-run mode

## New Public APIs Documented

### `listEntityIds(options?: { prefix?: string }): Promise<string[]>`
Returns all entity IDs with stored data. Includes entities with only soft-deleted rows so prune operations can reclaim storage. Supports optional prefix filtering for namespace filtering.

### `listSourceRefs(entityId): Promise<StoredSourceRef[]>`
Lists all documents stored for an entity with metadata (sourceRef, sourceHash, factCount, lastIngestedAt). Useful for auditing stored documents and validating sync state.

### `upsertGraph(entityId, params, adapter): Promise<{ nodesWritten, edgesWritten, superseded }>`
Writes structured graph data directly without LLM extraction. The tail of `ingestDocument` with the middle (LLM extraction) step removed. Accepts caller-supplied nodes (`{ id, type, title, body? }`) and edges (`{ type, sourceId, targetId, id? }`) under same `(sourceRef, sourceHash)` semantics. Throws `WikiSourceRefHashCollision` when a different live `sourceRef` already holds the same hash.

### `ingestDocument(..., { onDuplicateHash: 'ingest' | 'skip' | 'throw' })`
Controls behavior when a different live `sourceRef` already holds the same `sourceHash`:
- `'ingest'` (default): Proceed with extraction (pre-guard behavior)
- `'skip'`: Return early, zero-chunk result, no LLM call
- `'throw'`: Throw `WikiDuplicateHashError`

### `hasChanged(entityId, batch[]): Promise<Array<{ sourceRef, changed, duplicateOf? }>>`
Batch overload for checking multiple documents in one efficient query. `duplicateOf`, when present, is the canonical stored different `sourceRef` holding the same hash.

### `forget(entityId, params, { dryRun: true })`
Preview deletion impact without writing to database. Returns `{ deleted: { entries, tasks } }` for blast-radius validation.

## Packages Requiring No Updates

The following packages were reviewed and require no documentation updates:

### `@equationalapplications/expo-llm-wiki`
Expo package documentation focuses on React hooks and platform-specific setup. Core WikiMemory methods are documented in the main and core READMEs.

### `@equationalapplications/react-llm-wiki`
React package documentation focuses on React hooks and component lifecycle. Core WikiMemory methods are documented in the main and core READMEs.

### `@equationalapplications/core-llm-tools`
Focused on Gemini tool schemas and capability injection. Does not export the new WikiMemory APIs.

### `@equationalapplications/core-okf`
OKF v0.2 support already documented in core package README under "OKF v0.2 conformance (llm-wiki/2)" section.

### `@equationalapplications/prisma-outbox`
Focused on transactional outbox pattern. Does not export the new WikiMemory APIs.

## Already Documented Features

The following features were already documented in existing sections:

### Chunking Utilities (export-chunk-text-public-api)
Already documented in core package README with `chunkText`, `safeSlice`, `DEFAULT_MAX_CHUNK_LENGTH`, and `DEFAULT_CHUNK_OVERLAP` exports.

### Ingest Parse Resilience (ingest-parse-resilience-design)
Already documented in "Recent changes - 5.4.1" section of main and core READMEs with `WikiParseError`, partial-commit semantics, and retry behavior.

### OKF v0.2 Conformance (okf-v02-upgrade-design)
Already documented in core package README under "OKF v0.2 conformance (llm-wiki/2)" section with profile auto-detection and new public methods for trust/provenance writes.

### Heal/Librarian Dedupe Race (heal-librarian-dedupe-race-design)
Internal implementation fix with no user-facing API changes.

### Dependabot Concurrency Release Hygiene (dependabot-concurrency-release-hygiene-design)
CI/CD infrastructure improvements with no user-facing API changes.

## Documentation Approach

All new APIs were integrated into existing documentation sections rather than creating separate "What's New" sections. This maintains the handbook-style reference approach where developers can find APIs alongside related functionality.

## Testing Recommendations

Documentation should be tested by:
1. Verifying all code examples compile with TypeScript
2. Testing each new API in a development environment
3. Cross-referencing spec documents with README documentation
4. Ensuring all parameter types and return types are accurately described

## Future Considerations

As additional specs are implemented, documentation updates should:
1. Follow the same integration approach (add to existing sections)
2. Update both main README and core package README
3. Include working code examples with proper TypeScript types
4. Reference the original spec documents for detailed design rationale
