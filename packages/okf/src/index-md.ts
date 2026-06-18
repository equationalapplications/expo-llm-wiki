import type { OkfIndexEntry, OkfIndexSection } from './types';

function renderEntry(entry: OkfIndexEntry): string {
  return entry.description
    ? `* [${entry.title}](${entry.path}) - ${entry.description}`
    : `* [${entry.title}](${entry.path})`;
}

function renderSections(sections: OkfIndexSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    for (const entry of section.entries) {
      lines.push(renderEntry(entry));
    }
    lines.push('');
  }
  if (lines.length === 0) return '';
  return lines.join('\n').trimEnd() + '\n';
}

export function buildIndexMd(sections: OkfIndexSection[]): string {
  return renderSections(sections);
}

export function buildRootIndexMd(okfVersion: string, sections: OkfIndexSection[]): string {
  const frontmatter = `---\nokf_version: "${okfVersion}"\n---\n`;
  return `${frontmatter}\n${renderSections(sections)}`;
}
