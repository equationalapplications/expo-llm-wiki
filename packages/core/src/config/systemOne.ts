/**
 * System-One config surface (specs/system-one-config §1, §10).
 *
 * Boundary: S1-0 owns exactly `typing`, `minConfidence` (with the `'typing'`
 * member), and `onLowConfidence`. Later PRs add more threshold sites
 * (`'edges'`, `'resolve'`, `'healScreen'`) — each as one new line in
 * `SystemOneThresholdSite`, so sibling PRs merge cleanly. Nothing outside
 * that boundary belongs here.
 */

/** Sites a System-One threshold can apply to. Exactly one member today (§10 fence). */
export type SystemOneThresholdSite = 'typing';

export interface SystemOneConfig {
  /**
   * Typing mode for ontology backfill. `'auto'` uses
   * `llmProvider.classify` when present (no edges proposed); `'llm'`
   * always uses the generative path. Default `'llm'`.
   */
  typing?: 'auto' | 'llm';
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
