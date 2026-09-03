import { WikiInvalidReadOptions } from './types';

export function normalizeEntityIds(entityId: string | string[]): string[] {
  const input = Array.isArray(entityId) ? entityId : [entityId];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const id of input) {
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function sanitizeTierWeights(
  entityIds: readonly string[],
  tierWeights: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (tierWeights === undefined) return undefined;

  const sanitized = Object.create(null) as Record<string, number>;
  for (const entityId of entityIds) {
    const raw = tierWeights[entityId];
    if (raw === undefined || !Number.isFinite(raw)) {
      sanitized[entityId] = 1;
    } else {
      sanitized[entityId] = Math.max(0, raw);
    }
  }
  return sanitized;
}

export function applyTierWeight(
  score: number,
  entityId: string,
  sanitizedTierWeights: Record<string, number> | undefined,
): number {
  const weight = sanitizedTierWeights?.[entityId] ?? 1;
  // Weight=0 → sentinel -Infinity so zero-weight entities always sort below any
  // finite score, including negative cosine values from the pure-semantic path.
  if (weight === 0) return -Infinity;
  return score * weight;
}

export function shouldExposeReadMetadata(
  entityId: string | string[],
): boolean {
  return Array.isArray(entityId);
}

/**
 * Validates and sanitizes `ReadOptions.tierFloors`.
 *
 * Throws `WikiInvalidReadOptions` for contradictions detectable without touching
 * data. Sanitizes value-shape noise. Never throws for data-dependent shortfalls —
 * an entity with fewer facts than its floor simply contributes what it has.
 */
export function validateTierFloors(
  entityIds: readonly string[],
  tierFloors: Record<string, number> | undefined,
  sanitizedTierWeights: Record<string, number> | undefined,
  includeZeroWeightEntities: boolean | undefined,
  maxResults: number,
): Record<string, number> | undefined {
  if (tierFloors === undefined) return undefined;

  const known = new Set(entityIds);
  for (const key of Object.keys(tierFloors)) {
    // Per §4.2: non-finite values are sanitized away as absent. Filtering them
    // before key validation matches the documented rule and lets a typo like
    // { typo: NaN } fall through cleanly instead of tripping the "key is not
    // one of the entity IDs" check on a value the caller did not actually set.
    const raw = tierFloors[key];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    if (!known.has(key)) {
      throw new WikiInvalidReadOptions(
        'tierFloors',
        `"${key}" is not one of the entity IDs passed to read(); ` +
          `a floor on an unrequested entity can never be satisfied`,
      );
    }
  }

  const sanitized = Object.create(null) as Record<string, number>;
  let total = 0;
  for (const entityId of entityIds) {
    const raw = tierFloors[entityId];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    const floor = Math.max(0, Math.trunc(raw));

    if (floor > 0 && includeZeroWeightEntities !== true && sanitizedTierWeights?.[entityId] === 0) {
      throw new WikiInvalidReadOptions(
        'tierFloors',
        `"${entityId}" has tierWeight 0 and includeZeroWeightEntities is not set, ` +
          `so it is excluded from retrieval and its floor of ${floor} can never be met`,
      );
    }

    sanitized[entityId] = floor;
    total += floor;
  }

  if (total > maxResults) {
    throw new WikiInvalidReadOptions(
      'tierFloors',
      `floors sum to ${total}, which exceeds maxResults (${maxResults})`,
    );
  }

  return sanitized;
}

/**
 * Selects up to `maxResults` rows, reserving each entity's top-N first.
 *
 * PRECONDITION: `sortedRows` must already be in final rank order (the caller's
 * tie-break sort). Selection order is restored from each row's position in the
 * input, so unsorted input yields silently wrong output rather than an error.
 *
 * Floors change which rows are selected, never the order they are returned in.
 */
export function selectWithFloors<T extends { id: string; entity_id: string }>(
  sortedRows: readonly T[],
  floors: Record<string, number> | undefined,
  maxResults: number,
): T[] {
  if (maxResults <= 0) return [];
  if (floors === undefined || Object.keys(floors).length === 0) {
    return sortedRows.slice(0, maxResults);
  }

  const selected = new Set<number>();
  const taken = Object.create(null) as Record<string, number>;

  // Pass 1 — reserve each entity's top-N. Bounded by sum(floors) <= maxResults,
  // which validateTierFloors guarantees, so this cannot overflow the window.
  for (let i = 0; i < sortedRows.length; i++) {
    const entityId = sortedRows[i].entity_id;
    const floor = floors[entityId] ?? 0;
    if (floor <= 0) continue;
    const count = taken[entityId] ?? 0;
    if (count >= floor) continue;
    taken[entityId] = count + 1;
    selected.add(i);
  }

  // Pass 2 — fill the remaining slots in rank order.
  for (let i = 0; i < sortedRows.length && selected.size < maxResults; i++) {
    if (!selected.has(i)) selected.add(i);
  }

  // Restore global rank order: input was sorted, so index order is rank order.
  return Array.from(selected)
    .sort((a, b) => a - b)
    .map(i => sortedRows[i]);
}
