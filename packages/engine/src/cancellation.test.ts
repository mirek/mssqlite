import { expect, test } from 'vitest'
import {
  CancellationError,
  closeServer,
  closeSession,
  executeBatch,
  executeBatchAsync,
  server,
  session
} from './index.ts'

const canceledAfter =
  (count: number): { readonly controller: AbortController, readonly yield_: () => Promise<void> } => {
    const controller = new AbortController()
    let checkpoints = 0
    return {
      controller,
      yield_: async () => {
        checkpoints++
        if (checkpoints === count) {
          controller.abort()
        }
      }
    }
  }

test('cooperative execution cancels before work and during interpreted loops', async () => {
  const engine = server({ path: ':memory:' })
  const active = session(engine)
  try {
    const before = new AbortController()
    before.abort()
    await expect(executeBatchAsync(active, 'CREATE TABLE never_created (id INT)', {
      signal: before.signal
    })).rejects.toBeInstanceOf(CancellationError)
    expect(() => executeBatch(active, 'SELECT * FROM never_created')).toThrowError(/Invalid object/)

    const during = canceledAfter(40)
    await expect(executeBatchAsync(active, `
      DECLARE @i INT = 0
      WHILE @i < 1000000
      BEGIN
        SET @i += 1
      END
      SELECT @i AS leaked
    `, { signal: during.controller.signal, yield_: during.yield_ }))
      .rejects.toBeInstanceOf(CancellationError)
    expect(active.requestDepth).toBe(0)
  } finally {
    closeSession(active)
    closeServer(engine)
  }
})

test('cancellation preserves an explicit transaction and completed statements', async () => {
  const engine = server({ path: ':memory:' })
  const active = session(engine)
  try {
    executeBatch(active, 'CREATE TABLE cancel_tx (id INT PRIMARY KEY)')
    const during = canceledAfter(30)
    await expect(executeBatchAsync(active, `
      BEGIN TRANSACTION
      INSERT INTO cancel_tx VALUES (1)
      DECLARE @i INT = 0
      WHILE @i < 1000000 SET @i += 1
    `, { signal: during.controller.signal, yield_: during.yield_ }))
      .rejects.toBeInstanceOf(CancellationError)
    expect(active.transactionCount).toBe(1)
    expect(executeBatch(active, 'SELECT COUNT(*) AS count FROM cancel_tx')[0])
      .toMatchObject({ kind: 'rows', rows: [ [ 1 ] ] })
    executeBatch(active, 'ROLLBACK TRANSACTION')
    expect(executeBatch(active, 'SELECT COUNT(*) AS count FROM cancel_tx')[0])
      .toMatchObject({ kind: 'rows', rows: [ [ 0 ] ] })
  } finally {
    closeSession(active)
    closeServer(engine)
  }
})
