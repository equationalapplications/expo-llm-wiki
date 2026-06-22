import { useState, useEffect } from 'react';
import { useWiki } from './WikiContext';
import type { EntityStatus } from '@equationalapplications/core-llm-wiki';

export function useEntityStatus(entityId: string): EntityStatus {
  const wiki = useWiki();
  const [status, setStatus] = useState<EntityStatus>(() => wiki.getEntityStatus(entityId));

  useEffect(() => {
    setStatus(wiki.getEntityStatus(entityId));
    return wiki.subscribeEntityStatus(entityId, setStatus);
  }, [wiki, entityId]);

  return status;
}
