// backward-compat re-export — use @eq/wiki-expo directly in new code
// Re-exports @eq/wiki-core only so that React is not a hard dependency for
// consumers who only use createWiki / WikiMemory (React was historically
// behind the ./react sub-path).
export * from '@eq/wiki-core';
