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
