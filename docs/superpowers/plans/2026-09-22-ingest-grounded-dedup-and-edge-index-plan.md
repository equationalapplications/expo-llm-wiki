# Ingest Grounded Dedup & Edge Paging Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ingest dedupes by exact title, keep the best-grounded duplicate (#214). Make `lint()`'s keyset edge paging a bounded range scan with a composite `edges(entity_id, id)` index (#217).

**Architecture:**
- **PR A (#214):** the single dedup pass in `IngestionService.ingestDocument` becomes two passes.
  - Pass 1 picks one winner per `normalizeTitleKey` by rank (grounded = 1, else 0). A higher rank displaces the current winner; a tie keeps the first. Each loser gets its own `fact_deduplicated`.
  - Pass 2 rebuilds `orderedChunkFacts`, keeping each winner **in its own chunk's slot**, and fills `groundingLedger` for winners only.
  - Nothing downstream (`runFullUpsertGraph`, `appendPartialFacts`) changes.
- **PR B (#217):**
  - `schema.ts` swaps `edges_entity_idx (entity_id)` for `edges_entity_id_idx (entity_id, id)`.
  - Migration v12 creates the new index, then drops the old one.
  - No query text changes.

**Tech Stack:** TypeScript 5.9 (strict), vitest, pnpm workspace, better-sqlite3 (SQLite 3.53) in tests.

**Spec:** `docs/superpowers/specs/2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` (rev 1). §3 is PR A and §4 is PR B. If this plan and the spec disagree, the spec wins: stop and report.

## Global Constraints

> **Historical:** the separate-worktree and separate-branch workflow below was not used. Both changes were delivered on one branch (`spec/dedup-grounding-edge-index`) as PR #219. See spec rev 2.

- **PR A and PR B are independent.** Separate worktrees and branches, both based on `origin/main` @ `4ebf1bb` (or later `main`). Either can merge first.
  - PR A: worktree `.worktrees/dedup-grounded`, branch `fix/ingest-grounded-dedup`.
  - PR B: worktree `.worktrees/edges-index`, branch `perf/edges-entity-id-index`.
  - Run every command from the worktree root.
- **One-time setup per worktree:** `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`.
- **Commands:**
  - One core test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
  - Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
  - Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - Workspace build: `pnpm -r build`
- **Commit types:** PR A uses `fix(core): …`, PR B uses `perf(core): …`, docs use `docs: …` / `docs(spec): …`.
  - **Never start a commit body line with the words `BREAKING CHANGE`.** Semantic-release parses that as a footer and cuts a major. Neither PR is breaking.
- **Spec and code go in separate commits.** Spec edits are appended as revisions; existing revision entries are never rewritten.
- **Merge as merge commits only, never squash.** The controller does not merge; the user does.
- **Grounding off is byte-identical to today (REQ-COMPAT).** With grounding off, every rank is 0, so the winner is always the first one seen.
- **`fact_deduplicated` shape is unchanged:**
  - `{ sourceRef, chunkIndex, itemIndex, reason: 'exact_title' }`, severity `info`, from the chunk dedup.
  - `{ sourceRef, reason: 'exact_title' }` from the partial path's stored-fact dedup.
  - No new reason slugs.
- **Regression gate (spec §3.6):** every existing test passes unchanged. If an existing expectation shifts, stop and report the case. Do not edit the expectation.
- **Known local test-runner issue (found at plan time, 2026-09-22).** On the plan author's machine (Node 24.21.0), the full core suite on unmodified `4ebf1bb` reports 13 `Worker exited unexpectedly` errors from vitest's forks pool: 115/128 files, 1323/1493 tests complete, with zero assertion failures. `--pool=threads` aborts (SIGABRT) and `--no-file-parallelism` also crashes. CI (Node 24.20.0) is green on the same commit. The cause is unconfirmed (the Node patch version is one suspect).
  - Record the local baseline (files and tests passed, error count) before changing anything. Judge the full-suite gate as "no assertion failures, and completed counts ≥ baseline plus the new tests". **CI is the authoritative gate.**
  - Single-file runs are reliable. For the red phase of a multi-failure test file, forks may crash while reporting several failures at once. Re-run that file with `--pool=threads`, which works for single files.
  - Don't try to fix the runner inside these PRs. If Node 24.20.0 is available (`nvm use 24.20.0`), prefer it.
- Plans live in the gitignored `docs/superpowers/plans/`. Commit this file with `git add -f`.

---

## Task 0: Docs PR for the spec and this plan

**Files:**
- Already committed: `docs/superpowers/specs/2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` (branch `spec/dedup-grounding-edge-index`, commit `85b1c04`)
- Add: `docs/superpowers/plans/2026-09-22-ingest-grounded-dedup-and-edge-index-plan.md`

- [ ] **Step 1: Commit the plan on the spec branch**

```bash
git switch spec/dedup-grounding-edge-index
git add -f docs/superpowers/plans/2026-09-22-ingest-grounded-dedup-and-edge-index-plan.md
git commit -m "docs(plan): implementation plan for grounded ingest dedup and edges index

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Check for phantom diffs, then push and open the PR**

```bash
git log --oneline origin/main..HEAD   # expect exactly the spec commit and the plan commit
git push -u origin spec/dedup-grounding-edge-index
gh pr create --base main --title "docs(spec): grounded ingest dedup and edges paging index (#214, #217)" --body "$(cat <<'EOF'
Spec and implementation plan for #214 and #217. One spec, two independent code PRs to follow:

- PR A (#214, `fix(core)`): when ingest dedupes by exact title, keep the best-grounded duplicate. The winner stays in its own chunk's slot so emergent ontology updates still merge first.
- PR B (#217, `perf(core)`): migration v12 replaces `edges_entity_idx` with a composite `edges(entity_id, id)` index, so `lint()` keyset paging is a bounded range scan.

No code changes in this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR A: Keep the best-grounded duplicate (#214)

Setup (once):

```bash
git fetch origin
git worktree add .worktrees/dedup-grounded -b fix/ingest-grounded-dedup origin/main
cd .worktrees/dedup-grounded
pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build
pnpm --filter @equationalapplications/core-llm-wiki test   # record the baseline count; all must pass
```

### Task A1: Two-pass winner selection in ingest dedup

**Files:**
- Create: `packages/core/__tests__/groundingIngestDedup.test.ts`
- Modify: `packages/core/src/services/IngestionService.ts:236-275`. This is the block that starts `// Single pass: collect failures, dedup ok facts against the cross-chunk` and ends with `orderedChunkFacts.push({ facts: dedupedFacts, ontology_updates: slot.ontology_updates });` plus the closing `}` of the `for` loop.

**Interfaces:**
- Consumes (all existing):
  - `ChunkResult` (`IngestionService.ts:23`)
  - `normalizeTitleKey(title: string): string`
  - `GroundingVerdict` (`status: 'grounded' | 'missing' | 'failed'`)
  - `ingestGrounding` (a `ResolvedGrounding | null` local, `IngestionService.ts:138`)
  - `DiagnosticBuffer.push`
- Produces: nothing new. `orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }>` and `groundingLedger: Map<ExtractedFact, { verdict: GroundingVerdict; chunkIndex: number; itemIndex: number }>` keep their names and types, so `runFullUpsertGraph` and `appendPartialFacts` are untouched.

**Test fixture facts, verified:**
- `maxChunkLength: 40, chunkOverlap: 0` splits a doc on `\n\n` into one chunk per paragraph (the same pattern as `groundingIngest.test.ts`'s partial-path test).
- The default `minEvidenceChars` is 20.
- Each chunk's user prompt contains that chunk's text, so the stub LLM routes on `userPrompt.includes(...)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__tests__/groundingIngestDedup.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, factRows, GROUNDED, HASH_A, HASH_B } from './helpers/groundingHarness';
import type { SQLiteAdapter } from '../src/types';

// Two paragraphs → two chunks at maxChunkLength 40 (one per paragraph).
const A_TEXT = 'Alpha paragraph has no engine facts.';
const B_TEXT = 'Babbage designed the engine in 1837.';
const DOC = `${A_TEXT}\n\n${B_TEXT}`;
const QUOTE_A = 'Alpha paragraph has no engine';
const QUOTE_B = 'Babbage designed the engine';
const FAKE = 'Lovelace designed the engine in 1843';

const ON = { grounding: { mode: 'draft' as const }, maxChunkLength: 40, chunkOverlap: 0 };
const OFF = { maxChunkLength: 40, chunkOverlap: 0 };

type F = { title: string; body: string; tags: string[]; confidence: string; evidence?: string[]; okf_type?: string; edges?: object[] };
const fact = (title: string, body: string, evidence?: string[], extra: Partial<F> = {}): F =>
  ({ title, body, tags: [], confidence: 'certain', ...(evidence ? { evidence } : {}), ...extra });

/** Stub LLM: routes each chunk by its text. `BROKEN` chunks return unparseable output. */
function perChunk(byChunk: { a?: object; b?: object }) {
  return async ({ userPrompt }: { userPrompt: string }) => {
    if (userPrompt.includes('BROKEN')) return 'not json';
    if (userPrompt.includes(B_TEXT)) return JSON.stringify(byChunk.b ?? { facts: [] });
    if (userPrompt.includes(A_TEXT)) return JSON.stringify(byChunk.a ?? { facts: [] });
    return JSON.stringify({ facts: [] });
  };
}

async function bodyOf(db: SQLiteAdapter, title: string): Promise<string> {
  const row = await db.getFirstAsync<{ body: string }>(
    `SELECT body FROM llm_wiki_entries WHERE entity_id = 'e1' AND title = ? AND deleted_at IS NULL`, [title]);
  return row!.body;
}

const dedup = (chunkIndex: number, itemIndex: number) =>
  ({ sourceRef: 'doc.md', chunkIndex, itemIndex, reason: 'exact_title' });

afterEach(() => vi.restoreAllMocks());

describe('ingest title dedup prefers a grounded duplicate (spec REQ-DEDUP-01)', () => {
  it('scenario 1: ungrounded first, grounded second → the grounded one is stored stable', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    const res = await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(res.chunks).toBe(2);
    const rows = await factRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'X', lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('from B');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it('scenario 2: grounded first, ungrounded second → first kept', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', [QUOTE_A])] },
      b: { facts: [fact('X', 'from B')] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
    expect(ofCode(h.diagnostics, 'grounding_missing')).toEqual([]);
  });

  it('scenario 3: missing first, failed second (a tie) → first kept as draft', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [FAKE])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    const [row] = await factRows(h.db);
    expect(row).toMatchObject({ lifecycle_status: 'draft', okf_verified: null });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'grounding_missing').map((d) => d.detail)).toEqual([
      { factId: row.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 0, reason: 'no_evidence' },
    ]);
    expect(ofCode(h.diagnostics, 'grounding_failed')).toEqual([]);
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });

  it('scenario 4: two grounded duplicates → first kept', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', [QUOTE_A])] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });

  it('scenario 5: same-chunk duplicates → the grounded later item wins; the loser keeps its own indexes', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      b: { facts: [fact('X', 'first'), fact('Y', 'y', [QUOTE_B]), fact('X', 'second', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: B_TEXT });
    const rows = await factRows(h.db);
    expect(rows.map((r) => r.title)).toEqual(['X', 'Y']);
    expect(rows[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('second');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
  });

  it('scenario 6: emergent — a winner from a later chunk keeps the type its own chunk introduced', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', undefined, { okf_type: 'machine' })] },
      b: {
        ontology_updates: {
          node_types: [{ type: 'machine', description: 'A machine' }],
          edge_types: [{ type: 'designed_by', source_type: 'machine', target_type: 'person', description: 'Designed by' }],
        },
        facts: [
          fact('Babbage', 'person', [QUOTE_B], { okf_type: 'person' }),
          fact('X', 'from B', [QUOTE_B], { okf_type: 'machine', edges: [{ edge_type: 'designed_by', target_title: 'Babbage' }] }),
        ],
      },
    }) });
    await h.wiki.setOntologyManifest('e1', {
      node_types: [{ type: 'person', description: 'A person' }],
      edge_types: [],
    }, { mode: 'emergent' });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });

    const x = await h.db.getFirstAsync<{ id: string; okf_type: string | null; body: string }>(
      `SELECT id, okf_type, body FROM llm_wiki_entries WHERE entity_id = 'e1' AND title = 'X' AND deleted_at IS NULL`);
    expect(x).toMatchObject({ okf_type: 'machine', body: 'from B' });
    const edges = await h.db.getAllAsync<{ edge_type: string }>(
      `SELECT edge_type FROM llm_wiki_edges WHERE entity_id = 'e1' AND source_id = ?`, [x!.id]);
    expect(edges).toEqual([{ edge_type: 'designed_by' }]);
  });

  it('scenario 7: grounding off → the first duplicate wins even when a later one carries evidence', async () => {
    const h = await makeDiagnosticWiki({ config: OFF, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });
});

describe('ingest title dedup, partial path', () => {
  it('scenario 8a: a third chunk fails → the same grounded winner is chosen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    const res = await h.wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: `${DOC}\n\nBROKEN chunk text here.`,
    });
    expect(res.failedChunks).toBe(1);
    const [row] = await factRows(h.db);
    expect(row).toMatchObject({ title: 'X', lifecycle_status: 'stable', okf_verified: GROUNDED, source_hash: null });
    expect(await bodyOf(h.db, 'X')).toBe('from B');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
  });

  it('scenario 8b: a fact already stored for the sourceRef still beats a new grounded one (out of scope, unchanged)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let phase: 1 | 2 = 1;
    const h = await makeDiagnosticWiki({ config: ON, generateText: async ({ userPrompt }) => {
      if (userPrompt.includes('BROKEN')) return 'not json';
      if (phase === 1) return JSON.stringify({ facts: [fact('X', 'stored draft')] });
      return JSON.stringify({ facts: [fact('X', 'new grounded', [QUOTE_B])] });
    } });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: B_TEXT });
    phase = 2;
    h.diagnostics.length = 0;
    await h.wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: `${B_TEXT}\n\nBROKEN chunk text here.`,
    });
    const rows = await factRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lifecycle_status: 'draft' });
    expect(await bodyOf(h.db, 'X')).toBe('stored draft');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([{ sourceRef: 'doc.md', reason: 'exact_title' }]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm the right ones fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingIngestDedup.test.ts --pool=threads`. Use `--pool=threads` here: see the runner note in Global Constraints. The plan author reproduced this exact split on `4ebf1bb`.

Expected:
- **FAIL:** scenarios 1, 5, 6 and 8a. The stored body is the first duplicate's (`from A` / `first`), and the dedup diagnostic points at the later item.
- **PASS:** scenarios 2, 3, 4, 7 and 8b. They pin behavior that must not change.

If any of 2/3/4/7/8b fail, or 1/5/6/8a pass, stop. The fixture doesn't do what this plan assumes (for example, the chunking differs), and that must be fixed in the test, not the implementation.

- [ ] **Step 3: Implement the two passes**

In `packages/core/src/services/IngestionService.ts`, replace this block:

```ts
      // Single pass: collect failures, dedup ok facts against the cross-chunk
      // `seen` set, and count `ingestedChunks` / `failedChunks` together.
      let ingestedChunks = 0;
      let failedChunks = 0;
      const failures: ChunkFailure[] = [];
      const seen = new Set<string>();
      const orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }> = [];
      // Keyed by fact object identity: the same objects flow through dedupe,
      // the full path and the partial path. Empty when grounding is off.
      const groundingLedger = new Map<ExtractedFact, { verdict: GroundingVerdict; chunkIndex: number; itemIndex: number }>();
      const diagBuffer = new DiagnosticBuffer();
      const diagBase = { entityId, operation: 'ingest' as const, trigger: 'call' as const };
      for (const [chunkIndex, slot] of chunkResults.entries()) {
        if (slot.status === 'failed') {
          failedChunks++;
          failures.push(slot.error);
          continue;
        }
        ingestedChunks++;
        for (const r of slot.rejected) {
          diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { sourceRef, chunkIndex, itemIndex: r.itemIndex, reason: r.reason } });
        }
        const dedupedFacts: ExtractedFact[] = [];
        slot.facts.forEach((fact, k) => {
          const normalizedTitle = normalizeTitleKey(fact.title);
          if (!seen.has(normalizedTitle)) {
            seen.add(normalizedTitle);
            dedupedFacts.push(fact);
            if (ingestGrounding) groundingLedger.set(fact, { verdict: slot.verdicts[k], chunkIndex, itemIndex: slot.itemIndexes[k] });
          } else {
            diagBuffer.push({
              ...diagBase, code: 'fact_deduplicated',
              detail: { sourceRef, chunkIndex, itemIndex: slot.itemIndexes[k], reason: 'exact_title' },
            });
          }
        });
        orderedChunkFacts.push({ facts: dedupedFacts, ontology_updates: slot.ontology_updates });
      }
```

with:

```ts
      // Pass 1: collect failures, count chunks, and pick one winner per
      // normalized title across chunks. A grounded duplicate beats an
      // ungrounded one; on a tie the first seen wins. With grounding off
      // every rank is 0, so the first seen always wins (the pre-grounding
      // rule). Each loser gets exactly one `fact_deduplicated` carrying its
      // own locators.
      let ingestedChunks = 0;
      let failedChunks = 0;
      const failures: ChunkFailure[] = [];
      const winners = new Map<string, { chunkIndex: number; k: number; itemIndex: number; rank: number }>();
      const diagBuffer = new DiagnosticBuffer();
      const diagBase = { entityId, operation: 'ingest' as const, trigger: 'call' as const };
      const pushDeduplicated = (chunkIndex: number, itemIndex: number) => {
        diagBuffer.push({
          ...diagBase, code: 'fact_deduplicated',
          detail: { sourceRef, chunkIndex, itemIndex, reason: 'exact_title' },
        });
      };
      for (const [chunkIndex, slot] of chunkResults.entries()) {
        if (slot.status === 'failed') {
          failedChunks++;
          failures.push(slot.error);
          continue;
        }
        ingestedChunks++;
        for (const r of slot.rejected) {
          diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { sourceRef, chunkIndex, itemIndex: r.itemIndex, reason: r.reason } });
        }
        slot.facts.forEach((fact, k) => {
          const key = normalizeTitleKey(fact.title);
          const candidate = { chunkIndex, k, itemIndex: slot.itemIndexes[k], rank: slot.verdicts[k]?.status === 'grounded' ? 1 : 0 };
          const current = winners.get(key);
          if (!current) {
            winners.set(key, candidate);
          } else if (candidate.rank > current.rank) {
            pushDeduplicated(current.chunkIndex, current.itemIndex);
            winners.set(key, candidate);
          } else {
            pushDeduplicated(candidate.chunkIndex, candidate.itemIndex);
          }
        });
      }

      // Pass 2: each winner stays in its own chunk's slot, never the slot of
      // the duplicate it displaced. Emergent `ontology_updates` merge per
      // slot before that slot's facts are validated, so a winner must sit
      // with the chunk whose manifest additions it may depend on.
      const orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }> = [];
      // Keyed by fact object identity: the same objects flow through the
      // full path and the partial path. Empty when grounding is off.
      const groundingLedger = new Map<ExtractedFact, { verdict: GroundingVerdict; chunkIndex: number; itemIndex: number }>();
      for (const [chunkIndex, slot] of chunkResults.entries()) {
        if (slot.status === 'failed') continue;
        const keptFacts: ExtractedFact[] = [];
        slot.facts.forEach((fact, k) => {
          const winner = winners.get(normalizeTitleKey(fact.title));
          if (winner?.chunkIndex !== chunkIndex || winner.k !== k) return;
          keptFacts.push(fact);
          if (ingestGrounding) groundingLedger.set(fact, { verdict: slot.verdicts[k], chunkIndex, itemIndex: winner.itemIndex });
        });
        orderedChunkFacts.push({ facts: keptFacts, ontology_updates: slot.ontology_updates });
      }
```

Notes:
- `slot.verdicts[k]?.status` uses optional chaining because `verdicts` is `[]` when ingest isn't a grounding writer, so the rank is 0.
- A slot whose facts all lost still pushes its `ontology_updates` (spec §3.2).

- [ ] **Step 4: Run the new tests**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/groundingIngestDedup.test.ts`
Expected: all 9 pass. (The plan author applied this exact Step 3 code to `4ebf1bb`: 9/9 pass, typecheck clean.)

- [ ] **Step 5: Run the regression gate**

Run:

```bash
pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsIngest.test.ts __tests__/groundingIngest.test.ts __tests__/groundingOff.test.ts __tests__/groundingHeal.test.ts __tests__/instructions.test.ts
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter @equationalapplications/core-llm-wiki typecheck
```

Expected: the five named files pass. The full suite has no assertion failures, and completed counts are at least the recorded baseline plus 9 (see the runner note). Typecheck is clean. If any existing test fails an assertion, stop and report the test name and diff. Do not edit its expectation.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/IngestionService.ts packages/core/__tests__/groundingIngestDedup.test.ts
git commit -m "fix(core): keep the best-grounded duplicate when ingest titles match

Ingest dedup by normalized title now picks a winner per title: a
grounded duplicate beats an ungrounded one, and ties keep the first seen.
With grounding off every fact ranks equal, so behavior is unchanged.
The winner stays in its own chunk's slot so emergent ontology updates
from that chunk still merge before it is validated. Each losing
duplicate gets one fact_deduplicated with its own locators.

Closes #214

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task A2: Document the rule (README, then the grounding spec rev 10)

**Files:**
- Modify: `packages/core/README.md`, the `## Grounding` bullet list (after the `- **Diagnostics.** …` bullet, around line 363)
- Modify: `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md`: header line 4, §6.5 (after the outcomes table's bullets), and the revision log (append after the last `- **Status revision (2026-09-22):**` entry and its sub-bullet)

- [ ] **Step 1: README bullet**

Insert after the `- **Diagnostics.** …` bullet in `## Grounding`:

```markdown
- **Duplicate titles in one ingest.** When chunks yield facts with the same title, ingest keeps one: a grounded fact beats one with missing or failed evidence, and on a tie the first one wins. The others are reported as `fact_deduplicated`. A fact already stored for the same `sourceRef` is not replaced by a later partial ingest.
```

- [ ] **Step 2: Commit the README**

```bash
git add packages/core/README.md
git commit -m "docs: note which duplicate ingest keeps when grounding is on

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Grounding spec amendment (spec-only commit)**

Make three edits in `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md`:

1. Header line 4. Change `**Status:** Implemented — revision 9;` to `**Status:** Implemented — revision 10;`. Leave the rest of the line unchanged.
2. §6.5, after the `- Mode 'off': …` bullet, add:

   ```markdown
   - Duplicate titles within one ingest call (rev 10, #214): the fact with the best verdict is kept, `grounded` over `missing`/`failed`; on a tie the first seen is kept. The kept fact stays in its own chunk's slot. See `2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §3.
   ```

3. Append to the revision log, after the last existing entry:

   ```markdown
   - **rev 10 (2026-09-22):** post-series amendment (#214).
     - §6.5: ingest title dedup now keeps the best-grounded duplicate instead of the first one seen. Before grounding the choice didn't matter; with `mode: 'draft'` it decided whether a fact landed `stable` or `draft` based only on chunk order. Grounding off is unchanged. Design: `2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §3.
   ```

- [ ] **Step 4: Commit the spec amendment alone**

```bash
git add docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md
git commit -m "docs(spec): grounding rev 10 — ingest dedup keeps the grounded duplicate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task A3: Verify and open PR A

- [ ] **Step 1: Full verification**

```bash
pnpm -r build
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter @equationalapplications/core-llm-wiki typecheck
git log --oneline origin/main..HEAD   # expect exactly 3 commits: fix(core), docs README, docs(spec)
git diff --stat origin/main...HEAD    # expect only IngestionService.ts, the new test, README.md, the grounding spec
```

Expected: build exit 0, all tests pass, typecheck clean, no unrelated files in the diff.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/ingest-grounded-dedup
gh pr create --base main --title "fix(core): keep the best-grounded duplicate when ingest titles match (#214)" --body "$(cat <<'EOF'
Closes #214. Spec: `docs/superpowers/specs/2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §3.

- Ingest title dedup is now two passes. Pass 1 picks one winner per normalized title: a grounded duplicate beats one with missing or failed evidence, and a tie keeps the first. Pass 2 keeps each winner in its own chunk's slot, so emergent `ontology_updates` from that chunk still merge before it is validated.
- Each losing duplicate gets one `fact_deduplicated` with its own `chunkIndex`/`itemIndex`. The shape and reason are unchanged.
- Grounding off: unchanged (every rank is equal, so the first one wins).
- Out of scope, unchanged: the partial path's dedup against facts already stored for the `sourceRef`, and librarian/heal fuzzy dedup.
- Docs: a README note, and grounding spec rev 10 in its own commit.

Tests: `groundingIngestDedup.test.ts` covers spec §3.6 scenarios 1–8. All existing tests pass unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR B: Composite edges index (#217)

Setup (once):

```bash
git fetch origin
git worktree add .worktrees/edges-index -b perf/edges-entity-id-index origin/main
cd .worktrees/edges-index
pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build
pnpm --filter @equationalapplications/core-llm-wiki test   # record the baseline count
```

### Task B1: Migration v12, schema swap, and query-plan tests

**Files:**
- Create: `packages/core/__tests__/migration12.test.ts`
- Create: `packages/core/__tests__/edgeQueryPlans.test.ts`
- Modify: `packages/core/src/db/schema.ts:94`
- Modify: `packages/core/src/db/migrations.ts`: append a v12 entry after the v11 entry (which ends just before `];` at about line 295)
- Modify: `packages/core/__tests__/migration2.test.ts:63,80,82,104`

**Interfaces:**
- Consumes:
  - `MIGRATIONS` and `CURRENT_SCHEMA_VERSION` (`src/db/migrations.ts`)
  - `openTestDatabase()` (`__tests__/helpers/sqliteAdapter.ts`)
  - `new EdgeRepository(db, prefix)` and `new LintRepository(db, prefix)`. Both take `(db: SQLiteAdapter, prefix: string)` via `BaseRepository`.
  - `EdgeRepository.getByEntityId(entityId, tx?)`, `EdgeRepository.bulkDeleteByEntityId(entityId, tx)` and `EdgeRepository.softDeleteBySourceFactIds(entityId, ids, tx)`.
  - `LintRepository.countDanglingEdges(entityId)`, `LintRepository.sampleDanglingEdgeIds(entityId, limit)` and `LintRepository.pageLiveEdges(entityId, afterId, limit)`.
- Produces:
  - index name `${prefix}edges_entity_id_idx` on `(entity_id, id)`
  - `CURRENT_SCHEMA_VERSION === 12`

- [ ] **Step 1: Write the migration test**

Create `packages/core/__tests__/migration12.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

async function freshDb(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}

/** Explicitly created (non-autoindex) indexes on edges, with their column lists. */
async function edgeIndexes(db: SQLiteAdapter): Promise<Record<string, string[]>> {
  const list = await db.getAllAsync<{ name: string; origin: string }>(`PRAGMA index_list(${PREFIX}edges)`);
  const out: Record<string, string[]> = {};
  for (const { name, origin } of list) {
    if (origin !== 'c') continue;
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA index_info(${name})`);
    out[name] = cols.map((c) => c.name);
  }
  return out;
}

async function schemaVersion(db: SQLiteAdapter): Promise<string | undefined> {
  return (await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`))?.value;
}

/** Turn a fresh DB back into a v11 DB: old index, no new index, version 11. */
async function downgradeToV11(db: SQLiteAdapter): Promise<void> {
  await db.execAsync(`
    DROP INDEX IF EXISTS ${PREFIX}edges_entity_id_idx;
    CREATE INDEX IF NOT EXISTS ${PREFIX}edges_entity_idx ON ${PREFIX}edges(entity_id);
  `);
  await db.runAsync(`UPDATE ${PREFIX}meta SET value = '11' WHERE key = 'schema_version'`);
}

describe('migration v12: composite edges(entity_id, id) index', () => {
  it('CURRENT_SCHEMA_VERSION is the last migration and at least 12', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('fresh install has edges_entity_id_idx on (entity_id, id) and no edges_entity_idx', async () => {
    const db = await freshDb();
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('upgrades a v11 database: new index present, old index gone, version stamped', async () => {
    const db = await freshDb();
    await downgradeToV11(db);
    expect(Object.keys(await edgeIndexes(db))).toEqual([`${PREFIX}edges_entity_idx`]);
    await db.runAsync(
      `INSERT INTO ${PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES ('edge_1', 'e1', 's', 't', 'rel', 0)`,
    );

    await new WikiMemory(db, stubOptions).setup();

    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
    expect(await schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    const kept = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${PREFIX}edges`);
    expect(kept).toEqual([{ id: 'edge_1' }]);
  });

  it('v12 itself creates the new index and drops the old one (independent of schema.ts)', async () => {
    // setup() re-runs schema.ts on existing databases before migrations, so the
    // upgrade test above would pass even if v12's CREATE were broken. Run v12
    // directly against a v11-shaped database to pin the migration on its own.
    const db = await freshDb();
    await downgradeToV11(db);
    await MIGRATIONS.find((m) => m.version === 12)!.run(db, PREFIX);
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('running v12 twice is a no-op', async () => {
    const db = await freshDb();
    const v12 = MIGRATIONS.find((m) => m.version === 12)!;
    await v12.run(db, PREFIX);
    await v12.run(db, PREFIX);
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('a fresh database and an upgraded database end with the same edges indexes', async () => {
    const fresh = await freshDb();
    const upgraded = await freshDb();
    await downgradeToV11(upgraded);
    await new WikiMemory(upgraded, stubOptions).setup();
    expect(await edgeIndexes(upgraded)).toEqual(await edgeIndexes(fresh));
  });
});
```

- [ ] **Step 2: Write the query-plan test**

This test captures the SQL each repository method actually issues, through a recording adapter, and runs `EXPLAIN QUERY PLAN` on it with the same arguments. That way the plans track the real query text and not a copy that could drift.

Create `packages/core/__tests__/edgeQueryPlans.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { EdgeRepository } from '../src/repositories/EdgeRepository';
import { LintRepository } from '../src/repositories/LintRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

type Call = { sql: string; args: unknown[] };

/** Wraps an adapter and records every statement that touches the edges table. */
function recording(db: SQLiteAdapter): { adapter: SQLiteAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (sql: string, args: unknown[] = []) => {
    if (sql.includes(`${PREFIX}edges`)) calls.push({ sql, args });
  };
  const adapter: SQLiteAdapter = {
    ...db,
    execAsync: async (sql) => { rec(sql); return db.execAsync(sql); },
    runAsync: async (sql, args = []) => { rec(sql, args); return db.runAsync(sql, args); },
    getAllAsync: async (sql, args = []) => { rec(sql, args); return db.getAllAsync(sql, args); },
    getFirstAsync: async (sql, args = []) => { rec(sql, args); return db.getFirstAsync(sql, args); },
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
  };
  return { adapter, calls };
}

async function plan(db: SQLiteAdapter, call: Call): Promise<string[]> {
  const rows = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${call.sql}`, call.args);
  return rows.map((r) => r.detail);
}

/** A full scan of edges: `SCAN e`, `SCAN llm_wiki_edges`, or a full index scan of either. */
const FULL_EDGE_SCAN = new RegExp(`\\bSCAN (TABLE )?(e|${PREFIX}edges)\\b`);

async function setup() {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  const { adapter, calls } = recording(db);
  return { db, calls, edges: new EdgeRepository(adapter, PREFIX), lint: new LintRepository(adapter, PREFIX), adapter };
}

describe('edges query plans (spec REQ-EDGEIDX-01)', () => {
  it('pageLiveEdges range-scans edges_entity_id_idx with no temp B-tree sort', async () => {
    const { db, calls, lint } = await setup();
    await lint.pageLiveEdges('e1', '', 500);
    expect(calls).toHaveLength(1);
    const detail = await plan(db, calls[0]);
    expect(detail.some((d) => d.includes(`USING INDEX ${PREFIX}edges_entity_id_idx`) || d.includes(`USING COVERING INDEX ${PREFIX}edges_entity_id_idx`))).toBe(true);
    expect(detail.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
  });

  it.each([
    ['countDanglingEdges', (r: { lint: LintRepository }) => r.lint.countDanglingEdges('e1')],
    ['sampleDanglingEdgeIds', (r: { lint: LintRepository }) => r.lint.sampleDanglingEdgeIds('e1', 20)],
    ['getByEntityId', (r: { edges: EdgeRepository }) => r.edges.getByEntityId('e1')],
  ] as const)('%s uses an index on edges, not a full scan', async (_name, invoke) => {
    const r = await setup();
    await invoke(r as never);
    expect(r.calls).toHaveLength(1);
    const detail = await plan(r.db, r.calls[0]);
    expect(detail.filter((d) => FULL_EDGE_SCAN.test(d))).toEqual([]);
  });

  it.each([
    ['bulkDeleteByEntityId', (edges: EdgeRepository, tx: SQLiteAdapter) => edges.bulkDeleteByEntityId('e1', tx)],
    ['softDeleteBySourceFactIds', (edges: EdgeRepository, tx: SQLiteAdapter) => edges.softDeleteBySourceFactIds('e1', ['f1', 'f2'], tx)],
  ] as const)('%s uses an index on edges, not a full scan', async (_name, invoke) => {
    const r = await setup();
    await invoke(r.edges, r.adapter);
    expect(r.calls).toHaveLength(1);
    const detail = await plan(r.db, r.calls[0]);
    expect(detail.filter((d) => FULL_EDGE_SCAN.test(d))).toEqual([]);
  });
});
```

Note: `bulkDeleteByEntityId` and `softDeleteBySourceFactIds` go through `BaseRepository.getExecutor(tx)`, which returns `tx ?? this.db` (verified). So passing the recording adapter as `tx` routes their SQL through the recorder. Don't copy SQL strings into the test.

- [ ] **Step 3: Run both new tests and confirm they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/migration12.test.ts __tests__/edgeQueryPlans.test.ts`

Expected:
- **FAIL** in `migration12.test.ts`, on every test (there's no v12 yet, so `MIGRATIONS.find(...)!` is undefined, `CURRENT_SCHEMA_VERSION` is 11, and the fresh install has `edges_entity_idx`).
- **FAIL** in `edgeQueryPlans.test.ts`, on the `pageLiveEdges` test (the plan uses `edges_entity_idx` and has `USE TEMP B-TREE FOR ORDER BY`).
- The five "uses an index" cases should already **PASS** today. They guard against regressions from dropping the old index. If any of them fails now, stop and report: it means baseline fact 9 in the spec is wrong.

- [ ] **Step 4: Swap the index in `schema.ts`**

In `packages/core/src/db/schema.ts`, replace:

```ts
    CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_idx ON ${prefix}edges(entity_id);
```

with:

```ts
    CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_id_idx ON ${prefix}edges(entity_id, id);
```

- [ ] **Step 5: Append migration v12**

In `packages/core/src/db/migrations.ts`, append after the v11 entry (keep the trailing comma style):

```ts
  {
    version: 12,
    description: 'Replace edges_entity_idx with composite edges(entity_id, id) for keyset paging',
    run: async (db, prefix) => {
      // lint() pages edges with `entity_id = ? AND id > ? ORDER BY id LIMIT ?`.
      // With only (entity_id) indexed, every page read and sorted the entity's
      // whole edge set. The composite index makes each page a bounded range
      // scan, and its leading column serves every other `entity_id = ?` edges
      // query, so the single-column index is redundant. Create before drop so
      // edges is never without an entity_id index. Both statements are
      // idempotent.
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_id_idx ON ${prefix}edges(entity_id, id);
        DROP INDEX IF EXISTS ${prefix}edges_entity_idx;
      `);
    },
  },
```

Leave the v5 migration's `CREATE INDEX … edges_entity_idx` unchanged. On an old database, v5 creates it and v12 removes it. Note that `WikiMemory.setup()` runs `setupDatabase` (`schema.ts`, all `IF NOT EXISTS`) on existing databases too, before migrations. So on upgrade the new index already exists by the time v12 runs, and v12's `CREATE` is a safety net. The direct-run test in `migration12.test.ts` pins it anyway.

- [ ] **Step 6: Unpin the version in `migration2.test.ts`**

In `packages/core/__tests__/migration2.test.ts`:
- Line 63: change `setup ends at version 11'` to `setup ends at CURRENT_SCHEMA_VERSION'` in the `describe` title.
- Line 82: change `version becomes 11'` to `version becomes CURRENT_SCHEMA_VERSION'` in the `it` title.
- Lines 80 and 104: change `expect(meta?.value).toBe('11');` to `expect(meta?.value).toBe(String(CURRENT_SCHEMA_VERSION));`.
- If the file doesn't already import `CURRENT_SCHEMA_VERSION`, add `import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';` next to its other imports.

Then check for other version pins: `grep -rn "toBe('11')\|toBe(11)\|version 11" packages/core/__tests__`. Any remaining hit about the current schema version gets the same treatment. Report each one in the task summary.

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/migration12.test.ts __tests__/edgeQueryPlans.test.ts __tests__/migration2.test.ts __tests__/migrations.test.ts __tests__/lint.test.ts
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter @equationalapplications/core-llm-wiki typecheck
```

Expected: all pass. The total equals the baseline plus the new tests (6 in `migration12`, 6 in `edgeQueryPlans`). `lint.test.ts` passes unchanged, including `sample` ordering. If the `pageLiveEdges` plan still shows `TEMP B-TREE`, or picks `sqlite_autoindex_llm_wiki_edges_1`, stop and report the full plan output. Don't add `INDEXED BY` or change the query without a spec amendment.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/migrations.ts packages/core/__tests__/migration12.test.ts packages/core/__tests__/edgeQueryPlans.test.ts packages/core/__tests__/migration2.test.ts
git commit -m "perf(core): composite edges(entity_id, id) index for lint keyset paging

Migration v12 adds edges_entity_id_idx on (entity_id, id) and drops the
now-redundant edges_entity_idx. lint() manifest-violation paging becomes
a bounded range scan with no temp B-tree sort, instead of reading and
sorting every edge of the entity on each page. Fresh installs get the
new index from schema.ts. No query text changes.

Closes #217

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task B2: Verify and open PR B

- [ ] **Step 1: Full verification**

```bash
pnpm -r build
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter @equationalapplications/core-llm-wiki typecheck
git log --oneline origin/main..HEAD   # expect exactly 1 commit: perf(core)
git diff --stat origin/main...HEAD    # expect only schema.ts, migrations.ts, the 2 new tests, migration2.test.ts (+ any other unpinned version test from B1 step 6)
```

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin perf/edges-entity-id-index
gh pr create --base main --title "perf(core): composite edges(entity_id, id) index for lint paging (#217)" --body "$(cat <<'EOF'
Closes #217. Spec: `docs/superpowers/specs/2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §4.

- Migration v12 creates `edges_entity_id_idx ON edges(entity_id, id)`, then drops the redundant `edges_entity_idx`. Fresh installs get the new index from `schema.ts`. `CURRENT_SCHEMA_VERSION` → 12.
- `pageLiveEdges` is now a range scan on the new index that stops at `LIMIT`, with no temp B-tree sort. That makes `lint()` O(E) instead of O(E²/500) for constrained ontologies.
- No query text changes. Every other `entity_id = ?` edges query still uses an index (asserted with `EXPLAIN QUERY PLAN` in `edgeQueryPlans.test.ts`, on the SQL each repository method actually issues).
- `migration2.test.ts` no longer pins the schema version to a literal.

Tests: `migration12.test.ts` (fresh, upgrade from v11, idempotent, fresh equals upgraded) and `edgeQueryPlans.test.ts`. `lint.test.ts` passes unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## After both PRs merge (ask the user first)

1. Append a Status revision to this series' spec (`2026-09-22-ingest-grounded-dedup-and-edge-index-design.md`) saying it's Implemented, with the PR numbers, and set its header Status. Commit it on its own as `docs(spec): …`, via a small PR.
2. Remove the `.worktrees/dedup-grounded` and `.worktrees/edges-index` worktrees and delete the merged local branches.
3. The plan stays committed.
