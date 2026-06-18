export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string; // ISO 8601
  [key: string]: unknown; // producers may add custom keys; consumers must preserve them
}

export interface OkfIndexEntry {
  path: string; // bundle-relative, e.g. 'entities/alice/facts/fact_123.md'
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
