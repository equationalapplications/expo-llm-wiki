import { useState, useEffect } from 'react';
import { useWiki } from './WikiContext';
import type { EntityStatus } from '@equationalapplications/core-llm-wiki';

export function useEntityStatus(entityId: string): EntityStatus {
  const wiki = useWiki();
  const [snapshot, setSnapshot] = useState(() => ({
    wiki,
    entityId,
    status: wiki.getEntityStatus(entityId),
  }));

  useEffect(() => {
    setSnapshot({ wiki, entityId, status: wiki.getEntityStatus(entityId) });
    return wiki.subscribeEntityStatus(entityId, (status) => {
      setSnapshot({ wiki, entityId, status });
    });
  }, [wiki, entityId]);

  return snapshot.wiki === wiki && snapshot.entityId === entityId
    ? snapshot.status
    : wiki.getEntityStatus(entityId);
}
