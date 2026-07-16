import type { Item } from './execute.ts'

/** MSSQL-shaped error with number, state and severity class. */
export class MssqlError extends Error {
  readonly number: number
  readonly state: number
  readonly severity: number
  readonly statementTerminating: boolean
  readonly honorsXactAbort: boolean
  constructor(
    message: string,
    number = 50000,
    severity = 16,
    state = 1,
    options: { statementTerminating?: boolean, honorsXactAbort?: boolean } = {}
  ) {
    super(message)
    this.name = 'MssqlError'
    this.number = number
    this.state = state
    this.severity = severity
    this.statementTerminating = options.statementTerminating ?? false
    this.honorsXactAbort = options.honorsXactAbort ?? true
  }
}

/** Batch-aborting error retaining result/error items produced before it. */
export class BatchError extends MssqlError {
  readonly items: readonly Item[]
  constructor(error: MssqlError, items: readonly Item[]) {
    super(error.message, error.number, error.severity, error.state, {
      statementTerminating: false,
      honorsXactAbort: error.honorsXactAbort
    })
    this.name = 'BatchError'
    this.items = items
  }
}

/** @returns MSSQL-shaped error mapped from any thrown value. */
export const of =
  (error: unknown): MssqlError => {
    if (error instanceof MssqlError) {
      return error
    }
    const message = error instanceof Error ? error.message : String(error)
    const name = error instanceof Error ? error.name : ''
    if (name === 'ParseError' || name === 'LexError') {
      return new MssqlError(`Incorrect syntax: ${message}`, 102, 15)
    }
    if (name === 'UnsupportedError') {
      if (message.startsWith('Invalid collation')) {
        return new MssqlError(message, 448, 16)
      }
      if (message.startsWith('Cannot resolve the collation conflict')) {
        return new MssqlError(message, 468, 16)
      }
      return new MssqlError(message, 40000, 16)
    }
    if (message.includes('no such table')) {
      const table = /no such table: (\S+)/.exec(message)?.[1] ?? ''
      return new MssqlError(`Invalid object name '${table}'.`, 208, 16)
    }
    if (message.includes('no such column')) {
      const column = /no such column: (\S+)/.exec(message)?.[1] ?? ''
      return new MssqlError(`Invalid column name '${column}'.`, 207, 16)
    }
    if (message.includes('UNIQUE constraint failed')) {
      return new MssqlError(`Violation of UNIQUE KEY constraint. ${message}`, 2627, 14, 1, {
        statementTerminating: true
      })
    }
    if (message.includes('FOREIGN KEY constraint failed')) {
      return new MssqlError(`The statement conflicted with a FOREIGN KEY constraint. ${message}`, 547, 16, 1, {
        statementTerminating: true
      })
    }
    if (message.includes('CHECK constraint failed')) {
      return new MssqlError(`The statement conflicted with a CHECK constraint. ${message}`, 547, 16, 1, {
        statementTerminating: true
      })
    }
    if (message.includes('NOT NULL constraint failed')) {
      return new MssqlError(`Cannot insert the value NULL. ${message}`, 515, 16, 1, {
        statementTerminating: true
      })
    }
    if (message.includes('generated column')) {
      if (message.includes('subqueries prohibited')) {
        return new MssqlError('Subqueries are not allowed in this context.', 1046, 15)
      }
      if (message.includes('non-deterministic')) {
        return new MssqlError(
          `Computed column cannot be persisted because the column is non-deterministic. ${message}`,
          4936, 16)
      }
      if (message.includes('cannot INSERT') || message.includes('cannot UPDATE')) {
        return new MssqlError(
          `The column cannot be modified because it is a computed column. ${message}`,
          271, 16, 1, { statementTerminating: true })
      }
    }
    if (message.includes('misuse of aggregate function')) {
      return new MssqlError(
        `Computed column expression cannot contain an aggregate function. ${message}`,
        4936, 16)
    }
    if (message.includes('already exists')) {
      return new MssqlError(`There is already an object with that name. ${message}`, 2714, 16)
    }
    if (message.includes('integer overflow')) {
      return new MssqlError('Arithmetic overflow error converting expression to data type int.',
        8115, 16, 1, { statementTerminating: true })
    }
    return new MssqlError(message)
  }
