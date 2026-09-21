# PR 2 — Draft Visibility and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers opt out of seeing `lifecycle_status = 'draft'` facts in `read()` and `traverseGraph()`, and give hosts a review API: `listDrafts` and `promoteDraft`. Default behavior stays unchanged.

**Architecture:**
- **Reads.** Each `read()` fetches the draft ID set for its scored entities from SQLite once. That set filters candidate rows and MiniSearch pre-filter results before any cut. Vector-ranker and keyword limits are padded by the set's size, and the merged score list is filtered before `selectWithFloors`. The empty-query recency path filters in SQL.
- **Traversal.** Drafts become dead ends through one extra SQL predicate in the recursive walk. The root is exempt.
- **Review.** Promotion is a single transaction on top of the existing `setLifecycleStatus` and `writeOkfTrust` metadata writes.

**Tech Stack:** TypeScript 5.9 (strict), vitest 5, pnpm workspace, better-sqlite3 in tests.

**Spec:** `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md` (rev 6). §5 is this PR; REQ-COMPAT-01 applies. If this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Worktree: `.worktrees/pr2-drafts`, branch `feat/draft-review`. Run every command from the worktree root.
- One-time setup: `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`.
- Run one core test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`. Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- Tool-manifest tests: `pnpm --filter ./packages/core-llm-tools test`.
- **Defaults never change results.** `excludeDrafts` resolves call → `WikiConfig.excludeDrafts` → `false`. With it unset, every read and traversal must return exactly what it returns today.
- Draft status is always read from SQLite at query time. Never read it from MiniSearch or any cache: `setLifecycleStatus` does not bump `updated_at` or refresh indexes.
- Entity scoping is a disclosure boundary. Every new SQL statement binds `entity_id`.
- No schema migration: `lifecycle_status TEXT NOT NULL DEFAULT 'stable'` already exists (`db/schema.ts:25`).
- Commits: conventional commits. End every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** start a body line with `BREAKING CHANGE`. This PR is a `feat` minor release.
- Merge convention: regular merge commit, never squash.
- Do not edit this PR's own spec file. The native-slice spec gets one revision note (Task 5), as §5.4 requires.

## File map

| File | Change |
|---|---|
| `packages/core/src/types.ts` | `excludeDrafts` on `WikiConfig`, `ReadOptions`, `GraphTraversalOptions`; `WikiDraftNotFound`; `DraftPage` |
| `packages/core/src/repositories/EntryRepository.ts` | `findDraftIdsByEntityIds`, `listDraftsByEntityId`, `isLiveDraft`; `findRecentByEntityIds` gains `opts` |
| `packages/core/src/services/RetrievalService.ts` | draft filtering on every path |
| `packages/core/src/repositories/EdgeRepository.ts` | `excludeDrafts` predicate in `getNeighborhood` |
| `packages/core/src/services/GraphTraversalService.ts` | option resolution |
| `packages/core/src/WikiMemory.ts` | `listDrafts`, `promoteDraft` |
| `packages/core-llm-tools/src/manifests/graph.ts` | `excludeDrafts` on `wiki_traverse_graph` |
| `packages/core/__tests__/draft*.test.ts`, `packages/core-llm-tools/__tests__/manifests-graph.test.ts` | tests |
| `packages/core/README.md` | `## Draft Review` section |
| `docs/superpowers/specs/2026-09-17-native-graphrag-vertical-slice-design.md` | revision note (§5.4) |

---

### Task 1: Types, error class, repository queries

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/repositories/EntryRepository.ts`
- Test: `packages/core/__tests__/draftRepository.test.ts`

**Interfaces:**
- Produces:
  - `ReadOptions.excludeDrafts?: boolean`, `GraphTraversalOptions.excludeDrafts?: boolean`, `WikiConfig.excludeDrafts?: boolean`.
  - `class WikiDraftNotFound extends Error { readonly code: 'WIKI_DRAFT_NOT_FOUND' }` (no constructor arguments).
  - `interface DraftPage { facts: WikiFact[]; nextCursor: string | null }`.
  - `EntryRepository`:
    - `findDraftIdsByEntityIds(entityIds: readonly string[], tx?): Promise<Set<string>>`
    - `listDraftsByEntityId(entityId: string, limit: number, after: { createdAt: number; id: string } | null, tx?): Promise<WikiFact[]>`
    - `isLiveDraft(entryId: string, entityId: string, tx?): Promise<boolean>`
    - `findRecentByEntityIds(entityIds, limit, tx?, opts?: { excludeDrafts?: boolean })`

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/draftRepository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { WikiDraftNotFound } from '../src/types';
import type { SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

async function seed(db: SQLiteAdapter, id: string, opts: { entity?: string; status?: string; created?: number; deleted?: number | null } = {}) {
  const t = opts.created ?? 1000;
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at, deleted_at, lifecycle_status)
     VALUES (?, ?, ?, 'b', 'certain', 'user_stated', ?, ?, ?, ?)`,
    [id, opts.entity ?? 'e1', `t-${id}`, t, t, opts.deleted ?? null, opts.status ?? 'stable'],
  );
}

async function makeRepo() {
  const db = openTestDatabase();
  await setupDatabase(db, PREFIX);
  return { db, repo: new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false)) };
}

describe('WikiDraftNotFound', () => {
  it('is contextless with a stable code', () => {
    const err = new WikiDraftNotFound();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WikiDraftNotFound);
    expect(err.code).toBe('WIKI_DRAFT_NOT_FOUND');
    expect(err.name).toBe('WikiDraftNotFound');
  });
});

describe('EntryRepository draft queries', () => {
  it('findDraftIdsByEntityIds returns live drafts of the named entities only', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft' });
    await seed(db, 'd2', { status: 'draft', entity: 'e2' });
    await seed(db, 'd3', { status: 'draft', deleted: 5 });
    await seed(db, 's1');
    expect([...(await repo.findDraftIdsByEntityIds(['e1']))]).toEqual(['d1']);
    expect([...(await repo.findDraftIdsByEntityIds(['e1', 'e2']))].sort()).toEqual(['d1', 'd2']);
    expect((await repo.findDraftIdsByEntityIds([])).size).toBe(0);
  });

  it('listDraftsByEntityId orders created_at DESC, id DESC and pages with a keyset', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'a', { status: 'draft', created: 10 });
    await seed(db, 'b', { status: 'draft', created: 20 });
    await seed(db, 'c', { status: 'draft', created: 20 });
    await seed(db, 'x', { status: 'draft', created: 30, entity: 'e2' });
    await seed(db, 's', { created: 40 });
    const first = await repo.listDraftsByEntityId('e1', 2, null);
    expect(first.map((f) => f.id)).toEqual(['c', 'b']);
    const second = await repo.listDraftsByEntityId('e1', 2, { createdAt: 20, id: 'b' });
    expect(second.map((f) => f.id)).toEqual(['a']);
  });

  it('isLiveDraft is entity-scoped and ignores deleted and non-draft rows', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft' });
    await seed(db, 'd2', { status: 'draft', deleted: 1 });
    await seed(db, 's1');
    expect(await repo.isLiveDraft('d1', 'e1')).toBe(true);
    expect(await repo.isLiveDraft('d1', 'e2')).toBe(false);
    expect(await repo.isLiveDraft('d2', 'e1')).toBe(false);
    expect(await repo.isLiveDraft('s1', 'e1')).toBe(false);
    expect(await repo.isLiveDraft('missing', 'e1')).toBe(false);
  });

  it('findRecentByEntityIds excludes drafts only when asked', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft', created: 30 });
    await seed(db, 's1', { created: 20 });
    expect((await repo.findRecentByEntityIds(['e1'], 10)).map((f) => f.id)).toEqual(['d1', 's1']);
    expect((await repo.findRecentByEntityIds(['e1'], 10, undefined, { excludeDrafts: true })).map((f) => f.id)).toEqual(['s1']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftRepository.test.ts`. Expected: FAIL; `WikiDraftNotFound` is not exported.

- [ ] **Step 3: Add the types** in `packages/core/src/types.ts`.
  - Add as the last member of `WikiConfig`, after `excludeSourceTypes?`:

```ts
  /**
   * Engine default for `ReadOptions.excludeDrafts` and
   * `GraphTraversalOptions.excludeDrafts`. Default false (drafts visible).
   */
  excludeDrafts?: boolean;
```

  - Add as the last member of `ReadOptions`, after `tierFloors?`:

```ts
  /**
   * When true, facts whose `lifecycle_status` is `'draft'` are excluded before
   * `maxResults`, `tierFloors` and every other cut, on every read path.
   * Resolves call → `WikiConfig.excludeDrafts` → false.
   */
  excludeDrafts?: boolean;
```

  - Add as the last member of `GraphTraversalOptions`, after `excludeSourceTypes?`:

```ts
  /**
   * When true, draft facts are dead ends for *discovered* nodes (not
   * discovered, not traversed through). Does not gate the anchor.
   * Resolves call → `WikiConfig.excludeDrafts` → false.
   */
  excludeDrafts?: boolean;
```

  - Add directly after the `WikiInvalidReadOptions` class:

```ts
/**
 * Thrown by `promoteDraft` when no live draft with that id exists for the
 * entity: missing, soft-deleted, owned by another entity, or not a draft.
 * Contextless for the same reason as {@link WikiGraphNodeOwnershipConflict}.
 * The `WIKI_` code keeps it clear of `extractSqliteCode`, so it passes through
 * the serialized transaction wrapper unwrapped.
 */
export class WikiDraftNotFound extends Error {
  readonly code = 'WIKI_DRAFT_NOT_FOUND' as const;

  constructor() {
    super('No draft fact with that id exists for this entity.');
    this.name = 'WikiDraftNotFound';
    Object.setPrototypeOf(this, WikiDraftNotFound.prototype);
  }
}

/** One page of `listDrafts`. `nextCursor` is opaque; pass it back unchanged. */
export interface DraftPage {
  facts: WikiFact[];
  nextCursor: string | null;
}
```

- [ ] **Step 4: Add the repository methods** in `EntryRepository.ts`.
  - Replace `findRecentByEntityIds` with:

```ts
  async findRecentByEntityIds(
    entityIds: readonly string[],
    limit: number,
    tx?: SQLiteAdapter,
    opts?: { excludeDrafts?: boolean },
  ): Promise<WikiFact[]> {
    if (entityIds.length === 0) return [];
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    const draftClause = opts?.excludeDrafts === true ? ` AND lifecycle_status != 'draft'` : '';
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL${draftClause} ORDER BY updated_at DESC LIMIT ?`,
      [...entityIds, limit],
    );
    return rows.map(mapRowToFact);
  }
```

  - Add these three methods directly below it:

```ts
  /** IDs of live draft facts for the given entities (spec §5.1). Callers pass ≤ 100 entity ids. */
  async findDraftIdsByEntityIds(entityIds: readonly string[], tx?: SQLiteAdapter): Promise<Set<string>> {
    if (entityIds.length === 0) return new Set();
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = await executor.getAllAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries
       WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_status = 'draft'`,
      [...entityIds],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Live drafts for one entity, newest first, keyset-paged by (created_at, id). */
  async listDraftsByEntityId(
    entityId: string,
    limit: number,
    after: { createdAt: number; id: string } | null,
    tx?: SQLiteAdapter,
  ): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const afterClause = after ? ` AND (created_at < ? OR (created_at = ? AND id < ?))` : '';
    const args: unknown[] = after
      ? [entityId, after.createdAt, after.createdAt, after.id, limit]
      : [entityId, limit];
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL AND lifecycle_status = 'draft'${afterClause}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      args,
    );
    return rows.map(mapRowToFact);
  }

  /** True iff `entryId` is a live draft owned by `entityId`. */
  async isLiveDraft(entryId: string, entityId: string, tx?: SQLiteAdapter): Promise<boolean> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries
       WHERE id = ? AND entity_id = ? AND deleted_at IS NULL AND lifecycle_status = 'draft'`,
      [entryId, entityId],
    );
    return row != null;
  }
```

- [ ] **Step 5: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftRepository.test.ts __tests__/repositories/EntryRepository.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/repositories/EntryRepository.ts packages/core/__tests__/draftRepository.test.ts
git commit -m "feat(core): add draft options, WikiDraftNotFound and draft queries

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `read()` excludes drafts on every path

**Files:**
- Modify: `packages/core/src/services/RetrievalService.ts`
- Test: `packages/core/__tests__/draftRead.test.ts`

**Interfaces:**
- Consumes: `findDraftIdsByEntityIds`, the `findRecentByEntityIds(..., opts)` signature, and `ReadOptions.excludeDrafts` / `WikiConfig.excludeDrafts` (Task 1).

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/draftRead.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryBundle, VectorRanker, WikiConfig, WikiFact, WikiOptions } from '../src/types';

function fact(id: string, title: string, status: 'draft' | 'stable', t: number, entity = 'e1'): WikiFact {
  return {
    id, entity_id: entity, title, body: `${title} body`, tags: [], confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null,
    created_at: t, updated_at: t, last_accessed_at: null, access_count: 0, deleted_at: null,
    lifecycle_status: status,
  };
}

// Drafts match "apple" more strongly than stable facts, so without filtering they win every cut.
const FACTS = [
  fact('d1', 'DRAFT apple apple apple one', 'draft', 5),
  fact('d2', 'DRAFT apple apple apple two', 'draft', 4),
  fact('d3', 'DRAFT apple apple apple three', 'draft', 3),
  fact('s1', 'STABLE apple one', 'stable', 2),
  fact('s2', 'STABLE apple two', 'stable', 1),
];
const STABLE = ['s1', 's2'];

async function makeWiki(opts: { embed?: (t: string) => Promise<number[]>; config?: WikiConfig; vectorRanker?: VectorRanker; facts?: WikiFact[] } = {}) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}', ...(opts.embed ? { embed: opts.embed } : {}) },
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.vectorRanker ? { vectorRanker: opts.vectorRanker } : {}),
  };
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const entities: Record<string, MemoryBundle> = {};
  for (const f of opts.facts ?? FACTS) {
    (entities[f.entity_id] ??= { facts: [], tasks: [], events: [], edges: [] }).facts.push(f);
  }
  await wiki.importDump({ generatedAt: 1, entities });
  return wiki;
}

const semanticEmbed = async (t: string) => (t.includes('STABLE') ? [0.6, 0.8, 0] : [1, 0, 0]);
const ids = (b: MemoryBundle) => b.facts.map((f) => f.id).sort();

describe('read() excludeDrafts', () => {
  it('keyword path: drafts win by default; excluded when asked, without shrinking below available stable matches', async () => {
    const wiki = await makeWiki();
    const dflt = await wiki.read('e1', 'apple', { maxResults: 3 });
    expect(dflt.facts.some((f) => f.lifecycle_status === 'draft')).toBe(true);
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 3, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('semantic JS-cosine path', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2 }))).not.toEqual(STABLE);
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('MiniSearch pre-filter path: drafts do not occupy pre-filter slots', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 5, preFilterLimit: 3, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('hybrid path', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2, hybridWeight: 0.5, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('vector ranker path: limit padded by draft count; drafts never returned', async () => {
    const limits: number[] = [];
    const ranker: VectorRanker = {
      rankBySimilarity: async (args) => {
        limits.push(args.limit);
        return ['d1', 'd2', 'd3', 's1', 's2'].map((id, i) => ({ id, semanticScore: 1 - i / 10 }));
      },
    };
    const wiki = await makeWiki({ embed: semanticEmbed, vectorRanker: ranker });
    await wiki.read('e1', 'apple', { maxResults: 10 });
    const r = await wiki.read('e1', 'apple', { maxResults: 10, excludeDrafts: true });
    expect(limits).toEqual([60, 63]);
    expect(ids(r)).toEqual(STABLE);
  });

  it('empty-query recency path filters in SQL', async () => {
    const wiki = await makeWiki();
    expect(ids(await wiki.read('e1', '', { excludeDrafts: true }))).toEqual(STABLE);
    expect((await wiki.read('e1', '')).facts).toHaveLength(5);
  });

  it('resolves call → config → false', async () => {
    const wiki = await makeWiki({ config: { excludeDrafts: true } });
    expect(ids(await wiki.read('e1', 'apple'))).toEqual(STABLE);
    expect((await wiki.read('e1', 'apple', { excludeDrafts: false })).facts.length).toBe(5);
  });

  it('tierFloors on an entity whose only matches are drafts does not throw and yields nothing for it', async () => {
    const wiki = await makeWiki({
      facts: [fact('a1', 'STABLE apple', 'stable', 2, 'A'), fact('b1', 'DRAFT apple', 'draft', 1, 'B')],
    });
    const r = await wiki.read(['A', 'B'], 'apple', { maxResults: 5, tierFloors: { B: 1 }, excludeDrafts: true });
    expect(r.facts.map((f) => f.id)).toEqual(['a1']);
  });
});
```

> Before running, check that `VectorRankerSemanticResult` has exactly the fields `{ id, semanticScore }` (`src/types.ts` ~line 525) and adjust the stub's objects if not. In the ranker test, `60 = max(10 * 2, 10 + 50)` and `63 = 60 + 3 drafts`.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftRead.test.ts`. Expected: FAIL on every `excludeDrafts: true` assertion.

- [ ] **Step 3: Implement filtering in `RetrievalService.read()`.** Line numbers drift, so use the quoted anchors.

  (a) Directly after the `const maxResults = ...` statement, resolve the option:

```ts
    const excludeDrafts = (options?.excludeDrafts ?? config?.excludeDrafts ?? false) === true;
```

  (b) Directly after `const scoredEntityIds = this._filterScoredEntities(...)`, fetch the set once:

```ts
      // Spec §5.1: one SQLite read per call; status is never taken from an index.
      const draftIds: ReadonlySet<string> = excludeDrafts && scoredEntityIds.length > 0
        ? await this.entryRepo.findDraftIdsByEntityIds(scoredEntityIds)
        : EMPTY_ID_SET;
      const draftPad = draftIds.size;
      const padLimit = (n: number): number => (n >= Number.MAX_SAFE_INTEGER ? n : n + draftPad);
```

  Add `const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();` at module scope below the imports.

  (c) Pre-filter branch. Change `const preResults = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, Number.MAX_SAFE_INTEGER);` to:

```ts
            const preResults = this.searchService
              .searchKeyword(trimmedQuery, scoredEntityIds, Number.MAX_SAFE_INTEGER)
              .filter((r) => !draftIds.has(r.id));
```

  (d) Full-scan branch. Wrap both fetches:

```ts
            if (useRanker) {
              candidateRows = this._withoutDrafts(await this.entryRepo.findMetadataByEntityIds(scoredEntityIds), draftIds);
            } else {
              candidateRows = this._withoutDrafts(await this.entryRepo.findWithEmbeddingsByEntityIds(scoredEntityIds), draftIds);
            }
```

  Then add a private helper to the class:

```ts
  private _withoutDrafts<T extends { id: string }>(rows: T[], draftIds: ReadonlySet<string>): T[] {
    return draftIds.size === 0 ? rows : rows.filter((row) => !draftIds.has(row.id));
  }
```

  (e) Vector ranker limit. Change `limit: Math.max(maxResults * 2, maxResults + 50),` in the ranker call to:

```ts
                      limit: padLimit(Math.max(maxResults * 2, maxResults + 50)),
```

  (f) The ranker-fallback `keyword` policy. Wrap both `keywordOversampledLimit` branches: `? Number.MAX_SAFE_INTEGER : padLimit(Math.max(maxResults * 2, maxResults + 50))`.

  (g) Convergence. Directly before `if (scored.length > 0) {` (the block that applies `applyTierWeight` and `selectWithFloors`), add:

```ts
            if (draftPad > 0) scored = scored.filter((s) => !draftIds.has(s.id));
```

  (h) Final keyword fallback (`if (!usedEmbed && scoredEntityIds.length > 0) {`). Pad the limit and filter:

```ts
        const fallbackOversampledLimit = hasActiveFloors
          ? Number.MAX_SAFE_INTEGER
          : padLimit(Math.max(maxResults * 2, maxResults + 50));
        const results = this.searchService
          .searchKeyword(trimmedQuery, scoredEntityIds, fallbackOversampledLimit)
          .filter((r) => !draftIds.has(r.id as string));
```

  (i) Empty-query recency path. Change `facts = await this.entryRepo.findRecentByEntityIds(entityIds, maxResults);` to:

```ts
      facts = await this.entryRepo.findRecentByEntityIds(entityIds, maxResults, undefined, { excludeDrafts });
```

`draftIds` and `padLimit` are declared inside the `else if (trimmedQuery)` block, so (h) is in scope. If TypeScript reports `scored` as possibly unassigned at (g), place (g) inside the same `else` block that assigns it. It must stay above `if (scored.length > 0)`.

- [ ] **Step 4: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftRead.test.ts __tests__/readOptions.test.ts __tests__/tierFloors.test.ts __tests__/tierFloorsRetrieval.test.ts __tests__/preFilterLimit.test.ts __tests__/hybridScoring.test.ts __tests__/multiEntityVectorRanker.test.ts __tests__/miniSearchFallback.test.ts __tests__/services/RetrievalService.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/services/RetrievalService.ts packages/core/__tests__/draftRead.test.ts
git commit -m "feat(core): excludeDrafts on every read() path

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Traversal dead-ends drafts; tool manifest

**Files:**
- Modify: `packages/core/src/repositories/EdgeRepository.ts` (`NeighborhoodQueryOptions`, `getNeighborhood`)
- Modify: `packages/core/src/services/GraphTraversalService.ts`
- Modify: `packages/core-llm-tools/src/manifests/graph.ts`
- Test: `packages/core/__tests__/draftTraversal.test.ts`; extend `packages/core-llm-tools/__tests__/manifests-graph.test.ts`

**Interfaces:**
- Consumes: `GraphTraversalOptions.excludeDrafts`, `WikiConfig.excludeDrafts`.
- Produces: `NeighborhoodQueryOptions.excludeDrafts?: boolean`.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/draftTraversal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiConfig, WikiEdge, WikiFact } from '../src/types';

function fact(id: string, status: 'draft' | 'stable', t: number): WikiFact {
  return {
    id, entity_id: 'e1', title: `t-${id}`, body: 'b', tags: [], confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null,
    created_at: t, updated_at: t, last_accessed_at: null, access_count: 0, deleted_at: null,
    lifecycle_status: status,
  };
}
const edge = (id: string, s: string, t: string): WikiEdge => ({ id, entity_id: 'e1', source_id: s, target_id: t, edge_type: 'rel', created_at: 1 });

// n1 (stable) → n2 (draft) → n3 (stable)
async function makeWiki(config?: WikiConfig) {
  const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' }, ...(config ? { config } : {}) });
  await wiki.setup();
  await wiki.importDump({
    generatedAt: 1,
    entities: { e1: { facts: [fact('n1', 'stable', 3), fact('n2', 'draft', 2), fact('n3', 'stable', 1)], tasks: [], events: [], edges: [edge('x', 'n1', 'n2'), edge('y', 'n2', 'n3')] } },
  });
  return wiki;
}

describe('traverseGraph excludeDrafts', () => {
  it('default: drafts are traversed', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2 });
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('excludeDrafts: a draft interior node blocks discovery beyond it', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2, excludeDrafts: true });
    expect(r.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(r.edges).toEqual([]);
  });

  it('a draft root is retained and traversed from', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n2', excludeDrafts: true });
    expect(r.nodes[0].id).toBe('n2');
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('config default applies and a call can override it', async () => {
    const wiki = await makeWiki({ excludeDrafts: true });
    expect((await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2 })).nodes.map((n) => n.id)).toEqual(['n1']);
    expect((await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2, excludeDrafts: false })).nodes).toHaveLength(3);
  });
});
```

Append this test inside the existing `describe('wikiTraverseGraphManifest', ...)` in `packages/core-llm-tools/__tests__/manifests-graph.test.ts`:

```ts
  it('declares optional boolean excludeDrafts', () => {
    const props = wikiTraverseGraphManifest.schema.parameters?.properties as Record<string, any>;
    expect(props.excludeDrafts).toMatchObject({ type: 'boolean' });
    expect(wikiTraverseGraphManifest.schema.parameters?.required).not.toContain('excludeDrafts');
  });
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftTraversal.test.ts` and `pnpm --filter ./packages/core-llm-tools test`. Expected: FAIL in the `excludeDrafts` tests.

- [ ] **Step 3: Implement it.**
  - `EdgeRepository.ts`: add `excludeDrafts?: boolean;` to `NeighborhoodQueryOptions`. In the recursive SQL, directly after the line `AND n.source_type NOT IN (${excludeSourceTypesPlaceholders})`, add:

```sql
          AND (? = 0 OR n.lifecycle_status != 'draft')
```

  - In `params`, directly after `...opts.excludeSourceTypes,`, add `opts.excludeDrafts === true ? 1 : 0,`. The anchor `SELECT` is untouched, so the root stays exempt, and the induced-edge query is unchanged.
  - `GraphTraversalService.ts`: add `excludeDrafts: options.excludeDrafts ?? this.config.excludeDrafts ?? false,` to the `opts` literal.
  - `core-llm-tools/src/manifests/graph.ts`: add this property to `wiki_traverse_graph`'s `properties`, after `edgeTypes`:

```ts
        excludeDrafts: {
          type: 'boolean',
          description: 'When true, unreviewed draft facts are not discovered or traversed through. The starting fact is always returned. Default false.',
        },
```

- [ ] **Step 4: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftTraversal.test.ts __tests__/services/GraphTraversalService.test.ts __tests__/repositories/EdgeRepository.test.ts` and `pnpm --filter ./packages/core-llm-tools test`. Expected: PASS. Then run the core typecheck; expected exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/repositories/EdgeRepository.ts packages/core/src/services/GraphTraversalService.ts packages/core-llm-tools/src/manifests/graph.ts packages/core/__tests__/draftTraversal.test.ts packages/core-llm-tools/__tests__/manifests-graph.test.ts
git commit -m "feat(core): excludeDrafts dead-ends drafts in traverseGraph

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `listDrafts` and `promoteDraft`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts` (add after `setLifecycleStatus`)
- Test: `packages/core/__tests__/draftReview.test.ts`

**Interfaces:**
- Consumes: `listDraftsByEntityId`, `isLiveDraft`, `WikiDraftNotFound`, `DraftPage`; `okfTrustWrites.setLifecycleStatus(id, entity, status, tx)` and `okfTrustWrites.writeOkfTrust(id, entity, verified, tx)`.
- Produces:
  - `WikiMemory.listDrafts(entityId: string, options?: { limit?: number; cursor?: string }): Promise<DraftPage>`
  - `WikiMemory.promoteDraft(entryId: string, entityId: string, reviewer: { by: string }): Promise<void>`

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/draftReview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiDraftNotFound } from '../src/types';
import type { SQLiteAdapter } from '../src/types';

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  return { wiki, db };
}

async function seed(db: SQLiteAdapter, id: string, opts: { entity?: string; status?: string; created?: number; deleted?: number | null } = {}) {
  const t = opts.created ?? 1000;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at, deleted_at, lifecycle_status)
     VALUES (?, ?, ?, 'b', 'inferred', 'librarian_inferred', ?, ?, ?, ?)`,
    [id, opts.entity ?? 'e1', `t-${id}`, t, t, opts.deleted ?? null, opts.status ?? 'draft'],
  );
}

describe('listDrafts', () => {
  it('pages newest-first with an opaque cursor, entity-scoped', async () => {
    const { wiki, db } = await makeWiki();
    for (let i = 1; i <= 5; i++) await seed(db, `d${i}`, { created: i * 10 });
    await seed(db, 'other', { entity: 'e2', created: 999 });
    await seed(db, 'stable', { status: 'stable', created: 998 });

    const p1 = await wiki.listDrafts('e1', { limit: 2 });
    expect(p1.facts.map((f) => f.id)).toEqual(['d5', 'd4']);
    expect(typeof p1.nextCursor).toBe('string');
    const p2 = await wiki.listDrafts('e1', { limit: 2, cursor: p1.nextCursor! });
    expect(p2.facts.map((f) => f.id)).toEqual(['d3', 'd2']);
    const p3 = await wiki.listDrafts('e1', { limit: 2, cursor: p2.nextCursor! });
    expect(p3.facts.map((f) => f.id)).toEqual(['d1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('defaults to 50, clamps to [1, 500], and never exposes embedding_blob', async () => {
    const { wiki, db } = await makeWiki();
    for (let i = 0; i < 60; i++) await seed(db, `d${String(i).padStart(2, '0')}`, { created: i });
    expect((await wiki.listDrafts('e1')).facts).toHaveLength(50);
    expect((await wiki.listDrafts('e1', { limit: 0 })).facts).toHaveLength(1);
    expect((await wiki.listDrafts('e1', { limit: 10_000 })).facts).toHaveLength(60);
    expect((await wiki.listDrafts('e1')).facts[0]).not.toHaveProperty('embedding_blob');
  });

  it('rejects a malformed cursor', async () => {
    const { wiki } = await makeWiki();
    await expect(wiki.listDrafts('e1', { cursor: 'garbage' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('promoteDraft', () => {
  it('sets stable, records the reviewer, and does not bump updated_at', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1', { created: 1234 });
    await wiki.promoteDraft('d1', 'e1', { by: 'human:reviewer-1' });
    const row = await db.getFirstAsync<{ lifecycle_status: string; updated_at: number; okf_verified: string; last_verified_by: string }>(
      `SELECT lifecycle_status, updated_at, okf_verified, last_verified_by FROM llm_wiki_entries WHERE id = 'd1'`,
    );
    expect(row?.lifecycle_status).toBe('stable');
    expect(Number(row?.updated_at)).toBe(1234);
    expect(row?.last_verified_by).toBe('human:reviewer-1');
    const [promoted] = (await wiki.read('e1', '')).facts;
    expect(promoted.trustTier).toBe('human-reviewed');
  });

  it('keeps the promoted fact in its original recency position', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'old', { created: 1 });
    await seed(db, 'new', { status: 'stable', created: 2 });
    await wiki.promoteDraft('old', 'e1', { by: 'human:r' });
    expect((await wiki.read('e1', '')).facts.map((f) => f.id)).toEqual(['new', 'old']);
  });

  it('is visible to excludeDrafts reads immediately, without re-indexing', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1');
    expect((await wiki.read('e1', '', { excludeDrafts: true })).facts).toHaveLength(0);
    await wiki.promoteDraft('d1', 'e1', { by: 'human:r' });
    expect((await wiki.read('e1', '', { excludeDrafts: true })).facts.map((f) => f.id)).toEqual(['d1']);
  });

  it('throws WikiDraftNotFound for missing, foreign, deleted and non-draft facts, changing nothing', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'foreign', { entity: 'e2' });
    await seed(db, 'deleted', { deleted: 5 });
    await seed(db, 'stable', { status: 'stable' });
    for (const id of ['missing', 'foreign', 'deleted', 'stable']) {
      await expect(wiki.promoteDraft(id, 'e1', { by: 'human:r' })).rejects.toBeInstanceOf(WikiDraftNotFound);
    }
    const foreign = await db.getFirstAsync<{ lifecycle_status: string; okf_verified: string | null }>(
      `SELECT lifecycle_status, okf_verified FROM llm_wiki_entries WHERE id = 'foreign'`,
    );
    expect(foreign?.lifecycle_status).toBe('draft');
  });

  it('requires a non-empty reviewer', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1');
    await expect(wiki.promoteDraft('d1', 'e1', { by: '  ' })).rejects.toBeInstanceOf(TypeError);
    await expect(wiki.promoteDraft('d1', 'e1', {} as { by: string })).rejects.toBeInstanceOf(TypeError);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftReview.test.ts`. Expected: FAIL, because `wiki.listDrafts is not a function`.

- [ ] **Step 3: Implement it in `WikiMemory.ts`.**
  - Add `WikiDraftNotFound` to the value import from `./types` and `DraftPage` to the type import.
  - Add this module-level function above `export class WikiMemory`:

```ts
/** `listDrafts` cursors are `${created_at}:${id}`; opaque to callers. */
function decodeDraftCursor(cursor: unknown): { createdAt: number; id: string } {
  const sep = typeof cursor === 'string' ? cursor.indexOf(':') : -1;
  const createdAt = sep > 0 ? Number((cursor as string).slice(0, sep)) : Number.NaN;
  const id = sep > 0 ? (cursor as string).slice(sep + 1) : '';
  if (!Number.isSafeInteger(createdAt) || id.length === 0) {
    throw new TypeError('Invalid listDrafts cursor.');
  }
  return { createdAt, id };
}
```

  - Add these methods directly after `setLifecycleStatus(...)`:

```ts
  /**
   * Live draft facts for one entity, newest first (spec §5.2). Default page
   * size 50, clamped to [1, 500]. Pass `nextCursor` back unchanged for the next page.
   */
  async listDrafts(entityId: string, options?: { limit?: number; cursor?: string }): Promise<DraftPage> {
    const rawLimit = options?.limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(500, Math.max(1, Math.floor(rawLimit)))
      : 50;
    const after = options?.cursor === undefined ? null : decodeDraftCursor(options.cursor);
    const rows = await this.entryRepo.listDraftsByEntityId(entityId, limit + 1, after);
    const facts = rows.slice(0, limit);
    const last = facts[facts.length - 1];
    return {
      facts,
      nextCursor: rows.length > limit && last ? `${last.created_at}:${last.id}` : null,
    };
  }

  /**
   * Promote a draft to `stable` and record who reviewed it, atomically
   * (spec §5.2). Metadata writes only: `updated_at` is not bumped and no
   * outbox event is pushed. Pass `by: 'human:<id>'` so `trustTier` becomes
   * `'human-reviewed'`.
   *
   * @throws WikiDraftNotFound when no live draft with that id exists for the entity.
   */
  async promoteDraft(entryId: string, entityId: string, reviewer: { by: string }): Promise<void> {
    const by = reviewer?.by;
    if (typeof by !== 'string' || by.trim().length === 0) {
      throw new TypeError('promoteDraft requires reviewer.by to be a non-empty string.');
    }
    await this.db.withTransactionAsync(async (tx) => {
      if (!(await this.entryRepo.isLiveDraft(entryId, entityId, tx))) {
        throw new WikiDraftNotFound();
      }
      await this.okfTrustWrites.setLifecycleStatus(entryId, entityId, 'stable', tx);
      await this.okfTrustWrites.writeOkfTrust(entryId, entityId, [{ by, at: new Date().toISOString() }], tx);
    });
  }
```

- [ ] **Step 4: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/draftReview.test.ts __tests__/okfTrustWrites.test.ts __tests__/daoDiscipline.test.ts`. Expected: PASS. If `rejects.toBeInstanceOf(WikiDraftNotFound)` fails because the serialized transaction wrapper rewrapped the error, read `src/db/serializedAdapter.ts`. Adjust the class (as `WikiGraphNodeOwnershipConflict` does), not the test. Then run typecheck; expected exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/draftReview.test.ts
git commit -m "feat(core): add listDrafts and promoteDraft review API

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, native-slice coordination note, full verification

**Files:**
- Modify: `packages/core/README.md` (new `## Draft Review` section directly before `## Pluggable Vector Retrieval`)
- Modify: `docs/superpowers/specs/2026-09-17-native-graphrag-vertical-slice-design.md` (revision history)

- [ ] **Step 1: README.** Before writing, grep `src/types.ts` and `src/WikiMemory.ts` so every name matches the source. Insert:

````markdown
## Draft Review

Facts can carry `lifecycle_status: 'draft'`, for example when a host marks model output as unreviewed. Drafts stay visible by default. To keep them out of results:

```ts
await wiki.read('user-1', 'deploy process', { excludeDrafts: true });
await wiki.traverseGraph('user-1', { sourceId, excludeDrafts: true });
// or engine-wide:
createWiki(db, { llmProvider, config: { excludeDrafts: true } });
```

- On every `read()` path, drafts are removed **before** `maxResults`, `tierFloors`, and pre-filter cuts, so they never take slots from reviewed facts.
- In traversal, drafts are dead ends. The starting fact is always returned.
- Status is read from SQLite on every call. A promotion is visible immediately, with no re-indexing.

Review API:

```ts
const { facts, nextCursor } = await wiki.listDrafts('user-1', { limit: 50 });
await wiki.promoteDraft(facts[0].id, 'user-1', { by: 'human:alice' }); // → stable, trustTier 'human-reviewed'
// Reject with setLifecycleStatus(id, entityId, 'deprecated') or forget().
```

`promoteDraft` throws `WikiDraftNotFound` when no live draft with that id exists for the entity. The error is contextless by design. Promotion does not change `updated_at`, so a promoted fact keeps its recency position.
````

- [ ] **Step 2: Native-slice spec note (§5.4).** In `docs/superpowers/specs/2026-09-17-native-graphrag-vertical-slice-design.md`, under `### Revision history`, insert a new first entry above **Revision 5**:

```markdown
**Revision 6 (2026-09-21, coordination note — no contract change):** core adds `GraphTraversalOptions.excludeDrafts` / `WikiConfig.excludeDrafts` (grounding-diagnostics-classifier design §5.1/§5.4). The option is **outside** this slice's parity baseline (core 7.1.3) until the slice re-pins; REQ-SLICE-01 is unchanged. On re-pin, the native walk must add the discovered-node predicate `lifecycle_status != 'draft'` when the option is true, with the root exempt, and leave the induced-edge query unchanged.
```

Do not edit anything else in that file.

- [ ] **Step 3: Full verification.** Run `pnpm --filter @equationalapplications/core-llm-wiki test`, `pnpm --filter @equationalapplications/core-llm-wiki typecheck` and `pnpm test`. Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add packages/core/README.md docs/superpowers/specs/2026-09-17-native-graphrag-vertical-slice-design.md
git commit -m "docs(core): document draft review; note excludeDrafts on native slice spec

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec | Covered by |
|---|---|
| §5.1 `excludeDrafts` on read and traversal plus the config default, resolution order | Tasks 1–3 |
| §5.1 excluded before `maxResults` / `tierFloors` / caps on every path | Task 2 (keyword, semantic, pre-filter, hybrid, ranker, recency tests) |
| §5.1 status read from SQLite, never an index | Task 2 design; Task 4 "promotion visible without re-indexing" test |
| §5.1 drafts are dead ends; draft root retained; induced edges unchanged | Task 3 |
| §5.1 bundle, export and `formatGraphContext` unchanged | Not touched |
| §5.2 `listDrafts` (scoped, live, ordering, default 50 / max 500, cursor, no blob) | Tasks 1, 4 |
| §5.2 `promoteDraft` (one transaction, metadata-only, `by`, `WikiDraftNotFound`) | Tasks 1, 4 |
| §5.3 traverse manifest | Task 3 |
| §5.4 native-slice note | Task 5 |
| §5.5 tests (every path, `tierFloors`, traversal, promotion visibility, recency pin, scoping and cursor) | Tasks 2–4 |
