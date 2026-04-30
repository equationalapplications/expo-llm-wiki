import { useCallback, useState } from 'react';
import { useWiki } from './WikiContext';
import type { MemoryDump } from '../types';

export function useWikiExport(): {
  exportDump: (entityIds?: string[]) => Promise<MemoryDump>;
  isExporting: boolean;
  error: Error | null;
} {
  const wiki = useWiki();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const exportDump = useCallback(async (entityIds?: string[]): Promise<MemoryDump> => {
    setIsExporting(true);
    setError(null);
    try {
      const result = await wiki.exportDump(entityIds);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setIsExporting(false);
    }
  }, [wiki]);

  return { exportDump, isExporting, error };
}