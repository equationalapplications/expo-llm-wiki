# Spec: OKF Entity Summary Persistence in WikiMemory

**Date:** 2026-07-05
**Status:** Approved
**Related:** `docs/okf-profile.md` (§4 summary prose), `docs/superpowers/specs/2026-07-05-okf-profile-design.md`, Clanker `2026-07-05-okf-profile-v1-adoption-design.md`

## Problem

Profile v1 (§4) requires consumers to preserve the entity summary block on round-trip: "parse it into their entity-summary field if they have one, otherwise carry it through to re-export unchanged."

As of 4.18.1, the format layer is done but the storage layer drops the ball:

- `parseOkfBundle` parses summary prose into `MemoryBundle.summary` (profile-1 bundles only) — implemented.
- `formatOkfBundle` emits `bundle.summary` into entity `index.md` — implemented.
- `ImportExportService.doImportEntity` never reads `bundle.summary` — the parsed summary is silently discarded on `importDump`.
- `getFullBundle` returns `{ facts, tasks, events, edges }` with no `summary`, so `exportDump` can never re-emit it.

Net effect: any application that stores memory in `WikiMemory` (i.e. Clanker) loses an imported summary the moment it lands in SQLite, and violates the profile's consumer MUST on its next export. Clanker's profile-v1 adoption is blocked on this.

## Design

### Storage: the existing `{prefix}meta` kv table

`MetadataRepository` already has a generic upserting kv store (`getMeta`/`setMeta` against `{prefix}meta (key, value)`). Summary is stored under key:

```
entity_summary:{entity_id}
```

No schema migration. The raw `entity_id` (not sanitized) is the key suffix — consistent with every other place ids are authoritative.

Rejected alternative: a dedicated `entity_summaries` table or a column on `{prefix}checkpoints`. Both need migrations for a single nullable string per entity; the kv table is exactly this shape already. Revisit only if summary grows structure (profile 2 territory).

### Import semantics (`doImportEntity`)

| Mode | `bundle.summary` present | `bundle.summary` absent |
|---|---|---|
| replace (`merge: false`) | `setMeta(entity_summary:{id}, summary)` | delete the key — replace mirrors the bundle exactly |
| merge (`merge: true`) | `setMeta` (overwrite; summary has no timestamp to compare, incoming wins) | leave existing value untouched — absence means the producer has no summary concept (profile §4), not "delete" |

Writes happen inside the existing import transaction.

### Export (`getFullBundle`)

`getFullBundle` reads `getMeta('entity_summary:' + entityId)` alongside the four existing parallel queries and includes `summary` in the returned `MemoryBundle` when non-null. `exportDump` inherits it; `formatOkfBundle` already emits it — no further change.

This also means an application's existing cloud-sync path (any flow that round-trips `exportDump` → `importDump`) carries summaries with zero app-side work.

### Entity deletion

Wherever entity data is wiped wholesale (the entity-forget/wipe path that clears facts/tasks/edges/events for an entity), the `entity_summary:{id}` key is deleted too. Implementation locates the existing wipe path and adds the delete — an orphaned summary key must not survive its entity.

### Types and API surface

`MemoryBundle.summary?: string` already exists (added with 4.18.x parse support). One new public read method, so applications can display a summary without paying for a full `exportDump` (which includes embedding blobs):

```typescript
declare class WikiMemory {
  getEntitySummary(entityId: string): Promise<string | null>
}
```

Thin wrapper over `metadataRepo.getMeta('entity_summary:' + entityId)`. No write API (see Non-Goals).

## Non-Goals

- Summary **write** API (`setEntitySummary` on `WikiMemory`) — no producer UI exists yet; applications that want to author summaries can wait for a deliberate API (profile already permits emitting one).
- Librarian-generated summaries.
- Any change to `parseOkfBundle`/`formatOkfBundle` — the format layer is complete.

## Testing

- **Round-trip (the conformance test):** import `packages/okf/fixtures/golden-v1/` via `importDump`, then `exportDump` → `formatOkfBundle`, assert the entity `index.md` summary block is byte-identical to the fixture's.
- **Replace clears:** import a bundle with a summary, then replace-import a bundle without one → `getFullBundle().summary` is `undefined`.
- **Merge preserves:** import a bundle with a summary, then merge-import a bundle without one → summary unchanged.
- **Merge overwrites:** merge-import a bundle with a different summary → incoming wins.
- **Wipe cleans up:** entity wipe removes the meta key.
- **Legacy no-op:** importing `legacy-profile-0/` writes no summary key.
- **Accessor:** `getEntitySummary` returns the stored value after import, `null` before any import and after replace-clear.

## Release

Minor version bump (4.19.0) — additive within profile major, per the profile's versioning policy. Changelog notes that `importDump`/`exportDump` now persist entity summaries.

## Sequencing

This ships first; Clanker's profile-v1 adoption spec (`clanker/docs/superpowers/specs/2026-07-05-okf-profile-v1-adoption-design.md`) pins `^4.19.0` and depends on this behavior for its summary round-trip conformance.
