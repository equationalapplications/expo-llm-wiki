export type OkfFrontmatterScalar = string | number | boolean | null;
export type OkfFrontmatterValue = OkfFrontmatterScalar | OkfFrontmatterScalar[];

export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string; // ISO 8601
  [key: string]: OkfFrontmatterValue | undefined; // custom keys; values must be serializable scalars or scalar arrays
}

export interface OkfIndexEntry {
  path: string; // relative to the index.md that contains the link, e.g. 'facts/fact_123.md'
  title: string;
  description?: string;
}

export interface OkfIndexSection {
  heading: string; // e.g. 'Facts'
  entries: OkfIndexEntry[];
}

export interface OkfLogEntry {
  date: string; // ISO 8601 YYYY-MM-DD, used for grouping/heading
  text: string; // rendered line content; may include a markdown link
}

export interface OkfFile {
  path: string;
  content: string;
}

export interface OkfMarkdownLink {
  text: string;
  path: string;
}
