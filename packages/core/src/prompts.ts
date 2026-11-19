import type { GroundingWriter, ResolvedGrounding } from './utils/grounding';
import { normalizeTitleKey } from './utils/ontology';

/**
 * Specs/librarian-guidance. The general leave-out rule, ruled by the
 * owner (issue #375): the engine appends it, after the host guidance
 * section, only on prompt builds where guidance is actually sent — never
 * on its own. The text is asserted character-for-character by test.
 */
export const LEAVE_OUT_RULE_SENTENCE =
  'Memory leaves out what a better record already holds, and points to that record.';

/**
 * Specs/librarian-guidance. Upper bound on the effective guidance text,
 * counted as UTF-16 code units (`String.prototype.length`) on the value
 * as sent — verbatim, untrimmed (emptiness is judged on the trimmed
 * value; the cap on the real one). Guidance over the cap is not sent and
 * emits `guidance_too_long`; nothing is truncated.
 */
export const GUIDANCE_MAX_CHARS = 2000;

/**
 * The marked section the engine wraps the effective guidance in, appended
 * to the already-hydrated system prompt after ontology context and before
 * the grounding block. The guidance text itself is never run through
 * placeholder hydration, so `{{…}}` inside it cannot change a builder's
 * template branch or be expanded with data.
 */
export function guidanceSection(guidance: string): string {
  return `--- Host guidance ---\n${guidance}\n--- End host guidance ---\n${LEAVE_OUT_RULE_SENTENCE}`;
}

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

/**
 * #381 fix: the classifier prompt never surfaced the existing node titles, so
 * its strict-mode "omit invalid edges" rules made proposing nothing the
 * fully-compliant answer (0/28 in the statement-kinds measured run). The
 * title catalog is the verifiable target pool. Rows are typed nodes only —
 * the caller reads them from the same title index edge resolution uses, so
 * a catalog title is resolvable by construction.
 */
export const TITLE_CATALOG_MAX_ENTRIES = 200;

export function buildTitleCatalogBlock(
  rows: ReadonlyArray<{ title: string; okf_type: string | null }>,
): string {
  // Dedupe LAST-WINS by normalized title key — edge resolution fills its
  // index with Map.set on the same key, so the last row per key is the node
  // a proposal actually resolves to; the catalog must show that node's type
  // (T1.5 sonnet-xhigh rung N2). Residual ambiguity: the DB row order that
  // defines "last" is unspecified on both sides.
  const byKey = new Map<string, { title: string; okf_type: string }>();
  for (const r of rows) {
    if (typeof r.title !== 'string' || r.title.length === 0) continue;
    if (typeof r.okf_type !== 'string' || r.okf_type.length === 0) continue;
    byKey.set(normalizeTitleKey(r.title), { title: r.title, okf_type: r.okf_type });
  }
  const typed = [...byKey.values()]
    // UTF-16 code-unit order via `<` — deterministic across runtimes/locales
    // (not locale-sensitive), so prompts (and any cap boundary) are stable.
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  // Char budget (sonnet-xhigh N3): 200 entries of long imported titles could
  // eat the runBatched payload budget before any fact is added, and an
  // oversized lone fact is still sent. Bound the block itself.
  const CHAR_BUDGET = 8000;
  const listed: Array<{ title: string; okf_type: string }> = [];
  let used = 0;
  for (const r of typed) {
    const line = `- ${JSON.stringify(r.title)} (${r.okf_type})`;
    // Non-fitting lines are SKIPPED (continue), never a break: a break would
    // hide every shorter title sorting after an oversized one, and stopping
    // on the first line could empty the block while typed nodes exist — the
    // empty wording would then falsely claim there are no targets (Opus r3
    // delta M1 + haiku delta residual). Only the entry-count cap breaks.
    if (line.length + 1 > CHAR_BUDGET) continue;
    if (listed.length >= TITLE_CATALOG_MAX_ENTRIES) break;
    if (used + line.length + 1 > CHAR_BUDGET) continue;
    listed.push(r);
    used += line.length + 1;
  }
  const truncated = typed.length > listed.length;
  if (typed.length === 0) {
    return [
      'TITLE CATALOG: this memory contains no typed nodes yet.',
      'A fact classified in this same response is a valid "target_title" once typed. Otherwise omit "edges" rather than invent a target_title.',
    ].join('\n');
  }
  if (listed.length === 0) {
    // Typed nodes exist but none fit the budget — truncated, not empty.
    return [
      'TITLE CATALOG: existing typed nodes exist in this memory, but none fit the catalog budget.',
      'A fact classified in this same response is a valid "target_title" once typed. Otherwise omit "edges" rather than invent a target_title.',
    ].join('\n');
  }
  const catalog = listed.map((r) => `- ${JSON.stringify(r.title)} (${r.okf_type})`).join('\n');
  return [
    'TITLE CATALOG: existing typed nodes in this memory include:',
    catalog,
    ...(truncated ? ['(This list is truncated; more typed nodes exist than are shown here.)'] : []),
    'A "target_title" may be copied verbatim from this catalog, or be another fact classified in this same response. If no valid target exists, omit "edges" rather than invent a target_title.',
  ].join('\n');
}

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

export const OPS_EXTRACT_SYSTEM_PROMPT = `You are a memory extraction agent. Read the numbered events and extract durable facts about the user or entity, and actionable tasks.
Return ONLY a valid JSON object matching this schema:
{
  "facts": [{ "title": "string (max 80 chars)", "body": "string (max 800 chars)", "tags": ["string"], "confidence": "certain|inferred|tentative", "source_event": "the event label, e.g. e1", "valid_from": "optional ISO-8601 date the fact became true, only when the events state it" }],
  "tasks": [{ "description": "string", "priority": "number (0-10)" }]
}
One fact per claim. Every fact must name the single event it comes from in "source_event". Do not return markdown, just raw JSON.`;

export const OPS_RESOLVE_SYSTEM_PROMPT = `You are a memory reconciliation agent. Each item has a NEW candidate fact and EXISTING facts labelled n1, n2, ... that look similar to it. Choose exactly one op per item:
- "ADD": the candidate is new information; the existing facts are about something else.
- "UPDATE": one existing fact states the same thing and the candidate adds detail. Give the merged "title" and "body" for that existing fact.
- "SUPERSEDE": the candidate replaces an existing fact that is no longer true (moved, changed jobs, changed preference, reversed decision).
- "NOOP": an existing fact already states the candidate.
Return ONLY a valid JSON object matching this schema:
{ "ops": [{ "item": 0, "op": "ADD|UPDATE|SUPERSEDE|NOOP", "target": "n1", "title": "UPDATE only", "body": "UPDATE only" }] }
"target" is required for UPDATE, SUPERSEDE and NOOP and must be one of that item's own labels. Do not return markdown, just raw JSON.`;
