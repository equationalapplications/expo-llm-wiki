// backward-compat re-export — use @equationalapplications/expo-llm-wiki directly in new code
// Re-exports @equationalapplications/core-llm-wiki types/classes plus the Expo-flavoured createWiki
// factory (takes expo-sqlite SQLiteDatabase, matching the old package API).
// React hooks remain isolated behind the ./react sub-path.
export * from '@equationalapplications/core-llm-wiki';
export { createWiki } from '@equationalapplications/expo-llm-wiki/factory';
