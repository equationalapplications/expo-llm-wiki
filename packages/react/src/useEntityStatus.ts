import { useState, useEffect } from 'react';
import { useWiki } from './WikiContext';
import type { EntityStatus } from '@equationalapplications/core-llm-wiki';

export function useEntityStatus(entityId: string): EntityStatus {
  const wiki = useWiki();
  const [snapshot, setSnapshot] = useState<{ entityId: string; status: EntityStatus }>(() => ({
    entityId,
    status: wiki.getEntityStatus(entityId),
  }));

  useEffect(() => {
    setSnapshot({ entityId, status: wiki.getEntityStatus(entityId) });
    return wiki.subscribeEntityStatus(entityId, (status) => {
      setSnapshot({ entityId, status });
    });
  }, [wiki, entityId]);

  return snapshot.entityId === entityId
    ? snapshot.status
    : wiki.getEntityStatus(entityId);
}
