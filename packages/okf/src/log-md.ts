import type { OkfLogEntry } from './types';

export function buildLogMd(entries: OkfLogEntry[]): string {
  const groups = new Map<string, OkfLogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.date) ?? [];
    group.push(entry);
    groups.set(entry.date, group);
  }

  const dates = Array.from(groups.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const lines: string[] = [];
  for (const date of dates) {
    lines.push(`## ${date}`);
    lines.push('');
    for (const entry of groups.get(date)!) {
      lines.push(`- ${entry.text}`);
    }
    lines.push('');
  }

  if (lines.length === 0) return '';
  return lines.join('\n').trimEnd() + '\n';
}

export function appendEventIdComment(text: string, eventId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) return text;
  return `${text} <!-- id: ${eventId} -->`;
}

// Hand-rolled instead of an unanchored regex (closes CodeQL #5). `lastIndexOf` matches the
// old leftmost-regex result: `\S+` could never span the whitespace before a later `<!--`.
export function parseEventIdComment(text: string): { text: string; eventId?: string } {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('-->')) return { text };
  const open = trimmed.lastIndexOf('<!--');
  if (open === -1) return { text };
  const inner = trimmed.slice(open + 4, -3).trim();
  if (!inner.startsWith('id:')) return { text };
  const eventId = inner.slice(3).trim();
  if (eventId === '' || /\s/.test(eventId)) return { text };
  const stripped = trimmed.slice(0, open).trimEnd();
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) return { text: stripped };
  return { text: stripped, eventId };
}

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
// linear: capture starts on \S so it cannot trade characters with \s+ (closes CodeQL #6)
const BULLET = /^-\s+(\S.*)?$/;

/**
 * Reverse of {@link buildLogMd}. Best-effort: lines that don't match the exact
 * `## YYYY-MM-DD` heading or `- text` bullet shape buildLogMd emits are skipped,
 * not thrown — a foreign log.md in a different format degrades to fewer entries
 * rather than failing the import.
 */
export function parseLogMd(content: string): OkfLogEntry[] {
  const entries: OkfLogEntry[] = [];
  let currentDate: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const headingMatch = DATE_HEADING.exec(line);
    if (headingMatch) {
      currentDate = headingMatch[1];
      continue;
    }
    const bulletMatch = BULLET.exec(line);
    if (bulletMatch && currentDate) {
      entries.push({ date: currentDate, text: bulletMatch[1] ?? '' });
    }
  }

  return entries;
}
