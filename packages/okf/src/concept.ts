import type { OkfFrontmatter } from './types';
import { serializeFrontmatter } from './frontmatter';

export function buildConceptDocument(fm: OkfFrontmatter, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body}`;
}
