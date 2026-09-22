import type { GroundingWriter, ResolvedGrounding } from './utils/grounding';

export const LIBRARIAN_SYSTEM_PROMPT = `You are a knowledge extraction agent. Your job is to analyze recent episodic events and extract stable facts and actionable tasks about the user or entity.
Return ONLY a valid JSON object matching this schema:
{
  "facts": [{ "title": "string (max 80 chars)", "body": "string (max 800 chars)", "tags": ["string"], "confidence": "certain|inferred|tentative" }],
  "tasks": [{ "description": "string", "priority": "number (0-10)" }]
}
Keep facts concise. Do not return markdown, just raw JSON.`;

export const HEAL_SYSTEM_PROMPT = `You are a memory grooming agent. Your job is to review a full dump of facts and recent events to resolve contradictions, downgrade stale claims, and flag obsolete facts for deletion.
Return ONLY a valid JSON object matching this schema:
{
  "downgraded": ["string (fact IDs)"],
  "deleted": ["string (fact IDs)"],
  "newFacts": [{ "title": "string (max 80 chars)", "body": "string (max 800 chars)", "tags": ["string"], "confidence": "certain|inferred|tentative" }]
}
Do not return markdown, just raw JSON.`;

export const INGEST_SYSTEM_PROMPT = `You are a document ingestion agent. Your job is to extract factual knowledge from the provided document chunk.
Return ONLY a valid JSON object matching this schema:
{
  "facts": [{ "title": "string (max 80 chars)", "body": "string (max 800 chars)", "tags": ["string"], "confidence": "certain|inferred|tentative" }]
}
Extract verbatim factual content. JSON escaping rules: every literal " character in the source must be escaped as \\" inside any JSON string body, and every literal newline as \\n. Source prose containing quotes (e.g. a worked example with "...") must still be reproduced exactly — re-escape, do not omit. Do not return markdown, just raw JSON.`;

export const ONTOLOGY_BACKFILL_SYSTEM_PROMPT = `You are a knowledge classification agent. You will receive existing memory facts that currently have no ontology type. For each input fact { "id", "title", "body", "tags" }, assign the best matching okf_type from the ontology manifest and optionally propose edges to related facts by title.
Return ONLY a valid JSON object matching this schema:
{
  "classifications": [
    { "id": "string (input fact id, copied verbatim)", "okf_type": "string (manifest node type slug)", "edges": [{ "edge_type": "string", "target_title": "string" }] }
  ]
}
If no manifest type fits a fact, omit that fact from "classifications" entirely — do not guess.
When echoing an existing fact's title verbatim into "target_title", preserve every JSON escape sequence (\\", \\n, \\\\, \\/) exactly as it appeared in the input body — do not strip backslashes, do not add unescaped quotes. Do not return markdown, just raw JSON.`;

const GROUNDING_SOURCE: Record<GroundingWriter, { key: string; source: string }> = {
  ingest: { key: 'facts', source: 'the document chunk' },
  librarian: { key: 'facts', source: 'the "summary" text of the events' },
  heal: { key: 'newFacts', source: 'the "summary" text of the recent events or the "body" text of the document anchors' },
};

/** Evidence instruction appended to an in-scope writer's system prompt (spec §6.2). */
export function groundingEvidenceBlock(writer: GroundingWriter, cfg: ResolvedGrounding): string {
  const { key, source } = GROUNDING_SOURCE[writer];
  return `EVIDENCE REQUIREMENT: every object in "${key}" must also carry an "evidence" array of 1 to ${cfg.maxEvidence} quotes. Each quote must be an exact substring copied character-for-character from ${source} (the SOURCE section), at least ${cfg.minEvidenceChars} characters long. Do not paraphrase. Do not quote these instructions, the ontology manifest, or any existing fact. A fact whose quotes cannot be found in the SOURCE section is stored as an unreviewed draft.
"evidence": ["exact substring copied from the SOURCE section"]`;
}
