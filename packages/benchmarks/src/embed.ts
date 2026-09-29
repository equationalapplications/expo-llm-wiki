import { EmbeddingModel, FlagEmbedding } from 'fastembed';

type EmbedFn = (text: string) => Promise<number[]>;

let cached: Promise<EmbedFn> | null = null;

/**
 * Return a memoised `embed(text)` helper backed by fastembed's BGESmallENV15
 * singleton. The first call initialises the ONNX model (~150 MB); subsequent
 * calls reuse the same instance.
 *
 * Copied from `packages/integration/__tests__/scifact.test.ts`.
 */
export function getEmbedder(): Promise<EmbedFn> {
  if (!cached) {
    cached = (async () => {
      const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
      return async (text: string): Promise<number[]> => {
        for await (const batch of embedder.embed([text])) {
          return Array.from(batch[0]);
        }
        throw new Error('fastembed returned no vectors');
      };
    })();
  }
  return cached;
}