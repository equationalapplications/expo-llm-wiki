import type { OkfFrontmatter, OkfFrontmatterScalar, OkfFrontmatterValue } from './types';

const RESERVED_LITERALS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', '']);

function looksLikeNumber(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

function isIso8601Timestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4}|[+-]\d{2})$/.test(value);
}

function needsQuoting(value: string): boolean {
  if (value !== value.trim()) return true;
  if (/[\n\r\t]/.test(value)) return true;
  if (isIso8601Timestamp(value)) return false;

  // Quote strings that YAML could otherwise parse as collections/indicators.
  if (/^[-?:]\s/.test(value)) return true;
  if (/^[\[\]{}&,*%!|>'"@`]/.test(value)) return true;

  if (value.includes(':') || value.includes('#')) return true;
  if (RESERVED_LITERALS.has(value.toLowerCase())) return true;
  if (looksLikeNumber(value)) return true;
  return false;
}

function quoteString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export function serializeScalarString(value: string): string {
  return needsQuoting(value) ? quoteString(value) : value;
}

export function serializeActorString(value: string): string {
  // Actor strings in OKF v0.2 §7 contain `/` (agent/version), `:` (human:/process:),
  // or both — any of these would otherwise parse ambiguously as YAML scalars.
  if (/[/:]/.test(value)) return quoteString(value);
  return value;
}

function serializeKey(key: string): string {
  // needsQuoting() intentionally exempts ISO 8601 timestamps for *values*.
  // For keys, quote timestamp-like scalars to avoid YAML timestamp coercion in some parsers.
  if (/\s/.test(key) || needsQuoting(key) || isIso8601Timestamp(key)) {
    return quoteString(key);
  }
  return key;
}

function serializeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return serializeScalarString(value);
  throw new Error(`Unsupported frontmatter value type: ${typeof value}`);
}

export function serializeFrontmatter(fm: OkfFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${serializeKey(key)}: []`);
      } else {
        lines.push(`${serializeKey(key)}:`);
        for (const item of value as unknown[]) {
          if (typeof item === 'string') {
            lines.push(`  - ${serializeScalarString(item)}`);
          } else {
            lines.push(`  - ${serializeValue(item)}`);
          }
        }
      }
    } else {
      lines.push(`${serializeKey(key)}: ${serializeValue(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function unescapeFrontmatterString(escaped: string): string {
  let result = '';
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i];
    if (ch === '\\' && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next === 'n') { result += '\n'; i++; continue; }
      if (next === 'r') { result += '\r'; i++; continue; }
      if (next === 't') { result += '\t'; i++; continue; }
      if (next === '"') { result += '"'; i++; continue; }
      if (next === '\\') { result += '\\'; i++; continue; }
    }
    result += ch;
  }
  return result;
}

function unescapeSingleQuotedString(escaped: string): string {
  return escaped.replace(/''/g, "'");
}

function parseQuotedScalar(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeFrontmatterString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return unescapeSingleQuotedString(trimmed.slice(1, -1));
  }
  return null;
}

function parseKey(raw: string): string {
  return parseQuotedScalar(raw) ?? raw.trim();
}

function parseScalarValue(raw: string): OkfFrontmatterScalar {
  const quoted = parseQuotedScalar(raw);
  if (quoted !== null) return quoted;
  const trimmed = raw.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function matchFrontmatterKeyValue(
  line: string,
): { key: string; value: string; hasValue: boolean } | null {
  const keyMatch = /^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^:]+)/.exec(line);
  if (!keyMatch) return null;
  const key = keyMatch[0];
  if (line[key.length] !== ':') return null;
  const tail = line.slice(key.length + 1);
  return { key, value: tail.trimStart(), hasValue: tail.trim().length > 0 };
}

/**
 * True if `text` contains an unquoted `&` or `*` — the anchor/alias indicators we
 * refuse to recognize (billion-laughs safety, profile-1 §8). Quoted spans are
 * excluded from the scan so an ordinary value like a URL query string
 * (`"https://x/a?p=1&q=2"`) is never misdetected as an anchor.
 */
function hasUnquotedAnchorOrAlias(text: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '&' || ch === '*') return true;
  }
  return false;
}

/**
 * Split a comma-separated list of inner flow entries, respecting quoted strings
 * and nested `{...}` / `[...]` spans (so a nested flow collection's internal
 * commas don't split the outer entry list). Returns null on unbalanced
 * quotes/brackets.
 */
function splitFlowEntries(inner: string): string[] | null {
  const entries: string[] = [];
  let buf = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  let depthBrace = 0;
  let depthBracket = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < inner.length) { buf += inner[i + 1]; i += 2; continue; }
      if (ch === quote) quote = null;
      i++; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; i++; continue; }
    if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    if (ch === ',' && depthBrace === 0 && depthBracket === 0) {
      entries.push(buf.trim()); buf = ''; i++; continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim().length > 0) entries.push(buf.trim());
  if (depthBrace !== 0 || depthBracket !== 0 || quote !== null) return null;
  return entries;
}

/**
 * `depth` counts levels of **mapping-value nesting** only: it increments when a
 * flow MAPPING's key has a value that is itself a flow collection, and is
 * rejected once it would exceed 1 (spec §2.6's "at most one level of nesting").
 * It does NOT increment when a flow SEQUENCE's item is itself a mapping or
 * sequence — `sources: [ {...}, {...} ]` (a flat array of objects) is the base
 * shape v0.2 uses everywhere and is not "nesting" in the spec's sense. This is
 * what lets `sources: [ { usage_window: { from, to } } ]` parse (sequence item
 * is a mapping at depth 0; that mapping's `usage_window` value is a mapping at
 * depth 1 — one level, allowed) while `{ a: { b: { c: 1 } } }` is rejected
 * (`a`'s value nests at depth 1; `b`'s value would need depth 2 — rejected).
 */
export function parseFlowMapping(text: string, depth = 0): Record<string, OkfFrontmatterValue> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  // Anchor / alias hard ban, quoted spans excluded from the scan.
  if (hasUnquotedAnchorOrAlias(trimmed)) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return {};
  const entries = splitFlowEntries(inner);
  if (!entries) return null;
  const out: Record<string, OkfFrontmatterValue> = {};
  for (const entry of entries) {
    const kv = matchFrontmatterKeyValue(entry);
    if (!kv || !kv.hasValue) return null;
    const v = kv.value.trim();
    if (v.startsWith('{') || v.startsWith('[')) {
      // This IS a mapping-value nesting step: consumes one level of budget.
      if (depth >= 1) return null; // would be a 2nd level of mapping-value nesting — reject
      const nested = v.startsWith('{') ? parseFlowMapping(v, depth + 1) : parseFlowSequence(v, depth + 1);
      if (nested === null) return null;
      out[parseKey(kv.key)] = nested as OkfFrontmatterValue;
      continue;
    }
    out[parseKey(kv.key)] = parseScalarValue(v);
  }
  return out;
}

export function parseFlowSequence(text: string, depth = 0): OkfFrontmatterValue[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  if (hasUnquotedAnchorOrAlias(trimmed)) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const entries = splitFlowEntries(inner);
  if (!entries) return null;
  const out: OkfFrontmatterValue[] = [];
  for (const entry of entries) {
    const v = entry.trim();
    if (v.startsWith('{') || v.startsWith('[')) {
      // A sequence item that is itself a collection does NOT consume nesting
      // budget — it's parsed at the SAME depth (array-of-objects is the base
      // shape, not an extra level of nesting).
      const nested = v.startsWith('{') ? parseFlowMapping(v, depth) : parseFlowSequence(v, depth);
      if (nested === null) return null;
      out.push(nested as OkfFrontmatterValue);
      continue;
    }
    out.push(parseScalarValue(v));
  }
  return out;
}

/**
 * Parses the subset of YAML frontmatter that {@link serializeFrontmatter} produces:
 * scalar string/number/boolean/null values, quoted strings, and block string-lists.
 * NOT a general YAML parser — flow collections (`[...]`/`{...}`), multi-line block
 * scalars (`|`/`>`), anchors, and aliases are not recognized. Lines that don't match
 * a recognized shape are silently skipped rather than throwing, so a foreign bundle
 * never crashes
 * the import — it just loses fidelity on the unrecognized line.
 */
export function parseFrontmatter(content: string): { frontmatter: OkfFrontmatter; rest: string } {
  const lines = content.split(/\r?\n/);
  const fallback = { frontmatter: { type: '' } as OkfFrontmatter, rest: content };

  if (lines[0]?.trim() !== '---') return fallback;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return fallback;

  const frontmatter: Record<string, OkfFrontmatterValue> = {};
  let i = 1;
  while (i < closingIndex) {
    const line = lines[i];
    const kv = matchFrontmatterKeyValue(line);
    if (!kv) {
      i++;
      continue;
    }
    if (kv.value.trim() === '[]') {
      frontmatter[parseKey(kv.key)] = [];
      i++;
      continue;
    }
    if (!kv.hasValue) {
      const key = parseKey(kv.key);
      const items: OkfFrontmatterScalar[] = [];
      i++;
      while (i < closingIndex && /^\s*-\s/.test(lines[i])) {
        items.push(parseScalarValue(lines[i].replace(/^\s*-\s/, '')));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }
    const valueRaw = kv.value.trim();
    // OKF v0.2 flow collections: { k: v, k: v } and [ a, b, c ], at most one level
    // of nesting (spec §2.6). Anchor/alias-opaque (handled inside the flow parsers).
    if (valueRaw.startsWith('{')) {
      const flowObj = parseFlowMapping(valueRaw);
      if (flowObj !== null) { frontmatter[parseKey(kv.key)] = flowObj as OkfFrontmatterValue; i++; continue; }
      // Rejected (anchor/alias, or nested more than one level deep): preserve the key
      // with a null value rather than misreading `{ a: { b: 1 } }` as a scalar string.
      frontmatter[parseKey(kv.key)] = null;
      i++;
      continue;
    }
    if (valueRaw.startsWith('[')) {
      // Empty flow sequence falls through to existing `[]` handling above.
      if (valueRaw === '[]') {
        frontmatter[parseKey(kv.key)] = [];
        i++;
        continue;
      }
      const flowSeq = parseFlowSequence(valueRaw);
      if (flowSeq !== null) { frontmatter[parseKey(kv.key)] = flowSeq as OkfFrontmatterValue; i++; continue; }
      frontmatter[parseKey(kv.key)] = null;
      i++;
      continue;
    }
    frontmatter[parseKey(kv.key)] = parseScalarValue(kv.value);
    i++;
  }

  if (typeof frontmatter['type'] !== 'string') {
    frontmatter['type'] = '';
  }

  const restLines = lines.slice(closingIndex + 1);
  const rest = restLines.length > 0 ? restLines.join('\n') : '';

  return { frontmatter: frontmatter as OkfFrontmatter, rest };
}
