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
