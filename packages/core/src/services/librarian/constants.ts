/**
 * Librarian pass constants (spec 2026-09-29 §5.3).
 *
 * These were private to `MaintenanceService` before PR-S; PR-B (ops
 * librarian) needs to share them so the gate in `ops/gate.ts` can apply the
 * same Jaccard threshold as the legacy dedupe. The `ops/` subtree re-exports
 * from here; nothing else in core should import the old `MaintenanceService`
 * constants.
 */

/** Title-Jaccard cut-off above which a candidate is considered a duplicate of an existing fact. */
export const FUZZY_THRESHOLD = 0.5;

/** Minimum number of distinct tokens required for Jaccard to be meaningful. */
export const MIN_TOKENS_TO_QUALIFY = 3;
