import type { MemoryDump, FormattedMemoryDump, MemoryBundle, WikiFact, WikiTask, WikiEvent } from '../types';
import { sanitizeForFilename } from './sanitizeForFilename';

function renderFact(f: WikiFact): string {
  const tags = (f.tags || []).join(', ');
  const source = f.source_ref ?? f.source_type;
  return `### ${f.title}
**Tags:** ${tags}
**Confidence:** ${f.confidence}
**Source:** ${source}

${f.body}

---
`;
}

function renderTask(t: WikiTask): string {
  const checked = t.status === 'done' ? 'x' : ' ';
  const note = t.status === 'done' ? ' (done)'
    : t.status === 'abandoned' ? ' (abandoned)'
      : t.status === 'in_progress' ? ' (in progress)'
        : '';
  return `- [${checked}] ${t.description}${note}\n`;
}

function renderEvent(e: WikiEvent): string {
  const ts = new Date(e.created_at).toISOString();
  return `- [${ts}] (${e.event_type}) ${e.summary}\n`;
}

function renderEntity(entityId: string, bundle: MemoryBundle, generatedAt: number): string {
  const lines: string[] = [];
  lines.push(`# Memory Dump: ${entityId}`);
  lines.push(`Generated: ${new Date(generatedAt).toISOString()}`);
  lines.push('');
  lines.push('## Facts');
  lines.push('');
  if (bundle.facts.length === 0) {
    lines.push('_(none)_\n');
  } else {
    for (const f of bundle.facts) lines.push(renderFact(f));
  }
  lines.push('## Tasks');
  lines.push('');
  if (bundle.tasks.length === 0) {
    lines.push('_(none)_\n');
  } else {
    for (const t of bundle.tasks) lines.push(renderTask(t));
  }
  lines.push('');
  lines.push('## Recent Events');
  lines.push('');
  if (bundle.events.length === 0) {
    lines.push('_(none)_\n');
  } else {
    for (const e of bundle.events) lines.push(renderEvent(e));
  }
  return lines.join('\n');
}

function formatEntityFileName(entityId: string): string {
  return `${sanitizeForFilename(entityId)}.md`;
}

export function formatMemoryDump(dump: MemoryDump): FormattedMemoryDump {
  const files = Object.entries(dump.entities).map(([entityId, bundle]) => ({
    name: formatEntityFileName(entityId),
    content: renderEntity(entityId, bundle, dump.generatedAt),
  }));

  // Strip embedding_blob from each fact before JSON-serialising the manifest.
  // exportDump() now includes raw Uint8Array blobs for importDump() round-trips,
  // but those binaries serve no purpose in a human-readable manifest and can
  // massively inflate its size for non-trivial datasets.
  const manifestDump: MemoryDump = {
    generatedAt: dump.generatedAt,
    entities: Object.fromEntries(
      Object.entries(dump.entities).map(([entityId, bundle]) => [
        entityId,
        {
          ...bundle,
          facts: bundle.facts.map(f => {
            const { embedding_blob: _blob, ...rest } = f as WikiFact & { embedding_blob?: unknown };
            return rest as WikiFact;
          }),
        },
      ])
    ),
  };

  return {
    manifest: JSON.stringify(manifestDump, null, 2),
    files,
  };
}
