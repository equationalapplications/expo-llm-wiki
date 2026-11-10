import { describe, it, expect, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { SqlJsAdapter } from '../../database/sqljs-adapter'
import { WikiService } from '../wiki-service'

// The real service, not mockWiki: every chat test mocks it, which is how a
// missing llmProvider shipped a TypeError on every non-empty read.
async function realService(opts?: ConstructorParameters<typeof WikiService>[1]) {
  const wasmDir = dirname(createRequire(import.meta.url).resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => join(wasmDir, f) })
  const adapter = new (SqlJsAdapter as any)(new SQL.Database()) as SqlJsAdapter
  const service = new WikiService(adapter, opts)
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

describe('WikiService consolidate (real engine)', () => {
  // One fact, nothing to resolve against: the ops librarian makes one call.
  const extractOneFact = vi.fn(async () =>
    JSON.stringify({
      facts: [{ title: 'User has a dog named Rex', body: 'The user said they have a dog named Rex.', tags: ['pets'], confidence: 'certain', source_event: 'e1' }],
      tasks: [],
    }),
  )

  it('turns chat events into facts that search_memory can find', async () => {
    const service = await realService({ generateText: extractOneFact })
    await service.remember('I have a dog named Rex', { occurredAt: 1_000 })
    expect(await service.getContext('dog Rex')).toBe('')
    await expect(service.consolidate()).resolves.toBe(true)
    expect(extractOneFact).toHaveBeenCalledTimes(1)
    expect(await service.getContext('dog Rex')).toContain('User has a dog named Rex')
  })

  it('is a no-op without a maintenance model', async () => {
    const service = await realService()
    await service.remember('I have a dog named Rex')
    await expect(service.consolidate()).resolves.toBe(false)
    expect(await service.getContext('dog Rex')).toBe('')
  })

  it('runs overlapping consolidations one at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow = vi.fn(async () => { await gate; return JSON.stringify({ facts: [], tasks: [] }) })
    const service = await realService({ generateText: slow })
    await service.remember('first')
    const a = service.consolidate()
    const b = service.consolidate()
    release()
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
  })
})
