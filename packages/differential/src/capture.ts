import type { Connection } from 'tedious'
import { execute, firstRow, successful } from './execute.ts'
import type { Case, Scalar, SessionState, Snapshot } from './types.ts'

const numeric =
  (value: Scalar | undefined): number => {
    if (typeof value === 'number') {
      return value
    }
    if (typeof value === 'object' && value?.kind === 'bigint') {
      return Number(value.value)
    }
    throw new Error(`Expected numeric session state, received ${String(value)}.`)
  }

const sessionState =
  async (connection: Connection): Promise<SessionState> => {
    const transaction = await execute(connection,
      'SELECT @@TRANCOUNT AS transaction_count, XACT_STATE() AS transaction_state')
    successful(transaction, 'transaction-state probe failed')
    const row = firstRow(transaction)
    const reuse = await execute(connection, 'SELECT 1 AS reusable')
    return {
      transactionCount: numeric(row?.[0]),
      transactionState: numeric(row?.[1]),
      reusable: reuse.error === undefined && firstRow(reuse)?.[0] === 1
    }
  }

const cleanup =
  async (connection: Connection, value: Case): Promise<void> => {
    const rollback = await execute(connection, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
    successful(rollback, `${value.name} rollback cleanup failed`)
    if (value.cleanup !== undefined) {
      const cleaned = await execute(connection, value.cleanup.trim())
      successful(cleaned, `${value.name} cleanup failed`)
    }
  }

/** Runs one corpus case and proves the same connection remains usable. */
export const capture =
  async (connection: Connection, value: Case): Promise<Snapshot> => {
    try {
      if (value.setup !== undefined) {
        const setup = await execute(connection, value.setup.trim())
        successful(setup, `${value.name} setup failed`)
      }
      const execution = await execute(connection, value.query.trim())
      return { execution, session: await sessionState(connection) }
    } finally {
      await cleanup(connection, value)
    }
  }
