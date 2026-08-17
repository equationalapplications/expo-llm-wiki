# Spec: GraphRAG Positioning Across the Monorepo

**Date:** 2026-08-17
**Status:** Approved
**Status (2026-08-17):** Implemented via this spec — see commit history on `docs/graphrag-readme-positioning` for the per-file commit sequence.
**Branch:** docs/graphrag-readme-positioning
**Builds on:**
- [`2026-06-23-graph-traversal-api-design.md`](./2026-06-23-graph-traversal-api-design.md) — `traverseGraph`, `useWikiTraversal`, `formatGraphContext`
- [`2026-06-23-per-entity-seeded-ontology-design.md`](./2026-06-23-per-entity-seeded-ontology-design.md) — seeded ontology + `okf_type` + `EdgeRepository`
- [`2026-07-14-polymorphic-edge-triples-schema-org-package-spec.md`](./2026-07-14-polymorphic-edge-triples-schema-org-package-spec.md) — schema-org manifest (9 node types, 28 polymorphic edges)
- [`2026-08-16-documentation-update-summary.md`](./2026-08-16-documentation-update-summary.md) — most recent docs update pattern

**Packages touched:** `@equationalapplications/core-llm-wiki` (docs), `@equationalapplications/schema-org-llm-wiki` (docs), `@equationalapplications/expo-llm-wiki` (docs), `@equationalapplications/react-llm-wiki` (docs), `@equationalapplications/core-llm-tools` (docs), `@equationalapplications/core-okf` (docs), `@equationalapplications/prisma-outbox` (docs), `apps/wiki-demo` (docs), root `/README.md`. **Source code unchanged.** The only non-markdown edit is a single step added to an existing GitHub Actions workflow yaml (CI drift guard).

---

## Problem

The repository already implements a SQL-only graph retrieval engine:
- `EdgeRepository.getNeighborhood()` runs a recursive CTE with direction-neutral edge walking, cycle guarding, and confidence weighting.
- `traverseGraph(entityId, options)` exposes it as a public API.
- `useWikiTraversal` (React) and `WikiProvider` (React Native) re-export it as hooks.
- `formatGraphContext(neighborhood)` serializes the result into a dense text block suitable for prompt injection.
- `upsertGraph()` writes graph data deterministically (no LLM call).
- `@equationalapplications/schema-org-llm-wiki` ships a curated, JSON-LD-ready ontology (9 node types, 28 polymorphic edges) for warm-agent GraphRAG.

But the word **"GraphRAG"** does not appear in any README. The existing one-line bullets ("Seeded ontology & graph extraction", "Graph traversal — Walk the knowledge graph N hops") communicate *what* the engine does but not *what pattern it implements*. Developers searching for "GraphRAG", "graph RAG", or "SQLite GraphRAG" don't find us. The positioning lives only in the code, not the docs.

This spec adds the GraphRAG narrative to the README surface without changing any code.

---

## Goals

1. **Make the GraphRAG capability discoverable.** The word "GraphRAG" should appear in the main README and in the substantive section of `core/README.md` and `schema-org/README.md` such that npm + GitHub search ranks for the keyword.
2. **Prove the "no Neo4j" claim with the actual SQL.** Show the `WITH RECURSIVE` query shape (semi-abstracted) so a developer reads it and understands the engine is doing real graph work natively in SQLite.
3. **Stay coherent with existing docs.** The "Seeded ontology & graph extraction" bullet and the existing mermaid "How It Works" diagram are *augmented*, not replaced. The new content extends, it doesn't tear up.
4. **Drift-proof the SQL snippet.** A CI grep guardrail fails the build if the structural pillars of the recursive query disappear from `EdgeRepository.ts`.
5. **Reach every supported platform equally.** Node, React Native (Expo), and Web (React) developers each see GraphRAG surfaced in their package README.

---

## Non-Goals

- **No source code changes.** Zero edits to anything under `packages/*/src/**`. The only non-markdown file touched is one existing GitHub Actions workflow yaml (CI drift guard).
- **No new public API.** `traverseGraph`, `useWikiTraversal`, `formatGraphContext`, `upsertGraph`, `schemaOrgWarmAgentManifest` are already shipped.
- **No renaming of existing terms.** "Seeded ontology" stays "seeded ontology" — we add "GraphRAG" alongside, we don't replace.
- **No new GraphRAG-specific API.** If a developer wants GraphRAG today, they get it by turning on a seeded ontology (`mode: 'strict' | 'emergent'`) and calling `traverseGraph()`. This spec doesn't introduce a separate "GraphRAG mode."
- **No migration guide.** No API surface changed → no host updates required.

---

## Design Decisions Locked In

| Decision | Choice | Rationale |
|---|---|---|
| Top-fold placement in main README | **Expand existing sections** (Key Principles + mermaid), no new top-level section | Smallest narrative delta; respects existing architecture-as-identity framing |
| Package scope for substantive content | **`core` + `schema-org`** get substantive GraphRAG sections; the other six get one-line cross-links | Highest content density where the engine and the ontology actually live |
| Technical depth at top of main README | **Full recipe + actual `WITH RECURSIVE` SQL (semi-abstracted)** | "Show, don't tell" — proves the no-Neo4j claim with the actual query shape |
| SQL abstraction level | **Option B (semi-abstracted)** — keep anchor + recursive join + cycle guard + confidence rank CASE; abstract filter clauses and parameter bindings | Shows the schema and the cycle-safety math without committing to internal parameter names that drift |
| `UNION` vs `UNION ALL` in snippet | **`UNION`** (matches actual source) | Byte-for-byte match keeps the CI guardrail honest |
| Title/body hydration in snippet | **Single-query view with footnote** flagging that hydration actually happens in `GraphTraversalService` | Best readability; honest via footnote |
| Drift guard | **GitHub Actions grep** on three stable identifiers | Bounded scope; won't fire on parameter renames |

---

## File-by-File Changes

### 1. `/README.md` (root)

#### 1a. Key Principles bullet expansion

**Current (line 69):**
> **Seeded ontology & graph extraction:** Optional per-entity taxonomies (Strict, Emergent, or Off) guide librarian and ingest passes to classify facts with `okf_type` and persist structured graph edges alongside semantic and episodic memory.

**New:**
> **Seeded ontology & graph extraction (GraphRAG):** Optional per-entity taxonomies (Strict, Emergent, or Off) guide librarian and ingest passes to classify facts with `okf_type` and persist structured graph edges alongside semantic and episodic memory. This is the GraphRAG retrieval layer — `traverseGraph()` walks the resulting graph with `WITH RECURSIVE` SQLite, no separate graph database required.

#### 1b. "How It Works" mermaid augmentation

Add a third node to the existing `ReadPath` subgraph:

```mermaid
subgraph ReadPath["Read Path"]
    CosineSim(["cosine similarity\nprimary path"])
    MSFallback(["MiniSearch\nfallback"])
    GraphTraversal(["GraphRAG\ntraversal"])
    Bundle(["MemoryBundle\nfacts · tasks · events · subgraph"])
end

%% Existing edges preserved
%% New edges:
read --> GraphTraversal
GraphTraversal --> Bundle
```

#### 1c. New subsection after the mermaid

Insert between the mermaid block and the current `## Monorepo Ecosystem` heading.

```markdown
## GraphRAG: SQL-only graph retrieval

GraphRAG (Graph Retrieval-Augmented Generation) runs entirely on SQLite — no Neo4j, no separate graph database. Every fact becomes a node, every librarian/ingest pass writes typed edges into `llm_wiki_edges`, and `traverseGraph()` walks the resulting structure with one recursive CTE.

### End-to-end recipe

```typescript
import { createWiki } from '@equationalapplications/core-llm-wiki';
import Database from 'better-sqlite3';

const db = new Database('memory.db');
const wiki = createWiki(db, { llmProvider: { generateText } });

// 1. Ingest a document — librarian/ingest writes edges automatically.
await wiki.ingestDocument('user-123', {
  sourceRef: 'onboarding-doc.md',
  body: 'Alice joined the data team in March and reports to Bob.',
});

// 2. Pick an anchor fact and walk the graph N hops.
const graph = await wiki.traverseGraph('user-123', {
  sourceId: '<fact-id-for-alice>',
  maxDepth: 2,
  direction: 'both',
});

// 3. Format the result for prompt injection.
import { formatGraphContext } from '@equationalapplications/core-llm-wiki';
const promptContext = formatGraphContext(graph);

// 4. Inject into your next LLM call alongside vector results.
const answer = await generateText({
  systemPrompt: `You are an assistant with the following memory:\n\n${promptContext}`,
  userPrompt: userQuestion,
});
```

### The SQL: how traversal works in one query

`EdgeRepository.getNeighborhood()` runs a single recursive CTE that walks edges in either direction, guards against cycles via a string-accumulator `visited` column, and ranks results by hop distance and confidence rank.

```sql
WITH RECURSIVE walk(node_id, distance, visited) AS (
  -- 1. Anchor: Start at the exact nodes found via vector/keyword search
  SELECT id, 0, ',' || id || ','
  FROM llm_wiki_entries
  WHERE id IN (/* Initial Retrieval IDs */)

  UNION

  -- 2. Recursive Step: Walk edges in both directions
  SELECT
    CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END,
    w.distance + 1,
    w.visited || CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END || ','
  FROM walk w
  JOIN llm_wiki_edges e
    ON (e.source_id = w.node_id OR e.target_id = w.node_id)
  JOIN llm_wiki_entries n
    ON n.id = CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END
  WHERE w.distance < /* maxDepth */
    -- 3. Cycle Guard: Prevent infinite loops on bidirectional edges
    AND instr(w.visited, ',' || n.id || ',') = 0
    -- [Abstracted: Edge type and excluded source_type filters applied here]
)
-- 4. Final Aggregation & Ranking
SELECT
  n.id, n.title, n.body,
  MIN(w.distance) as min_distance,
  CASE n.confidence
    WHEN 'certain' THEN 2
    WHEN 'inferred' THEN 1
    WHEN 'tentative' THEN 0
    ELSE -1
  END as rank_weight
FROM walk w
JOIN llm_wiki_entries n ON n.id = w.node_id
GROUP BY n.id
ORDER BY min_distance ASC, rank_weight DESC
LIMIT /* maxNodes */;
```

> *Note: For clarity, the snippet above shows the final hydrated output in a single query. In the actual `expo-llm-wiki` codebase, the recursive CTE strictly calculates the `(node_id, distance)` graph traversal, and `GraphTraversalService` handles hydration in a subsequent optimized batch lookup.*
```

#### 1d. Monorepo Ecosystem table footnote

In the existing package table, append `*` to the `core-llm-wiki` and `schema-org-llm-wiki` rows. After the table, add:

```markdown
**\*** *These packages provide the core GraphRAG surface area and canonical ontology for warm-agent graph retrieval. See [GraphRAG: SQL-only graph retrieval](#graphrag-sql-only-graph-retrieval) above.*
```

---

### 2. `packages/core/README.md` — new substantive section

Insert between the existing `## Features` block (ending at line 53) and the existing `## Installation` heading.

```markdown
## GraphRAG & Multi-Modal Retrieval

`@equationalapplications/core-llm-wiki` exposes three complementary retrieval modes, each addressing a different shape of query:

| Mode | API | Best for |
|---|---|---|
| **Semantic** (vector cosine) | `wiki.read(entityId, query)` with `embed` configured | Open-ended natural-language questions; "what do I know about X" |
| **Keyword** (MiniSearch) | `wiki.read(entityId, query)` with `embed` absent or offline | Exact terms, identifiers, names; offline fallback |
| **GraphRAG** (recursive CTE) | `wiki.traverseGraph(entityId, options)` + `formatGraphContext(result)` | Structural questions; "what connects to X", "everything two hops from this fact", "summarise the people, places, and projects linked to Alice" |

The GraphRAG path is structurally distinct: it doesn't rank by relevance to a query string, it walks `llm_wiki_edges` from a known anchor fact. The result is dense and connected — subgraphs, not loose top-K hits.

### Graph traversal APIs

```typescript
import { WikiMemory, formatGraphContext } from '@equationalapplications/core-llm-wiki';

const graph = await wikiMemory.traverseGraph('user-123', {
  sourceId: anchorFactId,
  maxDepth: 2,
  direction: 'both',          // 'inbound' | 'outbound' | 'both'
  edgeTypes: ['reports_to'],   // optional filter
  excludeSourceTypes: ['immutable_document'],
  minConfidence: 'inferred',
  maxNodes: 20,
});

const promptContext = formatGraphContext(graph);
// → dense text block ready for prompt injection
```

`traverseGraph` runs as a single recursive CTE in SQLite (see the root README's ["The SQL: how traversal works in one query"](#the-sql-how-traversal-works-in-one-query) for the query shape). No external graph database.

### Deterministic graph seeding (no LLM)

For programmatic pipelines — importing pre-classified data, building a GraphRAG corpus from a CSV, or seed-loading from a JSON file — use `upsertGraph()`. It writes nodes and edges directly under the same `(sourceRef, sourceHash)` ownership semantics as `ingestDocument()`, but skips the LLM extraction step.

```typescript
await wikiMemory.upsertGraph('user-123', {
  sourceRef: 'crm-export.csv',
  sourceHash: '<sha256>',
  nodes: [
    { id: 'alice', type: 'person', title: 'Alice', body: 'Data team' },
    { id: 'bob',   type: 'person', title: 'Bob',   body: 'Data team lead' },
  ],
  edges: [
    { type: 'reports_to', sourceId: 'alice', targetId: 'bob' },
  ],
});
```

This is the GraphRAG seed path: load a corpus, walk it.
```

---

### 3. `packages/schema-org/README.md` — new subsection

Insert between `## Why curated?` (ends at line 19) and `## Requirements` (starts at line 21).

```markdown
## Why this is the GraphRAG ontology

This manifest is designed as the canonical taxonomy bundle for warm-agent GraphRAG: the 9 node types and 28 polymorphic edges cover the people, places, organizations, projects, events, and creative works that dominate personal and professional knowledge graphs. Pair it with `core-llm-wiki`'s `traverseGraph()` and you get a SQL-only GraphRAG stack with no Neo4j.

### Why a curated ontology prevents hallucination in edge extraction

The librarian and ingest LLM passes that write `llm_wiki_edges` only see this manifest's node types and edge properties in their prompt context. Without that constraint, an unconstrained LLM will invent edge types and node types on every call — producing a noisy graph where `WITH RECURSIVE` walks return orphaned nodes and arbitrary relationships.

With the manifest:
- **Every edge has a valid `(type, source_type, target_type)` triple** — the recursive CTE's JOINs return dense, connected subgraphs instead of dead-ends.
- **Polymorphic edges** (`knows`, `about`, `itemReviewed`, `object`, `agent`) cover the cases where a single property name applies to many source/target type combinations.
- **Token budget stays small** — ~2 KB serialized, vs ~50 KB for the full schema.org catalog. Edge classification accuracy stays high.

### Use it with `core-llm-wiki` for GraphRAG

```ts
import { createWiki } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';

const wiki = createWiki(db, {
  llmProvider,
  config: {
    ontology: {
      mode: 'strict',
      seedManifests: {
        [entityId]: { mode: 'strict', manifest: schemaOrgWarmAgentManifest },
      },
    },
  },
});

// After ingestDocument / runLibrarian populate edges:
const graph = await wiki.traverseGraph(entityId, { sourceId, maxDepth: 2 });
```
```

---

### 4. `packages/expo/README.md` — one-line cross-link

Insert after the existing `useWikiTraversal` bullet (around line 23) or as the closing bullet of the Features list:

```markdown
- **GraphRAG on React Native** — `useWikiTraversal` + `formatGraphContext` give you the same SQLite-only graph retrieval as the core package; pair with `@equationalapplications/schema-org-llm-wiki` for the canonical ontology. See [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).
```

#### 5. `packages/react/README.md` — extend existing bullet

The existing bullet at line 20 reads:

> **Graph traversal** — Walk the knowledge graph N hops from a fact and format the result for LLM prompts (`useWikiTraversal`, `formatGraphContext`).

Extend it to:

> **Graph traversal (GraphRAG)** — Walk the knowledge graph N hops from a fact and format the result for LLM prompts (`useWikiTraversal`, `formatGraphContext`). This is the React-web surface of the GraphRAG retrieval layer; pair with `@equationalapplications/schema-org-llm-wiki` for the canonical ontology. See [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).

### 6. `packages/core-llm-tools/README.md` — one-line cross-link

Append a bullet to the Features list (or wherever the existing tool-schemas bullet lives):

```markdown
- **GraphRAG tool schemas** — `wikiTraverseGraphManifest` and `wikiGetOntologyManifest` are pre-built Gemini tool schemas for the GraphRAG retrieval API; see [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).
```

### 7. `packages/okf/README.md` — one-line cross-link

In the existing intro paragraph (line 60 already mentions "knowledge graph edges"), append:

```markdown
> **GraphRAG compatibility:** OKF v0.2 bundles import directly into `llm_wiki_edges`, populating the GraphRAG graph for `traverseGraph()`. See [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).
```

### 8. `packages/prisma-outbox/README.md` — one-line cross-link

This package is orthogonal to the memory engine (transactional outbox for SQLite → Prisma sync). Add a single sentence at the end of the intro:

```markdown
For the GraphRAG retrieval surface (`traverseGraph`, `useWikiTraversal`, `formatGraphContext`), see [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).
```

### 9. `apps/wiki-demo/README.md` — one-line cross-link

If `wiki-demo` has a "What's shown here" or intro section, append:

```markdown
The demo exercises the GraphRAG retrieval path (`traverseGraph` + `formatGraphContext`) against a seeded schema.org ontology. See [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).
```

---

## Placement Resolution (deferred to implementation plan)

Sections 4 (`expo`), 6 (`core-llm-tools`), 7 (`okf`), and 9 (`wiki-demo`) name candidate insertion points rather than pinning one. The implementation plan will read each file and pick the placement that best fits the surrounding structure — typically: nearest to a related concept (a `useWikiTraversal` bullet, an existing knowledge-graph mention, a tool-schemas bullet, the demo's intro). The writing-plans step commits to specific line numbers, not this spec.

For sections 2 (`core`) and 3 (`schema-org`), the placement is precise (line numbers given against the current `main`).

---

## CI Guardrail (drift protection)

Add to `.github/workflows/*.yml` (the existing test/ci workflow). This guards the SQL snippet in the main README against source drift:

```yaml
      - name: Verify README GraphRAG SQL is in sync with EdgeRepository
        run: |
          grep -q "WITH RECURSIVE" packages/core/src/repositories/EdgeRepository.ts || { echo "Missing WITH RECURSIVE in EdgeRepository"; exit 1; }
          grep -q "instr(w.visited" packages/core/src/repositories/EdgeRepository.ts || { echo "Missing cycle guard in EdgeRepository"; exit 1; }
          grep -q "WHEN 'certain' THEN 2" packages/core/src/repositories/EdgeRepository.ts || { echo "Missing confidence CASE in EdgeRepository"; exit 1; }
```

**What this guards:** the three structural pillars of the recursive CTE (the recursion, the string-based cycle guard, and the manual confidence weight mapping). If any disappear, the SQL snippet in the README needs to be updated in the same PR.

**What this does NOT guard:** filter clause details (edge type filter, exclude source types), parameter binding order, or the hydration strategy. Those can change without the README needing to update.

---

## Verification Plan

Before merging the doc updates:

1. **CI guardrail passes** — the three grep patterns all hit `EdgeRepository.ts` (verified at spec time: 2/1/1 matches respectively).
2. **Manual SQL spot-check** — run `git diff main` and verify the snippet's `UNION` keyword, `instr(w.visited` cycle-guard substring, and `CASE n.confidence` rank expression all appear in `EdgeRepository.ts`.
3. **Internal links resolve** — every `[root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval)` cross-link targets an actual heading anchor. Verify by clicking each link in the rendered GitHub preview.
4. **Mermaid still renders** — the augmented mermaid block must not have syntax errors. Verify by pasting into the GitHub mermaid live editor.
5. **SEO keyword coverage** — grep the final diff for the strings `GraphRAG`, `graph RAG`, `SQLite`, `WITH RECURSIVE`. Expect at least 12 total hits across all updated READMEs.
6. **No source code touched** — `git diff --stat main` shows only `.md` files and at most one `.github/workflows/*.yml` changed. Zero files under `packages/*/src/**`.

---

## Risks

- **Link rot in cross-package anchors.** The anchor `#graphrag-sql-only-graph-retrieval` must be stable across README re-renders. GitHub auto-generates anchors by lowercasing and slugging the heading; our heading text is "GraphRAG: SQL-only graph retrieval" → slug is `graphrag-sql-only-graph-retrieval`. *Verified by inspection.* No mitigation needed unless the heading text changes.
- **Mermaid block re-render changes.** The mermaid block in the main README is currently 59 lines (lines 74-132). Adding one `GraphTraversal` node + two edges is well within GitHub's mermaid-render budget. No mitigation needed.
- **`schema-org` package rename or restructure.** If the package name changes (e.g. to `@equationalapplications/warm-agent-ontology`), the cross-links in this spec become stale. Not a near-term risk; documented for follow-up if rename ships.

---

## Out of Scope (deliberately)

- A dedicated `/docs/graphrag.md` long-form page. Considered and rejected: scope creep; the main README's section is the right anchor for SEO.
- A new npm keyword tag (`"graphrag"`, `"graph-rag"`). Worth doing but requires npm publish permissions and a release; punt to a follow-up issue.
- A worked benchmark comparing GraphRAG retrieval quality vs baseline cosine search. Engineering effort; not a doc change.
- Renaming "Seeded ontology" → "GraphRAG ontology" in the codebase. Existing term is fine; we add "GraphRAG" alongside.

---

## Decisions Locked In (no further questions)

- Approach A (expand existing sections, not new section).
- Substantive sections in `core` + `schema-org` only.
- Full code recipe + `WITH RECURSIVE` SQL at the top of the main README.
- Semi-abstracted SQL (Option B) with `UNION` (not `UNION ALL`).
- Single-query snippet with footnote on hydration.
- Three-pattern grep CI guardrail.

---

## Follow-ups (not part of this spec)

- Issue: add `"graphrag"`, `"graph-rag"`, `"sql-knowledge-graph"` to each package's `keywords` array in `package.json`.
- Issue: add a `/docs/graphrag.md` long-form page if downstream readers request deeper guidance.
- Issue: add `GraphRAG` to the npm topic on each package's registry page.