// backward-compat re-export — use @eq/wiki-expo directly in new code
// Re-exports @eq/wiki-core types/classes plus the Expo-flavoured createWiki
// factory (takes expo-sqlite SQLiteDatabase, matching the old package API).
// React hooks remain isolated behind the ./react sub-path.
export * from '@eq/wiki-core';
export { createWiki } from '@eq/wiki-expo';
