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

  const sanitized: Record<string, number> = {};
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
  return score * (sanitizedTierWeights?.[entityId] ?? 1);
}

export function shouldExposeReadMetadata(
  entityId: string | string[],
  options: { tierWeights?: Record<string, number> } | undefined,
): boolean {
  return Array.isArray(entityId) || options?.tierWeights !== undefined;
}
