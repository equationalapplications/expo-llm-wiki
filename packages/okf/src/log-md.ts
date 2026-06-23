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

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const BULLET = /^-\s+(.*)$/;

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
      entries.push({ date: currentDate, text: bulletMatch[1] });
    }
  }

  return entries;
}
