import type { OkfMarkdownLink } from './types';
import { extractMarkdownLinks } from './markdown-links';

function escapeLinkLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ');
}

export function appendRelatedSection(
  body: string,
  links: Array<{ edge_type: string; path: string }>,
): string {
  if (links.length === 0) return body;
  const trimmed = body.replace(/\s+$/, '');
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  const lines = ['## Related', ''];
  for (const link of links) {
    lines.push(`- [${escapeLinkLabel(link.edge_type)}](${link.path})`);
  }
  return `${prefix}${lines.join('\n')}\n`;
}

export function splitRelatedSection(body: string): { body: string; relatedLinks: OkfMarkdownLink[] } {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;

  let scan = end - 1;
  while (scan >= 0 && /^-\s+/.test(lines[scan])) scan -= 1;
  while (scan >= 0 && lines[scan].trim() === '') scan -= 1;

  if (scan < 0 || lines[scan].trim() !== '## Related') {
    return { body, relatedLinks: [] };
  }

  const relatedStart = scan;
  const contentBody = lines.slice(0, relatedStart).join('\n');
  const relatedBlock = lines.slice(relatedStart, end).join('\n');
  const relatedLinks: OkfMarkdownLink[] = [];
  for (const line of relatedBlock.split(/\r?\n/)) {
    const bullet = /^-\s+(.*)$/.exec(line);
    if (!bullet) continue;
    relatedLinks.push(
      ...extractMarkdownLinks(bullet[1]).map(l => ({
        ...l,
        text: l.text.replace(/\\\]/g, ']').replace(/\\\[/g, '[').replace(/\\\\/g, '\\'),
      })),
    );
  }
  const normalizedBody = contentBody.length > 0 ? `${contentBody.replace(/\s+$/, '')}\n` : '';
  return { body: normalizedBody, relatedLinks };
}
