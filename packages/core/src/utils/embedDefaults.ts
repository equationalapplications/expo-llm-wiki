/**
 * Default clamp on embed input length, in characters (~1,500 tokens).
 * Chosen to fit common embedding windows including nomic-embed-text's 2,048 tokens.
 */
export const DEFAULT_MAX_EMBED_CHARS = 6_000;

/**
 * Hard upper bound on embed input length, in characters.
 * An unbounded-input guard from `5e04bad fix(core): security hardening phase 2`.
 * Configuration may lower the effective limit but must never raise it past this.
 */
export const EMBED_CHARS_CEILING = 16_000;
