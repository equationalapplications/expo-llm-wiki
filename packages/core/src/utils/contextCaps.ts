/**
 * Leaf constant module for the context-budget caps (specs/context-budget T3).
 *
 * The five cap values moved here from their service modules because the
 * resolver (`config/context.ts`) must read them without a load-order cycle
 * (`MaintenanceService` → `librarian` → `ops/*` → `config/context` →
 * `MaintenanceService`) and `OPS_RESOLVE_MAX_PROMPT_CHARS` was not exported
 * from `resolve.ts` — the same shape that put `HEAL_*` in `utils/healConstants`.
 *
 * Names and values are unchanged; each current site re-exports or aliases from
 * this leaf, and the T1 byte-identity pins guard the move.
 */

/** Input bound for the ops resolve prompt (was `resolve.ts`). */
export const OPS_RESOLVE_MAX_PROMPT_CHARS = 40_000;

/** Input bound for the ontology-backfill generative prompt (was `MaintenanceService.ts`). */
export const ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000;

/** Input bound for heal, mirroring ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS (was `MaintenanceService.ts`). */
export const HEAL_MAX_PROMPT_CHARS = 40_000;

/** Batch event-summary char cap for ops extract (was `extract.ts`). */
export const OPS_MAX_EXTRACT_CHARS = 24_000;

/** `chunkingDefaults` is already a leaf; the cap set is re-exported from here for one-stop reads. */
export { DEFAULT_MAX_CHUNK_LENGTH } from './chunkingDefaults';
