import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import * as idsModule from '../src/utils/ids';
import type { SQLiteAdapter, WikiDiagnostic } from '../src/types';

/**
 * Parity snapshot for `runLibrarian` (spec 2026-09-29 §5.1, §5.8).
 *
 * This test must be recorded against the *unmoved* code (Task 5 Step 1) so that
 * the verbatim move to `services/librarian/legacy.ts` (Step 3) can be verified
 * by re-running it unchanged after the move. If the snapshot file changes
 * across the move, the move was not byte-for-byte equivalent.
 *
 * Determinism rules:
 *   - Fixed clock (`Date.now()` mocked).
 *   - A single LLM response with a known mix of valid facts, a duplicate, a
 *     malformed fact, an invalid task, and one task that validates.
 *   - Prompts, fact rows, task rows, and diagnostics are all serialised
 *     into a single snapshot object.
 *
 * Do NOT run this test with `-u`. The committed snapshot is the contract.
 */

interface FactRow {
  id: string;
  title: string;
  body: string;
  tags: string;
  confidence: string;
  source_type: string;
  lifecycle_status: string | null;
  okf_type: string | null;
}

interface TaskRow {
  id: string;
  description: string;
  status: string;
  priority: string;
}

const FIXED_NOW = 1_700_000_000_000;

async function factRows(db: SQLiteAdapter, entityId = 'e1'): Promise<FactRow[]> {
  return db.getAllAsync<FactRow>(
    `SELECT id, title, body, tags, confidence, source_type, lifecycle_status, okf_type
       FROM llm_wiki_entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY title`,
    [entityId],
  );
}

async function taskRows(db: SQLiteAdapter, entityId = 'e1'): Promise<TaskRow[]> {
  return db.getAllAsync<TaskRow>(
    `SELECT id, description, status, priority FROM llm_wiki_tasks
       WHERE entity_id = ? AND deleted_at IS NULL ORDER BY description`,
    [entityId],
  );
}

/** Strip the volatile fields (timestamps, random IDs we cannot reproduce) from diagnostics. */
function normalizeDiagnostic(d: WikiDiagnostic): Omit<WikiDiagnostic, 'at'> {
  const { at: _at, ...rest } = d;
  return rest;
}

describe('librarian legacy parity (snapshot, recorded before the verbatim move)', () => {
  let db: SQLiteAdapter;
  const generateText = vi.fn();
  const diagnostics: WikiDiagnostic[] = [];
  let wiki: WikiMemory;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    // Deterministic IDs: a per-call counter so the snapshot is stable across
    // re-runs. The shape of the ID matches `generateId`'s output (prefix + 24 hex)
    // so any consumer that parses IDs does not crash.
    let idCounter = 0;
    vi.spyOn(idsModule, 'generateId').mockImplementation((prefix: string = '') => {
      idCounter += 1;
      const hex = idCounter.toString(16).padStart(24, '0');
      return prefix + hex;
    });

    db = openTestDatabase();
    diagnostics.length = 0;

    // A deterministic LLM response exercising every branch: valid fact, duplicate
    // (above Jaccard threshold against an existing librarian_inferred fact),
    // malformed fact (will be rejected), valid task, invalid task (no description).
    generateText.mockResolvedValue(JSON.stringify({
      facts: [
        // Will insert: title passes dedupe, body has grounding-relevant text.
        { title: 'Ada Lovelace wrote programs', body: 'First algorithm by Ada Lovelace', tags: ['history'], confidence: 'certain', evidence: ['Ada wrote the first algorithm'] },
        // Will be deduped against an existing librarian_inferred row (see seed below).
        { title: 'Charles Babbage built engines', body: 'Difference Engine history', tags: ['history'], confidence: 'certain' },
        // Will be rejected: missing body.
        { title: 'Malformed Fact', tags: [], confidence: 'certain' },
      ],
      tasks: [
        // Will insert.
        { description: 'Verify the engine design', priority: 'medium' },
        // Will be rejected: description missing entirely.
        { priority: 'low' },
      ],
    }));

    wiki = new WikiMemory(db, {
      llmProvider: { generateText },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await wiki.setup();

    // Seed: one existing librarian_inferred fact whose title is fuzzy-equal to
    // 'Charles Babbage built engines' to exercise the dedupe branch.
    await wiki.write('e1', { event_type: 'observation', summary: 'User said hi' });
    // Insert a librarian_inferred fact by hand via SQL so we control the title.
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence,
        source_type, source_hash, source_ref, created_at, updated_at,
        last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, NULL)`,
      ['fact_seed_1', 'e1', 'Charles Babbage engines history', 'Old body',
        JSON.stringify(['history']), 'certain', 'librarian_inferred', FIXED_NOW, FIXED_NOW],
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, related_entry_id, created_at)
       VALUES (?, ?, 'observation', 'Babbage designed the Analytical Engine', NULL, ?)`,
      ['evt_seed_2', 'e1', FIXED_NOW],
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runLibrarian output is byte-stable across re-runs (snapshot recorded pre-move)', async () => {
    await wiki.runLibrarian('e1');

    const facts = await factRows(db);
    const tasks = await taskRows(db);
    const diags = diagnostics.map(normalizeDiagnostic);

    const captured = {
      // Prompts the librarian sent. Both go through callLlm in production, but
      // here we capture what is fed to llmProvider.generateText directly.
      prompts: generateText.mock.calls.map(([params]) => ({
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
      })),
      facts,
      tasks,
      diagnostics: diags,
    };

    expect(captured).toMatchSnapshot();
  });
});