// backward-compat re-export — use @eq/wiki-react (or @eq/wiki-expo for Expo) directly in new code
export {
  WikiProvider,
  useWiki,
  useMemoryRead,
  useWikiWrite,
  useWikiMaintenance,
  type MaintenanceResult,
  useWikiIngest,
  useWikiForget,
  useWikiExport,
  useWikiHasChanged,
} from '@eq/wiki-react';
