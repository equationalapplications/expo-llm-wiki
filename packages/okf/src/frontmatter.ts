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
  if (Array.isArray(value)) return serializeFlowSequenceValue(value);
  if (typeof value === 'object') return serializeFlowMappingValue(value as Record<string, OkfFrontmatterValue>);
  throw new Error(`Unsupported frontmatter value type: ${typeof value}`);
}

/**
 * Quote a flow-mapping/-sequence scalar string more strictly than a top-level
 * scalar. Flow syntax additionally treats `,`, `{`, `}`, `[`, `]` as
 * structural (so a `title` like `"Foo, Bar"` MUST be quoted even though
 * `needsQuoting` alone wouldn't require it for a top-level, non-flow value),
 * and `/`/`:` are quoted too — this is what makes it safe to use uniformly
 * for actor strings (`reference_agent/gemini-2.5-pro`, `human:ahormati`) as
 * well as ordinary string values inside the same flow mapping. This
 * subsumes what a narrower "only quote actor-shaped values" helper would
 * need to do, so every string inside a flow mapping/sequence goes through
 * this one function rather than two different quoting rules depending on
 * which key it's under.
 */
function needsFlowQuoting(value: string): boolean {
  return needsQuoting(value) || /[,{}[\]/:]/.test(value);
}

function serializeFlowScalarString(value: string): string {
  return needsFlowQuoting(value) ? quoteString(value) : value;
}

/** Emit a plain object as an inline flow mapping `{ k: v, k: v }`. At most one
 *  level of nested flow collection (mapping or sequence) as a value, per
 *  spec §2.6 — matches what the parser accepts. */
function serializeFlowMappingValue(obj: Record<string, OkfFrontmatterValue>, depth = 0): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  const parts = entries.map(([k, v]) => {
    let rendered: string;
    if (typeof v === 'string') rendered = serializeFlowScalarString(v);
    else if (v === null || typeof v === 'boolean' || typeof v === 'number') rendered = serializeValue(v);
    else if (Array.isArray(v)) {
      if (depth >= 1) throw new Error(`serializeFlowMappingValue: nesting deeper than one level is not supported (key "${k}")`);
      rendered = serializeFlowSequenceValue(v, depth + 1);
    } else if (typeof v === 'object') {
      if (depth >= 1) throw new Error(`serializeFlowMappingValue: nesting deeper than one level is not supported (key "${k}")`);
      rendered = serializeFlowMappingValue(v as Record<string, OkfFrontmatterValue>, depth + 1);
    } else {
      throw new Error(`serializeFlowMappingValue: unsupported value type for key "${k}"`);
    }
    return `${serializeKey(k)}: ${rendered}`;
  });
  return `{ ${parts.join(', ')} }`;
}

/** Emit an array as an inline flow sequence `[ a, b, c ]`. Object items
 *  serialize as nested inline flow mappings (the base "array of objects"
 *  shape — see the design note above Step 5.1 — does not consume the
 *  one-level nesting budget). */
function serializeFlowSequenceValue(arr: unknown[], depth = 0): string {
  if (arr.length === 0) return '[]';
  const parts = arr.map((item) => {
    if (typeof item === 'string') return serializeFlowScalarString(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return serializeValue(item);
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      // Sequence item that is itself a mapping: same depth (base shape, not nesting).
      return serializeFlowMappingValue(item as Record<string, OkfFrontmatterValue>, depth);
    }
    if (Array.isArray(item)) return serializeFlowSequenceValue(item, depth);
    throw new Error('serializeFlowSequenceValue: unsupported item type');
  });
  return `[ ${parts.join(', ')} ]`;
}

export function serializeFrontmatter(fm: OkfFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${serializeKey(key)}: []`);
      } else if ((value as unknown[]).some((item) => item !== null && typeof item === 'object')) {
        // Array of objects (sources, verified-list, parameters, ...): always a
        // single-line flow sequence, never a block-list of flow-mapping items
        // (see the Step 5 design note — the latter cannot round-trip).
        lines.push(`${serializeKey(key)}: ${serializeFlowSequenceValue(value as unknown[])}`);
      } else {
        // Plain scalar array: existing v0.1 block-sequence form, unchanged.
        lines.push(`${serializeKey(key)}:`);
        for (const item of value as unknown[]) {
          lines.push(`  - ${typeof item === 'string' ? serializeScalarString(item) : serializeValue(item)}`);
        }
      }
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${serializeKey(key)}: ${serializeFlowMappingValue(value as Record<string, OkfFrontmatterValue>)}`);
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
