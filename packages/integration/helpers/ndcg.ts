export function computeNDCG(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  const dcg = rankedIds.slice(0, k).reduce(
    (sum, id, i) => (relevantIds.has(id) ? sum + 1 / Math.log2(i + 2) : sum),
    0
  );
  const idealLen = Math.min(relevantIds.size, k);
  const idcg = Array.from({ length: idealLen }, (_, i) => 1 / Math.log2(i + 2))
    .reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}
