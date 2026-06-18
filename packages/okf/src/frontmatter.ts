import type { OkfFrontmatter } from './types';

const RESERVED_LITERALS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', '']);

function looksLikeNumber(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

function isIso8601Timestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4}|[+-]\d{2})$/.test(value);
}

function needsQuoting(value: string): boolean {
  if (value !== value.trim()) return true;
  if (isIso8601Timestamp(value)) return false;
  if (value.includes(':') || value.includes('#')) return true;
  if (RESERVED_LITERALS.has(value.toLowerCase())) return true;
  if (looksLikeNumber(value)) return true;
  return false;
}

function quoteString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function serializeScalarString(value: string): string {
  return needsQuoting(value) ? quoteString(value) : value;
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
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value as unknown[]) {
          if (typeof item === 'string') {
            lines.push(`  - ${serializeScalarString(item)}`);
          } else {
            lines.push(`  - ${serializeValue(item)}`);
          }
        }
      }
    } else {
      lines.push(`${key}: ${serializeValue(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}
