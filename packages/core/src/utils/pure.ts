import type { ExtractedFact, ExtractedTask } from '../types';
import { WikiParseError } from '../types';

/**
 * Maximum number of candidate substrings the tier-2 walker will try before
 * throwing `WikiParseError`. 5 covers the realistic case (a few bare quotes
 * produce a few candidate spans) without unbounded retry on truly broken
 * inputs.
 */
const MAX_REPAIR_CANDIDATES = 5;

/**
 * Extract JSON from an LLM response.
 *
 * Tier 1 (strict): the existing hand-rolled brace-matching scanner. Walks
 * `text` from the first `{` or `[` to its matching close, respecting `\"` and
 * `\\`. Correct whenever the input contains no unescaped `"` inside string
 * bodies. Returns the parsed value via `JSON.parse`.
 *
 * Tier 2 (repair): triggered only when tier 1 throws. Re-walks the raw text
 * from `start` (NOT from the scanner's possibly-truncated slice) with a
 * container-context stack that classifies every `"` as **structural** (open
 * or close a string) or **content** (needs `\` prefix). Produces candidate
 * substrings at every position the container stack returns to empty and
 * tries each largest-first; the first that `JSON.parse` accepts is returned.
 *
 * Throws {@link WikiParseError} when both tiers fail. The error's `tier`
 * field distinguishes 'strict' (no scanner slice found) from 'repair'
 * (scanner slice found but unparsable) from 'all' (catch-all).
 */
export function parseJsonResponse<T>(text: string): T {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start: number;
  let openChar: string;

  const useBrace =
    firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);

  if (useBrace) {
    start = firstBrace;
    openChar = '{';
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openChar = '[';
  } else {
    throw new WikiParseError(
      'No JSON object/array found in LLM response',
      { tier: 'strict', position: null, slice: text },
    );
  }

  // Tier 1: try the existing scanner first. If `JSON.parse` succeeds we're done.
  const slice = scanJsonSlice(text, start, openChar);
  const scannerFoundSlice = slice !== null;
  if (slice !== null) {
    try {
      return JSON.parse(slice) as T;
    } catch {
      // fall through to tier 2
    }
  }

  // Tier 2: container-aware walker over the raw text. The scanner's slice may
  // be arbitrarily truncated by a bare quote mid-string — running the walker
  // on the raw text from `start` is the only way to get a complete container
  // span to repair against.
  const repair = containerAwareRepair(text, start);
  if (repair.success !== null) {
    return JSON.parse(repair.success) as T;
  }
  // `repair.failed` carries the largest balanced span the walker found plus
  // the parse position from JSON.parse — both fields the public contract
  // promises on `WikiParseError` for `tier: 'repair'`. Without this branch
  // a balanced but invalid payload (e.g. `{"facts":}`) would fall through to
  // the generic `tier: 'all'` throw below, losing the diagnostic.
  if (repair.failed !== null) {
    throw new WikiParseError(
      `Repair produced a candidate but JSON.parse rejected it: ${repair.failed.message}`,
      { tier: 'repair', position: repair.failed.position, slice: repair.failed.candidate },
    );
  }

  // Per spec (WikiParseError `tier: 'strict'`): a scanner that produced NO
  // usable slice (no balanced close) is a strict failure even when the
  // container-aware walker also finds nothing — the input is structurally
  // incomplete, not just unparseable.
  if (!scannerFoundSlice) {
    throw new WikiParseError(
      'No JSON object/array found in LLM response',
      { tier: 'strict', position: start, slice: text },
    );
  }

  throw new WikiParseError(
    'No parsable JSON candidate found',
    { tier: 'all', position: start, slice: text },
  );
}

/**
 * Tier-1 scanner: returns the substring from `start` to the matching close
 * of the container opened by `openChar` at `start`, or `null` if no balanced
 * close exists. Pure function — extracted so `parseJsonResponse` reads as
 * the two-tier flow it implements.
 */
function scanJsonSlice(text: string, start: number, openChar: string): string | null {
  const closeChar = openChar === '{' ? '}' : ']';
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
  if (end === -1) return null;
  return text.slice(start, end + 1);
}

/**
 * Tier-2 walker: re-walks the raw text from `start` with a container-context
 * stack and a peek-ahead rule that classifies every `"` as either structural
 * (opens/closes a string) or content (needs `\` prefix). Produces candidate
 * substrings at every balanced container close and returns the first one
 * that `JSON.parse` would accept (largest balanced span first), or `null` if
 * no candidate parses.
 *
 * Bounded to {@link MAX_REPAIR_CANDIDATES} candidates to avoid pathological
 * retries on truly broken inputs.
 */
interface ContainerFrame {
  container: 'object' | 'array';
  /**
   * For objects: `true` while the next string token starts a property NAME;
   * `false` while the next string token starts a property VALUE. Stays the
   * role through `,` (a `,` in an object leaves us expecting a key again) and
   * through `:` (a `:` leaves us expecting a value). Arrays always treat
   * every string as a value, so this flag is unused for arrays.
   */
  expectKey: boolean;
}

interface RepairFailure {
  candidate: string;
  position: number | null;
  message: string;
}

interface RepairResult {
  /** First candidate that JSON.parse accepted, or null if none parsed. */
  success: string | null;
  /** First candidate that JSON.parse rejected (best diagnostic), or null. */
  failed: RepairFailure | null;
}

function containerAwareRepair(text: string, start: number): RepairResult {
  const openChar = text[start];
  // The walker produces a sequence of (candidateString, parseable) attempts
  // in largest-first order. We only care about the first one that JSON.parse
  // accepts; JSON.parse itself throws on bad candidates, so we wrap it. The
  // `failed` slot is the best rejection we saw along the way — callers use
  // it to construct a `WikiParseError` with `tier: 'repair'` when no
  // candidate parses (the public contract documents the slice + position in
  // the error; without this we'd lose them and be forced to `tier: 'all'`).
  const candidates: string[] = [];
  const stack: ContainerFrame[] = [];
  let inString = false;
  let stringRole: 'key' | 'value' | null = null;
  let escape = false;
  let i = start;
  // Output buffer; rebuilt as we walk, used to emit candidate substrings.
  let out = '';
  // Tracks bare quotes emitted as content so far inside the current string
  // token. Used to suppress a structural close on a `,` peek-ahead when the
  // body still has an open unescaped bare quote (`{"body":"hi", then...`}`);
  // closing prematurely puts the comma at structural level where JSON.parse
  // expects a property name. Reset on every structural close (or open).
  let bareQuoteCount = 0;

  while (i < text.length) {
    const ch = text[i];

    if (escape) {
      out += ch;
      escape = false;
      i++;
      continue;
    }
    if (inString && ch === '\\') {
      out += ch;
      escape = true;
      i++;
      continue;
    }
    if (ch === '"') {
      // Peek-ahead: skip whitespace, then look at the next non-whitespace char.
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) {
        j++;
      }
      const next = j < text.length ? text[j] : '';

      if (!inString) {
        // Structural opening quote — except when peek-ahead shows a
        // container close, in which case this `"` is the close of an
        // implicit string (the body string was implicitly closed at the
        // previous position by a bare-quote fix) and the structural close
        // follows immediately. Emit both and pop the stack.
        if (next === '}' || next === ']') {
          out += ch;
          out += next;
          i = j + 1;
          stack.pop();
          if (stack.length === 0) {
            candidates.push(out);
            if (candidates.length >= MAX_REPAIR_CANDIDATES) break;
          }
          continue;
        }
        // Structural opening quote — always treated as opening (no escape).
        // Determine the string's role from the top frame: object + expectKey
        // → key, otherwise value. Arrays always treat strings as values.
        const top = stack[stack.length - 1];
        stringRole = top?.container === 'object' && top.expectKey ? 'key' : 'value';
        out += ch;
        inString = true;
        i++;
        continue;
      }

      // We're inside a string. Closing if next is one of , } ] : or another " followed by :
      // Suppress the comma-only close when we have an open bare quote —
      // a `,` peek-ahead after an odd number of bare quotes means the
      // comma is body content, not a structural separator.
      //
      // Role-aware: `next === ':'` and `next === '"' && text[j+1] === ':'`
      // are KEY-close signals (the `: ` is the JSON "this string was a key"
      // separator) and only fire for `stringRole === 'key'`. For value
      // strings, a `:` after the closing quote is body content (e.g.
      // `{"body":"foo: "bar": baz"}`) — closing prematurely there corrupts
      // the value. The `,` `}` `]` cases are value-close signals and always
      // apply.
      const commaOnly = next === ',';
      const isKeyClose = stringRole === 'key' && (
        next === ':' ||
        (next === '"' && j + 1 < text.length && text[j + 1] === ':')
      );
      const isValueClose = !commaOnly && (
        next === ',' ||
        next === '}' ||
        next === ']'
      );
      const isClosing =
        isKeyClose ||
        isValueClose ||
        (commaOnly && bareQuoteCount % 2 === 0);

      if (isClosing) {
        out += ch;
        inString = false;
        // Update the top frame's expectKey state. After closing a key, the
        // next string token is a value (separator is `:`) — expectKey=false.
        // After closing a value in an object, the next string token is a key
        // (separator is `,` or end-of-object) — expectKey=true. Array frames
        // ignore this flag (every string in an array is a value).
        const topFrame = stack[stack.length - 1];
        if (topFrame && topFrame.container === 'object') {
          topFrame.expectKey = stringRole === 'value';
        }
        stringRole = null;
        bareQuoteCount = 0;
        i++;
        continue;
      }

      // Content quote — escape it.
      out += '\\' + ch;
      bareQuoteCount++;
      i++;
      continue;
    }
    if (!inString && (ch === '{' || ch === '[')) {
      // Push a new frame. Objects start expecting a key; arrays ignore the
      // flag (every string token is a value).
      stack.push({ container: ch === '{' ? 'object' : 'array', expectKey: true });
      out += ch;
      i++;
      continue;
    }
    if (!inString && ch === ',') {
      // A `,` in an object leaves us expecting a key. The string-close handler
      // already sets `expectKey=true` after a value close, so the only case
      // we need to handle here is the unit-structural case where the prior
      // element was a primitive (number, null, true, false, etc.) — its
      // position in the OUT stream is identical to a value close for the
      // purposes of the next string token.
      const topFrame = stack[stack.length - 1];
      if (topFrame && topFrame.container === 'object') {
        topFrame.expectKey = true;
      }
      out += ch;
      i++;
      continue;
    }
    if (!inString && (ch === '}' || ch === ']')) {
      out += ch;
      stack.pop();
      if (stack.length === 0) {
        // Balanced close at this position — emit a candidate.
        candidates.push(out);
        if (candidates.length >= MAX_REPAIR_CANDIDATES) break;
        // Continue walking; subsequent balanced spans are inner / sibling
        // subtrees. The largest outer span is what `JSON.parse` will accept
        // first, so we try in collection order (outermost wins).
      }
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  let bestFailed: RepairFailure | null = null;
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return { success: candidate, failed: bestFailed };
    } catch (err) {
      // Capture the first rejection as the best diagnostic. `parseJsonResponse`
      // uses this to build `WikiParseError` with `tier: 'repair'` and the
      // candidate slice + parse position — the public contract that callers
      // rely on for observability.
      if (bestFailed === null) {
        bestFailed = {
          candidate,
          position: extractParsePosition(err),
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  return { success: null, failed: bestFailed };
}

/**
 * Pulls the position offset out of a V8 `SyntaxError` message when present.
 * The V8 message format is `"Unexpected token X in JSON at position N"` (or
 * `"Unexpected end of JSON input"` with no position). We return `null` when
 * no position can be parsed — `WikiParseError.position` is `number | null`.
 */
function extractParsePosition(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /position\s+(\d+)/.exec(msg);
  return match ? Number(match[1]) : null;
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
 *   before chunking. Empty/whitespace-only input returns the empty result
 *   below without validating `maxChunkLength`/`overlap`.
 * @param maxChunkLength - For non-empty input, maximum characters per chunk;
 *   must be an integer >= 2.
 * @param overlap - For non-empty input, maximum number of characters each
 *   chunk repeats from the end of the previous chunk; must be a
 *   non-negative integer less than `maxChunkLength`. A chunk repeats fewer
 *   characters when the previous chunk was shorter than `overlap`.
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
