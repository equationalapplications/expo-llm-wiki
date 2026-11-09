/**
 * Librarian strategy dispatcher (spec 2026-09-29 §5.1).
 *
 * This is the only place that knows which strategies exist. New strategies
 * (PR-B `ops`) register an entry in `STRATEGIES` and the dispatcher picks
 * the right implementation. The default is defined in `utils/engineDefaults`
 * (`'ops'` since 8.0.0).
 */

import { runLegacyLibrarianPass } from './legacy';
import { runOpsLibrarianPass } from './ops';
import { resolveLibrarianStrategy } from '../../utils/engineDefaults';
import type { LibrarianDeps, LibrarianContext, LibrarianResult, LibrarianStrategy } from './types';

// A Map (not a plain object literal) so inherited Object properties like
// 'constructor' or 'toString' cannot masquerade as strategy names.
const STRATEGIES = new Map<string, LibrarianStrategy>([
  ['legacy', runLegacyLibrarianPass],
  ['ops', runOpsLibrarianPass],
]);

export async function runLibrarianStrategy(
  deps: LibrarianDeps,
  ctx: LibrarianContext,
): Promise<LibrarianResult> {
  const strategy = resolveLibrarianStrategy(deps.options.config);
  const fn = STRATEGIES.get(strategy);
  if (!fn) {
    throw new Error(`Unknown librarian strategy: ${strategy}`);
  }
  return fn(deps, ctx);
}

export type { LibrarianDeps, LibrarianContext, LibrarianResult, LibrarianStrategy } from './types';
export { FUZZY_THRESHOLD, MIN_TOKENS_TO_QUALIFY } from './constants';
