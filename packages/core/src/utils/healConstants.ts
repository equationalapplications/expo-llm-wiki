/**
 * Shared constants for the heal pipeline.
 *
 * Both `PromptService.buildHealPrompt` (which applies the L0 anchor cap and
 * the L3 body truncation default) and `MaintenanceService.doRunHeal` (which
 * fetches tasks at the cap and looks up anchors with the overfetch sized off
 * it) read from this module. The spec ("heal output-bounded convergence
 * ladder") explicitly requires the values to match across the two callers —
 * if they drift, the L0 anchor slice and `_selectHealAnchors`'s overfetch
 * silently disagree with no test catching the gap.
 *
 * Lives in `utils/` rather than alongside `MaintenanceService` because
 * `PromptService` is constructed before `MaintenanceService` exists, and
 * importing from `MaintenanceService` would create a cycle at construction
 * time. A leaf constants module has no such risk.
 *
 * Heal-specific batch sizing, recheck cadence, and prompt char limits
 * (`HEAL_BATCH_SIZE`, `HEAL_RECHECK_MS`, `HEAL_MAX_PROMPT_CHARS`,
 * `HEAL_ANCHOR_SEARCH_OVERFETCH`) are not duplicated across files and stay
 * in `MaintenanceService.ts` — moving them here would expand this module's
 * surface without buying anything.
 */

/** Cap on document anchors surfaced to the model at L0. */
export const HEAL_MAX_ANCHORS = 50;

/** Per-candidate anchor ratio used at L0: `min(HEAL_MAX_ANCHORS, batch.length * HEAL_ANCHORS_PER_CANDIDATE)`. */
export const HEAL_ANCHORS_PER_CANDIDATE = 4;

/**
 * Default body truncation cap applied at L3 only. A fact whose body is at or
 * below this cap passes through unchanged; a fact above it is sliced to this
 * length with a `...[truncated at N chars, original was M]` marker.
 */
export const HEAL_MAX_FACT_BODY_CHARS_L3 = 4_000;

/**
 * Hard ceiling on the `allTasks` slice fed to the heal prompt at L0. Tasks
 * are entity-global (not batch-local), so this is a constant rather than a
 * function of batch length.
 */
export const HEAL_MAX_TASKS = 50;