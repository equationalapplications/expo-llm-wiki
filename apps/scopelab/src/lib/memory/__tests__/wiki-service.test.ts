import { describe, it, expect, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { SqlJsAdapter } from '../../database/sqljs-adapter'
import { WikiService } from '../wiki-service'

// The real service, not mockWiki: every chat test mocks it, which is how a
// missing llmProvider shipped a TypeError on every non-empty read.
async function realService() {
  const wasmDir = dirname(createRequire(import.meta.url).resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => join(wasmDir, f) })
  const adapter = new (SqlJsAdapter as any)(new SQL.Database()) as SqlJsAdapter
  const service = new WikiService(adapter)
  await service.init()
  return service
}

describe('WikiService (real engine)', () => {
  it('reads context for a non-empty query without an embed provider', async () => {
    const service = await realService()
    await expect(service.getContext('hi')).resolves.toBe('')
  })

  it('stores chat events without running the librarian', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = await realService()
      // Past the old autoLibrarianThreshold (10): under 'auto' with no LLM,
      // each pass after that failed and logged.
      for (let i = 0; i < 25; i++) await service.remember(`message ${i}`, { occurredAt: 1_000 + i })
      await service.getContext('message')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
