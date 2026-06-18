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

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAMES.has(name.toLowerCase());
}

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

  let baseName = trimmed && trimmed !== '.' && trimmed !== '..' ? trimmed : 'entity';

  // Windows disallows trailing dots and spaces in filenames.
  const withoutTrailingDotSpace = baseName.replace(/[. ]+$/, '');
  const hadTrailingDotSpace = withoutTrailingDotSpace !== baseName;
  if (hadTrailingDotSpace) {
    baseName = withoutTrailingDotSpace || 'entity';
  }

  const windowsReserved = isWindowsReservedName(baseName);
  const needsSuffix =
    baseName !== value || sanitized.length > MAX_BASE || hadTrailingDotSpace || windowsReserved;
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
