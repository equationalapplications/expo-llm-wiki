import type { ExtractedFact, ExtractedTask } from '../types';

export function parseJsonResponse<T>(text: string): T {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start: number;
  let openChar: string;
  let closeChar: string;

  const useBrace =
    firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);

  if (useBrace) {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    throw new SyntaxError('No JSON object/array found in LLM response');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) { depth++; continue; }
    if (ch === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) throw new SyntaxError('No JSON object/array found in LLM response');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export function sanitizeRankerError(err: unknown, sanitizeRankerErrors: boolean | undefined): Error {
  if (sanitizeRankerErrors === false) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const typeName = err instanceof Error ? (err.constructor?.name ?? 'Error') : typeof err;
  const innerCause =
    err instanceof Error && err.cause !== undefined
      ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
      : undefined;
  const sanitized = new Error(
    `VectorRanker ${typeName} (message scrubbed for security)`,
    innerCause ? { cause: innerCause } : undefined,
  );
  sanitized.name = typeName;
  return sanitized;
}

/**
 * Slices a string like `String.prototype.slice`, but clamps out-of-range
 * indices instead of relying on JS's implicit clamping, normalizes a
 * start-after-end range by swapping the two bounds, and nudges either bound
 * off a UTF-16 surrogate pair boundary so slicing never splits one code
 * point in half.
 *
 * @param value - The source string to slice.
 * @param start - Start index; negative counts from the end, out-of-range
 *   values are clamped to `[0, value.length]`.
 * @param end - End index (exclusive); defaults to `value.length` when
 *   omitted. Same clamping/negative-index rules as `start`.
 * @returns The sliced substring, never splitting a surrogate pair.
 */
export function safeSlice(value: string, start: number, end?: number): string {
  const length = value.length;
  let safeStart = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  let safeEnd = end === undefined
    ? length
    : end < 0
      ? Math.max(length + end, 0)
      : Math.min(end, length);

  if (safeStart > safeEnd) {
    [safeStart, safeEnd] = [safeEnd, safeStart];
  }

  if (
    safeStart > 0 &&
    safeStart < length &&
    value.charCodeAt(safeStart) >= 0xDC00 &&
    value.charCodeAt(safeStart) <= 0xDFFF &&
    value.charCodeAt(safeStart - 1) >= 0xD800 &&
    value.charCodeAt(safeStart - 1) <= 0xDBFF
  ) {
    safeStart--;
  }

  if (
    safeEnd > 0 &&
    safeEnd < length &&
    value.charCodeAt(safeEnd - 1) >= 0xD800 &&
    value.charCodeAt(safeEnd - 1) <= 0xDBFF &&
    value.charCodeAt(safeEnd) >= 0xDC00 &&
    value.charCodeAt(safeEnd) <= 0xDFFF
  ) {
    safeEnd--;
  }

  return value.slice(safeStart, safeEnd);
}

/**
 * Splits `input` into chunks of at most `maxChunkLength` characters,
 * preferring to split on a paragraph break, then a sentence terminator,
 * then whitespace, falling back to a hard cut only when none of those are
 * found within the window. Consecutive chunks overlap by up to `overlap`
 * characters so context isn't lost at a chunk boundary. This is the exact
 * chunking algorithm `IngestionService.ingestDocument` uses before
 * embedding, so callers can reproduce ingest-time chunk boundaries exactly
 * given the same `maxChunkLength`/`overlap` (see `DEFAULT_MAX_CHUNK_LENGTH`
 * and `DEFAULT_CHUNK_OVERLAP` for the defaults ingest uses).
 *
 * @param input - The text to chunk; leading/trailing whitespace is trimmed
 *   before chunking.
 * @param maxChunkLength - Maximum characters per chunk; must be an integer
 *   >= 2.
 * @param overlap - Maximum number of characters each chunk repeats from the
 *   end of the previous chunk; must be a non-negative integer less than
 *   `maxChunkLength`. A chunk repeats fewer characters when the previous
 *   chunk was shorter than `overlap`.
 * @returns `chunks` — the resulting chunk strings (empty array for
 *   empty/whitespace-only input); `truncated` — `true` if any split had to
 *   fall back to a hard cut (no paragraph/sentence/whitespace boundary
 *   found in the window).
 */
export function chunkText(
  input: string,
  maxChunkLength: number,
  overlap: number
): { chunks: string[]; truncated: boolean } {
  const text = input.trim();
  if (text.length === 0) return { chunks: [], truncated: false };
  if (!Number.isInteger(maxChunkLength) || maxChunkLength < 2) {
    throw new Error('maxChunkLength must be an integer >= 2');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChunkLength) {
    throw new Error('overlap must be a non-negative integer < maxChunkLength');
  }

  const chunks: string[] = [];
  let truncated = false;
  let cursor = 0;
  const halfMax = Math.floor(maxChunkLength / 2);

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChunkLength) {
      chunks.push(safeSlice(text, cursor, text.length));
      break;
    }

    const windowEnd = cursor + maxChunkLength;
    const minSplit = cursor + halfMax;

    // 1. paragraph break
    let splitPoint = -1;
    const paraIdx = text.lastIndexOf('\n\n', windowEnd);
    if (paraIdx >= minSplit && paraIdx + 2 <= windowEnd) {
      splitPoint = paraIdx + 2;
    }

    // 2. sentence terminator (single left-to-right pass, no lookahead regex)
    if (splitPoint === -1) {
      let lastTerm = -1;
      for (let i = minSplit; i < windowEnd - 1; i++) {
        const ch = text[i];
        if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1])) {
          lastTerm = i + 2; // include the terminator + whitespace
        }
      }
      if (lastTerm !== -1 && lastTerm <= windowEnd) splitPoint = lastTerm;
    }

    // 3. whitespace
    if (splitPoint === -1) {
      for (let i = windowEnd - 1; i >= minSplit; i--) {
        if (/\s/.test(text[i])) {
          splitPoint = i + 1;
          break;
        }
      }
    }

    // 4. hard cut
    if (splitPoint === -1) {
      truncated = true;
      splitPoint = windowEnd;
    }

    chunks.push(safeSlice(text, cursor, splitPoint));
    const next = Math.max(splitPoint - overlap, cursor + 1);
    cursor = next;
  }

  return { chunks, truncated };
}

export async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  let failed = false;
  let firstError: unknown;
  async function worker() {
    while (index < tasks.length && !failed) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        if (!failed) { failed = true; firstError = e; }
        return;
      }
    }
  }
  const workerCount = tasks.length === 0 ? 0 : Math.min(Math.max(limit, 1), tasks.length);
  await Promise.allSettled(Array.from({ length: workerCount }, worker));
  if (failed) throw firstError;
  return results;
}

export function clip(value: string, max: number): string {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length <= max ? s : safeSlice(s, 0, max).trimEnd();
}

export function validateTags(tags: any[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(t => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0 && t.length <= 40)
    .slice(0, 6);
}

export function validateFact(fact: any): ExtractedFact | null {
  if (typeof fact?.title !== 'string' || typeof fact?.body !== 'string') return null;
  const title = clip(fact.title, 80);
  const body = clip(fact.body, 800);
  if (!title || !body) return null;

  let confidence = fact.confidence;
  if (confidence !== 'certain' && confidence !== 'tentative') confidence = 'inferred';

  return {
    ...fact,
    title,
    body,
    confidence,
    tags: validateTags(fact.tags)
  };
}

export function validateTask(task: any): ExtractedTask | null {
  if (typeof task?.description !== 'string') return null;
  const description = clip(task.description, 200);
  if (!description) return null;

  let priority = task.priority;
  if (typeof priority !== 'number' || !isFinite(priority)) priority = 0;
  // Clamp priority to valid range 0-10 as documented in the prompt contract
  priority = Math.max(0, Math.min(10, Math.round(priority)));

  return {
    ...task,
    description,
    priority
  };
}

export function normalizeSourceRef(value: string): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeSourceHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

export function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3));
}

export function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}
