# Spec: Security Hardening Phase 2 (Opus 4.7 Review Fixes)

**Date:** 2026-06-22
**Status:** Implemented
**Builds on:** [`2026-05-07-vectorranker-security-hardening.md`](2026-05-07-vectorranker-security-hardening.md)
**Target version:** v4.14.1 (patch — no new public API surface)

---

## Problem

An Opus 4.7 security review of `packages/core` (the platform-agnostic SQLite/LLM "wiki" memory engine) identified 8 actionable findings beyond the VectorRanker-specific hardening already shipped. Unlike the VectorRanker spec, these findings span the core write/import/embed paths and are not gated behind an optional adapter — they apply to every deployment.

1. **`tablePrefix` (H-1):** Interpolated directly into ~30 DDL/DML statements (`db/schema.ts`, `db/migrations.ts`, every repository) with no validation. Hosts that derive `tablePrefix` from partially-trusted input (e.g. per-tenant config) open a DDL injection gap — `setupDatabase` and migration v2 use multi-statement `execAsync`.

2. **`importDump` (H-2):** `ImportExportService.doImportEntity` reconstructs `embedding_blob` from arbitrary JSON shapes with no upper bound on byte length — a single fact with a 200MB `data` array forces unbounded allocation. The same path bypasses `validateFact`, forwarding `title`/`body` verbatim to storage and to `embedFact` (cost amplification against the host's LLM bill).

3. **`WriteService.write` (M-1):** `event.summary` has no length cap, type check, or character filtering — stored verbatim, later interpolated into librarian prompts. `related_entry_id` is not validated against existing facts or scoped to the same entity.

4. **`EmbeddingService.embedFact` (M-2):** Builds `${title} ${body} ${tagsStr}` and ships it to the host's remote embed endpoint unbounded. Bounded on librarian/heal/ingest paths via `validateFact`'s clip, but not on `importDump` or `runReembed` paths.

5. **Prompt-injection trust boundary (Doc):** README's Security section documents VectorRanker adapter risks but doesn't state that prompt injection via stored user content is a structural property the host must own.

6. **Log/error forging (L-1):** `WikiMemory.hasChanged` and `ImportExportService._warnCrossEntityCollision` interpolate raw `sourceRef`/`sourceHash`/IDs into thrown messages and `console.warn` — a malicious value containing ANSI/CRLF sequences can forge log lines.

7. **Weak ID fallback (L-3):** `utils/ids.ts` falls back to `Math.random()` (~92-bit combined entropy) when `crypto` is unavailable, silently weakening record IDs.

8. **Untyped dynamic dispatch (L-4):** `JobManager.acquireLock`/`releaseLock` resolve `` `_${operation}Key` `` as a computed property name. No exploit path today (operation is type-checked), but it's a code smell that resists static verification.

(A 9th, L-2 — `parseJsonResponse` walking attacker text without a size cap — was reviewed and judged no-action: bounded by LLM provider max-tokens, no proto-pollution risk. Not included below.)

---

## Goal

Close the 8 actionable findings above, in the review's suggested fix order, with no new public API surface (patch release).

**Non-goals:**
- New `WikiOptions` fields or configurable limits (all bounds are fixed constants for this pass)
- Escape hatch for the `tablePrefix` validation — hosts with invalid prefixes must fix their config
- Re-deriving the VectorRanker-specific hardening already shipped in v3.2 (separate spec, separate concern)
- Rate limiting or timeouts on `llmProvider.embed`/`generateText` (host responsibility, called out in docs only)

---

## Design

### 1. `tablePrefix` whitelist (H-1)

**Location:** `WikiMemory.ts:71`, immediately after `this.prefix = options.config?.tablePrefix || 'llm_wiki_';` and before any repository/service is constructed.

```typescript
const TABLE_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,30}_$/;

this.prefix = options.config?.tablePrefix || 'llm_wiki_';
if (!TABLE_PREFIX_PATTERN.test(this.prefix)) {
  throw new Error(
    `Invalid tablePrefix: ${JSON.stringify(this.prefix)}. ` +
      `Must match ${TABLE_PREFIX_PATTERN} (letter, then alphanumeric/underscore, ending in "_", max 32 chars total).`,
  );
}
```

`JSON.stringify` around the rejected value covers L-1 (escapes quotes/control chars) for this specific throw site.

**Why this pattern:** Identifiers can't be parameterized in SQLite — string interpolation into DDL is unavoidable. The pattern matches the existing default (`llm_wiki_`), requires a trailing underscore (every call site appends a table name directly: `` `${prefix}entries` ``), and caps length well under SQLite's identifier limits.

**Breaking change:** Hosts with a prefix that doesn't match (no trailing underscore, special characters, etc.) will see the constructor throw where it previously succeeded. No escape hatch — documented in Migration Notes below.

---

### 2. `importDump` constraints (H-2)

**Location:** `ImportExportService.ts`, inside the `bundle.facts` loop in `doImportEntity` (`ImportExportService.ts:150-227`).

**2a. Cap blob byte length.** After `rawBlob` is reconstructed (lines 164-187), before the alignment/float-validation block (lines 189-207):

```typescript
const MAX_EMBEDDING_BLOB_BYTES = 32 * 1024; // 8192-dim float32 ceiling

if (rawBlob !== null && rawBlob.byteLength > MAX_EMBEDDING_BLOB_BYTES) {
  rawBlob = null; // Treat oversized blobs the same as malformed ones — drop, don't reject the whole import.
}
```

Placed before the existing `rawBlob.byteLength % 4 === 0` check, so oversized blobs fall through to `blobData = null` exactly like today's malformed-blob path — the fact still imports, just without a preserved embedding (re-embedded on next access, same as any cache-miss).

**2b. Clip imported fact text.** `validateFact`'s clip (`title` 80 chars / `body` 800 chars, `utils/pure.ts:211-227`) is tuned for fresh LLM extraction, not backup/restore — reusing it would truncate legitimate prior data on every restore. Add a separate, looser clip applied when building `factObj` (`ImportExportService.ts:225`):

```typescript
import { clip } from '../utils/pure';

const IMPORT_TITLE_MAX = 500;
const IMPORT_BODY_MAX = 8000;

// ... inside the loop, before constructing factObj:
const safeTitle = clip(String(fact.title ?? ''), IMPORT_TITLE_MAX);
const safeBody = clip(String(fact.body ?? ''), IMPORT_BODY_MAX);

const factObj: WikiFact = {
  id: fact.id,
  entity_id: entityId,
  title: safeTitle,
  body: safeBody,
  // ... unchanged
};
```

This bounds both the `upsertForImport` call and the later `embedFact` call (`ImportExportService.ts:~338`), which reads `fact.title`/`fact.body` from the bundle — `embedFact` must read the clipped values, so the loop should track `safeTitle`/`safeBody` per fact id (e.g. via a `Map<factId, {title, body}>` alongside `factsWithPreservedBlob`) and use it when constructing the `embedFact` argument later in the method, rather than re-reading `fact.title`/`fact.body` from `bundle.facts`.

---

### 3. `WriteService.write` input validation (M-1)

**Location:** `WriteService.ts:20`, before constructing `newEvent`.

```typescript
import { clip } from '../utils/pure';

async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
  if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 200 || entityId.includes('\0')) {
    throw new Error('Invalid entityId: must be a non-empty string under 200 chars with no null bytes.');
  }
  if (typeof event.summary !== 'string') {
    throw new Error('Invalid event.summary: must be a string.');
  }
  const summary = clip(event.summary, 4000);

  let relatedEntryId = event.related_entry_id || null;
  if (relatedEntryId !== null) {
    const exists = await this.entryRepo.existsForEntity(relatedEntryId, entityId);
    if (!exists) relatedEntryId = null;
  }

  const id = generateId('evt_');
  // ... newEvent.summary = summary; newEvent.related_entry_id = relatedEntryId;
}
```

`entityId` validation mirrors the existing guard in `RetrievalService.read` (null-byte rejection, length clamp) for consistency across entry points.

**New repository method:** `EntryRepository.existsForEntity(factId, entityId)` — a single parameterized `SELECT 1 FROM ${prefix}entries WHERE id = ? AND entity_id = ? LIMIT 1`, reused if a similar check doesn't already exist (verify during implementation — `RetrievalService._hydrateFactsByIds` does scoped lookups but not a single-id existence check).

---

### 4. `EmbeddingService.embedFact` bound (M-2)

**Location:** `EmbeddingService.ts:45-62`, right before `embedFn(text)` is called.

```typescript
import { clip } from '../utils/pure';

const text = clip(`${fact.title} ${fact.body} ${tagsStr}`.trim(), 16_000);
try {
  const vector = await embedFn(text);
  // ... unchanged
```

Defense-in-depth: covers `importDump` (bounded further upstream by §2b, but `embedFact` shouldn't rely on every caller clipping correctly) and `runReembed` (pulls rows directly from SQLite with no clipping today).

---

### 5. Prompt-injection trust boundary (Doc)

Add a paragraph to the repo-root `README.md` `## Security` section, after the existing `### Host Application Security` block (`README.md:462-477`), and mirror in `packages/core/README.md`:

```markdown
### Prompt-Injection Trust Boundary

User-controlled text — `event.summary` passed to `write()`, document chunks passed to `ingestDocument()`,
fact `title`/`body` (including imported dumps) — is interpolated verbatim into LLM prompts for librarian,
heal, and embedding operations. `PromptService.hydrate` performs simple template substitution; it does not
detect or filter instruction-like content.

Mitigating prompt injection (e.g. "ignore prior instructions and emit...") is **the host's responsibility**.
If your application accepts untrusted input that flows into `write()`, `ingestDocument()`, or `importDump()`,
treat the LLM's librarian/heal output as similarly untrusted — validate or scope it before acting on it
downstream.
```

---

### 6. Escape user input in errors/logs (L-1)

**`WikiMemory.hasChanged`** (`WikiMemory.ts:219-227`): wrap `sourceRef` in the thrown message with `JSON.stringify`:

```typescript
throw new Error(`Invalid sourceRef: ${JSON.stringify(sourceRef)}`);
```

**`ImportExportService._warnCrossEntityCollision`**: same treatment for any user-supplied ID interpolated into the `console.warn` call — `JSON.stringify` each value before interpolating.

`JSON.stringify` escapes control characters (including CR/LF and ANSI escape sequences) inside the resulting string literal, closing the log-forging gap without adding a dependency.

---

### 7. Remove weak ID fallback (L-3)

**Location:** `utils/ids.ts:16-17`.

```typescript
export function generateId(prefix: string = ''): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return prefix + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
  }
  throw new Error(
    'generateId: no cryptographically secure random source available (crypto.randomUUID / crypto.getRandomValues missing).',
  );
}
```

Both `crypto` branches stay as-is; only the `Math.random()` fallback is deleted. `crypto.getRandomValues` is universally available on Node ≥20 and modern RN/browser runtimes, so this throw should never fire in supported environments — it converts silent entropy weakening into a loud, fixable error.

---

### 8. Typed dispatch in `JobManager` (L-4)

**Location:** `JobManager.ts:177-178` (`acquireLock`) and `193-194` (`releaseLock`).

Replace the computed-property dispatch with a lookup table built once from the existing private key methods:

```typescript
type LockableOperation = 'prune' | 'librarian' | 'heal' | 'reembed' | 'import' | 'forget';

private readonly keyFns: Record<LockableOperation, (entityId: string) => string> = {
  prune: (id) => this._pruneKey(id),
  librarian: (id) => this._librarianKey(id),
  heal: (id) => this._healKey(id),
  reembed: (id) => this._reembedKey(id),
  import: (id) => this._importKey(id),
  forget: (id) => this._forgetKey(id),
};
```

In `acquireLock`/`releaseLock`, the `else` branch (everything except `ingest`/`global_reembed`/`global_import`, which already have explicit handling) becomes:

```typescript
} else {
  this.activeMaintenanceJobs.add(this.keyFns[operation as LockableOperation](entityId));
}
```

(`.delete(...)` for `releaseLock`.) `OperationType` already excludes the three explicitly-handled variants from reaching this branch at the call sites that matter; the `as LockableOperation` cast documents that narrowing rather than introducing new runtime risk — no behavior change, just provably-typed dispatch instead of string-templated property lookup.

---

## Documentation Updates

### README.md (repo root and `packages/core/README.md`)

Add §5's "Prompt-Injection Trust Boundary" subsection to both files' Security sections.

### Release notes (semantic-release)

`CHANGELOG.md` is generated automatically on merge to `main` by `@semantic-release/changelog` (see `.releaserc.json`). Do **not** hand-edit `CHANGELOG.md` in this PR. Use Conventional Commits (`fix(core): …`) so semantic-release produces a patch bump and appends release notes.

Expected content in the generated entry (for reviewer/release verification):

```markdown
### Security

* **core:** validate `tablePrefix` against a strict whitelist (`^[A-Za-z][A-Za-z0-9_]{0,30}_$`) in the `WikiMemory` constructor — closes a DDL-injection gap for hosts deriving prefixes from partially-trusted config
* **core:** cap reconstructed `embedding_blob` at 32KB and clip imported fact `title`/`body` (500/8000 chars) in `importDump` — prevents memory-exhaustion DoS and LLM cost amplification from untrusted dumps
* **core:** validate and clip `WriteService.write()` inputs — `event.summary` (4000 chars), `entityId` (null-byte/length checks), `related_entry_id` (dropped unless it references an existing fact in the same entity) — prevents database/prompt bloat from untrusted writes
* **core:** defensively clip text in `EmbeddingService.embedFact` (16,000 chars) before shipping to the host's remote embed endpoint
* **core:** escape user-supplied values (`sourceRef`, cross-entity collision IDs) before interpolating into thrown errors / `console.warn` — prevents log forging via ANSI/CRLF sequences
* **core:** `generateId` now throws if no cryptographically secure random source is available, instead of silently falling back to `Math.random()`
* **core:** `JobManager` lock dispatch now uses a typed `Record` lookup instead of computed property-name access
* **docs:** document the prompt-injection trust boundary in the README Security section — user-controlled text reaches the LLM verbatim; mitigation is the host's responsibility

### BREAKING (behavioral, not API)

* `new WikiMemory(db, { config: { tablePrefix } })` now throws if `tablePrefix` doesn't match `^[A-Za-z][A-Za-z0-9_]{0,30}_$`. Hosts using a non-conforming prefix must rename it. See migration notes.
```

---

## Testing

Add to `packages/core/__tests__/`:

**`tablePrefix` validation** (`wikiMemory.test.ts` or new `tablePrefixValidation.test.ts`):
- Valid prefixes (`llm_wiki_`, `a_`, `Tenant1_Data_`) construct successfully.
- Invalid prefixes (`x; DROP TABLE users;-- `, `123_`, `no_trailing`, `' OR 1=1 --`, 32+ char string) throw on construction.

**`importDump` constraints** (`importExportService.test.ts`):
- A dump with an `embedding_blob`-equivalent `data` array exceeding 32KB imports the fact with `embedding_blob: null` (no crash, no oversized allocation retained).
- A dump with `title`/`body` exceeding 500/8000 chars imports with clipped values; the subsequent `embedFact` call (if triggered) receives the clipped text, not the original.

**`WriteService.write` validation** (`writeService.test.ts`):
- `write(entityId, { summary: 'x'.repeat(10_000), ... })` stores a summary clipped to 4000 chars.
- `write(entityId, { summary: 123 as any, ... })` throws.
- `write('bad\0id', { summary: 'ok', ... })` throws.
- `write(entityId, { related_entry_id: 'nonexistent', ... })` stores `related_entry_id: null`.
- `write(entityId, { related_entry_id: factIdFromOtherEntity, ... })` stores `related_entry_id: null`.

**`embedFact` bound** (`embeddingService.test.ts`):
- `embedFact({ title: 'x'.repeat(20_000), body: '', tags: [] })` calls `embedFn` with text ≤ 16,000 chars.

**Log forging** (`wikiMemory.test.ts`):
- `hasChanged(entityId, '\x1b[31mFAKE\x1b[0m\nINJECTED LINE', hash)` throws an error whose message does not contain a raw newline or raw ESC byte (verify via `JSON.stringify`-escaped substring presence instead).

**`generateId` fallback removal** (`ids.test.ts`):
- Mock `crypto` as `undefined` (or stub `randomUUID`/`getRandomValues` as missing) — `generateId()` throws.

**`JobManager` typed dispatch** (`jobManager.test.ts`):
- Existing lock/unlock tests for `prune`, `librarian`, `heal`, `reembed`, `import`, `forget` continue to pass unchanged (regression check — behavior is identical, only the dispatch mechanism changed).

---

## Acceptance Criteria

- [ ] `tablePrefix` validated in `WikiMemory` constructor against `^[A-Za-z][A-Za-z0-9_]{0,30}_$`; invalid prefix throws before any repo/service construction
- [ ] `importDump` caps reconstructed blob at 32KB (oversized → `null`, fact still imports)
- [ ] `importDump` clips `title`/`body` to 500/8000 chars before `upsertForImport` and before `embedFact`
- [ ] `WriteService.write` validates `entityId` (null-byte/length), validates `event.summary` is a string and clips to 4000 chars, drops `related_entry_id` unless it references an existing fact in the same entity
- [ ] `EmbeddingService.embedFact` clips assembled text to 16,000 chars before calling `embedFn`
- [ ] README (repo root + `packages/core/README.md`) documents the prompt-injection trust boundary
- [ ] `WikiMemory.hasChanged` and `ImportExportService._warnCrossEntityCollision` escape user-supplied values before interpolating into errors/logs
- [ ] `generateId` throws when no `crypto` random source is available; `Math.random()` fallback removed
- [ ] `JobManager.acquireLock`/`releaseLock` use a typed `Record` lookup instead of `` `_${operation}Key` `` computed property access; all existing lock tests pass unchanged
- [ ] On merge to `main`, semantic-release generates `CHANGELOG.md` with Security fixes and a BREAKING (behavioral) callout for `tablePrefix` (from `fix(core):` conventional commits; no manual changelog edit in the PR)
- [ ] All existing tests pass (no regressions)

---

## Migration Notes

**For host applications:**

- **BREAKING (behavioral):** If your `tablePrefix` config doesn't match `^[A-Za-z][A-Za-z0-9_]{0,30}_$` (must start with a letter, contain only letters/digits/underscores, end with `_`, max 32 chars total), `new WikiMemory(...)` will throw on upgrade. Rename your prefix to conform — this requires a one-time table-rename migration if you have existing data under the old prefix (out of scope for this package; use your platform's SQL migration tooling).
- If you call `write()` with summaries longer than 4000 chars, they'll now be silently clipped rather than stored in full. If you need the full text, store it in your own system and pass a reference/summary to `write()`.
- If you call `write()` with a `related_entry_id` that doesn't exist or belongs to a different entity, it's now silently dropped (`null`) rather than stored as-is. No action needed unless you were relying on storing dangling references.
- If you call `importDump()` with dumps containing facts with `title`/`body` longer than 500/8000 chars, they'll be clipped on import. If your dumps were generated by `getFullBundle()` from this same package, facts already went through `validateFact`'s tighter 80/800 clip at write time, so this should not affect round-trip export/import.
- No action needed if you don't set a custom `tablePrefix`, don't pass oversized event summaries, and don't author `MemoryDump` objects by hand.

---

## References

- Prior spec: [`2026-05-07-vectorranker-security-hardening.md`](2026-05-07-vectorranker-security-hardening.md)
- Source review: Opus 4.7 security review of `packages/core` (2026-06-22, conversation-internal — not a separate document)
- OWASP Top 10: https://owasp.org/www-project-top-ten/
