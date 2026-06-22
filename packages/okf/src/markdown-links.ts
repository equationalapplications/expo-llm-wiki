import type { OkfMarkdownLink } from './types';

const LINK_PATTERN = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const EXCLUDED_SCHEME = /^(https?:|mailto:)/i;
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Extracts inline markdown links (`[text](path)`) from a concept body.
 * Single-line regex, not a CommonMark parser — reference-style links, links
 * split across lines, and links inside code fences are not recognized.
 * `http(s):` and `mailto:` targets are excluded; only relative/local paths
 * are candidates for graph edges.
 */
export function extractMarkdownLinks(body: string): OkfMarkdownLink[] {
  const searchableBody = body.replace(FENCED_CODE_BLOCK_PATTERN, '');
  const links: OkfMarkdownLink[] = [];
  let match: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((match = LINK_PATTERN.exec(searchableBody)) !== null) {
    const [, text, path] = match;
    if (EXCLUDED_SCHEME.test(path)) continue;
    links.push({ text, path });
  }
  return links;
}
