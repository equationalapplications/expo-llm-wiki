import type { MemoryDump, FormattedMemoryDump, MemoryBundle, WikiFact, WikiTask, WikiEvent } from '../types';

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

function shortHash(value: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1, 33) ^ c;
    h2 = Math.imul(h2, 31) ^ c;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function formatEntityFileName(entityId: string): string {
  const normalized = entityId.normalize('NFKC');
  const sanitized = normalized
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  // Enforce a max base-name length so the final filename stays within typical
  // filesystem limits (~255 bytes). Reserve ~20 chars for `-<16hexchars>.md`.
  const MAX_BASE = 200;
  const trimmed = sanitized.length > MAX_BASE ? sanitized.slice(0, MAX_BASE) : sanitized;

  const baseName = trimmed && trimmed !== '.' && trimmed !== '..'
    ? trimmed
    : 'entity';
  const needsSuffix = baseName !== entityId || sanitized.length > MAX_BASE;
  const uniqueBaseName = needsSuffix ? `${baseName}-${shortHash(entityId)}` : baseName;

  return `${uniqueBaseName}.md`;
}

export function formatMemoryDump(dump: MemoryDump): FormattedMemoryDump {
  const files = Object.entries(dump.entities).map(([entityId, bundle]) => ({
    name: formatEntityFileName(entityId),
    content: renderEntity(entityId, bundle, dump.generatedAt),
  }));
  return {
    manifest: JSON.stringify(dump, null, 2),
    files,
  };
}
