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

function parseKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeFrontmatterString(trimmed.slice(1, -1));
  }
  return trimmed;
}

function parseScalarValue(raw: string): OkfFrontmatterScalar {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeFrontmatterString(trimmed.slice(1, -1));
  }
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Parses the subset of YAML frontmatter that {@link serializeFrontmatter} produces:
 * scalar string/number/boolean/null values, quoted strings, and block string-lists.
 * NOT a general YAML parser — flow collections (`[...]`/`{...}`), multi-line block
 * scalars (`|`/`>`), anchors, and aliases are not recognized. Lines that don't match
 * a recognized shape (including quoted keys/values containing an embedded, unescaped
 * colon) are silently skipped rather than throwing, so a foreign bundle never crashes
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
    const emptyArrayMatch = /^([^:]+):\s*\[\]\s*$/.exec(line);
    if (emptyArrayMatch) {
      frontmatter[parseKey(emptyArrayMatch[1])] = [];
      i++;
      continue;
    }
    const arrayHeaderMatch = /^([^:]+):\s*$/.exec(line);
    if (arrayHeaderMatch) {
      const key = parseKey(arrayHeaderMatch[1]);
      const items: OkfFrontmatterScalar[] = [];
      i++;
      while (i < closingIndex && /^\s*-\s/.test(lines[i])) {
        items.push(parseScalarValue(lines[i].replace(/^\s*-\s/, '')));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }
    const kvMatch = /^([^:]+):\s(.*)$/.exec(line);
    if (kvMatch) {
      frontmatter[parseKey(kvMatch[1])] = parseScalarValue(kvMatch[2]);
    }
    i++;
  }

  if (typeof frontmatter['type'] !== 'string') {
    frontmatter['type'] = '';
  }

  const restLines = lines.slice(closingIndex + 1);
  const rest = restLines.length > 0 ? restLines.join('\n') : '';

  return { frontmatter: frontmatter as OkfFrontmatter, rest };
}
