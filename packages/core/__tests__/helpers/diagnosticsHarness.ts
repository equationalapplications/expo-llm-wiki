import { vi } from 'vitest';
import { WikiMemory } from '../../src/WikiMemory';
import { openTestDatabase } from './sqliteAdapter';
import type { LLMProvider, SQLiteAdapter, WikiConfig, WikiDiagnostic, WikiOptions } from '../../src/types';

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

export async function makeDiagnosticWiki(opts: {
  generateText?: LLMProvider['generateText'];
  embed?: LLMProvider['embed'];
  config?: WikiConfig;
  extra?: Partial<WikiOptions>;
  /** Default true. False builds the wiki with no onDiagnostic at all. */
  withHook?: boolean;
} = {}): Promise<{
  wiki: WikiMemory;
  db: SQLiteAdapter;
  diagnostics: WikiDiagnostic[];
  generateText: ReturnType<typeof vi.fn>;
}> {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(opts.generateText ?? (async () => JSON.stringify({ facts: [] })));
  const llmProvider: LLMProvider = {
    generateText,
    ...(opts.embed ? { embed: opts.embed } : {}),
  };
  const wiki = new WikiMemory(db, {
    llmProvider,
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.withHook === false ? {} : { onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); } }),
    ...(opts.extra ?? {}),
  });
  await wiki.setup();
  return { wiki, db, diagnostics, generateText };
}

export function ofCode(diagnostics: WikiDiagnostic[], code: WikiDiagnostic['code']): WikiDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

/** Throws if any forbidden fixture string appears anywhere in the serialized diagnostics (REQ-DIAG-03). */
export function expectNoContent(diagnostics: WikiDiagnostic[], forbidden: string[]): void {
  const serialized = JSON.stringify(diagnostics);
  for (const s of forbidden) {
    if (serialized.includes(s)) {
      throw new Error(`diagnostic leaked content: ${JSON.stringify(s)}`);
    }
  }
}
