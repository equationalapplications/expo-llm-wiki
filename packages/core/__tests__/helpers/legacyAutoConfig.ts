import type { WikiConfig } from '../../src/types';

/**
 * The 7.x engine behavior, set explicitly. Tests of the legacy librarian or
 * of the auto-mode write() triggers spread this in since 8.0.0 changed the
 * defaults to `ops` + `deferred` (specs/release-8-0-0).
 */
export const LEGACY_AUTO: Pick<WikiConfig, 'librarian' | 'maintenance'> = {
  librarian: { strategy: 'legacy' },
  maintenance: 'auto',
};
