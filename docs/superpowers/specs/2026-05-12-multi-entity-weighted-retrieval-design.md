# Multi-Entity Weighted Retrieval and Librarian Prompt Overrides

**Date:** 2026-05-12  
**Status:** Approved
**Breaking Change:** No

## Overview

Extend `WikiMemory.read()` so callers can search one or more `entity_id` namespaces in a single retrieval pass, apply per-entity score multipliers, and receive optional retrieval metadata for explainability. Define the downstream Librarian prompt override contract that consumes this weighted `MemoryBundle` without moving application policy into the core retrieval layer.

This supports applications such as Curated Thoughts, where separate tiers like `tier_wisdom`, `tier_fact`, and `tier_working` should remain namespace-isolated at ingestion time but compete together during retrieval. The goal is to select the true top-K context across tiers instead of retrieving one tier at a time and merging after the important results may already have been displaced. The same metadata then lets a Librarian synthesis layer explain provenance and lets developers swap in domain-specific prompts, such as a strict fact checker, legal researcher, or creative brainstormer.

## Motivation

The current `read(entityId: string, query, options)` API can only search one namespace at a time. An application can call it repeatedly and re-rank in the app layer, but that has two problems:

- Top-K displacement: a high-value wisdom fact may never be returned if the initial per-tier search window is flooded with similar working-memory facts.
- Poor explainability: callers cannot inspect how score weighting affected the final ranking without duplicating core retrieval logic.

The core package already treats `entity_id` as a namespace boundary. This design keeps that model and lets the app layer own policy by passing entity IDs and weights explicitly.

Curated Thoughts also needs the synthesis prompt to be replaceable. Different product surfaces may want the same weighted retrieval pass but different instructions, output formats, and strictness rules. A prompt override should therefore sit above retrieval: it receives the ranked context, tasks, and query through explicit template variables, while `WikiMemory.read()` remains responsible only for selecting and scoring memory.

## Goals

- Support `entityId: string | string[]` in `WikiMemory.read()`.
- Preserve backward compatibility for existing single-entity calls.
- Apply tier/entity weights inside core retrieval before the final top-K slice.
- Preserve each returned `WikiFact.entity_id` so downstream prompts can explain source provenance.
- Expose optional `factScores` and `metadata` when multi-entity (array-shaped `entityId`) retrieval is used.
- Define a Librarian `systemPrompt` override pattern that can consume weighted retrieval output through stable template variables.
- Allow developers to tune synthesis behavior, output format, and strictness without changing core retrieval logic.
- Keep the single-entity hot path clean: no extra metadata for plain calls.
- Avoid schema changes.

## Non-Goals

- Add a separate `tier` column or schema-level tier concept.
- Make the core package decide application policy for wisdom, facts, or working memory.
- Implement application-specific Librarian conflict-resolution behavior. The returned `entity_id`, scores, and metadata should enable strict or domain-specific prompts, but the core package should not decide what to do when tiers conflict.
- Require the core retrieval package to own a particular LLM provider, chat protocol, or final response format.
- Weight or semantically merge tasks and events.

## API Design

### `read()` Signature

```typescript
// Phase 1 (current): entityId is string only
async read(
  entityId: string,
  query: string,
  options?: ReadOptions
): Promise<MemoryBundle>

// Phase 2+ (planned): entityId will accept string | string[]
// async read(
//   entityId: string | string[],
//   query: string,
//   options?: ReadOptions
// ): Promise<MemoryBundle>
```

**Phase 1 (current)**: `read(entityId: string, query, options)` operates on a single entity as today.

**Phase 2+ (planned)**: `entityId` will accept `string | string[]` to enable multi-entity retrieval. A string behaves as it does today. An array enables multi-entity retrieval. Internally, the implementation will normalize to a deduplicated `entityIds: string[]`.

A single-element array will be behaviorally equivalent to a string, except that optional metadata may be returned because the caller explicitly used the multi-entity shape.

### `ReadOptions`

```typescript
export interface ReadOptions {
  maxResults?: number;
  /**
   * undefined -> use WikiConfig.preFilterLimit (or no pre-filter if also unset).
   * null -> explicitly disable a config-level preFilterLimit for this call.
   */
  preFilterLimit?: number | null;
  hybridWeight?: number;
  /** entity_id -> score multiplier. Missing entries default to 1.0. */
  tierWeights?: Record<string, number>;
  /**
   * false/default -> skip zero-weight entities during scored retrieval.
   * true -> retrieve zero-weight entities and let them fill only if the pool is small.
   */
  includeZeroWeightEntities?: boolean;
}
```

`tierWeights` is policy input from the application layer. The core package applies the values, but it does not infer which entity IDs represent wisdom, facts, working memory, or any other tier.

Weight values are sanitized before scoring:

- Missing or non-finite values default to `1.0`.
- Negative values clamp to `0`.
- `0` skips that entity's scored retrieval branch by default to avoid unnecessary compute and I/O.
- If `includeZeroWeightEntities` is `true`, `0` does not exclude an entity; it pushes its scored facts to the bottom while still allowing them to appear if the result pool is small.

### `MemoryBundle`

```typescript
export interface MemoryBundle {
  facts: WikiFact[];
  tasks: WikiTask[];
  events: WikiEvent[];
  factScores?: Record<string, number>;
  metadata?: {
    query: string;
    entityIds: string[];
    tierWeights?: Record<string, number>;
  };
}
```

`factScores` maps fact ID to the final weighted score used for ranking. It is separate from `WikiFact` so the fact type remains a pure persisted-domain type.

For non-empty scored reads, `factScores` and `metadata` are present only when the caller passed an array-shaped `entityId`. Plain single-string calls keep the existing minimal bundle shape regardless of any other options (including `tierWeights`).

For empty-query recency reads, tier weights are ignored because there is no semantic or keyword score to multiply. Metadata may still echo the requested entities and weights, but `factScores` should be omitted for that path to avoid inventing a score.

## Retrieval and Scoring

For non-empty queries, tier weighting is applied after the current semantic/keyword scoring path and before the final sort/slice:

```text
finalScore = retrievalScore * (tierWeights[entity_id] ?? 1.0)
```

`retrievalScore` is the score produced by the active retrieval branch:

- vector ranker semantic score, optionally blended with normalized MiniSearch score via `hybridWeight`
- in-process JS cosine score, optionally blended with normalized MiniSearch score via `hybridWeight`
- MiniSearch fallback score when embedding or ranker retrieval is unavailable

Applying the multiplier at this point preserves the existing hybrid behavior and ensures weights affect the global top-K result set.

## Multi-Entity Flow

The implementation should favor per-entity parallel scoring followed by a global merge:

1. Normalize `entityId` to deduplicated `entityIds`.
2. For each entity, score candidates using the existing retrieval machinery. For non-empty scored reads, skip entities whose sanitized weight is `0` unless `includeZeroWeightEntities` is enabled.
3. Run per-entity work in parallel with `Promise.all` where practical.
4. Carry `entity_id` through scored intermediate rows.
5. Apply the sanitized tier weight to each scored row.
6. Merge all scored rows into one array.
7. Apply the existing deterministic tie-break sort globally.
8. Slice to `maxResults`.
9. Hydrate the selected fact IDs.
10. Populate `factScores` and `metadata` when applicable.

This preserves the existing vector cache shape because cache entries remain keyed by entity ID. It also keeps latency bound by the slowest entity scoring pass instead of the sum of all tiers, subject to SQLite adapter concurrency limits.

## SQL and MiniSearch Changes

The implementation should avoid a broad SQL rewrite where the existing per-entity paths are easier to preserve. Where a merged SQL path is simpler, use `IN` safely with placeholders.

Required changes include:

- Normalize MiniSearch filters from `r.entity_id === entityId` to membership in the normalized `entityIds` set.
- Include `entity_id` in candidate row shapes when scores need tier weighting.
- Exclude zero-weight entities from non-empty scored candidate selection unless `includeZeroWeightEntities` is enabled.
- In phase 2 hydration, fetch by selected IDs without a single `entity_id = ?` guard, since the IDs already came from namespace-scoped candidate selection.
- In ranker fallback embedding fetches, fetch selected IDs without assuming one entity ID.
- For empty-query recency reads, use `WHERE entity_id IN (...)`, order globally by `updated_at DESC`, and ignore tier weights.
- Fetch tasks and events for all requested entities and concatenate them without semantic scoring.

All dynamic `IN` clauses must use parameter placeholders and chunking consistent with the existing 500-ID chunk patterns.

## Dimension Mismatch and Fallback Policy

Dimension mismatch remains fail-safe. If any requested entity has embeddings whose dimension does not match the query vector, the whole retrieval call falls back to keyword retrieval instead of mixing semantic scores for one entity with keyword scores for another.

This preserves a level scoring field before tier weights are applied. It avoids comparing cosine-derived scores against BM25-like MiniSearch scores in the same final list.

Existing retrieval fallback hooks should continue to fire when the semantic path falls back.

## Tasks and Events

Tasks and events are not part of the weighted fact ranking.

For multi-entity calls:

- `tasks` includes pending and in-progress tasks for all requested entities, ordered globally by the existing task ordering.
- `events` includes recent events for all requested entities, ordered globally by the existing event ordering and returned with the existing chronological convention.
- Callers can use each returned task or event's `entity_id` for provenance.

This keeps the feature focused on fact retrieval while avoiding surprising semantic behavior for operational data.

## Librarian Prompt Override Contract

The Librarian synthesis layer should accept an optional `systemPrompt` in its execution options. This prompt replaces the internal default system instructions while keeping the same weighted retrieval pass.

```typescript
export interface LibrarianOptions {
  /**
   * If provided, replaces the default Librarian system instructions.
   * Developers are responsible for including template variables such as
   * {{context}}, {{tasks}}, and {{query}}.
   */
  systemPrompt?: string;

  /** entity_id -> score multiplier, forwarded to WikiMemory.read() as tierWeights. */
  entityWeights?: Record<string, number>;

  /** Forwarded to WikiMemory.read() for callers that want zero-weight filler context. */
  includeZeroWeightEntities?: boolean;

  temperature?: number;
}
```

`entityWeights` is intentionally named for the Librarian/app-facing API, while `ReadOptions.tierWeights` remains the lower-level retrieval option. The Librarian maps `entityWeights` directly to `tierWeights` when it calls `WikiMemory.read()`.

The standard prompt variables are:

- `{{context}}`: The ranked fact list from the weighted retrieval pass. Each rendered fact should include its `entity_id`; when `factScores` is present, the formatter may also include the weighted score for explainability.
- `{{tasks}}`: Pending and in-progress tasks returned in the `MemoryBundle`, preserving each task's `entity_id` for provenance.
- `{{query}}`: The user's original intent, question, or synthesis request.

The default Librarian prompt should use these same variables so the override path and default path share one hydration mechanism.

### Synthesis Flow

```typescript
async synthesize(query: string, options: LibrarianOptions = {}) {
  const memory = await this.wiki.read(this.targetEntities, query, {
    tierWeights: options.entityWeights,
    includeZeroWeightEntities: options.includeZeroWeightEntities,
  });

  const template = options.systemPrompt ?? DEFAULT_LIBRARIAN_PROMPT;
  validatePromptTemplate(template, { custom: options.systemPrompt != null });

  const finalPrompt = hydrate(template, {
    context: formatFacts(memory.facts, memory.factScores),
    tasks: formatTasks(memory.tasks),
    query,
  });

  return this.inference.generate(finalPrompt, {
    temperature: options.temperature,
  });
}
```

The override controls synthesis instructions only. It must not bypass multi-entity retrieval, weight sanitization, metadata creation, or provenance preservation.

### Prompt Validation and Token Budgeting

When `systemPrompt` is provided, the Librarian should warn if the template omits `{{context}}`, because that makes the model blind to the retrieved memory. It should also warn when `{{query}}` is omitted. Omitting `{{tasks}}` is allowed for prompts that do not need operational data, but the warning should make that choice visible to developers if tasks were retrieved.

Custom prompts can be much longer than the default. The Librarian should calculate the remaining context budget after selecting the template and rendering fixed variables such as `{{query}}`. It should then fit facts and tasks into the remaining window in ranked order, preserving the global weighted order from `MemoryBundle.facts`. If truncation is necessary, the formatter should prefer fewer complete facts over partial fact text and should keep provenance with every included fact.

### Example Override

```typescript
await librarian.synthesize('Which source should I trust?', {
  entityWeights: {
    tier_wisdom: 2,
    tier_fact: 1,
    tier_working: 0.25,
  },
  systemPrompt: `You are a strict fact checker.
Use only the retrieved context. If sources conflict, prefer tier_wisdom over tier_fact over tier_working.

Question:
{{query}}

Retrieved context:
{{context}}

Open tasks:
{{tasks}}`,
});
```

This lets Curated Thoughts define strict fact-checking, JSON dashboard output, markdown comparison tables, or creative brainstorming prompts without changing `WikiMemory.read()`.

## Edge Cases

- Duplicate entity IDs are deduplicated before retrieval.
- An empty entity ID array returns an empty fact/task/event bundle with metadata showing `entityIds: []`.
- Missing tier weights default to `1.0`.
- Non-finite tier weights default to `1.0`.
- Negative tier weights clamp to `0`.
- `tierWeights[entity] = 0` skips that entity's scored retrieval branch by default.
- When `includeZeroWeightEntities: true`, zero-weight entities are included and their scored facts are pushed to the bottom-ranked filler context (not removed).
- `maxResults` applies globally across all requested entities.
- Empty query reads ignore weights, do not apply the zero-weight skip optimization, and use global recency ordering.
- Access tracking updates only hydrated facts, using the existing ID-based update path.
- A custom Librarian `systemPrompt` that omits `{{context}}` still runs, but it should produce a developer warning because retrieved memory will not be injected.
- A custom Librarian `systemPrompt` that omits `{{tasks}}` is valid when task context is not needed.
- Prompt token budgeting must happen after selecting the default or custom template, because the template size determines how many ranked facts can fit.

## Testing Plan

Add or update tests in `packages/core/__tests__` to cover:

1. Existing single-string `read()` behavior remains unchanged.
2. Plain single-entity calls do not include `factScores` or `metadata`.
3. Multi-entity read returns one merged `facts` array and preserves each fact's `entity_id`.
4. Tier weights affect final top-K ordering before `maxResults` slicing.
5. `factScores` is present for scored multi-entity reads and contains every returned fact ID.
6. Single-entity string calls never expose `factScores` or `metadata` regardless of options.
7. Metadata echoes `query`, normalized `entityIds`, and sanitized tier weights when applicable.
8. Missing, non-finite, negative, and zero weights behave as specified.
9. Empty-query multi-entity reads merge by `updated_at DESC` and ignore weights.
10. Tasks and events are returned for all requested entities.
11. A dimension mismatch in any requested entity causes the whole scored retrieval to use keyword fallback.
12. Duplicate entity IDs are deduplicated.
13. MiniSearch fallback applies tier weights before the final top-K slice.
14. Ranker fallback to JS cosine preserves entity IDs and applies tier weights.
15. Zero-weight entities are skipped by default for scored reads and included as bottom-ranked filler when `includeZeroWeightEntities` is `true`.

Add Librarian synthesis-layer tests where that layer is implemented to cover:

16. `systemPrompt` replaces the default prompt while still using the weighted `MemoryBundle`.
17. `entityWeights` maps to `WikiMemory.read(..., { tierWeights })`.
18. `includeZeroWeightEntities` is forwarded when the Librarian caller explicitly wants zero-weight filler context.
19. `{{context}}`, `{{tasks}}`, and `{{query}}` hydrate with ranked facts, task provenance, and the original query.
20. A custom prompt missing `{{context}}` emits a developer warning.
21. Token budgeting trims facts after accounting for the selected custom prompt and preserves fact order and provenance.

## Future Considerations

The Librarian prompt override can use `entity_id`, `metadata.tierWeights`, and `factScores` to explain source priority and detect conflicts between tiers. For example, Curated Thoughts could show when a high-weight wisdom note displaced a working-memory snippet, or ask the user to resolve a conflict between official documentation and prior personal experience.

Future work can add richer template variables such as `{{scores}}`, `{{metadata}}`, or `{{events}}`, plus stricter validation modes for products that want to fail fast when required placeholders are missing. Those additions should remain synthesis and UX policy layered above the core retrieval mechanics.
