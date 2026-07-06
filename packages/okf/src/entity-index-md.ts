import type { OkfIndexSection } from './types';
import { buildIndexMd } from './index-md';

const EVENT_LOG_LINK = /^\[Event log\]\(\.\/log\.md\)\s*$/;
const TOP_LEVEL_H1 = /^#\s+.+\s*$/;
const SECTION_HEADING = /^##\s+(.+)\s*$/;
const INDEX_ENTRY = /^\*\s+\[((?:\\.|[^\]])*)\]\(([^)]+)\)(?:\s+-\s+(.*))?$/;

function unescapeIndexTitle(title: string): string {
  return title.replace(/\\\]/g, ']').replace(/\\\[/g, '[').replace(/\\\\/g, '\\');
}

export function buildEntityIndexMd(options: {
  summary?: string;
  sections: OkfIndexSection[];
}): string {
  const parts: string[] = [];
  if (options.summary?.trim()) {
    parts.push(options.summary.trimEnd(), '');
  }
  const sectionsMd = buildIndexMd(options.sections).trimEnd();
  if (sectionsMd) {
    parts.push(sectionsMd);
    parts.push('');
  }
  parts.push('[Event log](./log.md)');
  return `${parts.join('\n')}\n`;
}

export function parseEntityIndexMd(content: string): {
  summary: string;
  sections: OkfIndexSection[];
} {
  const lines = content.split(/\r?\n/);

  // Optional frontmatter block (--- ... ---) per profile.
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
    if (closing !== -1) start = closing + 1;
  }

  const firstSectionIdx = lines.findIndex((line, idx) => idx >= start && SECTION_HEADING.test(line));
  const summaryEnd = firstSectionIdx === -1 ? lines.length : firstSectionIdx;
  const summaryLines = lines
    .slice(start, summaryEnd)
    .filter(line => !EVENT_LOG_LINK.test(line.trim()));
  let summaryStart = 0;
  while (summaryStart < summaryLines.length && summaryLines[summaryStart].trim() === '') {
    summaryStart += 1;
  }
  if (summaryStart < summaryLines.length && TOP_LEVEL_H1.test(summaryLines[summaryStart].trim())) {
    summaryStart += 1;
  }
  const summary = summaryLines.slice(summaryStart).join('\n').trim();

  const sections: OkfIndexSection[] = [];
  let current: OkfIndexSection | null = null;
  for (let i = Math.max(firstSectionIdx, start); i < lines.length; i += 1) {
    const line = lines[i];
    if (EVENT_LOG_LINK.test(line.trim())) continue;
    const headingMatch = SECTION_HEADING.exec(line);
    if (headingMatch) {
      current = { heading: headingMatch[1], entries: [] };
      sections.push(current);
      continue;
    }
    const entryMatch = INDEX_ENTRY.exec(line);
    if (entryMatch && current) {
      current.entries.push({
        title: unescapeIndexTitle(entryMatch[1]),
        path: entryMatch[2],
        description: entryMatch[3],
      });
    }
  }
  return { summary, sections };
}
