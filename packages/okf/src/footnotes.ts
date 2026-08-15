import type { OkfFootnote } from './types';

const FOOTNOTE_DEFINITION = /^\[\^([^\]]+)\]:\s?(.*)$/;

/**
 * Extracts footnote definitions from a body. OKF v0.2 footnote attribution uses
 * `[^id]` markers whose label joins to `sources[].id`. This helper parses the
 * `[^id]: text` definition lines at the body tail and returns them as opaque
 * text — we deliberately do NOT try to interpret which body span uses which
 * footnote; the body is the source of truth and is preserved verbatim on
 * round-trip.
 */
export function extractFootnotes(body: string): OkfFootnote[] {
  const out: OkfFootnote[] = [];
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = FOOTNOTE_DEFINITION.exec(lines[i]);
    if (!m) { i++; continue; }
    const id = m[1];
    const firstLine = m[2] ?? '';
    const collected: string[] = [firstLine];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (FOOTNOTE_DEFINITION.test(next)) break;
      // Continuation lines are indented (>= 2 spaces) per CommonMark.
      if (/^\s{2,}\S/.test(next) || /^\s{2,}/.test(next)) {
        collected.push(next.replace(/^\s{2}/, ''));
        i++;
        continue;
      }
      break;
    }
    out.push({ id, body: collected.join('\n').trimEnd() });
  }
  return out;
}

/** Joins footnote definitions back into a body block. Currently unused by round-trip
 * (we preserve bodies verbatim), but exported for future callers. */
export function serializeFootnotes(footnotes: OkfFootnote[]): string {
  return footnotes.map((f) => `[^${f.id}]: ${f.body}`).join('\n');
}