/**
 * System-One config surface (specs/system-one-config §1, §10).
 *
 * Boundary: S1-0 owns exactly `typing`, `minConfidence` (with the `'typing'`
 * member), and `onLowConfidence`; the edge-suggestions step adds `edges` and
 * the `'edges'` member; the resolution step adds `resolve` and the
 * `'resolve'` member. Later PRs add more threshold sites
 * (`'healScreen'`) — each as one new line in
 * `SystemOneThresholdSite`, so sibling PRs merge cleanly. Nothing outside
 * that boundary belongs here.
 */

/** Sites a System-One threshold can apply to. Exactly three members today: `'typing'`, `'edges'`, and `'resolve'` (§10 fence). */
export type SystemOneThresholdSite = 'typing' | 'edges' | 'resolve';

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
