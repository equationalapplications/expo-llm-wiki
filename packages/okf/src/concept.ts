import type { OkfFrontmatter } from './types';
import { serializeFrontmatter, parseFrontmatter } from './frontmatter';

export function buildConceptDocument(fm: OkfFrontmatter, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body}`;
}

/** Reverse of {@link buildConceptDocument}: strips the single leading blank-line separator. */
export function parseConcept(content: string): { frontmatter: OkfFrontmatter; body: string } {
  const { frontmatter, rest } = parseFrontmatter(content);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  return { frontmatter, body };
}
