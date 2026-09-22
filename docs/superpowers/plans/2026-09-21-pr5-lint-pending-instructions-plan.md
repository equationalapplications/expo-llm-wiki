# PR 5 — Lint, Pending Sources, Instructions Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosts a read-only maintenance report (`lint`), a batch pending-state check (`pendingSources`), and the effective system prompts as a `memory:read` tool (`getInstructions` + `wiki_get_instructions`).

**Architecture:**
- **`pendingSources`** is `hasChanged`'s batch path with one more distinction (`partial`), backed by one windowed query per chunk of refs.
- **`lint`:**
  - SQL aggregates handle counts and dangling edges.
  - Manifest violations need the effective manifest, which is a JS object. They are computed by **streaming the entity's live-endpoint edges in keyset pages** and checking each (edge type, source type, target type) triple in JS, with the same `typeSatisfies` rule ingest uses.
  - Lint lives in a new `LintRepository` (SQL only) and `LintService` (policy).
- **`getInstructions`** returns what `PromptService` would send as the system prompt, minus hydrated data: overrides applied, the ontology block appended, and data placeholders left verbatim.
  - `core-llm-tools` gains a schema-only `wiki_get_instructions` manifest. Hosts dispatch it to `getInstructions`, as they already do for `wiki_get_ontology`.
  - Task 5 adds the grounding block. It is **gated on PR 3 merging** (spec §8.3).

**Tech Stack:** TypeScript 5.9 (strict), vitest, pnpm workspace, better-sqlite3 in tests.

**Spec:** `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md` §8. `main` has rev 6. PR 3's branch carries rev 7, which only touches §6 and does not affect this PR. REQ-COMPAT-01 applies. If this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Worktree: `.worktrees/pr5-lint`, branch `feat/lint-pending-instructions`, based on `main` @ `0515831` (PRs 1, 2 and 4 merged). Run every command from the worktree root.
- One-time setup (already done by the plan author; re-run if `node_modules` is missing): `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`. The baseline is 1413/1413 core tests.
- Run one core test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`. Tools: `pnpm --filter ./packages/core-llm-tools exec vitest run __tests__/<file>.test.ts`. Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- **Everything in this PR is additive and read-only.** No new option changes an existing operation (REQ-COMPAT-01). `lint`, `pendingSources` and `getInstructions` never write; `lint` must not persist a seed manifest.
- **Entity scope:** every SQL statement filters `entity_id = ?`. Edge endpoints count as live only when they are the same entity's non-deleted entries; a cross-entity endpoint is dangling.
- **`source_hash` (spec §3, §8.1):** lint never inspects it. A null hash on partial-ingest rows is the intended retry state and is reported only by `pendingSources` as `partial`.
- **`pendingSources` semantics:** status is `current` exactly when `hasChanged` returns false for that pair. `new`, `partial` and `changed` all mean `hasChanged` would return true. Validation and raw-ref echo match batched `hasChanged`: an invalid ref or hash throws, and the result echoes the caller's spelling. Input order and duplicates are preserved; empty input returns `[]` with zero SQL.
- **Manifest violations:**
  - Counted only when ontology mode is not `'off'` and the effective manifest has at least one node type or edge type; otherwise 0. This mirrors `upsertGraphCore`'s "no constraints" rule.
  - Only edges with both endpoints live are checked, so a dangling edge is never also a violation.
  - An untyped endpoint is a violation, because its triple cannot be in the manifest.
- **Samples:** at most 20 ids each, ascending by edge id.
- **`getInstructions` disclosure:**
  - Templates only, never events, chunks, facts or candidates.
  - Override templates are returned verbatim, so docs must warn hosts not to put secrets or private data in `WikiConfig.prompts`.
- **Task 5 is gated.** Start it only after PR 3 (`feat/grounding-check`) has merged to `main`. Tasks 1–4 do not depend on PR 3. If PR 3 is already merged when Task 4 finishes, do Task 5 before opening the PR. Otherwise open the PR after Task 4 and say in its body that it must not merge before Task 5.
- Commits: conventional commits. End every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** start a body line with `BREAKING CHANGE`. This PR is a `feat` minor release.
- Merge convention: regular merge commit, never squash. Do not merge the PR yourself. After another PR merges, bring `main` in with `git fetch origin && git merge origin/main` (never rebase).
- Do not edit the series spec in this PR.
- **Never put `expect` inside a fake `generateText`.** Core catches provider errors, so an assertion there is swallowed. Capture, then assert after the operation resolves.
- Never use bare `git stash`; use WIP commits.

## File map

| File | Change |
|---|---|
| `packages/core/src/types.ts` | `PendingSourceStatus`, `WikiLintReport`, `WikiInstructions` (appended after `DraftPage`) |
| `packages/core/src/repositories/EntryRepository.ts` | `findSourceStates(entityId, refs)` |
| `packages/core/src/repositories/LintRepository.ts` | **new** — fact-health counts, dangling edges, keyset edge pages |
| `packages/core/src/utils/ontology.ts` | `edgeTripleAllowed(manifest, edgeType, sourceType, targetType)` |
| `packages/core/src/services/LintService.ts` | **new** — assembles `WikiLintReport` |
| `packages/core/src/services/PromptService.ts` | `buildInstructionTemplates(ontologyContext)` |
| `packages/core/src/WikiMemory.ts` | `pendingSources`, `lint`, `getInstructions`; wiring |
| `packages/core-llm-tools/src/manifests/instructions.ts` | **new** — `wikiGetInstructionsManifest` |
| `packages/core-llm-tools/src/index.ts` | export it |
| `packages/core/__tests__/pendingSources.test.ts`, `lint.test.ts`, `instructions.test.ts` | **new** |
| `packages/core-llm-tools/__tests__/manifests-instructions.test.ts` | **new** |
| READMEs (core, core-llm-tools) | docs |

---

### Task 1: `pendingSources`

**Files:**
- Modify: `packages/core/src/types.ts` (append after `export interface DraftPage { ... }` at the end of the file)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (new method directly after `findLatestSourceHashes`, ~line 1150)
- Modify: `packages/core/src/WikiMemory.ts` (new method directly after the `hasChanged` implementation, ~line 365)
- Test: `packages/core/__tests__/pendingSources.test.ts`

**Interfaces:**
- Produces:
  - `export type PendingSourceStatus = 'new' | 'changed' | 'partial' | 'current'`
  - `EntryRepository.findSourceStates(entityId: string, sourceRefs: readonly string[], tx?: SQLiteAdapter): Promise<Map<string, { latestHash: string | null; anyHashed: boolean }>>`. Refs with no live row are absent from the map.
  - `WikiMemory.pendingSources(entityId: string, sources: Array<{ sourceRef: string; sourceHash: string }>): Promise<Array<{ sourceRef: string; status: PendingSourceStatus }>>`

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/pendingSources.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, HASH_A, HASH_B } from './helpers/diagnosticsHarness';

const HASH_C = 'c'.repeat(64);
afterEach(() => vi.restoreAllMocks());

const ok = async () => JSON.stringify({ facts: [{ title: 'Fact', body: 'body', tags: [], confidence: 'certain' }] });
const halfBroken = async ({ userPrompt }: { userPrompt: string }) =>
  userPrompt.includes('BROKEN') ? 'not json' : JSON.stringify({ facts: [{ title: 'Half', body: 'half body', tags: [], confidence: 'certain' }] });
const TWO_CHUNKS = 'First chunk of the doc.\n\nBROKEN chunk text here.';

async function setup() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let gen: (p: { userPrompt: string }) => Promise<string> = ok;
  const h = await makeDiagnosticWiki({ config: { maxChunkLength: 30, chunkOverlap: 0 }, generateText: (p) => gen(p) });
  await h.wiki.ingestDocument('e1', { sourceRef: 'full.md', sourceHash: HASH_A, documentChunk: 'full' });
  gen = halfBroken;
  await h.wiki.ingestDocument('e1', { sourceRef: 'partial.md', sourceHash: HASH_A, documentChunk: TWO_CHUNKS });
  // mixed.md: a full ingest, then a partial re-ingest whose null-hash rows are newest.
  gen = ok;
  await h.wiki.ingestDocument('e1', { sourceRef: 'mixed.md', sourceHash: HASH_B, documentChunk: 'mixed' });
  gen = halfBroken;
  await h.wiki.ingestDocument('e1', { sourceRef: 'mixed.md', sourceHash: HASH_C, documentChunk: TWO_CHUNKS });
  // Both ingests can land in the same millisecond, and the latest-row tie-break
  // is by random id; push the partial rows later so "latest is hash-less" is deterministic.
  await h.db.runAsync(
    `UPDATE llm_wiki_entries SET updated_at = updated_at + 1000 WHERE entity_id = 'e1' AND source_ref = 'mixed.md' AND source_hash IS NULL`,
  );
  gen = ok;
  await h.wiki.ingestDocument('e2', { sourceRef: 'other.md', sourceHash: HASH_A, documentChunk: 'other' });
  return h;
}

describe('pendingSources', () => {
  it('classifies new, current, changed and partial, preserving input order and duplicates', async () => {
    const { wiki } = await setup();
    const input = [
      { sourceRef: 'full.md', sourceHash: HASH_B },
      { sourceRef: 'nope.md', sourceHash: HASH_A },
      { sourceRef: 'full.md', sourceHash: HASH_A },
      { sourceRef: 'partial.md', sourceHash: HASH_A },
      { sourceRef: 'other.md', sourceHash: HASH_A }, // exists only under e2
      { sourceRef: 'full.md', sourceHash: HASH_A },
    ];
    expect(await wiki.pendingSources('e1', input)).toEqual([
      { sourceRef: 'full.md', status: 'changed' },
      { sourceRef: 'nope.md', status: 'new' },
      { sourceRef: 'full.md', status: 'current' },
      { sourceRef: 'partial.md', status: 'partial' },
      { sourceRef: 'other.md', status: 'new' },
      { sourceRef: 'full.md', status: 'current' },
    ]);
  });

  it('status is current exactly when hasChanged is false, including mixed hashed/partial refs', async () => {
    const { wiki } = await setup();
    const input = ['full.md', 'partial.md', 'mixed.md', 'nope.md'].flatMap((sourceRef) =>
      [HASH_A, HASH_B, HASH_C].map((sourceHash) => ({ sourceRef, sourceHash })));
    const pending = await wiki.pendingSources('e1', input);
    const changed = await wiki.hasChanged('e1', input);
    expect(pending.map((p) => p.status === 'current')).toEqual(changed.map((c) => !c.changed));
    expect(pending.filter((p) => p.sourceRef === 'mixed.md').map((p) => p.status)).toEqual(['changed', 'changed', 'changed']);
  });

  it('echoes the raw ref, uppercases hashes the same way as hasChanged, and validates', async () => {
    const { wiki } = await setup();
    expect(await wiki.pendingSources('e1', [{ sourceRef: 'full!.md', sourceHash: HASH_A.toUpperCase() }]))
      .toEqual([{ sourceRef: 'full!.md', status: 'current' }]);
    await expect(wiki.pendingSources('e1', [{ sourceRef: '!!!', sourceHash: HASH_A }])).rejects.toThrow(/Invalid sourceRef/);
    await expect(wiki.pendingSources('e1', [{ sourceRef: 'a.md', sourceHash: 'xyz' }])).rejects.toThrow(/Invalid sourceHash/);
  });

  it('returns [] for empty input without querying', async () => {
    const { wiki, db } = await setup();
    const spy = vi.spyOn(db, 'getAllAsync');
    expect(await wiki.pendingSources('e1', [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chunks large inputs under the SQLite variable limit', async () => {
    const { wiki } = await setup();
    const many = Array.from({ length: 1200 }, (_, i) => ({ sourceRef: `doc-${i}.md`, sourceHash: HASH_A }));
    many[700] = { sourceRef: 'full.md', sourceHash: HASH_A };
    const result = await wiki.pendingSources('e1', many);
    expect(result).toHaveLength(1200);
    expect(result[700]).toEqual({ sourceRef: 'full.md', status: 'current' });
    expect(result.filter((r) => r.status === 'new')).toHaveLength(1199);
  });
});
```

**Fixture-only adjustment allowed.** The "empty input" test spies on the raw adapter. If `WikiMemory` wraps it so the spy cannot observe reads, assert the result only, and record the change as a ruling. If `partial.md` does not produce a partial commit with `maxChunkLength: 30`, adjust only the document text so the first chunk succeeds and the second contains `BROKEN`.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/pendingSources.test.ts`. Expected: FAIL (`wiki.pendingSources is not a function`).

- [ ] **Step 3: Type.** Append to `packages/core/src/types.ts`:

```ts
/**
 * `pendingSources` status (spec §8.2). `partial`: live rows exist for the ref
 * but none carries a hash, which is the intended retry state after a partial
 * ingest. `current` is exactly the case where `hasChanged` returns false.
 */
export type PendingSourceStatus = 'new' | 'changed' | 'partial' | 'current';
```

- [ ] **Step 4: Repository.** In `EntryRepository`, directly after `findLatestSourceHashes`:

```ts
  /**
   * Per source ref, the hash of the latest live row (same ordering as
   * {@link findLatestSourceHashes}) and whether ANY live row carries a hash.
   * Refs with no live row are absent. Chunked under the bind-variable limit.
   */
  async findSourceStates(
    entityId: string,
    sourceRefs: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Map<string, { latestHash: string | null; anyHashed: boolean }>> {
    const out = new Map<string, { latestHash: string | null; anyHashed: boolean }>();
    const deduped = Array.from(new Set(sourceRefs));
    if (deduped.length === 0) return out;
    const executor = this.getExecutor(tx);
    const chunkLimit = Math.max(1, this.chunkSize - 1);
    for (let i = 0; i < deduped.length; i += chunkLimit) {
      const chunk = deduped.slice(i, i + chunkLimit);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await executor.getAllAsync<{ source_ref: string; source_hash: string | null; any_hashed: number }>(
        `WITH ranked AS (
           SELECT source_ref, source_hash,
                  ROW_NUMBER() OVER (PARTITION BY source_ref ORDER BY updated_at DESC, id ASC) AS rn,
                  MAX(CASE WHEN source_hash IS NOT NULL THEN 1 ELSE 0 END) OVER (PARTITION BY source_ref) AS any_hashed
           FROM ${this.prefix}entries
           WHERE entity_id = ? AND source_ref IN (${placeholders}) AND deleted_at IS NULL
         )
         SELECT source_ref, source_hash, any_hashed FROM ranked WHERE rn = 1`,
        [entityId, ...chunk],
      );
      for (const r of rows) out.set(r.source_ref, { latestHash: r.source_hash, anyHashed: Number(r.any_hashed) === 1 });
    }
    return out;
  }
```

- [ ] **Step 5: Facade.** In `WikiMemory`, directly after the `hasChanged` implementation (and import `PendingSourceStatus` from `./types`):

```ts
  /**
   * Batch pending state per source (spec §8.2). `current` exactly when
   * `hasChanged` is false; `partial` when live rows exist but none carries a
   * hash (a partial ingest's retry state). Validation and raw-ref echo match
   * batched `hasChanged`. Input order and duplicates are preserved.
   */
  async pendingSources(
    entityId: string,
    sources: Array<{ sourceRef: string; sourceHash: string }>,
  ): Promise<Array<{ sourceRef: string; status: PendingSourceStatus }>> {
    if (sources.length === 0) return [];
    const normalized = sources.map((s) => {
      const sourceRef = normalizeSourceRef(s.sourceRef);
      if (!sourceRef) throw new Error(`Invalid sourceRef: ${JSON.stringify(s.sourceRef)}`);
      const sourceHash = normalizeSourceHash(s.sourceHash);
      if (!sourceHash) throw new Error('Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)');
      return { rawSourceRef: s.sourceRef, sourceRef, sourceHash };
    });
    const states = await this.entryRepo.findSourceStates(entityId, normalized.map((n) => n.sourceRef));
    return normalized.map((n) => {
      const state = states.get(n.sourceRef);
      let status: PendingSourceStatus;
      if (!state) status = 'new';
      else if (!state.anyHashed) status = 'partial';
      else if (state.latestHash !== null && normalizeSourceHash(state.latestHash) === n.sourceHash) status = 'current';
      else status = 'changed';
      return { sourceRef: n.rawSourceRef, status };
    });
  }
```

- [ ] **Step 6: Run the test and confirm it passes.** Same command as Step 2. Expected: PASS.

- [ ] **Step 7: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/repositories/EntryRepository.ts packages/core/src/WikiMemory.ts packages/core/__tests__/pendingSources.test.ts
git commit -m "feat(core): add pendingSources batch status with a partial-ingest state

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `lint`

**Files:**
- Modify: `packages/core/src/types.ts` (append)
- Modify: `packages/core/src/utils/ontology.ts` (new export directly after `typeSatisfies`)
- Create: `packages/core/src/repositories/LintRepository.ts`
- Create: `packages/core/src/services/LintService.ts`
- Modify: `packages/core/src/WikiMemory.ts` (field and construction next to the other repositories/services, lines ~87–190; the `lint` method next to `pendingSources`)
- Test: `packages/core/__tests__/lint.test.ts`

**Interfaces:**
- Produces:
  - `export interface WikiLintReport { danglingEdges: number; manifestViolations: number; untypedFacts: number; drafts: number; unverifiedInferred: number; sample: { danglingEdgeIds: string[]; manifestViolationEdgeIds: string[] } }`
  - `edgeTripleAllowed(manifest: OntologyManifest, edgeType: string, sourceType: string, targetType: string): boolean`
  - `LintRepository`:
    - `countFactHealth(entityId): Promise<{ untypedFacts: number; drafts: number; unverifiedInferred: number }>`
    - `countDanglingEdges(entityId): Promise<number>`
    - `sampleDanglingEdgeIds(entityId, limit): Promise<string[]>`
    - `pageLiveEdges(entityId, afterId: string, limit): Promise<Array<{ id: string; edge_type: string; source_type: string | null; target_type: string | null }>>`
  - `LintService.lint(entityId): Promise<WikiLintReport>`
  - `WikiMemory.lint(entityId: string): Promise<WikiLintReport>`

- [ ] **Step 1: Write the failing tests** in `packages/core/__tests__/lint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'employee', description: 'An employed person', parent_type: 'person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Lives in' }],
};

async function fact(db: SQLiteAdapter, id: string, o: { entity?: string; type?: string | null; status?: string; source?: string; verified?: string | null; deleted?: boolean } = {}) {
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, okf_type, lifecycle_status, okf_verified, deleted_at)
     VALUES (?, ?, ?, 'body', '[]', 'certain', ?, ?, ?, ?, ?, ?, ?)`,
    [id, o.entity ?? 'e1', `title ${id}`, o.source ?? 'immutable_document', now, now, o.type === undefined ? 'person' : o.type,
      o.status ?? 'stable', o.verified ?? null, o.deleted ? now : null],
  );
}
async function edge(db: SQLiteAdapter, id: string, source: string, target: string, type = 'lives_in', entity = 'e1') {
  await db.runAsync(
    `INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, entity, source, target, type, Date.now()],
  );
}
const totalChanges = async (db: SQLiteAdapter) => (await db.getFirstAsync<{ n: number }>('SELECT total_changes() AS n'))!.n;

async function fixture(config = {}) {
  const h = await makeDiagnosticWiki({ config });
  const { db } = h;
  await fact(db, 'p1');
  await fact(db, 'p2');
  await fact(db, 'emp', { type: 'employee' });
  await fact(db, 'pl', { type: 'place' });
  await fact(db, 'u1', { type: null });
  await fact(db, 'gone', { deleted: true });
  await fact(db, 'foreign', { entity: 'e2', type: 'place' });
  await fact(db, 'd1', { status: 'draft' });
  await fact(db, 'inf1', { source: 'librarian_inferred' });
  await fact(db, 'inf2', { source: 'librarian_inferred', verified: '[]' });
  await fact(db, 'inf3', { source: 'librarian_inferred', verified: '[{"by":"human:a","at":"2026-01-01T00:00:00Z"}]' });
  await fact(db, 'inf4', { source: 'librarian_inferred', deleted: true });
  await edge(db, 'e_ok', 'p1', 'pl');
  await edge(db, 'e_parent', 'emp', 'pl');           // employee satisfies person
  await edge(db, 'e_badtype', 'p1', 'p2', 'knows');  // edge type not in manifest
  await edge(db, 'e_badtarget', 'p1', 'p2');         // target type mismatch
  await edge(db, 'e_untyped', 'u1', 'pl');           // untyped source
  await edge(db, 'e_ghost', 'p1', 'ghost');          // missing target
  await edge(db, 'e_gone', 'gone', 'pl');            // soft-deleted source
  await edge(db, 'e_foreign', 'p1', 'foreign');      // target owned by another entity
  await edge(db, 'x_other', 'foreign', 'foreign', 'lives_in', 'e2'); // other entity's edge
  return h;
}

describe('lint', () => {
  it('reports every count, entity-scoped, with sorted samples', async () => {
    const { wiki } = await fixture();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    expect(await wiki.lint('e1')).toEqual({
      danglingEdges: 3,
      manifestViolations: 3,
      untypedFacts: 1,
      drafts: 1,
      unverifiedInferred: 2,
      sample: {
        danglingEdgeIds: ['e_foreign', 'e_ghost', 'e_gone'],
        manifestViolationEdgeIds: ['e_badtarget', 'e_badtype', 'e_untyped'],
      },
    });
  });

  it('reports no manifest violations with ontology off or an empty manifest', async () => {
    const { wiki } = await fixture();
    expect((await wiki.lint('e1')).manifestViolations).toBe(0);
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
    expect((await wiki.lint('e1')).manifestViolations).toBe(0);
  });

  it('pages through more edges than one page and caps samples at 20', async () => {
    const { wiki, db } = await fixture();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    for (let i = 0; i < 1100; i++) await edge(db, `v${String(i).padStart(4, '0')}`, 'p1', 'p2', `bad_${i}`);
    for (let i = 0; i < 30; i++) await edge(db, `g${String(i).padStart(2, '0')}`, 'p1', `ghost${i}`);
    const report = await wiki.lint('e1');
    expect(report.manifestViolations).toBe(1103);
    expect(report.danglingEdges).toBe(33);
    expect(report.sample.manifestViolationEdgeIds).toHaveLength(20);
    expect(report.sample.manifestViolationEdgeIds[0]).toBe('e_badtarget');
    expect(report.sample.danglingEdgeIds).toEqual([...report.sample.danglingEdgeIds].sort());
    expect(report.sample.danglingEdgeIds).toHaveLength(20);
  });

  it('is read-only, including for a seed manifest', async () => {
    const { wiki, db } = await fixture({ ontology: { seedManifests: { e1: { manifest: MANIFEST, mode: 'strict' } } } });
    const before = await totalChanges(db);
    const report = await wiki.lint('e1');
    expect(report.manifestViolations).toBe(3);
    expect(await totalChanges(db)).toBe(before);
    expect(await db.getFirstAsync(`SELECT 1 AS x FROM llm_wiki_metadata WHERE entity_id = 'e1' AND manifest IS NOT NULL`)).toBeFalsy();
  });

  it('returns zeros for an empty entity', async () => {
    const { wiki } = await makeDiagnosticWiki();
    expect(await wiki.lint('empty')).toEqual({
      danglingEdges: 0, manifestViolations: 0, untypedFacts: 0, drafts: 0, unverifiedInferred: 0,
      sample: { danglingEdgeIds: [], manifestViolationEdgeIds: [] },
    });
  });
});
```

**Fixture-only adjustments allowed.**
- If an `INSERT` column list does not match the schema, fix only the fixture's column list and don't change the expectations. Check `db/schema.ts` and `db/migrations.ts` for exact column names.
- The metadata-table assertion in the read-only test must name the real table and column where manifests are persisted. Find them in `MetadataRepository.getManifest` and keep the "no row persisted" intent.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/lint.test.ts`. Expected: FAIL (`wiki.lint is not a function`).

- [ ] **Step 3: Type.** Append to `packages/core/src/types.ts`:

```ts
/** Read-only maintenance report for one entity (spec §8.1). Counts cover live rows only. */
export interface WikiLintReport {
  /** Edges whose source or target is missing, soft-deleted, or owned by another entity. */
  danglingEdges: number;
  /** Live-endpoint edges whose (source type, edge type, target type) is not in the effective manifest. 0 when ontology is off or the manifest is empty. */
  manifestViolations: number;
  /** Live facts with `okf_type` NULL. */
  untypedFacts: number;
  /** Live facts with `lifecycle_status = 'draft'`. */
  drafts: number;
  /** Live `librarian_inferred` facts with an empty `okf_verified`. */
  unverifiedInferred: number;
  /** Up to 20 ids each, ascending. */
  sample: { danglingEdgeIds: string[]; manifestViolationEdgeIds: string[] };
}
```

- [ ] **Step 4: Triple check.** In `packages/core/src/utils/ontology.ts`, directly after `typeSatisfies`:

```ts
/**
 * True iff some manifest edge type matches `edgeType` (case-insensitive) and
 * accepts the concrete endpoint types, parent types included. An empty
 * endpoint type never satisfies (the triple cannot be in the manifest).
 */
export function edgeTripleAllowed(
  manifest: OntologyManifest,
  edgeType: string,
  sourceType: string,
  targetType: string,
): boolean {
  const wanted = edgeType.trim().toLowerCase();
  return (manifest.edge_types ?? []).some((d) =>
    typeof d?.type === 'string'
    && d.type.trim().toLowerCase() === wanted
    && typeof d.source_type === 'string' && typeSatisfies(d.source_type, sourceType, manifest)
    && typeof d.target_type === 'string' && typeSatisfies(d.target_type, targetType, manifest));
}
```

- [ ] **Step 5: Repository.** Create `packages/core/src/repositories/LintRepository.ts`:

```ts
import { BaseRepository } from './BaseRepository';

/** Read-only queries for `lint` (spec §8.1). Every statement is entity-scoped. */
export class LintRepository extends BaseRepository {
  async countFactHealth(entityId: string): Promise<{ untypedFacts: number; drafts: number; unverifiedInferred: number }> {
    const row = await this.db.getFirstAsync<{ untyped: number | null; drafts: number | null; unverified: number | null }>(
      `SELECT
         SUM(CASE WHEN okf_type IS NULL THEN 1 ELSE 0 END) AS untyped,
         SUM(CASE WHEN lifecycle_status = 'draft' THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN source_type = 'librarian_inferred'
                   AND COALESCE(json_array_length(CASE WHEN json_valid(okf_verified) THEN okf_verified END), 0) = 0
                  THEN 1 ELSE 0 END) AS unverified
       FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    return {
      untypedFacts: Number(row?.untyped ?? 0),
      drafts: Number(row?.drafts ?? 0),
      unverifiedInferred: Number(row?.unverified ?? 0),
    };
  }

  private danglingWhere(): string {
    const live = (col: string) =>
      `EXISTS (SELECT 1 FROM ${this.prefix}entries n WHERE n.id = e.${col} AND n.entity_id = e.entity_id AND n.deleted_at IS NULL)`;
    return `e.entity_id = ? AND (NOT ${live('source_id')} OR NOT ${live('target_id')})`;
  }

  async countDanglingEdges(entityId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${this.prefix}edges e WHERE ${this.danglingWhere()}`,
      [entityId],
    );
    return Number(row?.n ?? 0);
  }

  async sampleDanglingEdgeIds(entityId: string, limit: number): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ id: string }>(
      `SELECT e.id FROM ${this.prefix}edges e WHERE ${this.danglingWhere()} ORDER BY e.id ASC LIMIT ?`,
      [entityId, limit],
    );
    return rows.map((r) => r.id);
  }

  /** Keyset page of edges whose endpoints are both live in this entity, with endpoint types. */
  async pageLiveEdges(
    entityId: string,
    afterId: string,
    limit: number,
  ): Promise<Array<{ id: string; edge_type: string; source_type: string | null; target_type: string | null }>> {
    return this.db.getAllAsync(
      `SELECT e.id, e.edge_type, s.okf_type AS source_type, t.okf_type AS target_type
         FROM ${this.prefix}edges e
         JOIN ${this.prefix}entries s ON s.id = e.source_id AND s.entity_id = e.entity_id AND s.deleted_at IS NULL
         JOIN ${this.prefix}entries t ON t.id = e.target_id AND t.entity_id = e.entity_id AND t.deleted_at IS NULL
        WHERE e.entity_id = ? AND e.id > ?
        ORDER BY e.id ASC
        LIMIT ?`,
      [entityId, afterId, limit],
    );
  }
}
```

- [ ] **Step 6: Service.** Create `packages/core/src/services/LintService.ts`:

```ts
import type { WikiLintReport } from '../types';
import type { LintRepository } from '../repositories/LintRepository';
import type { OntologyService } from './OntologyService';
import { edgeTripleAllowed } from '../utils/ontology';

const LINT_SAMPLE_SIZE = 20;
const LINT_PAGE_SIZE = 500;

export class LintService {
  constructor(private lintRepo: LintRepository, private ontologyService: OntologyService) {}

  /**
   * Read-only (spec §8.1). Manifest violations stream the entity's live-endpoint
   * edges in keyset pages and check each triple in JS against the effective
   * manifest. `getEffectiveState` is called without a transaction, so a seed
   * manifest is cached, never persisted. Counts come from separate statements,
   * not one snapshot.
   */
  async lint(entityId: string): Promise<WikiLintReport> {
    const health = await this.lintRepo.countFactHealth(entityId);
    const danglingEdges = await this.lintRepo.countDanglingEdges(entityId);
    const danglingEdgeIds = danglingEdges > 0 ? await this.lintRepo.sampleDanglingEdgeIds(entityId, LINT_SAMPLE_SIZE) : [];

    const { mode, manifest } = await this.ontologyService.getEffectiveState(entityId);
    const constrained = mode !== 'off'
      && ((manifest.node_types?.length ?? 0) > 0 || (manifest.edge_types?.length ?? 0) > 0);
    let manifestViolations = 0;
    const manifestViolationEdgeIds: string[] = [];
    if (constrained) {
      let after = '';
      for (;;) {
        const page = await this.lintRepo.pageLiveEdges(entityId, after, LINT_PAGE_SIZE);
        for (const e of page) {
          if (!edgeTripleAllowed(manifest, e.edge_type, e.source_type ?? '', e.target_type ?? '')) {
            manifestViolations++;
            if (manifestViolationEdgeIds.length < LINT_SAMPLE_SIZE) manifestViolationEdgeIds.push(e.id);
          }
        }
        if (page.length < LINT_PAGE_SIZE) break;
        after = page[page.length - 1].id;
      }
    }

    return {
      danglingEdges,
      manifestViolations,
      ...health,
      sample: { danglingEdgeIds, manifestViolationEdgeIds },
    };
  }
}
```

- [ ] **Step 7: Facade.** In `WikiMemory`:
  - Add the fields `private lintRepo: LintRepository;` and `private lintService: LintService;`.
  - Construct `this.lintRepo = new LintRepository(this.db, this.prefix);` next to the other repositories, and `this.lintService = new LintService(this.lintRepo, this.ontologyService);` after `ontologyService` exists.
  - Import both, and add the method after `pendingSources`:

```ts
  /** Read-only maintenance report for one entity (spec §8.1). Reports, never repairs. */
  async lint(entityId: string): Promise<WikiLintReport> {
    return this.lintService.lint(entityId);
  }
```

- [ ] **Step 8: Run the test and confirm it passes.** Same command as Step 2. Expected: PASS.

- [ ] **Step 9: Full suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 10: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/utils/ontology.ts packages/core/src/repositories/LintRepository.ts packages/core/src/services/LintService.ts packages/core/src/WikiMemory.ts packages/core/__tests__/lint.test.ts
git commit -m "feat(core): add read-only lint report for dangling edges, manifest violations and review backlog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `getInstructions` and the `wiki_get_instructions` manifest

**Files:**
- Modify: `packages/core/src/types.ts` (append)
- Modify: `packages/core/src/services/PromptService.ts` (new method after `buildOntologyBackfillPrompt`)
- Modify: `packages/core/src/WikiMemory.ts` (method after `lint`)
- Create: `packages/core-llm-tools/src/manifests/instructions.ts`
- Modify: `packages/core-llm-tools/src/index.ts`
- Test: `packages/core/__tests__/instructions.test.ts`, `packages/core-llm-tools/__tests__/manifests-instructions.test.ts`

**Interfaces:**
- Produces:
  - `export interface WikiInstructions { ingest: string; librarian: string; heal: string; ontologyBackfill: string }`
  - `PromptService.buildInstructionTemplates(ontologyContext: OntologyPromptContext | null): WikiInstructions`. Task 5 extends it with the grounding block.
  - `WikiMemory.getInstructions(entityId: string): Promise<WikiInstructions>`
  - `wikiGetInstructionsManifest: AgentToolManifest` (name `wiki_get_instructions`, scope `memory:read`, requires `entityId`)

- [ ] **Step 1: Write the failing core tests** in `packages/core/__tests__/instructions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';
import { PromptService } from '../src/services/PromptService';
import { HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from '../src/prompts';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }],
  edge_types: [],
};

describe('getInstructions', () => {
  it('returns defaults with no ontology block when ontology is off', async () => {
    const { wiki } = await makeDiagnosticWiki();
    const out = await wiki.getInstructions('e1');
    expect(Object.keys(out).sort()).toEqual(['heal', 'ingest', 'librarian', 'ontologyBackfill']);
    expect(out.ingest).toBe(INGEST_SYSTEM_PROMPT);
    expect(out.heal).toBe(HEAL_SYSTEM_PROMPT);
  });

  it('matches the system prompt each writer actually sends, ontology block included', async () => {
    const { wiki, generateText } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [], tasks: [] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: 'a'.repeat(64), documentChunk: 'SECRET CHUNK TEXT' }).catch(() => {});
    await wiki.write('e1', { event_type: 'observation', summary: 'SECRET EVENT TEXT' });
    await wiki.runLibrarian('e1');
    const sent = generateText.mock.calls.map(([p]) => p.systemPrompt);
    const out = await wiki.getInstructions('e1');
    expect(out.ingest).toContain('## Ontology constraints');
    expect(sent).toContain(out.ingest);
    expect(sent).toContain(out.librarian);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('applies overrides verbatim and leaves data placeholders unhydrated', async () => {
    const { wiki } = await makeDiagnosticWiki({
      config: { prompts: {
        ingestSystemPrompt: 'Ingest {{documentChunk}} under {{ontologyModeInstructions}}',
        healSystemPrompt: 'Heal {{healCandidates}} with {{recentEvents}}',
      } },
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    const out = await wiki.getInstructions('e1');
    expect(out.ingest.startsWith('Ingest {{documentChunk}} under ## Ontology constraints')).toBe(true);
    expect(out.heal).toBe('Heal {{healCandidates}} with {{recentEvents}}');
  });

  it('PromptService equivalence: instruction templates equal the runtime system prompts for default templates', () => {
    const svc = new PromptService();
    const ctx = { ontologyManifest: '{}', ontologyModeInstructions: 'ONTOLOGY' };
    const t = svc.buildInstructionTemplates(ctx);
    expect(t.ingest).toBe(svc.buildIngestPrompt('chunk', undefined, ctx).systemPrompt);
    expect(t.librarian).toBe(svc.buildLibrarianPrompt([], [], undefined, ctx).systemPrompt);
    expect(t.heal).toBe(svc.buildHealPrompt([{ id: 'c' }], [], [], [], undefined, 0).prompts.systemPrompt);
    expect(t.ontologyBackfill).toBe(svc.buildOntologyBackfillPrompt([], undefined, ctx).systemPrompt);
  });
});
```

The ingest call returns zero facts, which may raise `WikiIngestEmptyError` or return normally; the `.catch` keeps the test about the prompt that was sent. If the prompt names differ in `src/prompts.ts`, fix only the imports.

- [ ] **Step 2: Write the failing tools test** in `packages/core-llm-tools/__tests__/manifests-instructions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { wikiGetInstructionsManifest } from '../src/manifests/instructions';
import * as CoreLlmTools from '../src/index';

describe('wikiGetInstructionsManifest', () => {
  it('is a memory:read function tool named wiki_get_instructions that requires entityId', () => {
    expect(wikiGetInstructionsManifest.name).toBe('wiki_get_instructions');
    expect(wikiGetInstructionsManifest.scope).toBe('memory:read');
    expect(wikiGetInstructionsManifest.schema.name).toBe(wikiGetInstructionsManifest.name);
    expect(wikiGetInstructionsManifest.schema.parameters?.required).toEqual(['entityId']);
  });

  it('is exported from the package entry point', () => {
    expect(CoreLlmTools.wikiGetInstructionsManifest).toBe(wikiGetInstructionsManifest);
  });
});
```

- [ ] **Step 3: Run both and confirm they fail.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/instructions.test.ts` and `pnpm --filter ./packages/core-llm-tools exec vitest run __tests__/manifests-instructions.test.ts`. Expected: both FAIL (missing method or module).

- [ ] **Step 4: Type.** Append to `packages/core/src/types.ts`:

```ts
/**
 * Effective system prompts (spec §8.3): defaults with `WikiConfig.prompts`
 * overrides applied and the ontology block appended. Templates only: data
 * placeholders such as `{{documentChunk}}` stay verbatim, and no events,
 * chunks or facts are ever included. Overrides are returned as written, so
 * never put secrets or private data in `WikiConfig.prompts`.
 */
export interface WikiInstructions {
  ingest: string;
  librarian: string;
  heal: string;
  ontologyBackfill: string;
}
```

- [ ] **Step 5: `PromptService.buildInstructionTemplates`.** Add after `buildOntologyBackfillPrompt` (import `WikiInstructions` into the existing `../types` type import):

```ts
  /**
   * The system prompt each writer would send, without hydrating data (spec
   * §8.3). `buildSystemPrompt` with no variables hydrates only ontology
   * placeholders and leaves data placeholders verbatim; heal never receives
   * ontology context, matching `buildHealPrompt`.
   */
  buildInstructionTemplates(ontologyContext: OntologyPromptContext | null): WikiInstructions {
    const o = this.globalOverrides;
    return {
      ingest: this.buildSystemPrompt(o?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT, {}, ontologyContext),
      librarian: this.buildSystemPrompt(o?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT, {}, ontologyContext),
      heal: o?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT,
      ontologyBackfill: this.buildSystemPrompt(o?.ontologyBackfillSystemPrompt ?? ONTOLOGY_BACKFILL_SYSTEM_PROMPT, {}, ontologyContext),
    };
  }
```

- [ ] **Step 6: Facade.** In `WikiMemory`, after `lint` (import `WikiInstructions`):

```ts
  /**
   * Effective system prompts for ingest, librarian, heal and ontology backfill
   * (spec §8.3). Backs the `wiki_get_instructions` tool. Templates only;
   * overrides are returned verbatim, so keep secrets out of `WikiConfig.prompts`.
   */
  async getInstructions(entityId: string): Promise<WikiInstructions> {
    const ontologyContext = await this.ontologyService.buildPromptContext(entityId);
    return this.promptService.buildInstructionTemplates(ontologyContext);
  }
```

- [ ] **Step 7: Manifest.** Create `packages/core-llm-tools/src/manifests/instructions.ts`:

```ts
import type { AgentToolManifest } from '../types';

/**
 * Schema only. Hosts dispatch it to `WikiMemory.getInstructions(entityId)`.
 * The result includes `WikiConfig.prompts` overrides verbatim, so any client
 * granted `memory:read` can read them.
 */
export const wikiGetInstructionsManifest: AgentToolManifest = {
  name: 'wiki_get_instructions',
  scope: 'memory:read',
  schema: {
    name: 'wiki_get_instructions',
    description:
      "Retrieve the rules the memory engine follows when it writes: the effective system instructions for ingest, librarian, heal and ontology backfill, with the user's configured overrides and ontology constraints applied. Read these before proposing facts so your output follows the same rules. Returns instruction templates only, never stored memory content.",
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID whose instructions to fetch.' },
      },
      required: ['entityId'],
    },
  },
};
```

In `packages/core-llm-tools/src/index.ts`, add:

```ts
export { wikiGetInstructionsManifest } from './manifests/instructions';
```

- [ ] **Step 8: Run both tests and confirm they pass.** Same commands as Step 3. Expected: PASS. Then run the whole tools suite: `pnpm --filter ./packages/core-llm-tools test`. Expected: 52 + 2 passing.

- [ ] **Step 9: Full core suite and typecheck.** Expected: green, exit 0.

- [ ] **Step 10: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/services/PromptService.ts packages/core/src/WikiMemory.ts packages/core/__tests__/instructions.test.ts packages/core-llm-tools/src/manifests/instructions.ts packages/core-llm-tools/src/index.ts packages/core-llm-tools/__tests__/manifests-instructions.test.ts
git commit -m "feat(core): expose effective system prompts via getInstructions and wiki_get_instructions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Docs, verification, PR

**Files:**
- Modify: `packages/core/README.md`:
  - extend `## Batch Change Detection` (~line 1156);
  - add `## Lint` directly after it;
  - add ``### Effective instructions (`getInstructions`)`` at the end of `## Prompt Management & Overrides`, before `## Retrieval Tuning`.
- Modify: `packages/core-llm-tools/README.md` (short `### Memory manifests` subsection under `## Quick Start`, after `### 3. Built-In Tools (Grounding)`)

- [ ] **Step 1: Write the docs.** Grep each signature against source first (repo rule), and adjust the prose if anything differs.

Append inside `## Batch Change Detection`, after its code block:

````markdown
`pendingSources` returns one status per input, in order, and adds the partial-ingest state:

```typescript
const statuses = await wikiMemory.pendingSources('entity-123', batch);
// Array<{ sourceRef: string; status: 'new' | 'changed' | 'partial' | 'current' }>
```

- `current` means exactly what `hasChanged` returning `false` means.
- `partial` means live facts exist for the ref, but a failed chunk left them without a stored hash. Re-ingest to retry.
````

New section after it:

````markdown
## Lint

Read-only health report for one entity. It reports problems and never repairs them.

```typescript
const report = await wikiMemory.lint('entity-123');
// {
//   danglingEdges,       // source or target missing, soft-deleted, or another entity's
//   manifestViolations,  // (source type, edge type, target type) not in the effective manifest
//   untypedFacts,        // okf_type is null
//   drafts,              // lifecycle_status = 'draft' (see Draft Review)
//   unverifiedInferred,  // librarian_inferred facts with no okf_verified entry
//   sample: { danglingEdgeIds, manifestViolationEdgeIds }, // up to 20 each
// }
```

- Manifest violations are 0 when ontology is off or the manifest is empty.
- An edge with an untyped endpoint counts as a violation.
- Partial-ingest rows are not reported here; use `pendingSources`.
````

At the end of `## Prompt Management & Overrides`:

````markdown
### Effective instructions (`getInstructions`)

```typescript
const { ingest, librarian, heal, ontologyBackfill } = await wikiMemory.getInstructions('entity-123');
```

Returns the system prompt each writer sends, with `WikiConfig.prompts` overrides and the entity's ontology block applied. Data placeholders such as `{{documentChunk}}` stay unfilled; no events, chunks or facts are included. `core-llm-tools` exposes this as the `wiki_get_instructions` tool (`memory:read`), so agents can read the rules before proposing writes.

> **Warning:** overrides are returned verbatim to any client with `memory:read`. Never put secrets, API keys or private data in `WikiConfig.prompts`.
````

In `packages/core-llm-tools/README.md`:

````markdown
### Memory manifests

`wikiGetOntologyManifest`, `wikiTraverseGraphManifest` and `wikiGetInstructionsManifest` are schema-only `memory:read` tools. Dispatch them to `WikiMemory.getOntologyManifest`, `traverseGraph` and `getInstructions`. `wiki_get_instructions` returns your `WikiConfig.prompts` overrides verbatim, so keep secrets out of them.
````

- [ ] **Step 2: Full verification.** Run each and paste the real output into the report:
  - `pnpm --filter @equationalapplications/core-llm-wiki test`
  - `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - `pnpm --filter ./packages/core-llm-tools test`
  - `pnpm -r build && pnpm test`. Consumer packages resolve core through `dist/`, so build first.

  Expected: all green.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/README.md packages/core-llm-tools/README.md
git commit -m "docs: document lint, pendingSources and getInstructions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Gate check, then PR.** Run `git fetch origin && git cat-file -e origin/main:packages/core/src/utils/grounding.ts && echo PR3-MERGED`.
  - **If it prints `PR3-MERGED`:** do Task 5 now, then come back and run the commands below.
  - **Otherwise:** run the commands below now. The PR body must say "Do not merge before Task 5 (grounding block in getInstructions, gated on PR 3)".

```bash
git log --oneline origin/main..HEAD   # expect: this plan and the task commits only
git push -u origin feat/lint-pending-instructions
gh pr create --base main --title "feat(core): lint, pendingSources and wiki_get_instructions" --body "<summary, gate note if applicable, test evidence>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Tell the user the PR is ready, and whether Task 5 is still pending.

---

### Task 5 (GATED on PR 3 merged to `main`): grounding block in `getInstructions`

**Precondition (do not skip):** run `git fetch origin && git cat-file -e origin/main:packages/core/src/utils/grounding.ts`. It must succeed. Then run `git merge origin/main` (a merge commit; never rebase) and resolve conflicts by keeping both sides. Expect conflicts in:
- `PromptService.ts`: PR 3 changed the constructor and three builders; this PR added a method.
- `WikiMemory.ts`: imports and new methods.
- `README.md`: separate sections.

Re-run the full core suite. Expected: green before starting.

**Files:**
- Modify: `packages/core/src/services/PromptService.ts` (`buildInstructionTemplates`)
- Modify: `packages/core/README.md` (one sentence in the `getInstructions` subsection)
- Test: append to `packages/core/__tests__/instructions.test.ts`

**Interfaces:**
- Consumes (from PR 3): `new PromptService(overrides, resolveGrounding(cfg))`, `resolveGrounding`, and the private `appendGrounding(systemPrompt, writer)`. Confirm those names with `grep -n "appendGrounding\|groundingFor" packages/core/src/services/PromptService.ts`. If PR 3 landed different names, use the landed ones and record it.

- [ ] **Step 1: Write the failing test** (append to `instructions.test.ts`; add `import { resolveGrounding } from '../src/utils/grounding';` at the top):

```ts
describe('getInstructions with grounding', () => {
  it('appends the evidence block for grounding writers only, identical to the runtime prompt', () => {
    const svc = new PromptService(undefined, resolveGrounding({ mode: 'draft', writers: ['ingest', 'heal'] }));
    const ctx = { ontologyManifest: '{}', ontologyModeInstructions: 'ONTOLOGY' };
    const t = svc.buildInstructionTemplates(ctx);
    expect(t.ingest).toContain('EVIDENCE REQUIREMENT');
    expect(t.heal).toContain('EVIDENCE REQUIREMENT');
    expect(t.librarian).not.toContain('EVIDENCE REQUIREMENT');
    expect(t.ontologyBackfill).not.toContain('EVIDENCE REQUIREMENT');
    expect(t.ingest).toBe(svc.buildIngestPrompt('chunk', undefined, ctx).systemPrompt);
    expect(t.heal).toBe(svc.buildHealPrompt([{ id: 'c' }], [], [], [], undefined, 0).prompts.systemPrompt);
  });

  it('is unchanged when grounding is off', async () => {
    const { wiki } = await makeDiagnosticWiki({ config: { grounding: { mode: 'off', writers: ['ingest', 'librarian', 'heal'] } } });
    expect(JSON.stringify(await wiki.getInstructions('e1'))).not.toContain('EVIDENCE REQUIREMENT');
  });
});
```

- [ ] **Step 2: Run it and confirm the first test fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/instructions.test.ts`. Expected: FAIL. The ingest template lacks the block.

- [ ] **Step 3: Implement.** In `buildInstructionTemplates`, wrap the three writer entries:

```ts
      ingest: this.appendGrounding(this.buildSystemPrompt(o?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT, {}, ontologyContext), 'ingest'),
      librarian: this.appendGrounding(this.buildSystemPrompt(o?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT, {}, ontologyContext), 'librarian'),
      heal: this.appendGrounding(o?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT, 'heal'),
```

Leave `ontologyBackfill` as it is (not a grounding writer).

- [ ] **Step 4: Docs.** In the README `getInstructions` subsection, after the first sentence, add: "When `WikiConfig.grounding` is on, the evidence block is appended for each writer in `grounding.writers`, exactly as sent."

- [ ] **Step 5: Verify.** Run the test file (PASS), then the full core suite, typecheck, `pnpm -r build && pnpm test`. All green; paste the output.

- [ ] **Step 6: Commit and push.**

```bash
git add packages/core/src/services/PromptService.ts packages/core/README.md packages/core/__tests__/instructions.test.ts
git commit -m "feat(core): include the grounding block in getInstructions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

If the PR is already open, update its body with the Task 5 evidence and remove the do-not-merge note (`gh pr edit <n> --body ...`). Tell the user the PR is ready to merge as a merge commit.
