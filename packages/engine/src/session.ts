import { bootstrap } from '@mssqlite/catalog'
import { registerFunctions } from './udf.ts'
import { DatabaseSync } from 'node:sqlite'
import type { TypeName } from '@mssqlite/tsql'

/** Runtime value of a variable or column. */
export type Value =
  null | number | bigint | string | Uint8Array | boolean

/** Declared variable slot. */
export type Variable = {
  readonly type: TypeName.t,
  value: Value
}

/** Error captured by the innermost active CATCH block, read by ERROR_*. */
export type CaughtError = {
  readonly number: number,
  readonly severity: number,
  readonly state: number,
  readonly message: string,
  readonly procedure: string | null,
  readonly line: number
}

/** Server-wide state shared by sessions. */
export type Server = {
  readonly db: DatabaseSync,
  readonly databaseName: string,
  readonly serverName: string,
  readonly version: string,
  /** Session whose batch is executing — read by session-scoped UDFs. */
  current: Session | undefined
}

/**
 * Per-connection execution state. Sessions share the server's SQLite
 * connection — SQLite serializes writes; one transaction at a time.
 */
export type Session = {
  readonly server: Server,
  readonly db: DatabaseSync,
  readonly spid: number,
  database: string,
  userName: string,
  applicationName: string,
  hostName: string,
  /** Declared variables keyed by lowercased `@name`. */
  readonly variables: Map<string, Variable>,
  /** Session options set via SET, lowercased. */
  readonly options: Map<string, string>,
  rowCount: number,
  lastIdentity: Value,
  transactionCount: number,
  lastError: number,
  caughtError: CaughtError | undefined,
  /** Uncommittable after an error under SET XACT_ABORT ON — XACT_STATE() −1. */
  transactionDoomed: boolean
}

export type t =
  Session

let nextSpid = 51

/** @returns server over a SQLite database path (`:memory:` by default). */
export const server =
  (options: { path?: string, databaseName?: string, serverName?: string } = {}): Server => {
    const db = new DatabaseSync(options.path ?? ':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    const databaseName = options.databaseName ?? 'master'
    bootstrap(db, databaseName)
    const server_: Server = {
      db,
      databaseName,
      serverName: options.serverName ?? 'mssqlite',
      version: 'Microsoft SQL Server 2019 (mssqlite) - 15.0.2000.5 (X64)',
      current: undefined
    }
    registerFunctions(server_)
    return server_
  }

/** @returns fresh session on a server. */
export const session =
  (server_: Server): Session =>
    ({
      server: server_,
      db: server_.db,
      spid: nextSpid++,
      database: server_.databaseName,
      userName: 'sa',
      applicationName: '',
      hostName: '',
      variables: new Map(),
      options: new Map(),
      rowCount: 0,
      lastIdentity: null,
      transactionCount: 0,
      lastError: 0,
      caughtError: undefined,
      transactionDoomed: false
    })
