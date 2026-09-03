# Spec: Per-Entity Result Floors (`tierFloors`) and Configurable Embed Input Clamp

**Date:** 2026-09-02
**Status:** Implemented (2026-09-02) — branch `spec/tier-floors-and-embed-clamp`. Revised from Draft on 2026-09-02: implemented as specified with two recorded deviations — §3.4 step 3 restores rank order by original input index rather than re-sorting with the private `_compareScoredRows` (provably equivalent for already-sorted input, avoids a second copy of the tie-break rule), and the JS-cosine ranker's `limit` now materializes all candidates when floors are active (§2 did not account for that ranker's own pre-truncation, which would otherwise have made floors unsatisfiable). Core suite 1226/1226 green, `pnpm typecheck` clean across all 11 packages.
**Issues:** [#109](https://github.com/equationalapplications/expo-llm-wiki/issues/109) (`tierFloors`), [#104](https://github.com/equationalapplications/expo-llm-wiki/issues/104) (embed input guard)
**Packages:** `@equationalapplications/core-llm-wiki`
**Baseline:** 6.3.0
**Consumer context:** `equationalapplications/aws-cloud-agent` — a PR code-review
agent that reads three tiers in one `read()` call and abandons the review when the
codebase tier returns nothing. Measured at 17 abandoned runs out of 161 over seven
days.

Two independent changes, specified together because they ship in one PR. They share
no code and no data path. §1–§5 cover `tierFloors`; §6 covers the embed clamp; §7–§9
are common.

---

## 1. Problem — `tierFloors` (#109)

`ReadOptions.tierWeights` controls *relative ranking* between entities in a
multi-entity read. It cannot guarantee that a given entity contributes **any**
results. When one entity is both weighted higher and substantially larger than
another, it takes every slot within `maxResults`, and the lower-weighted entity is
silently absent from the returned bundle.

This is not a tuning problem. No weight assignment fixes it, because the failure is a
function of the *size ratio* between entities, which drifts as data accumulates.

### 1.1 Observed failure

The consuming host reads:

```ts
wiki.read(
  ['guidance@owner/repo', 'codebase@owner/repo', 'business'],
  seedQuery,
  { maxResults: 25, hybridWeight: 0.7, tierWeights: {
      'guidance@owner/repo': 2.5,
      'codebase@owner/repo': 2.0,
      'business': 0.25,
  }},
);
```

`guidance` outranks `codebase` deliberately: when the bundle is capped, a stated rule
should survive at the expense of a structural fact. That is correct for the *marginal*
slot. It stopped being correct once the tiers diverged in size:

| entity | live facts | weight |
| --- | --- | --- |
| `guidance@…` | 6,655 | 2.5 |
| `codebase@…` | 1,841 | 2.0 |

At a 3.6:1 ratio, guidance facts fill all 25 slots and the bundle contains **zero**
codebase facts — against a fully populated codebase tier. The consumer requires
codebase context, so it correctly refuses to proceed and the review is skipped. The
abandonment rate tracks the ratio across repositories (3.6:1 → 5 occurrences,
2.2:1 → 1, 0.8:1 → 2), which is what identified the cause.

### 1.2 Why the library must own it

A caller can only approximate a floor by issuing a second, entity-scoped read and
merging by score. That duplicates the scoring the library just performed, and needs
`factScores` to merge correctly. The floor is a ranking concern, and the library owns
ranking.

### 1.3 Why the failure is silent

Nothing errors. No hook fires. `onRetrievalFallback` is not involved — retrieval
succeeded. The bundle is well-formed and simply structurally blind. There is no
signal to alert on, which is why the condition persisted for a week before the rate
correlation exposed it.

---

## 2. Current cut points

`RetrievalService.read()` reduces candidates to `maxResults` at three places, and they
do not behave alike.

**Path A — ranker (`RetrievalService.ts:449–458`).** Tier weights applied, tie-break
sorted, then sliced:

```ts
scored = scored.map(row => ({
  ...row,
  score: applyTierWeight(row.score, row.entity_id, sanitizedTierWeights),
}));
this._tieBreakSort(scored);
const selectedScored = scored.slice(0, maxResults);
```

**Path B — keyword fallback (`RetrievalService.ts:553–556`).** Taken when `embed` is
absent or throws. Structurally identical:

```ts
this._tieBreakSort(candidates);
const topCandidates = candidates.slice(0, maxResults);
```

**Path C — empty query (`RetrievalService.ts:573`).** A SQL-level `LIMIT`, no scoring:

```ts
// Empty query: use global recency ordering, ignore tier weights.
facts = await this.entryRepo.findRecentByEntityIds(entityIds, maxResults);
```

Paths A and B share a row shape — `{ id, entity_id, score, updated_at, access_count }` —
and both have ordering already applied at the point of the cut. That is the seam this
design uses. Path C is excluded (§3.3).

**Correction (implementation, 2026-09-02).** The analysis above is necessary but not
sufficient for Path A. `scored` does not always contain the full candidate set at the
cut: the JS-cosine call passes `limit: jsCosineNeedsTierSort ? candidateRows.length :
maxResults`, and that flag was previously true only when some tier weight was `!== 1`.
With floors set but no non-unit weights, `scored` arrived **already truncated to the
starved top-K**, leaving `selectWithFloors` no low-ranked rows to reserve. Honoring a
floor therefore requires widening that flag to also fire when any sanitized floor is
`> 0`. Floors now pay the same full-materialization cost that non-unit weights already
did (bounded by `preFilterLimit`); with neither active the flag stays false and the hot
path is unchanged. The general rule this exposes: a cut site is only a valid seam for
floors if nothing upstream has already applied a ranking-order truncation.

Honoring a floor on one scored path but not the other would reintroduce the exact
failure mode under a different trigger: a host whose `embed` throws would silently
lose its floors. Both scored paths are therefore in scope, and a test asserts each
independently (§8).

---

## 3. Design — `tierFloors`

### 3.1 Public API

```ts
interface ReadOptions {
  // …existing fields…

  /**
   * Minimum number of results to retain from each named entity before the global
   * `maxResults` cut. Applied after scoring: the top-N scored results from each
   * named entity are reserved, then remaining slots fill by score as usual.
   *
   * An entity with fewer than N matching results contributes what it has — this is
   * not an error. Floors cannot resurrect a result excluded by `preFilterLimit`.
   *
   * Only meaningful when `entityId` is an array; ignored for single-string calls.
   * Ignored when `query` is empty, which uses recency ordering and ignores
   * `tierWeights` as well.
   *
   * Throws `WikiInvalidReadOptions` when a floor cannot be satisfied by
   * construction — see the spec for the exact conditions.
   */
  tierFloors?: Record<string, number>;
}
```

### 3.2 Two pure functions in `src/readOptions.ts`

The module already holds `normalizeEntityIds`, `sanitizeTierWeights`,
`applyTierWeight`, and `shouldExposeReadMetadata`. The floor logic joins them, keeping
it DB-free and unit-testable in isolation.

```ts
export function validateTierFloors(
  entityIds: readonly string[],
  tierFloors: Record<string, number> | undefined,
  sanitizedTierWeights: Record<string, number> | undefined,
  includeZeroWeightEntities: boolean | undefined,
  maxResults: number,
): Record<string, number> | undefined;

export function selectWithFloors<T extends { id: string; entity_id: string }>(
  sortedRows: readonly T[],
  floors: Record<string, number> | undefined,
  maxResults: number,
): T[];
```

`validateTierFloors` returns `undefined` when `tierFloors` is `undefined`, mirroring
`sanitizeTierWeights`. Otherwise it returns a sanitized map of entity id → integer
floor, or throws (§4).

`selectWithFloors` requires `sortedRows` to be **already ordered** by
`_compareScoredRows`. Both call sites satisfy this — the `_tieBreakSort` immediately
precedes the cut on each. The precondition is documented on the function, because
violating it produces silently wrong output rather than an error.

### 3.3 Path C is out of scope, deliberately

`tierFloors` has no meaning on the empty-query path. The issue defines the floor as
operating "after scoring"; on a path where nothing is scored there is no ranking to
reserve against. Extending floors there would require replacing one
`findRecentByEntityIds` call with N per-entity recency queries and a merge.

It would also create a semantic contradiction. Path C explicitly ignores
`tierWeights`. If it honored `tierFloors`, then
`{ tierWeights: { x: 0 }, tierFloors: { x: 5 } }` would reserve five slots on that
path for an entity the caller had zeroed out — while the same options on Paths A and B
throw (§4.1). The asymmetry is documented on the field and asserted in a test rather
than left to be discovered.

### 3.4 Selection algorithm

Given `sortedRows` in descending rank order:

1. **Reserve.** Walk `sortedRows` once with a per-entity counter. Take a row when its
   entity's counter is below that entity's floor. Entities with no floor reserve
   nothing.
2. **Fill.** Walk again, taking rows not already selected in rank order, until the
   selection reaches `maxResults`.
3. **Restore order.** Sort the selected set with `_compareScoredRows`.

Step 3 matters. Without it, reserved rows appear ahead of higher-scored unreserved
rows and the bundle leaks the reservation mechanism through its ordering. Consumers
read `bundle.facts` as rank-ordered; the floor changes *membership*, never *order*.

Because step 1 never takes more than `sum(floors)` rows and §4.1 rejects
`sum(floors) > maxResults`, step 1 cannot overflow the window. Reserved rows are
always a subset of the final selection.

Complexity is O(n) for both walks plus the final sort of at most `maxResults` rows,
against an existing O(n log n) sort of the full candidate set — no change to the
asymptotic cost of `read()`.

**Tie-breaks** reuse the existing `_compareScoredRows` ordering
(score → access_count → updated_at → id) at every step. No new ordering rule is
introduced.

### 3.5 Interaction with `preFilterLimit`

Floors apply to the candidate set that survives pre-filtering. A floor cannot
resurrect a fact the pre-filter excluded — pre-filtering happens during retrieval,
long before the cut. A host that sets `preFilterLimit` low enough to starve an entity
must raise it; the floor does not compensate. Documented on the field.

---

## 4. Error handling — `tierFloors`

The rule: **throw on contradictions detectable before touching data; sanitize value-shape
noise; never throw on data-dependent shortfalls.**

`sanitizeTierWeights` never throws — it clamps negatives to 0 and coerces non-finite
values to 1. That forgiveness is right for a *weight*, where a malformed value
degrades ranking slightly. It is wrong for a *floor*, whose entire purpose is a
guarantee. A floor that silently fails to apply is the same silent structural
blindness this feature exists to eliminate: the caller believes the bundle is
protected and it is not.

`read()` already throws `RangeError` (`:43`, >100 entity ids) and `TypeError` (`:47`,
null byte in an entity id), so rejecting malformed options is consistent with the
method's existing contract.

### 4.1 Throws

| Condition | Rationale |
| --- | --- |
| `sum(floors) > maxResults` | Arithmetically unsatisfiable regardless of data. |
| Floor on an entity with `tierWeight: 0` while `includeZeroWeightEntities` is falsy | `_filterScoredEntities` (`:605`) removes the entity from retrieval entirely; the floor can never be met. |
| Floor key not present in `entityIds` | Almost always a typo'd entity id. Silently ignoring it yields a bundle with no floor at all — the original bug, reintroduced by a typo. |

`sum(floors) > maxResults` covers `maxResults: 0` with any positive floor: "return
nothing" and "return at least N" are a genuine contradiction.

### 4.2 Sanitizes

| Input | Result |
| --- | --- |
| Negative floor | Clamped to 0 |
| Non-finite (`NaN`, `Infinity`) | Treated as absent |
| Non-integer (e.g. `2.7`) | `Math.trunc` → 2 |
| Floor of 0 | Retained as a no-op |

### 4.3 Never an error

| Situation | Behavior |
| --- | --- |
| Floor of 5, entity has 2 matching facts | Contributes 2. Data-dependent. |
| Floor of 5, entity has 2 after `preFilterLimit` | Contributes 2 (§3.5). |
| `tierFloors` passed with a single-string `entityId` | Ignored, matching `tierWeights`. |
| `tierFloors` passed with an empty query | Ignored (§3.3). |

Rows 1 and 2 are the load-bearing cases: a floor that throws as a corpus shrinks
would break working calls over time, which is worse than the bug being fixed.

### 4.4 New error class

```ts
export class WikiInvalidReadOptions extends Error {
  readonly field: string;
  readonly reason: string;
}
```

Exported from `types.ts` alongside the existing `Wiki*` family. Named for
`ReadOptions` rather than `tierFloors` so future option validation reuses it instead
of spawning a class per field. `field` and `reason` support programmatic handling
without message parsing.

Per `docs/superpowers/specs/2026-08-17-instanceof-error-proxy-guard-design.md`, any
new `instanceof` dispatch on this class in a documented non-throwing helper must be
guarded. This design adds none — the class is thrown from `read()` and caught by
callers, never type-tested inside the library.

---

## 5. Integration points — `tierFloors`

**Validation.** One call in `read()`, placed after `maxResults` resolves (`:51–53`)
and after `sanitizedTierWeights` (`:28`); both are inputs.

It sits *after* the `entityIds.length === 0` early return (`:32–40`), so an empty
entity list returns an empty bundle rather than throwing. This matches how
`tierWeights` behaves there and keeps a degenerate-input call from becoming an error.

**Application.** Two one-line replacements:

- `:458` — `scored.slice(0, maxResults)` → `selectWithFloors(scored, floors, maxResults)`
- `:556` — `candidates.slice(0, maxResults)` → `selectWithFloors(candidates, floors, maxResults)`

**Metadata.** `MemoryBundle.metadata` (`types.ts:620–624`) gains an optional
`tierFloors?: Record<string, number>`, and `read()` populates it when floors were
supplied and non-empty, mirroring the existing `tierWeights` exposure at `:594`. This lets a
consumer confirm the floor was received, and is the observable a host uses to verify
the fix without inspecting fact counts.

**No changes** to `EntryRepository`, `SearchService`, the SQL schema, or any
migration. `selectWithFloors` operates on rows already in memory.

---

## 6. Problem and design — embed input clamp (#104)

### 6.1 Corrected premise

Issue #104 states `embedFact` passes its text to `llmProvider.embed()` "with no check
against the embedding model's context window." That is no longer accurate. A clamp
exists at `EmbeddingService.ts:66`:

```ts
const text = clip(`${fact.title} ${fact.body} ${tagsStr}`.trim(), 16_000);
```

It arrived in `5e04bad fix(core): security hardening phase 2` as an unbounded-input
guard, not as an embed-window guard. **The reported bug still reproduces**: 16,000
characters is roughly 4,000 tokens, about double `nomic-embed-text`'s 2,048-token
window. Ollama returns HTTP 400 "the input length exceeds the context length", the
`catch` at `:94` logs a warning, and the fact is left permanently without an
embedding.

The fix is therefore to lower the limit and make it configurable — not to add a guard.
`WikiConfig` has no `maxEmbedChars` knob today.

### 6.2 Design

```ts
interface WikiConfig {
  // …existing fields…

  /**
   * Maximum characters of `title + body + tags` passed to `llmProvider.embed()`
   * when embedding a fact. Input longer than this is clipped, not rejected.
   *
   * Default 6000 (~1,500 tokens), which fits common embedding windows including
   * nomic-embed-text's 2,048 tokens with headroom. Values above the 16,000
   * hard ceiling are clamped to it.
   */
  maxEmbedChars?: number;
}
```

Resolution in `embedFact`:

```ts
const EMBED_CHARS_CEILING = 16_000;
const DEFAULT_MAX_EMBED_CHARS = 6_000;

const configured = this.options.config?.maxEmbedChars;
const maxEmbedChars = Number.isFinite(configured)
  ? Math.min(Math.max(0, Math.trunc(configured as number)), EMBED_CHARS_CEILING)
  : DEFAULT_MAX_EMBED_CHARS;

const text = clip(`${fact.title} ${fact.body} ${tagsStr}`.trim(), maxEmbedChars);
```

The 16,000 ceiling is retained as a hard upper bound. It is a security control from
`5e04bad`, and configuration must not be able to raise it.

### 6.3 Default choice

6,000 characters is a deliberate trade: it truncates some long facts that would
previously have embedded successfully against a large-window model, in exchange for
never silently dropping an embedding against a small-window one. A silent drop is
invisible and permanent; truncation is visible in retrieval quality and recoverable
by raising the knob. Hosts on large-window models can set `maxEmbedChars: 16000` to
restore prior behavior exactly.

### 6.4 Scope boundary

`embedFact` keeps its `Promise<boolean>` contract. Failed embeddings remain a
`console.warn` and a `false` return. Making embedding failures a persisted, retryable
state — the second option in #104 — touches persistence, the return contract, and
`runReembed` orchestration. It is a separate feature and gets its own spec and issue
(§9).

---

## 7. Non-goals

- Token-accurate measurement. Character clamping is a coarse proxy; exact tokenization
  would require a per-model tokenizer the library does not have and should not bundle.
- Retryable embedding state (#104 option B) — deferred, §9.
- Floors on the empty-query recency path — §3.3.
- Any change to how scores are computed. `tierFloors` changes *selection*, never
  *scoring*; `applyTierWeight` is untouched.
- A `tierCeilings` counterpart. No demand exists; `maxResults` plus weights already
  bound an entity from above. YAGNI.

---

## 8. Testing

Test-driven: each behavior below gets a failing test before implementation.

### 8.1 `selectWithFloors` — pure, no DB

| Test | Asserts |
| --- | --- |
| Floor reserves slots the pure cut would take | The §1.1 scenario at 3.6:1 with `{ codebase: 8 }` yields ≥8 codebase rows |
| Floor exceeds available rows | Contributes what exists; no throw |
| `sum(floors) === maxResults` | Exactly the floors, no filler rows |
| Returned order | Globally score-sorted, not floor-first (§3.4 step 3) |
| Floors absent or empty | Output identical to `slice(0, maxResults)` |
| Zero floor | No-op |

The "floors absent" case is the regression guard for the two call sites: it pins that
the default path is byte-identical to today's behavior.

### 8.2 `validateTierFloors`

One test per row of §4.1 (throws, asserting `field` and `reason`) and §4.2
(sanitizes). Explicit test that `maxResults: 0` with a positive floor throws.

### 8.3 `RetrievalService` integration

| Test | Asserts |
| --- | --- |
| Floors honored on ranker path (A) | ≥N facts from the floored entity |
| Floors honored on keyword-fallback path (B) | Same, with `embed` throwing |
| Empty query ignores floors | No throw, recency ordering preserved |
| Single-string `entityId` ignores floors | No throw, no effect |
| `bundle.metadata.tierFloors` | Present and matches sanitized input |

Paths A and B are asserted separately and deliberately — a shared helper does not by
itself prove both call sites were changed (§2).

### 8.4 `embedFact`

| Test | Asserts |
| --- | --- |
| Input at the cap | Passed whole, uncut |
| Input over the cap | Clipped to `maxEmbedChars` |
| `maxEmbedChars: 99999` | Clipped at 16,000, not 99,999 |
| No config | Default 6,000 applied |
| `maxEmbedChars: 0` | Clipped to empty; `embed` still called, existing empty-vector guard at `:69` handles the result |

---

## 9. Follow-up issue to file

**Retryable embedding failures.** `embedFact` returns `false` and logs a warning on
every failure — over-length input, provider outage, malformed vector — with no record
that the fact lacks an embedding for a recoverable reason. `runReembed` cannot
distinguish "never embedded because the provider was down" from "never embedded
because no `embed` is configured." Requires a persisted marker, a change to
`embedFact`'s return contract, and `runReembed` orchestration. Filed as a separate
issue after this spec is approved; #104 closes on the clamp alone.

---

## 10. Rollout

Both changes are additive and opt-in at the API level. `tierFloors` is new, so no
existing caller can trigger its throws. `maxEmbedChars` changes a default —
16,000 → 6,000 — which is the one behavioral change to an existing code path, and is
called out in the changelog as such.

Semantic-release: `feat` (minor) for `tierFloors`, `fix` for the clamp. The two land
as separate commits under a **merge commit**, never a squash, so both reach the
changelog independently.

Version: 6.4.0.
