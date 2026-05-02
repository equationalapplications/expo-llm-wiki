import React, { createContext, useContext, type ReactNode } from 'react';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';

const WikiContext = createContext<WikiMemory | null>(null);

export function WikiProvider({ wiki, children }: { wiki: WikiMemory; children: ReactNode }) {
  return <WikiContext.Provider value={wiki}>{children}</WikiContext.Provider>;
}

export function useWiki(): WikiMemory {
  const wiki = useContext(WikiContext);
  if (!wiki) throw new Error('useWiki must be used within WikiProvider');
  return wiki;
}
