/**
 * Offset-tracking passage cutter (spec source-store §3). Pure, no dependencies.
 * NOT `chunkText`: that trims and overlaps, so it cannot supply offsets.
 */

/** Maximum passage length in UTF-16 code units (spec §3). */
export const MAX_PASSAGE_UNITS = 12_000;

export interface PassageSpan {
  /** UTF-16 code-unit offset, inclusive: `text.slice(start, end)` is the passage. */
  start: number;
  /** UTF-16 code-unit offset, exclusive. */
  end: number;
}

const WHITESPACE = /\s/;

function isHigh(code: number): boolean { return code >= 0xD800 && code <= 0xDBFF; }
function isLow(code: number): boolean { return code >= 0xDC00 && code <= 0xDFFF; }

/**
 * Cut `text` into contiguous passages of at most `maxUnits` code units. Each
 * boundary prefers the last whitespace in the window (the passage then ends
 * with that whitespace, the `safeSlice` preference), falls back to a hard cut,
 * and never lands between a surrogate pair. No trimming, no overlap: the spans
 * tile `[0, text.length)` exactly. Empty text yields no passages.
 */
export function cutPassages(text: string, maxUnits: number = MAX_PASSAGE_UNITS): PassageSpan[] {
  const limit = Math.max(2, Math.floor(maxUnits)); // 2 so one astral char always fits
  const spans: PassageSpan[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= limit) {
      spans.push({ start, end: text.length });
      break;
    }
    let end = start + limit;
    let cut = -1;
    for (let i = end - 1; i > start; i--) {
      if (WHITESPACE.test(text[i]!)) { cut = i + 1; break; }
    }
    if (cut > start) {
      end = cut;
    } else if (isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) {
      end -= 1; // hard cut: step back so the pair stays whole
    }
    spans.push({ start, end });
    start = end;
  }
  return spans;
}
