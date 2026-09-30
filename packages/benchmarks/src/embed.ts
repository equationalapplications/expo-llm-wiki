import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { EmbeddingModel, FlagEmbedding } from 'fastembed';

type EmbedFn = (text: string) => Promise<number[]>;

let cached: Promise<EmbedFn> | null = null;

/**
 * Absolute cache directory for the ONNX model. fastembed's default is a
 * cwd-relative `local_cache/`, which litters the package directory when run
 * through `pnpm --filter` (cwd = the package dir); keep the ~150 MB model
 * under this package's gitignored `.cache/` instead.
 */
const MODEL_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'fastembed');

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
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
      const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir: MODEL_CACHE_DIR });
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