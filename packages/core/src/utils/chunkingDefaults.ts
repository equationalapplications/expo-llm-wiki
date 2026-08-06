/**
 * Default maximum characters per chunk that `ingestDocument` uses when a
 * caller doesn't override `maxChunkLength` (directly or via
 * `WikiOptions.config.maxChunkLength`).
 */
export const DEFAULT_MAX_CHUNK_LENGTH = 12000;

/**
 * Default/fallback character overlap between consecutive chunks.
 * `ingestDocument` uses this when a caller doesn't override `chunkOverlap`
 * (directly or via `WikiOptions.config.chunkOverlap`), and clamps the
 * effective overlap (including this default) to `maxChunkLength - 1` when
 * needed. The clamp is a no-op for the shipped defaults; it can also apply
 * when a custom `maxChunkLength` makes the resolved overlap too large.
 */
export const DEFAULT_CHUNK_OVERLAP = 400;
