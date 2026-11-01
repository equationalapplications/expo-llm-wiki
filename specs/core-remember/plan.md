# `WikiMemory.remember()` — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tick the matching box in `specs/core-remember/LEDGER.md` only after a task's verification step has passed.

Spec: `specs/core-remember/spec.md`

**Goal:** Add `WikiMemory.remember(entityId, input): Promise<WikiFact>` — store one mutable fact in one transaction, no LLM step, no maintenance side effects, returning the stored row.

**Architecture:** A pure normalizer (`utils/rememberInput.ts`) owns every validation rule and builds the `WikiFact` literal; a small `RememberService` owns the transaction (upsert → optional `valid_from` → read-back), then the same post-commit sequence `supersede()` uses (search sync, embed, cache evict). `WikiMemory` exposes it next to `supersede()`/`history()`. `write()`'s entityId rule moves to a shared helper so both entry points agree.

**Tech Stack:** TypeScript 5.9 strict, vitest, pnpm 10.33.2 workspace (Corepack), better-sqlite3 in tests. Node ≥ 20 (CI 24).

## Global Constraints

- **Branch / PR:** `feat/core-remember`, one draft PR carrying `specs/core-remember/`. Merge commit, never squash. Draft until the final cleanup commit (Task 7).
- **Commands** (run from the repo root; one-time setup `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build` — core's row mapper imports `@equationalapplications/core-okf` from its `dist`):
  - one file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
  - core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
  - types: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - build: `pnpm run build`
  - everything CI runs: `pnpm run build && pnpm run typecheck && pnpm test`
- **Commit types:** `feat(core)`, `test(core)`, `docs(core)`, `docs(spec)`. Never write a `BREAKING CHANGE` footer; nothing here is breaking. Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Never edit** `CHANGELOG.md` or any `"version"` field; semantic-release owns them. Expected release: 7.14.0 (minor, from the `feat(core)` commits).
- **Spec wins.** If this plan and `spec.md` disagree, stop and report; do not pick one. Spec §6 lists owner questions with defaults; implement the defaults unless the spec has been amended.
- **No clipping, no coercion** of host input (spec §3.2). Bad input throws `TypeError` before any write.
- **Do not touch** `TemporalService.ts`, `packages/core-llm-tools`, PR #305's worktree (`.worktrees/feat-mcp-server`), or `CHANGELOG.md`.
- **Baseline before Task 1:** record the core suite's file/test counts and confirm `typecheck` exit 0 on the branch tip; write both into the ledger's "Baseline" line. On 2026-11-01 (`5ecd716`) `__tests__/supersede.test.ts` ran 13/13 green and `typecheck` exited 0 with this setup.

---

### Task 1: `assertEntityId` helper shared by `write()` and `remember()`

**Files:**
- Create: `packages/core/src/utils/entityId.ts`
- Modify: `packages/core/src/services/WriteService.ts:39-43`
- Test: `packages/core/__tests__/entityId.test.ts`

**Interfaces:**
- Produces: `assertEntityId(entityId: unknown): asserts entityId is string` — throws `TypeError` with the exact message `write()` uses today.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/__tests__/entityId.test.ts
import { describe, it, expect } from 'vitest';
import { assertEntityId } from '../src/utils/entityId';

describe('assertEntityId', () => {
  it('accepts a non-empty string up to 200 chars with no null bytes', () => {
    expect(() => assertEntityId('e1')).not.toThrow();
    expect(() => assertEntityId('x'.repeat(200))).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(201)],
    ['null byte', 'a\0b'],
    ['not a string', 42 as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('rejects %s with the write() message', (_label, value) => {
    expect(() => assertEntityId(value)).toThrow(TypeError);
    expect(() => assertEntityId(value)).toThrow(
      `Invalid entityId: must be a non-empty string at most 200 chars with no null bytes; got ${JSON.stringify(value)}.`,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/entityId.test.ts`
Expected: FAIL — cannot resolve `../src/utils/entityId`.

- [ ] **Step 3: Write the helper**

```ts
// packages/core/src/utils/entityId.ts
/**
 * The entity id rule shared by write() and remember(): a non-empty string,
 * at most 200 chars, no null bytes. Message is byte-for-byte what write()
 * threw before the helper existed (hosts match on it).
 */
export function assertEntityId(entityId: unknown): asserts entityId is string {
  if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 200 || entityId.includes('\0')) {
    throw new TypeError(
      `Invalid entityId: must be a non-empty string at most 200 chars with no null bytes; got ${JSON.stringify(entityId)}.`,
    );
  }
}
```

- [ ] **Step 4: Make `write()` call it**

In `packages/core/src/services/WriteService.ts`, add the import next to the other `../utils/*` imports:

```ts
import { assertEntityId } from '../utils/entityId';
```

and replace lines 39-43 (the `if (typeof entityId !== 'string' || …) { throw new TypeError(…) }` block at the top of `write()`) with:

```ts
    assertEntityId(entityId);
```

- [ ] **Step 5: Run the new test, the write tests and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/entityId.test.ts __tests__/write.test.ts __tests__/deferredWrite.test.ts && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: all PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/utils/entityId.ts packages/core/src/services/WriteService.ts packages/core/__tests__/entityId.test.ts
git commit -m "refactor(core): share the entityId rule between write() and remember()

Spec: specs/core-remember/spec.md §3.2, §3.9.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `RememberInput` type and the pure normalizer

**Files:**
- Modify: `packages/core/src/types.ts` (next to `SupersedeReplacement`, ~L1368; and `WikiDiagnosticOperation`, ~L834)
- Create: `packages/core/src/utils/rememberInput.ts`
- Test: `packages/core/__tests__/rememberInput.test.ts`

**Interfaces:**
- Consumes: `assertEntityId` (Task 1), `generateId` (`utils/ids.ts`), `assertEpochMs` (`utils/temporal.ts`).
- Produces:
  - `export interface RememberInput { title: string; body: string; tags?: string[]; confidence?: WikiFact['confidence']; source_type?: 'user_stated' | 'user_confirmed'; okf_type?: string | null; valid_from?: number }`
  - `WikiDiagnosticOperation` gains `'remember'`.
  - `export interface NormalizedRememberInput { fact: WikiFact; validFrom?: number; okfType: string | null }`
  - `export function normalizeRememberInput(entityId: string, input: RememberInput, now: number): NormalizedRememberInput` — throws `TypeError` on every spec §3.2 rule; `fact.okf_type` is `null` here (Task 3 resolves `okfType`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/__tests__/rememberInput.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeRememberInput } from '../src/utils/rememberInput';
import type { RememberInput } from '../src/types';

const NOW = 1_700_000_000_000;

describe('normalizeRememberInput', () => {
  it('applies the defaults from spec §3.1 and builds the fact literal', () => {
    const { fact, validFrom, okfType } = normalizeRememberInput('e1', { title: 'T', body: 'B' }, NOW);
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(fact).toMatchObject({
      entity_id: 'e1', title: 'T', body: 'B', tags: [], confidence: 'certain', source_type: 'user_stated',
      source_hash: null, source_ref: null, created_at: NOW, updated_at: NOW,
      last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: null,
    });
    expect(validFrom).toBeUndefined();
    expect(okfType).toBeNull();
  });

  it('stores title, body and tags verbatim and truncates valid_from', () => {
    const { fact, validFrom, okfType } = normalizeRememberInput('e1', {
      title: '  Untrimmed ', body: '', tags: ['Git', ' Mixed Case '], confidence: 'tentative',
      source_type: 'user_confirmed', okf_type: 'Person', valid_from: 5000.9,
    }, NOW);
    expect(fact.title).toBe('  Untrimmed ');
    expect(fact.body).toBe('');
    expect(fact.tags).toEqual(['Git', ' Mixed Case ']);
    expect(fact.confidence).toBe('tentative');
    expect(fact.source_type).toBe('user_confirmed');
    expect(validFrom).toBe(5000);
    expect(okfType).toBe('Person');
  });

  it('does not alias the caller’s tags array', () => {
    const tags = ['a'];
    const { fact } = normalizeRememberInput('e1', { title: 'T', body: 'B', tags }, NOW);
    tags.push('b');
    expect(fact.tags).toEqual(['a']);
  });

  it.each<[string, unknown, unknown]>([
    ['empty entityId', '', { title: 'T', body: 'B' }],
    ['entityId > 200 chars', 'x'.repeat(201), { title: 'T', body: 'B' }],
    ['entityId with null byte', 'a\0b', { title: 'T', body: 'B' }],
    ['non-string entityId', 7, { title: 'T', body: 'B' }],
    ['null input', 'e1', null],
    ['array input', 'e1', []],
    ['missing title', 'e1', { body: 'B' }],
    ['whitespace title', 'e1', { title: '   ', body: 'B' }],
    ['non-string title', 'e1', { title: 1, body: 'B' }],
    ['missing body', 'e1', { title: 'T' }],
    ['non-string body', 'e1', { title: 'T', body: null }],
    ['non-array tags', 'e1', { title: 'T', body: 'B', tags: 'git' }],
    ['non-string tag element', 'e1', { title: 'T', body: 'B', tags: ['ok', 2] }],
    ['unknown confidence', 'e1', { title: 'T', body: 'B', confidence: 'sure' }],
    ['source_type immutable_document', 'e1', { title: 'T', body: 'B', source_type: 'immutable_document' }],
    ['source_type librarian_inferred', 'e1', { title: 'T', body: 'B', source_type: 'librarian_inferred' }],
    ['garbage source_type', 'e1', { title: 'T', body: 'B', source_type: 'oracle' }],
    ['non-string okf_type', 'e1', { title: 'T', body: 'B', okf_type: 3 }],
    ['negative valid_from', 'e1', { title: 'T', body: 'B', valid_from: -1 }],
    ['NaN valid_from', 'e1', { title: 'T', body: 'B', valid_from: Number.NaN }],
    ['string valid_from', 'e1', { title: 'T', body: 'B', valid_from: '2026-01-01' }],
  ])('rejects %s with TypeError', (_label, entityId, input) => {
    expect(() => normalizeRememberInput(entityId as string, input as RememberInput, NOW)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/rememberInput.test.ts`
Expected: FAIL — cannot resolve `../src/utils/rememberInput`.

- [ ] **Step 3: Add the types**

In `packages/core/src/types.ts`, directly after the `SupersedeReplacement` type (ends ~L1377), add:

```ts
/**
 * Input to `WikiMemory.remember()` (spec `specs/core-remember/spec.md` §3.1).
 * Only mutable, host-stated facts: `immutable_document` is reserved for
 * `ingestDocument()`, `librarian_inferred` for the librarian.
 */
export interface RememberInput {
  /** Required; must be non-empty after trim. Stored verbatim. */
  title: string;
  /** Required; any string, '' allowed. Stored verbatim. */
  body: string;
  /** Default []. Stored verbatim: no trim, no lowercasing, no cap. */
  tags?: string[];
  /** Default 'certain'. */
  confidence?: WikiFact['confidence'];
  /** Default 'user_stated'. */
  source_type?: 'user_stated' | 'user_confirmed';
  /** Resolved against the entity's ontology manifest like an `upsertGraph` node type (spec §3.4). Default null. */
  okf_type?: string | null;
  /** Epoch ms the fact became true. Absent ⇒ since `created_at`. */
  valid_from?: number;
}
```

In the same file, change `WikiDiagnosticOperation` (~L834-835) to:

```ts
export type WikiDiagnosticOperation =
  | 'ingest' | 'upsertGraph' | 'librarian' | 'heal' | 'ontologyBackfill' | 'reembed' | 'importDump' | 'write' | 'supersede' | 'remember' | 'read' | 'prune';
```

- [ ] **Step 4: Write the normalizer**

```ts
// packages/core/src/utils/rememberInput.ts
import type { RememberInput, WikiFact } from '../types';
import { assertEntityId } from './entityId';
import { generateId } from './ids';
import { assertEpochMs } from './temporal';

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(['certain', 'inferred', 'tentative']);
const SOURCE_TYPE_VALUES: ReadonlySet<string> = new Set(['user_stated', 'user_confirmed']);

export interface NormalizedRememberInput {
  /** The row to upsert. `okf_type` is null here; RememberService resolves `okfType` against the manifest. */
  fact: WikiFact;
  /** Truncated epoch ms, or undefined when the caller gave none. */
  validFrom?: number;
  /** The caller's raw type slug, or null. */
  okfType: string | null;
}

/**
 * Every validation rule of remember() (spec §3.2), with no I/O. Throws
 * TypeError; never clips or coerces. `now` is injected so tests are stable.
 */
export function normalizeRememberInput(entityId: string, input: RememberInput, now: number): NormalizedRememberInput {
  assertEntityId(entityId);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('remember(): input must be a non-null object.');
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new TypeError('remember(): input.title must be a non-empty string.');
  }
  if (typeof input.body !== 'string') {
    throw new TypeError('remember(): input.body must be a string.');
  }
  let tags: string[] = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || !input.tags.every((t) => typeof t === 'string')) {
      throw new TypeError('remember(): input.tags must be an array of strings.');
    }
    tags = [...input.tags];
  }
  const confidence = input.confidence ?? 'certain';
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new TypeError(`remember(): input.confidence must be certain | inferred | tentative; got ${JSON.stringify(input.confidence)}.`);
  }
  const sourceType = input.source_type ?? 'user_stated';
  if (!SOURCE_TYPE_VALUES.has(sourceType)) {
    throw new TypeError(`remember(): input.source_type must be user_stated | user_confirmed; got ${JSON.stringify(input.source_type)}.`);
  }
  let okfType: string | null = null;
  if (input.okf_type !== undefined && input.okf_type !== null) {
    if (typeof input.okf_type !== 'string') {
      throw new TypeError('remember(): input.okf_type must be a string or null.');
    }
    okfType = input.okf_type;
  }
  const validFrom = input.valid_from === undefined ? undefined : assertEpochMs('input.valid_from', input.valid_from);

  const fact: WikiFact = {
    id: generateId('fact_'),
    entity_id: entityId,
    title: input.title,
    body: input.body,
    tags,
    confidence,
    source_type: sourceType,
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    okf_type: null,
  };
  return { fact, validFrom, okfType };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/rememberInput.test.ts && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: all PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/utils/rememberInput.ts packages/core/__tests__/rememberInput.test.ts
git commit -m "feat(core): RememberInput type and remember() input normalizer

Spec: specs/core-remember/spec.md §3.1, §3.2.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `RememberService` and `WikiMemory.remember()` — storage, read-back, `valid_from`, `okf_type`

**Files:**
- Create: `packages/core/src/services/RememberService.ts`
- Modify: `packages/core/src/WikiMemory.ts` (imports; `WikiMemoryTestAccess` L68-82; private field near L125; construction after L159; `__testAccess` return ~L256-270; public method after `history()` ~L874)
- Test: `packages/core/__tests__/remember.test.ts`

**Interfaces:**
- Consumes: `normalizeRememberInput` (Task 2); `EntryRepository.upsert(fact, tx)`, `.setTemporal(id, entityId, fields, tx)`, `.findByIds(ids, scopedEntityIds, tx)`; `OntologyService.getEffectiveState(entityId, tx)` and `.validateAndNormalizeFact(factLike, manifest, { strict, entityId })`; `SearchService.syncEntries(entityId, ids)` / `.evictCache(entityId)`; `EmbeddingService.embedFact(fact, ctx)`.
- Produces: `WikiMemory.remember(entityId: string, input: RememberInput): Promise<WikiFact>`; `WikiMemoryTestAccess.rememberService`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/__tests__/remember.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiStrictOntologyViolation } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;

const row = (id: string) => db.getFirstAsync<any>(`SELECT * FROM llm_wiki_entries WHERE id = ?`, [id]);
const count = async () => (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_entries`))!.n;
const manifest: OntologyManifest = {
  node_types: [{ type: 'Person', description: 'a person' }],
  edge_types: [],
};

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
});

describe('remember(): storage', () => {
  it('stores a user_stated fact with defaults and returns the stored row', async () => {
    const before = Date.now();
    const fact = await wiki.remember('e1', { title: 'Prefers merge commits', body: 'Never squash.' });
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(fact).toMatchObject({
      entity_id: 'e1', title: 'Prefers merge commits', body: 'Never squash.', tags: [],
      confidence: 'certain', source_type: 'user_stated', source_ref: null, source_hash: null,
      access_count: 0, deleted_at: null, okf_type: null, lifecycle_status: 'stable',
      trustTier: 'unverified', isStale: false,
    });
    expect(fact.created_at).toBeGreaterThanOrEqual(before);
    expect(fact.updated_at).toBe(fact.created_at);
    expect(fact).not.toHaveProperty('valid_from');
    const stored = await row(fact.id);
    expect(stored).toMatchObject({ entity_id: 'e1', title: 'Prefers merge commits', source_type: 'user_stated', confidence: 'certain' });
    expect(stored.valid_from).toBeNull();
    const [readBack] = await wiki.__testAccess.entryRepo.findByIds([fact.id], ['e1']);
    expect(fact).toEqual(readBack);
  });

  it('stores tags, confidence, source_type and valid_from as given', async () => {
    const fact = await wiki.remember('e1', {
      title: 'Lives in SF', body: 'Moved in March.', tags: ['Place', 'home'],
      confidence: 'inferred', source_type: 'user_confirmed', valid_from: 5_000,
    });
    expect(fact).toMatchObject({ tags: ['Place', 'home'], confidence: 'inferred', source_type: 'user_confirmed', valid_from: 5_000 });
    expect((await row(fact.id)).valid_from).toBe(5_000);
  });

  it('writes nothing when validation rejects', async () => {
    const before = await count();
    await expect(wiki.remember('e1', { title: '', body: 'B' })).rejects.toThrow(TypeError);
    await expect(wiki.remember('', { title: 'T', body: 'B' })).rejects.toThrow(TypeError);
    await expect(wiki.remember('e1', { title: 'T', body: 'B', source_type: 'immutable_document' as any })).rejects.toThrow(TypeError);
    expect(await count()).toBe(before);
  });

  it('stores two facts for two identical calls (not idempotent; spec §3.7)', async () => {
    const a = await wiki.remember('e1', { title: 'T', body: 'B' });
    const b = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect(a.id).not.toBe(b.id);
    expect(await count()).toBe(2);
  });
});

describe('remember(): okf_type (spec §3.4)', () => {
  it('stores null and never reads the manifest when okf_type is absent', async () => {
    const spy = vi.spyOn(wiki.__testAccess.metadataRepo, 'getManifest');
    const fact = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect(fact.okf_type).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('stores the canonical slug when the type is in the manifest (emergent)', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    const fact = await wiki.remember('e1', { title: 'Kurt', body: 'Owner.', okf_type: 'person' });
    expect(fact.okf_type).toBe('Person');
  });

  it('throws WikiStrictOntologyViolation and writes nothing for an unknown type under strict', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'strict' });
    const before = await count();
    await expect(wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'Spaceship' })).rejects.toBeInstanceOf(WikiStrictOntologyViolation);
    expect(await count()).toBe(before);
  });

  it('stores null for an unknown type under emergent, and for an entity with no manifest', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    expect((await wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'Spaceship' })).okf_type).toBeNull();
    expect((await wiki.remember('e2', { title: 'T', body: 'B', okf_type: 'Person' })).okf_type).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/remember.test.ts`
Expected: FAIL — `wiki.remember is not a function`.

- [ ] **Step 3: Write the service**

```ts
// packages/core/src/services/RememberService.ts
import type { SQLiteAdapter, WikiFact, RememberInput, ExtractedFactWithOntology } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { OntologyService } from './OntologyService';
import type { SearchService } from './SearchService';
import type { EmbeddingService } from './EmbeddingService';
import { normalizeRememberInput } from '../utils/rememberInput';

/** Direct mutable-fact writes (spec `specs/core-remember/spec.md` §3.3–§3.6). */
export class RememberService {
  constructor(
    private db: SQLiteAdapter,
    private entryRepo: EntryRepository,
    private ontologyService: OntologyService,
    private searchService: SearchService,
    private embeddingService: EmbeddingService,
  ) {}

  async remember(entityId: string, input: RememberInput): Promise<WikiFact> {
    const now = Date.now();
    const { fact, validFrom, okfType } = normalizeRememberInput(entityId, input, now);
    let stored: WikiFact | undefined;

    await this.db.withTransactionAsync(async (tx) => {
      if (okfType !== null) {
        // Same rule as an upsertGraph node type (IngestionService.upsertGraphCore):
        // canonical slug when the manifest knows it, a throw under strict, null otherwise.
        const { mode, manifest } = await this.ontologyService.getEffectiveState(entityId, tx);
        const factLike = { okf_type: okfType, edges: [] } as unknown as ExtractedFactWithOntology;
        fact.okf_type = this.ontologyService.validateAndNormalizeFact(factLike, manifest, {
          strict: mode === 'strict',
          entityId,
        }).okf_type;
      }
      await this.entryRepo.upsert(fact, tx);
      if (validFrom !== undefined) {
        await this.entryRepo.setTemporal(fact.id, entityId, { valid_from: validFrom }, tx);
      }
      // The return value is the stored row, not the literal: defaults the INSERT
      // bound and the read-time isStale / trustTier come from the mapper.
      const [readBack] = await this.entryRepo.findByIds([fact.id], [entityId], tx);
      if (!readBack) {
        throw new Error('remember(): the stored fact could not be read back; the SQLiteAdapter did not perform the write');
      }
      stored = readBack;
    });

    await this.searchService.syncEntries(entityId, [fact.id]);
    await this.embeddingService.embedFact(
      { id: fact.id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags },
      { operation: 'remember', trigger: 'call' },
    );
    this.searchService.evictCache(entityId);
    return stored!;
  }
}
```

- [ ] **Step 4: Wire it into `WikiMemory`**

In `packages/core/src/WikiMemory.ts`:

1. Add the import next to `TemporalService`'s:
   ```ts
   import { RememberService } from './services/RememberService';
   ```
   and add `RememberInput` to the `import type { … } from './types'` list.
2. In `WikiMemoryTestAccess` (L68-82) add, after `temporalService: TemporalService;`:
   ```ts
     rememberService: RememberService;
   ```
3. Add the private field after `private temporalService: TemporalService;` (~L125):
   ```ts
     private rememberService: RememberService;
   ```
4. Construct it directly after the `this.temporalService = new TemporalService(…)` line (~L159):
   ```ts
       this.rememberService = new RememberService(this.db, this.entryRepo, this.ontologyService, this.searchService, this.embeddingService);
   ```
   (`this.ontologyService`, `this.searchService` and `this.embeddingService` are all assigned above that line — L148, L155, L154.)
5. In the `__testAccess` getter's returned object, after `temporalService: this.temporalService,`:
   ```ts
         rememberService: this.rememberService,
   ```
6. Add the public method directly after `history()` (~L872-874):
   ```ts
     /**
      * Store one mutable fact directly, with no LLM step (spec
      * `specs/core-remember/spec.md`). One transaction; resolves with the stored
      * row read back (`id`, timestamps, defaults, `isStale`, `trustTier`). Never
      * starts the librarian or heal and writes no event, in `'auto'` and
      * `'deferred'` mode alike. Embeds through `llmProvider.embed` when present;
      * keyword-only otherwise. Not idempotent. To replace an existing fact use
      * `supersede()` so history is kept. Opens its own transaction: do not call
      * it inside `withTransactionAsync` (the serialized adapter would deadlock).
      *
      * Throws `TypeError` on invalid input and `WikiStrictOntologyViolation` for
      * an `okf_type` the entity's strict manifest does not define; nothing is
      * written in either case.
      */
     async remember(entityId: string, input: RememberInput): Promise<WikiFact> {
       return this.rememberService.remember(entityId, input);
     }
   ```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/remember.test.ts && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: all PASS; typecheck exit 0. If the "stores null … no manifest" case fails because `setOntologyManifest` persists per entity and `e2` inherits a global `config.ontology.mode`, the test is wrong, not the code: the wiki in this file has no `config.ontology`, so `e2` resolves to `{ mode: 'off', manifest: empty }`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/RememberService.ts packages/core/src/WikiMemory.ts packages/core/__tests__/remember.test.ts
git commit -m "feat(core): remember() — store a fact directly without an LLM step

One transaction: upsert, optional valid_from, read-back. okf_type follows
the upsertGraph node rule. Spec: specs/core-remember/spec.md §3.1-§3.4, §3.8.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Behaviour guarantees — no maintenance, searchable, embedding, outbox, temporal interplay

No production code is expected to change in this task. Each test pins a spec promise; a red test here is a spec-vs-code disagreement — fix the code only if the spec is unambiguous, otherwise stop and report.

**Files:**
- Modify: `packages/core/__tests__/remember.test.ts` (append)

**Interfaces:**
- Consumes: `WikiMemory.remember` (Task 3); `drain()`, `getPendingMaintenance()`, `read()`, `supersede()`, `history()`, `forget()`, `getUnprocessedOutboxEvents()`; `WikiOptions.onDiagnostic`.

- [ ] **Step 1: Append the tests**

```ts
// append to packages/core/__tests__/remember.test.ts
import type { WikiDiagnostic } from '../src/types';

describe('remember(): no maintenance side effects (spec §3.6)', () => {
  it.each([['auto'], ['deferred']] as const)('%s mode: no events, no librarian, no heal, nothing pending', async (maintenance) => {
    const generateText = vi.fn(async () => '{}');
    const local = new WikiMemory(openTestDatabase(), {
      llmProvider: { generateText },
      config: { maintenance, autoLibrarianThreshold: 1, autoHealThreshold: 1 },
    });
    await local.setup();
    for (let i = 0; i < 3; i++) await local.remember('e1', { title: `T${i}`, body: 'B' });
    await local.drain();
    expect(generateText).not.toHaveBeenCalled();
    expect(await local.getPendingMaintenance(['e1'])).toEqual([]);
    const events = await (local as any).eventRepo.getRecent('e1');
    expect(events).toHaveLength(0);
  });
});

describe('remember(): retrieval (spec §3.3 step 5, §3.5)', () => {
  it('is keyword-searchable as soon as remember() resolves, with no embed configured', async () => {
    const fact = await wiki.remember('e1', { title: 'Pet', body: 'The zebraphant sleeps upstairs.' });
    const bundle = await wiki.read('e1', 'zebraphant');
    expect(bundle.facts.map((f) => f.id)).toContain(fact.id);
  });

  it('honours valid_from on asOf reads', async () => {
    const fact = await wiki.remember('e1', { title: 'Pet', body: 'The zebraphant sleeps upstairs.', valid_from: 5_000 });
    expect((await wiki.read('e1', 'zebraphant', { asOf: 4_999 })).facts.map((f) => f.id)).not.toContain(fact.id);
    expect((await wiki.read('e1', 'zebraphant', { asOf: 5_000 })).facts.map((f) => f.id)).toContain(fact.id);
  });

  it('embeds once through llmProvider.embed when it exists', async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const local = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}', embed } });
    await local.setup();
    const fact = await local.remember('e1', { title: 'Alpha', body: 'Beta gamma.' });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toContain('Alpha');
    expect(embed.mock.calls[0][0]).toContain('Beta gamma.');
    const stored = await (local as any).db.getFirstAsync(`SELECT embedding_blob FROM llm_wiki_entries WHERE id = ?`, [fact.id]);
    expect(stored.embedding_blob).not.toBeNull();
  });

  it('reports an embed failure as embedding_failed with operation remember and still resolves', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const local = new WikiMemory(openTestDatabase(), {
      llmProvider: { generateText: async () => '{}', embed: async () => { throw new Error('down'); } },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    await local.setup();
    const fact = await local.remember('e1', { title: 'T', body: 'B' });
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'embedding_failed', operation: 'remember', trigger: 'call', entityId: 'e1',
      detail: expect.objectContaining({ factId: fact.id, reason: 'embed_threw' }),
    }));
  });

  it('leaves no failure marker when there is no embed function', async () => {
    const fact = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect((await row(fact.id)).embedding_failed_at).toBeNull();
  });
});

describe('remember(): plays with the rest of the fact API', () => {
  it('can be superseded, shows in history, and can be forgotten', async () => {
    const fact = await wiki.remember('e1', { title: 'Lives in Seattle', body: 'Since 2020.' });
    expect((await wiki.history('e1', fact.id)).map((f) => f.id)).toEqual([fact.id]);
    const { newId } = await wiki.supersede('e1', fact.id, { title: 'Lives in SF', body: 'Moved.' });
    expect((await wiki.history('e1', fact.id)).map((f) => f.id)).toEqual([fact.id, newId]);
    const result = await wiki.forget('e1', { entryId: newId });
    expect(result.deleted.entries).toBe(1);
  });

  it('stages one INSERT outbox row, plus one UPDATE when valid_from is set', async () => {
    const local = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } });
    await local.setup();
    const plain = await local.remember('e1', { title: 'T', body: 'B' });
    const dated = await local.remember('e1', { title: 'T', body: 'B', valid_from: 5_000 });
    const events = await local.getUnprocessedOutboxEvents();
    expect(events.filter((e) => e.record_id === plain.id).map((e) => e.operation)).toEqual(['INSERT']);
    expect(events.filter((e) => e.record_id === dated.id).map((e) => e.operation)).toEqual(['INSERT', 'UPDATE']);
  });
});
```

Move the `import type { WikiDiagnostic }` line up to the file's import block (vitest's ESM transform tolerates a mid-file `import type`, but keep imports together).

- [ ] **Step 2: Run the file**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/remember.test.ts`
Expected: all PASS. If the keyword-search cases fail with the in-memory adapter, check how `__tests__/incrementalSearchIndex.test.ts` reads after a write and mirror its setup; do not weaken the assertion.

- [ ] **Step 3: Run the core suite and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: no failures; file/test counts ≥ baseline + 4 files (`entityId`, `rememberInput`, `remember`, and the existing ones). Record the counts in the ledger.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/remember.test.ts
git commit -m "test(core): pin remember() guarantees — no maintenance, search, embed, outbox, temporal

Spec: specs/core-remember/spec.md §3.3, §3.5, §3.6, §5.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Docs and the published surface

**Files:**
- Modify: `packages/core/README.md` (insert before "## Temporal facts" at L70; bullet under "## Deferred maintenance" L117-144; sentence under "## Diagnostics" L703-725)
- Modify: `docs/synapsetree-integration.md:159-168` (table row)

- [ ] **Step 1: README — new section before "## Temporal facts"**

````markdown
## Direct fact writes

`remember()` stores one mutable fact in one transaction, with no model call, and returns the stored row. Use it when the host already knows the fact (a user preference, an agent's observation the user approved). To replace a fact, use `supersede()` so history is kept.

```typescript
const fact = await wiki.remember('user-123', {
  title: 'Prefers merge commits',
  body: 'Kurt wants PRs merged with merge commits, never squashed.',
  tags: ['git'],                 // default []
  confidence: 'certain',         // default
  source_type: 'user_stated',    // or 'user_confirmed'; default 'user_stated'
  okf_type: 'Preference',        // optional; resolved like an upsertGraph node type
  valid_from: Date.parse('2026-03-01'), // optional epoch ms
});
fact.id; // 'fact_…' — the row as stored: timestamps, defaults, isStale, trustTier
```

- Validation throws `TypeError` before anything is written: `title` non-empty, `body` a string, `tags` an array of strings, known `confidence` and `source_type`, finite `valid_from`. Nothing is clipped; length limits are the host's.
- `okf_type` follows the `upsertGraph` rule: the manifest's canonical slug when known; `WikiStrictOntologyViolation` under strict mode otherwise; `null` otherwise.
- Never starts the librarian or heal and writes no event, in `'auto'` and `'deferred'` mode alike. Embeds through `llmProvider.embed` when present (failures surface as `embedding_failed` with `operation: 'remember'`); keyword-only otherwise, and `getPendingMaintenance().reembedPending` picks it up once an `embed` exists.
- Not idempotent: two identical calls store two facts. Hosts that expose retries own the idempotency key.
- Opens its own transaction. Do not call it inside `withTransactionAsync`.
````

- [ ] **Step 2: README — one bullet under "## Deferred maintenance"**

After the bullet "`getPendingMaintenance()` shows the backlog per entity without calling a model.", add:

```markdown
- `remember()` and `supersede()` never schedule maintenance in either mode; only `write()` does.
```

- [ ] **Step 3: README — "## Diagnostics"**

After the "**`trigger`.**" bullet, add:

```markdown
- **`operation`** names the entry point: `ingest`, `upsertGraph`, `librarian`, `heal`, `ontologyBackfill`, `reembed`, `importDump`, `write`, `supersede`, `remember`, `read`, `prune`. New values may be added in minor releases.
```

- [ ] **Step 4: Integration guide table row**

In `docs/synapsetree-integration.md` §6, after the `wiki.write(entityId, ...)` row, add:

```markdown
| `wiki.remember(entityId, input)` | `memory_remember` | **No** — host-defined MCP wrapper |
```

and in the note below the table, change "All other wiki calls (`read`, `write`, `supersede`, `history`, the `asOf` form of `read`)" to "All other wiki calls (`read`, `write`, `remember`, `supersede`, `history`, the `asOf` form of `read`)".

- [ ] **Step 5: Build and check the published declarations**

Run: `pnpm run build && grep -l "remember(entityId: string, input: RememberInput): Promise<WikiFact>" packages/core/dist/*.d.ts && grep -l "interface RememberInput" packages/core/dist/*.d.ts`
Expected: build exit 0; both greps print a file name (the real declarations live in a hashed `dist/testing-*.d.ts` re-exported by `dist/index.d.ts`).

- [ ] **Step 6: Full CI-equivalent run**

Run: `pnpm run typecheck && pnpm test`
Expected: exit 0, no failures.

- [ ] **Step 7: Commit**

```bash
git add packages/core/README.md docs/synapsetree-integration.md
git commit -m "docs(core): document remember() and its no-maintenance guarantee

Spec: specs/core-remember/spec.md §4.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Final cleanup commit (owner-gated)

Runs only after review loops converge and the owner says so (`specs/README.md` lifecycle step 4). Not part of the implementer's loop.

**Files:**
- Modify: `specs/core-remember/spec.md` (Status line)
- Delete: `specs/core-remember/plan.md`, `specs/core-remember/LEDGER.md`

- [ ] **Step 1: Flip the Status and delete the transient files**

Change `**Status:** Draft` (or `Reviewed`) to `**Status:** Implemented (<merge-date>, PR #<n>)`. Then:

```bash
git rm specs/core-remember/plan.md specs/core-remember/LEDGER.md
git add specs/core-remember/spec.md
git commit -m "docs(spec): core-remember — Implemented; drop plan and ledger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Mark the PR ready**

Run: `gh pr ready`
Expected: the PR leaves draft; bot reviews that skip drafts fire; CI re-runs.

---

## Self-review (done when this plan was written)

- **Spec coverage.** §3.1 → Task 2 (type) + Task 3 (method). §3.2 → Tasks 1–2. §3.3 → Task 3 (service) + Task 4 (search/embed/outbox tests). §3.4 → Task 3. §3.5 → Task 3 code, Task 4 tests, Task 2 (`'remember'` operation). §3.6 → Task 4. §3.7 → Task 3 test ("not idempotent"). §3.8 → Tasks 2–3 tests. §3.9 → file layout of Tasks 1–3. §4 docs → Task 5. §5 items 1–14 → Tasks 2, 3, 4, 1. Status flip → Task 6.
- **Placeholders.** None; every code step is complete.
- **Type consistency.** `normalizeRememberInput(entityId, input, now)` returns `{ fact, validFrom, okfType }` in Task 2 and is consumed with those names in Task 3. `RememberService` constructor `(db, entryRepo, ontologyService, searchService, embeddingService)` matches its construction in `WikiMemory`. `WikiDiagnosticOperation` includes `'remember'` before Task 3 passes `{ operation: 'remember' }`.
