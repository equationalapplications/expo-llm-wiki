import type { MemoryDump, WikiEdge, WikiFact, WikiTask, WikiEvent } from '../types';
import {
  appendEventIdComment,
  appendRelatedSection,
  buildConceptDocument,
  buildEntityIndexMd,
  buildRootIndexMd,
  buildLogMd,
  serializeActorString,
  type OkfFile,
  type OkfFrontmatter,
  type OkfIndexEntry,
  type OkfIndexSection,
  type OkfLogEntry,
} from '@equationalapplications/core-okf';
import { sanitizeConceptId, sanitizeForFilename } from './sanitizeForFilename';

export type OkfFormatProfile = 'llm-wiki/1' | 'llm-wiki/2';

export interface FormatOkfBundleOptions {
  /** Defaults to 'llm-wiki/2'. Pass 'llm-wiki/1' to force the v0.1 subset. */
  profile?: OkfFormatProfile;
}

const DEFAULT_PROFILE: OkfFormatProfile = 'llm-wiki/2';

function isoOrFallback(updatedAt: number): string {
  return new Date(updatedAt).toISOString();
}

function factFrontmatterV2(f: WikiFact): OkfFrontmatter {
  return {
    type: f.okf_type ?? 'fact',
    title: f.title,
    tags: f.tags,
    // `timestamp` rides along deliberately even on the v0.2 path — a naive
    // consumer that only understands the v0.1 key still gets a readable date
    // without needing flow-mapping support. `generated.at` is the canonical
    // v0.2 field and always wins on import when both are present (spec §2.4).
    timestamp: isoOrFallback(f.updated_at),
    resource: f.source_ref ?? undefined,
    id: f.id,
    entity_id: f.entity_id,
    confidence: f.confidence,
    source_type: f.source_type,
    source_hash: f.source_hash,
    created_at: f.created_at,
    access_count: f.access_count,
    last_accessed_at: f.last_accessed_at,
    deleted_at: f.deleted_at,
    // OKF v0.2
    status: f.lifecycle_status ?? 'stable',
    ...(f.stale_after != null ? { stale_after: new Date(f.stale_after).toISOString().slice(0, 10) } : {}),
    // Omit `generated` entirely when there's no actor on record — never
    // fabricate a `generated_by` (mirrors the import side's rule in §4.8:
    // it never invents one either, so export must not manufacture one that
    // would then round-trip back in as if it had always been asserted).
    ...(f.generated_by ? { generated: { by: f.generated_by, at: isoOrFallback(f.updated_at) } } : {}),
    // Omit `verified`/`sources` when empty — an emitted `[]` is not the same
    // shape as an absent key (spec §5.3 derives `unverified` from "no
    // `verified` key", not from "empty `verified` list").
    ...(f.okf_verified && f.okf_verified.length > 0 ? { verified: f.okf_verified } : {}),
    ...(f.okf_sources && f.okf_sources.length > 0 ? { sources: f.okf_sources } : {}),
    ...(f.okf_usage_window ? { usage_window: f.okf_usage_window } : {}),
  };
}

function taskFrontmatterV2(t: WikiTask): OkfFrontmatter {
  return {
    type: t.okf_type ?? 'task',
    title: t.description,
    timestamp: isoOrFallback(t.updated_at), // see factFrontmatterV2 comment — deliberate back-compat duplication
    id: t.id,
    entity_id: t.entity_id,
    status: t.lifecycle_status ?? 'stable',         // OKF v0.2 lifecycle
    execution_status: t.status,                      // execution state under renamed key
    priority: t.priority,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
    deleted_at: t.deleted_at,
    // OKF v0.2 — symmetric with facts (spec §2.5): stale_after applies to
    // tasks too (a hallucinated task needs a freshness signal as much as a
    // hallucinated fact does).
    ...(t.stale_after != null ? { stale_after: new Date(t.stale_after).toISOString().slice(0, 10) } : {}),
    ...(t.generated_by ? { generated: { by: t.generated_by, at: isoOrFallback(t.updated_at) } } : {}),
    ...(t.okf_verified && t.okf_verified.length > 0 ? { verified: t.okf_verified } : {}),
    ...(t.okf_sources && t.okf_sources.length > 0 ? { sources: t.okf_sources } : {}),
    ...(t.okf_usage_window ? { usage_window: t.okf_usage_window } : {}),
  };
}

function factFrontmatterV1(f: WikiFact): OkfFrontmatter {
  return {
    type: f.okf_type ?? 'fact',
    title: f.title,
    tags: f.tags,
    timestamp: isoOrFallback(f.updated_at),
    resource: f.source_ref ?? undefined,
    id: f.id,
    entity_id: f.entity_id,
    confidence: f.confidence,
    source_type: f.source_type,
    source_hash: f.source_hash,
    created_at: f.created_at,
    access_count: f.access_count,
    last_accessed_at: f.last_accessed_at,
    deleted_at: f.deleted_at,
  };
}

function taskFrontmatterV1(t: WikiTask): OkfFrontmatter {
  return {
    type: t.okf_type ?? 'task',
    title: t.description,
    timestamp: isoOrFallback(t.updated_at),
    id: t.id,
    entity_id: t.entity_id,
    status: t.status,
    priority: t.priority,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
    deleted_at: t.deleted_at,
  };
}

function formatLogDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function conceptRelativePath(sourceFilePath: string, targetFilePath: string): string {
  const sourceDir = sourceFilePath.slice(0, sourceFilePath.lastIndexOf('/'));
  const targetDir = targetFilePath.slice(0, targetFilePath.lastIndexOf('/'));
  const targetName = targetFilePath.slice(targetFilePath.lastIndexOf('/') + 1);
  if (sourceDir === targetDir) return `./${targetName}`;
  if (sourceDir.endsWith('/facts') && targetDir.endsWith('/tasks')) return `../tasks/${targetName}`;
  if (sourceDir.endsWith('/tasks') && targetDir.endsWith('/facts')) return `../facts/${targetName}`;
  return targetFilePath.replace(/^entities\/[^/]+\//, '');
}

function buildEventLogEntries(
  events: WikiEvent[],
  factIdToFilename: Map<string, string>,
): OkfLogEntry[] {
  return events.map(e => {
    const factFilename = e.related_entry_id ? factIdToFilename.get(e.related_entry_id) : undefined;
    const summary = e.summary
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\r?\n/g, ' ');

    const text = factFilename
      ? `(${e.event_type}) [${summary}](./facts/${factFilename}.md)`
      : `(${e.event_type}) ${summary}`;
    return { date: formatLogDate(e.created_at), text: appendEventIdComment(text, e.id) };
  });
}

export function formatOkfBundle(
  dump: MemoryDump,
  options?: FormatOkfBundleOptions,
): { files: OkfFile[] } {
  const profile: OkfFormatProfile = options?.profile ?? DEFAULT_PROFILE;
  const okfVersion = profile === 'llm-wiki/2' ? '0.2' : '0.1';
  const factFm = profile === 'llm-wiki/2' ? factFrontmatterV2 : factFrontmatterV1;
  const taskFm = profile === 'llm-wiki/2' ? taskFrontmatterV2 : taskFrontmatterV1;

  const files: OkfFile[] = [];
  const rootEntries: OkfIndexEntry[] = [];

  for (const [entityId, bundle] of Object.entries(dump.entities)) {
    const dir = sanitizeForFilename(entityId);
    const factIdToFilename = new Map(
      bundle.facts.map(f => [f.id, sanitizeConceptId(f.id)] as const),
    );

    const idToConceptPath = new Map<string, string>();
    for (const f of bundle.facts) {
      idToConceptPath.set(f.id, `entities/${dir}/facts/${factIdToFilename.get(f.id)!}.md`);
    }
    for (const t of bundle.tasks) {
      idToConceptPath.set(t.id, `entities/${dir}/tasks/${sanitizeConceptId(t.id)}.md`);
    }

    const edgesBySource = new Map<string, WikiEdge[]>();
    for (const edge of bundle.edges ?? []) {
      const group = edgesBySource.get(edge.source_id) ?? [];
      group.push(edge);
      edgesBySource.set(edge.source_id, group);
    }

    function relatedLinksFor(sourcePath: string, sourceId: string) {
      return (edgesBySource.get(sourceId) ?? [])
        .map(edge => {
          const targetPath = idToConceptPath.get(edge.target_id);
          if (!targetPath) return null;
          return { edge_type: edge.edge_type, path: conceptRelativePath(sourcePath, targetPath) };
        })
        .filter((link): link is { edge_type: string; path: string } => link != null);
    }

    const factEntries: OkfIndexEntry[] = bundle.facts.map(f => ({
      path: `facts/${factIdToFilename.get(f.id)!}.md`,
      title: f.title,
    }));
    for (const f of bundle.facts) {
      const factPath = `entities/${dir}/facts/${factIdToFilename.get(f.id)!}.md`;
      const factBody = appendRelatedSection(f.body, relatedLinksFor(factPath, f.id));
      files.push({
        path: factPath,
        content: buildConceptDocument(factFm(f), factBody),
      });
    }

    const taskEntries: OkfIndexEntry[] = bundle.tasks.map(t => ({
      path: `tasks/${sanitizeConceptId(t.id)}.md`,
      title: t.description,
    }));
    for (const t of bundle.tasks) {
      const taskPath = `entities/${dir}/tasks/${sanitizeConceptId(t.id)}.md`;
      const taskBody = appendRelatedSection('', relatedLinksFor(taskPath, t.id));
      files.push({
        path: taskPath,
        content: buildConceptDocument(taskFm(t), taskBody),
      });
    }

    files.push({
      path: `entities/${dir}/log.md`,
      content: buildLogMd(buildEventLogEntries(bundle.events, factIdToFilename)),
    });

    const entityIndexSections: OkfIndexSection[] = [
      { heading: 'Facts', entries: factEntries },
      { heading: 'Tasks', entries: taskEntries },
    ];
    files.push({
      path: `entities/${dir}/index.md`,
      content: buildEntityIndexMd({
        summary: bundle.summary,
        sections: entityIndexSections,
      }),
    });

    rootEntries.push({ path: `entities/${dir}/index.md`, title: entityId });
  }

  files.push({
    path: 'index.md',
    content: buildRootIndexMd(
      okfVersion,
      rootEntries.length > 0 ? [{ heading: 'Entities', entries: rootEntries }] : [],
      { profile },
    ),
  });

  return { files };
}