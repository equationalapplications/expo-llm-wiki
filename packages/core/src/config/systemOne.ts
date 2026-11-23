/**
 * System-One config surface (specs/system-one-config §1, §10).
 *
 * Boundary: S1-0 owns exactly `typing`, `minConfidence` (with the `'typing'`
 * member), and `onLowConfidence`; the edge-suggestions step adds `edges` and
 * the `'edges'` member; the resolution step added the `'resolve'` member and
 * the heal-screen step added the `'healScreen'` member. Each landed as one
 * new line in
 * `SystemOneThresholdSite`, so sibling PRs merged cleanly. The type-on-write
 * step landed the `typeOnWrite` key and the ingest-time typing step landed
 * `typeOnIngest`; both reuse the `'typing'` floor and added no
 * `SystemOneThresholdSite` member. Nothing outside that boundary belongs
 * here.
 */

/** Sites a System-One threshold can apply to. Exactly four members today: `'typing'`, `'edges'`, `'resolve'` and `'healScreen'` (§10 fence). */
export type SystemOneThresholdSite = 'typing' | 'edges' | 'resolve' | 'healScreen';

export interface SystemOneConfig {
  /**
   * Typing mode for ontology backfill. `'auto'` uses
   * `llmProvider.classify` when present (no edges proposed, unless `systemOne.edges: 'auto'`); `'llm'`
   * always uses the generative path. Default `'llm'`.
   */
  typing?: 'auto' | 'llm';
  /**
   * Edge mode for ontology backfill. `'llm'` (default) keeps edge proposal
   * on the generative path exactly as today. `'auto'` engages the classifier
   * edge screen (§4) when the classifier step runs AND an explicit
   * `minConfidence.edges` floor is set (§3 — missing floor under `'auto'`
   * warns once and the site resolves `'llm'`); answers at or above the
   * floor apply the edge, confident "no" answers are terminal, and facts
   * whose edge answers land in the uncertain band fall through to the
   * generative step of the same pass (§3, §5). There is no `'off'`: this PR
   * adds no configuration that can silently discard a model-proposed edge.
   */
  edges?: 'auto' | 'llm';
  /**
   * Resolution mode for the librarian's ops resolve step. `'llm'` (default)
   * keeps resolution on the generative path exactly as today. `'auto'`
   * engages the classifier resolution screen (§4) when
   * `llmProvider.classify` is present AND an explicit
   * `minConfidence.resolve` floor is set (missing floor under `'auto'`
   * warns once and the site resolves `'llm'`); a confident duplicate
   * answer at or above the floor settles the candidate as a terminal NOOP,
   * and every other answer falls through to the generative resolve of the
   * same pass. An unavailable classifier warns once per process and the
   * whole batch falls through. There is no `'off'`: this adds no
   * configuration that can silently discard a candidate fact.
   */
  resolve?: 'auto' | 'llm';
  /**
   * Heal-screen mode. `'llm'` (default) keeps heal exactly as today: every
   * model-directed verdict the mutable-ids guard admits is applied, no
   * confidence is read. `'auto'` floors each model-directed downgrade and
   * delete on the confidence the model declares in its verdict (§4): at or
   * above the `minConfidence.healScreen` floor the verdict applies with a
   * per-fact receipt (§5); below it the verdict is withheld — the fact is
   * left untouched, never silently discarded, and the withheld move is
   * itself receipted (§5). The deterministic SQL passes (orphan-marking,
   * stale-inferred downgrade) are rule-driven host policy and are NEVER
   * gated by this key (§4). There is no `'off'`: this PR adds no
   * configuration that can silently discard a model-directed heal action.
   */
  healScreen?: 'auto' | 'llm';
  /**
   * Write-time typing for the librarian (both strategies). `'llm'` (default)
   * keeps today's write path exactly: the generative prompt carries the
   * ontology block and the model types each fact inline, or leaves it for
   * backfill. `'auto'` asks `llmProvider.classify` to type every fact the
   * librarian is about to insert, inside the pass's own token meter, and the
   * ontology block leaves the write prompt for that pass. Facts the
   * classifier does not type are written untyped exactly as today and stay
   * eligible for backfill. Engages only when a classifier is present and the
   * manifest is representable. Facts typed this way carry no
   * manifest-drawn edges. There is no `'off'`. Librarian only;
   * `typeOnIngest` governs ingest.
   */
  typeOnWrite?: 'auto' | 'llm';
  /**
   * Ingest-time typing for `ingestDocument()`. `'llm'` (default) keeps today's
   * ingest path exactly: every chunk prompt carries the ontology block and the
   * model types each fact inline, or leaves it for backfill. `'auto'` asks
   * `llmProvider.classify` to type every extracted fact the call is about to
   * insert, and the ontology block leaves the ingest prompt for that call.
   * The classify calls are as metered as the call's generative chunk calls:
   * `ingestDocument()` carries no token budget. Facts the classifier does
   * not type are written untyped exactly as today and stay eligible for
   * backfill. Engages only when a classifier is present and the manifest is
   * representable. Facts typed this way carry no manifest-drawn edges.
   * Independent of `typeOnWrite`. There is no `'off'`.
   */
  typeOnIngest?: 'auto' | 'llm';
  /** Per-site minimum confidence. Only the classifier path reads a floor. */
  minConfidence?: Partial<Record<SystemOneThresholdSite, number>>;
  /**
   * Routing for classifier low-confidence outcomes (and abstains).
   * `'leave'` (default) keeps them untyped and cooldown-stamped; `'llm'`
   * escalates them to the generative step of the same pass. A cost and
   * quality setting, not a safety mechanism; a no-op when typing resolves
   * `'llm'`.
   */
  onLowConfidence?: 'leave' | 'llm';
}
