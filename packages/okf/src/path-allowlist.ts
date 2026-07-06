const ALLOWED =
  /^(index\.md|entities\/[^/]+\/(index\.md|log\.md|(facts|tasks)\/[^/]+\.md))$/;

export function isAllowedOkfPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, '').replace(/\\/g, '/');
  if (normalized.split('/').some(segment => segment === '.' || segment === '..')) {
    return false;
  }
  return ALLOWED.test(normalized);
}
