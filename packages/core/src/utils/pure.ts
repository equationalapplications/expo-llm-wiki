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
 * Throws {@link WikiParseError} for the "no JSON object/array found" case.
 * Used at the two strict-tier throw sites that differ only in whether a
 * `[`/`{` was located: when `start === null`, no open bracket was found;
 * when `start` is a number, an open bracket was found but no balanced
 * close existed. Both share the user-facing diagnostic.
 */
function throwNoJsonFound(text: string, start: number | null): never {
  throw new WikiParseError(
    'No JSON object/array found in LLM response',
    { tier: 'strict', position: start, slice: text },
  );
}

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
    throwNoJsonFound(text, null);
  }

  // Tier 1: try the existing scanner first. If `JSON.parse` succeeds we're done.
  const slice = scanJsonSlice(text, start, openChar);
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
  // span to repair against. The walker validates via `JSON.parse` itself and
  // returns the already-parsed value, so we don't re-parse on the hot path.
  //
  // The walker runs twice under opposing comma-ambiguity policies — see
  // `containerAwareRepair` docstring. Both passes can produce parseable
  // JSON for the SAME input but with different shapes — e.g. for
  // `{"title":"He said "hi"","body":"ok"}` the odd-parity pass swallows
  // `,"body":"ok"` into the title (parseable but wrong), while for
  // `{"title":"24" monitor","body":"ok"}` the even-parity pass does the
  // swallowing. When both parse, we prefer the pass that mutated the input
  // LESS (fewer content-quote escapes): the correct interpretation escapes
  // exactly the true bare quotes, while the swallowing one escapes the
  // structural quotes it consumes too. When only the odd-parity pass parsed
  // AND it never hit a comma-ambiguity position, the even-parity pass is
  // guaranteed to make identical decisions, so we skip it entirely. Each
  // pass is bounded by MAX_REPAIR_CANDIDATES.
  const repairOdd = containerAwareRepair(text, start, false);
  if (repairOdd.success !== null && !repairOdd.ambiguous) {
    return repairOdd.success as T;
  }
  const repairEven = containerAwareRepair(text, start, true);
  if (repairOdd.success !== null && repairEven.success !== null) {
    // Both policies produced a parseable candidate. Prefer the minimal
    // repair; on a tie (identical walks) keep the odd-parity result, which
    // matches the historical single-pass behavior.
    const pick = repairEven.escapes < repairOdd.escapes ? repairEven : repairOdd;
    return pick.success as T;
  }
  if (repairOdd.success !== null) {
    return repairOdd.success as T;
  }
  if (repairEven.success !== null) {
    return repairEven.success as T;
  }
  // Both policies failed to parse. Prefer the even-parity failed candidate
  // as the diagnostic — it's the original walker behavior and its failure
  // message matches what callers (and existing tests) expect on
  // balanced-but-invalid payloads like `{"facts":}`.
  const repair = repairEven.failed !== null ? repairEven : repairOdd;
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
  if (slice === null) {
    throwNoJsonFound(text, start);
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
  // safeSlice lives in this same file and is the project's surrogate-pair-safe
  // string-slice helper (used by chunkText). Bare `text.slice(start, end + 1)`
  // can split a UTF-16 surrogate pair when `end` lands between the high and
  // low halves; the walker downstream then trips on a U+FFFD replacement char.
  return safeSlice(text, start, end + 1);
}

/**
 * Tier-2 walker: re-walks the raw text from `start` with a container-context
 * stack and a peek-ahead rule that classifies every `"` as either structural
 * (opens/closes a string) or content (needs `\` prefix). Produces candidate
 * substrings at every balanced container close and returns the first one
 * that `JSON.parse` would accept (largest balanced span first), or `null` if
 * no candidate parses.
 *
 * The walker tries two policies at comma-ambiguity positions (`"X"`,
 * `X` ends in a bare quote, peek-ahead is `,`):
 *
 * - `closeOnEvenParity=true`  — treat the quote as STRUCTURAL CLOSE when the
 *   bare-quote count is EVEN, content escape when ODD. This is the heuristic
 *   that has historically matched LLM output (it works for `"He said "hi", then left."`).
 * - `closeOnEvenParity=false` — the opposite flip. Required for inputs whose
 *   real close is at an ODD count (e.g. `"24" monitor","body":"ok"}`), where
 *   the model intended one literal `"` inside the value string and the next
 *   `"` to be the structural close.
 *
 * `parseJsonResponse` runs both policies and accepts the first parse-success
 * from either; {@link MAX_REPAIR_CANDIDATES} bounds each policy's emissions
 * so the combined work stays small.
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
  success: unknown | null;
  /** First candidate that JSON.parse rejected (best diagnostic), or null. */
  failed: RepairFailure | null;
  /** Number of content quotes this policy escaped (mutated) while walking.
   * Used to arbitrate when BOTH policies produce a parseable candidate:
   * the interpretation that mutated the input less is preferred. */
  escapes: number;
  /** True when the walk hit at least one comma-ambiguity position — the
   * only place the two policies' decisions can diverge. When false, the
   * opposing-policy pass is guaranteed to make identical decisions, so the
   * caller can skip it entirely. */
  ambiguous: boolean;
}

function containerAwareRepair(
  text: string,
  start: number,
  closeOnEvenParity: boolean,
): RepairResult {
  // The walker produces a stream of balanced-span candidates in largest-first
  // order. We try each via `JSON.parse` at emission time so the success
  // path short-circuits without ever building the trailing-prefix out of
  // the walker; on a rejection we capture the first failure as the best
  // diagnostic and keep walking to find another candidate (bounded by
  // MAX_REPAIR_CANDIDATES). The `failed` slot is what callers use to
  // construct a `WikiParseError` with `tier: 'repair'` when nothing parses
  // — the public contract documents the slice + parse position in the
  // error.
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
  // Best rejection seen so far — captured when JSON.parse rejects a
  // candidate so we can surface it on `WikiParseError(tier: 'repair')`.
  let bestFailed: RepairFailure | null = null;
  // Content quotes escaped so far this pass (see RepairResult.escapes).
  let escapes = 0;
  // Whether any comma-ambiguity position was reached (see
  // RepairResult.ambiguous).
  let ambiguous = false;
  // Captured successfully-parsed value of the first candidate that JSON.parse
  // accepted. Carried through the walker's short-circuit return so callers
  // can skip a second `JSON.parse` and `T`-cast on the hot success path.
  let bestSuccess: unknown = null;
  let attempts = 0;

  // Try `JSON.parse(candidate)` immediately on emission; capture the
  // failure as bestFailed (or the value as bestSuccess) and bump the
  // attempt counter. Returns true on success so the caller can short-circuit
  // out of the walk.
  //
  // `safeErrorToString` (defined in this same file) is the hardened
  // non-throwing coercion for the message field. `JSON.parse` always throws
  // a `SyntaxError`, but a hostile SyntaxError subclass with a throwing
  // `message` getter could still escape a raw `err.message` access —
  // delegating to `safeErrorToString` keeps the helper non-throwing.
  function tryEmitCandidate(candidate: string): boolean {
    attempts++;
    try {
      bestSuccess = JSON.parse(candidate);
      return true;
    } catch (err) {
      if (bestFailed === null) {
        bestFailed = {
          candidate,
          position: extractParsePosition(err),
          message: safeErrorToString(err),
        };
      }
      return false;
    }
  }

  while (i < text.length) {
    const ch = text[i];

    // Between top-level spans (stack empty after a failed candidate emit):
    // skip everything except a new container opener, and never accumulate
    // the inter-span text into `out` — sibling candidates must be
    // standalone spans, not span1 + prose + span2 concatenations that
    // JSON.parse can never accept.
    if (stack.length === 0 && !inString) {
      if (ch === '{' || ch === '[') {
        stack.push({ container: ch === '{' ? 'object' : 'array', expectKey: true });
        out += ch;
      }
      i++;
      continue;
    }

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
    // Raw C0 control characters are invalid inside JSON strings, always.
    // Unlike the bare-quote case this repair is fully deterministic (no
    // comma-parity ambiguity — a control char inside a string body can
    // only be content), so both policy passes escape identically.
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += controlCharEscape(code);
        i++;
        continue;
      }
    }
    if (ch === '"') {
      // Peek-ahead: skip whitespace, then look at the next non-whitespace char.
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) {
        j++;
      }
      const next = j < text.length ? text[j] : '';

      if (!inString) {
        // A `"` sitting at structural level right before a container close
        // is stray punctuation from a mis-tracked string boundary — emitting
        // it would open an unterminated string and guarantee JSON.parse
        // rejects the candidate. Skip the quote itself, preserve any
        // whitespace the peek-ahead skipped, emit the close, and pop.
        if (next === '}' || next === ']') {
          if (j > i + 1) out += text.slice(i + 1, j);
          out += next;
          i = j + 1;
          stack.pop();
          if (stack.length === 0) {
            if (tryEmitCandidate(out)) return { success: bestSuccess, failed: bestFailed, escapes, ambiguous };
            if (attempts >= MAX_REPAIR_CANDIDATES) break;
            out = '';
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
      // Comma-ambiguity: when the peek-ahead is `,` after at least one
      // bare-quote content escape, neither interpretation is structurally
      // implied — the comma is either a value separator OR content body.
      // The two passes diverge ONLY here (see the parameter docs on
      // `containerAwareRepair`): the `closeOnEvenParity=true` pass closes
      // on an even count (the legacy heuristic), the false pass on an odd
      // count. When `bareQuoteCount === 0` no ambiguity exists — the comma
      // must close — so both passes close and the caller can skip the
      // second pass entirely (see RepairResult.ambiguous).
      if (commaOnly && bareQuoteCount > 0) ambiguous = true;
      const shouldCommaClose =
        commaOnly && (
          bareQuoteCount === 0 ||
          (closeOnEvenParity
            ? bareQuoteCount % 2 === 0
            : bareQuoteCount % 2 === 1)
        );
      const isClosing =
        isKeyClose ||
        isValueClose ||
        shouldCommaClose;

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
      escapes++;
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
        // Balanced close at this position — try the candidate. The largest
        // outer span is the first one tried, so this short-circuits on the
        // success path. On a rejection, reset `out` so any trailing sibling
        // span is emitted standalone rather than concatenated onto the
        // already-rejected prefix.
        if (tryEmitCandidate(out)) return { success: bestSuccess, failed: bestFailed, escapes, ambiguous };
        if (attempts >= MAX_REPAIR_CANDIDATES) break;
        out = '';
      }
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return { success: null, failed: bestFailed, escapes, ambiguous };
}

/**
 * Maps a C0 control character's code point to its JSON string escape.
 * Uses the short forms JSON shares with JS (\n, \t, \r, \b, \f) and
 * \u00XX for everything else, exactly as JSON.stringify would.
 */
function controlCharEscape(code: number): string {
  switch (code) {
    case 0x0A: return '\\n';
    case 0x09: return '\\t';
    case 0x0D: return '\\r';
    case 0x08: return '\\b';
    case 0x0C: return '\\f';
    default: return '\\u' + code.toString(16).padStart(4, '0');
  }
}

/**
 * Pulls the position offset out of a V8 `SyntaxError` message when present.
 * The V8 message format is `"Unexpected token X in JSON at position N"` (or
 * `"Unexpected end of JSON input"` with no position). We return `null` when
 * no position can be parsed — `WikiParseError.position` is `number | null`.
 *
 * Delegates the unknown→string coercion to `safeErrorToString` so a hostile
 * value (throwing toString, Proxy rejecting property access) can never throw
 * out of this helper and unwind the walker. JSON.parse always throws a
 * `SyntaxError`, so the defensive branch is rarely exercised in practice,
 * but the fallback is here to keep the walker non-throwing by construction.
 */
function extractParsePosition(err: unknown): number | null {
  const match = /position\s+(\d+)/.exec(safeErrorToString(err));
  return match ? Number(match[1]) : null;
}

/**
 * Non-throwing coercion of an arbitrary JavaScript value to a string for
 * error-message reporting. JavaScript's `String(e)` returns `e.toString()`
 * for objects, which can throw if `toString` itself throws (e.g. an object
 * with a misbehaving prototype). Without this guard, a single provider-side
 * rejection can escape an `ingestDocument` per-chunk `catch` and tear down
 * `withConcurrency`, discarding every sibling chunk's results — the exact
 * silent-forever failure mode the partial-commit work exists to prevent.
 *
 * Falls back through:
 * - `Error.message` for `Error` instances (always available).
 * - `String(e)`, wrapped in try/catch.
 * - `Object.prototype.toString.call(e)` if `String(e)` threw (also wrapped).
 * - A static `[unstringifiable error]` marker as a final guarantee.
 */
export function safeErrorToString(e: unknown): string {
  // `e instanceof Error` invokes the `getPrototypeOf` trap on `e`. A Proxy
  // whose trap rejects turns the type-check itself into a throw point,
  // escaping every catch around this function body. Treat the trap throw
  // as "not an Error" and fall through to the String() / Object.prototype
  // paths, which themselves catch their own throws.
  let isErrorLike = false;
  try {
    isErrorLike = e instanceof Error;
  } catch {
    // hostile Proxy whose getPrototypeOf trap rejects — fall through
  }
  if (isErrorLike) {
    // Defensive: a hostile `Error` subclass or a tampered native Error could
    // set `message` to a non-string (e.g. `err.message = 42`) or make it a
    // throwing getter. `e.name` is similarly attacker-controllable. Coerce
    // both without unwinding so this helper is truly non-throwing.
    const msg = readErrorField(e, 'message');
    if (typeof msg === 'string' && msg.length > 0) return msg;
    const name = readErrorField(e, 'name');
    if (typeof name === 'string' && name.length > 0) return name;
    return '[Error]';
  }
  try {
    return String(e);
  } catch {
    try {
      return Object.prototype.toString.call(e);
    } catch {
      return '[unstringifiable error]';
    }
  }
}

/**
 * Read a fixed string-typed field off an `Error` instance without ever
 * throwing, even if a subclass installs a hostile getter. Internal helper
 * for `safeErrorToString`.
 */
function readErrorField(e: unknown, key: 'message' | 'name'): unknown {
  try {
    return (e as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function sanitizeRankerError(err: unknown, sanitizeRankerErrors: boolean | undefined): Error {
  // `err instanceof Error` invokes the `getPrototypeOf` trap on `err`. A
  // hostile Proxy (e.g. an injected VectorRanker returning one) whose trap
  // rejects would otherwise escape this "sanitize" function. Compute the
  // guard once — the property accesses below share the same hostile-input
  // surface and need their own guards.
  let isErrorLike = false;
  try {
    isErrorLike = err instanceof Error;
  } catch {
    /* hostile Proxy — treat as non-Error */
  }
  if (sanitizeRankerErrors === false) {
    // `String(err)` invokes the `toString` / `Symbol.toPrimitive` trap on
    // `err`; a hostile Proxy whose trap rejects would throw out of this
    // function, defeating the non-throwing contract. Delegate to the
    // hardened `safeErrorToString` helper which converges all coercion
    // paths onto the static `[unstringifiable error]` marker on throw.
    return isErrorLike ? (err as Error) : new Error(safeErrorToString(err));
  }
  // `errLike.constructor?.name` and `.cause` access can also throw on a
  // hostile Error subclass with throwing getters (optional chaining `?.`
  // only short-circuits null/undefined, not trap throws). Wrap each access
  // so the function's documented non-throwing contract holds for all
  // attacker-controlled inputs.
  let errLike: Error | null = null;
  if (isErrorLike) errLike = err as Error;
  let typeName: string;
  try {
    if (errLike) {
      const rawName: unknown = errLike.constructor?.name;
      typeName = typeof rawName === 'string' ? rawName : 'Error';
    } else {
      typeName = typeof err;
    }
  } catch {
    typeName = isErrorLike ? 'Error' : typeof err;
  }
  let innerCause: Error | undefined;
  if (errLike) {
    let cause: unknown;
    try { cause = errLike.cause; } catch { cause = undefined; }
    if (cause !== undefined) {
      let causeName: string;
      try {
        const rawCauseName: unknown = (cause as Error)?.constructor?.name;
        causeName = typeof rawCauseName === 'string' ? rawCauseName : typeof cause;
      } catch {
        causeName = typeof cause;
      }
      innerCause = new Error(`Caused by: ${causeName}`);
    }
  }
  const sanitized = new Error(
    `VectorRanker ${typeName} (message scrubbed for security)`,
    innerCause ? { cause: innerCause } : undefined,
  );
  try { sanitized.name = typeName; } catch { /* hostile name setter — leave default */ }
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
