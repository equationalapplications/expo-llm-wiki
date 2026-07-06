import { parseFrontmatter, serializeScalarString } from './frontmatter';
import type { OkfIndexEntry, OkfIndexSection } from './types';

function renderEntry(entry: OkfIndexEntry): string {
  const esc = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\r?\n/g, ' ');

  const title = esc(entry.title);
  const description = entry.description ? esc(entry.description) : undefined;

  return description
    ? `* [${title}](${entry.path}) - ${description}`
    : `* [${title}](${entry.path})`;
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

export function buildRootIndexMd(
  okfVersion: string,
  sections: OkfIndexSection[],
  options?: { profile?: string },
): string {
  const lines = ['---', `okf_version: ${serializeScalarString(okfVersion)}`];
  if (options?.profile) {
    lines.push(`profile: ${serializeScalarString(options.profile)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${renderSections(sections)}`;
}

export function parseRootIndexMd(content: string): { okf_version?: string; profile?: string } {
  const { frontmatter } = parseFrontmatter(content);
  return {
    okf_version: typeof frontmatter.okf_version === 'string' ? frontmatter.okf_version : undefined,
    profile: typeof frontmatter.profile === 'string' ? frontmatter.profile : undefined,
  };
}
