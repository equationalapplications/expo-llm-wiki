export function computeMRR(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  const topK = rankedIds.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevantIds.has(topK[i])) return 1 / (i + 1);
  }
  return 0;
}

export function computeHitRate(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  return rankedIds.slice(0, k).some((id) => relevantIds.has(id)) ? 1 : 0;
}
