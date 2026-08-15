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

// --- OKF v0.2 surface (additive; existing types unchanged) -----------------

export type OkfStatus = 'draft' | 'stable' | 'deprecated';

export type OkfActorKind = 'agent' | 'human' | 'process';

export interface OkfGenerated {
  by: string; // actor per v0.2 §7 (e.g. 'reference_agent/gemini-2.5-pro', 'human:ahormati', 'process:finance-nightly')
  at: string; // ISO 8601 datetime
}

export interface OkfVerifiedEntry {
  by: string;
  at: string;
}

export type OkfVerified = OkfVerifiedEntry[]; // bare mapping = one-element list per v0.2 §5.2

export interface OkfSourceUsageWindow {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

export interface OkfSource {
  id?: string;
  resource: string;            // absolute URL, bundle-relative path, or scope descriptor
  title?: string;
  author?: string;             // actor per v0.2 §7
  usage_count?: number;
  last_modified?: string;      // YYYY-MM-DD
  usage_window?: OkfSourceUsageWindow; // per-entry override of the sibling usage_window
}

export interface OkfFootnote {
  id: string;
  body: string;
}
