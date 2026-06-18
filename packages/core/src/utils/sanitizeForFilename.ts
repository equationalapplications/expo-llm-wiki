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

const OKF_RESERVED_CONCEPT_NAMES = new Set(['index', 'log']);

export function sanitizeForFilename(value: string): string {
  const normalized = value.normalize('NFKC');
  const sanitized = normalized
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  // Enforce a max base-name length so the final filename stays within typical
  // filesystem limits (~255 bytes). Reserve ~20 chars for `-<16hexchars>`.
  const MAX_BASE = 200;
  const trimmed = sanitized.length > MAX_BASE ? sanitized.slice(0, MAX_BASE) : sanitized;

  const baseName = trimmed && trimmed !== '.' && trimmed !== '..' ? trimmed : 'entity';
  const needsSuffix = baseName !== value || sanitized.length > MAX_BASE;
  return needsSuffix ? `${baseName}-${shortHash(value)}` : baseName;
}

/** Sanitize a fact/task id for use as a concept filename (without .md). */
export function sanitizeConceptId(id: string): string {
  const sanitized = sanitizeForFilename(id);
  if (OKF_RESERVED_CONCEPT_NAMES.has(sanitized.toLowerCase())) {
    return `${sanitized}-${shortHash(id)}`;
  }
  return sanitized;
}
