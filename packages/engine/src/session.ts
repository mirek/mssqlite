import { bootstrap, rowversionValue } from '@mssqlite/catalog'
import { parse } from '@mssqlite/tsql'
import { registerFunctions } from './udf.ts'
import { loadSequences, type Sequence } from './sequence.ts'
import { loadIdentities, type Identity } from './identity.ts'
import type { RowversionState } from './rowversion.ts'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import * as Transpile from '@mssqlite/transpile'
import { initializeDatabases } from './database.ts'
import { localize } from './database-name.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { Column } from './metadata.ts'

/** Runtime value of a variable or column. */
export type Value =
  null | number | bigint | string | Uint8Array | boolean

/** Declared variable slot. */
export type Variable = {
  readonly type: TypeName.t,
  value: Value
}

/** Active table variable and its collision-free SQLite backing table. */
export type TableVariable = {
  readonly table: Ast.QualifiedName,
  readonly columns: readonly Ast.ColumnDefinition[],
  readonly constraints: readonly Ast.TableConstraint[],
  readonly identity?: Identity
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

/** Registered stored procedure. */
export type Procedure = {
  readonly name: string,
  readonly parameters: readonly Ast.ProcedureParameter[],
  readonly body: readonly Ast.Statement[],
  readonly definition: string
}

/** Registered scalar or inline table-valued user function. */
export type UserFunction = {
  readonly name: Ast.QualifiedName,
  readonly parameters: readonly Ast.FunctionParameter[],
  readonly returns: Extract<Ast.Statement, { kind: 'createFunction' }>['returns'],
  readonly definition: string
}

/** Registered statement-level DML trigger. */
export type Trigger = {
  readonly name: Ast.QualifiedName,
  readonly target: Ast.QualifiedName,
  readonly timing: 'after' | 'insteadOf',
  readonly events: readonly Ast.TriggerEvent[],
  readonly options: readonly string[],
  readonly body: readonly Ast.Statement[],
  readonly definition: string
}

/** Materialized engine cursor owned by one session. */
export type Cursor = {
  readonly name: string,
  readonly scope: 'local' | 'global',
  readonly options: readonly string[],
  readonly select: Ast.Select,
  readonly updateColumns?: readonly string[],
  state: 'declared' | 'open' | 'closed',
  columns: readonly Column[],
  rows: readonly (readonly Value[])[],
  position: number
}

/** Server-wide state shared by sessions. */
export type DatabaseState = {
  id: number,
  name: string,
  alias: string,
  readOnly: boolean,
  readonly location: string,
  readonly engineOwned: boolean,
  readonly db: DatabaseSync,
  readonly procedures: Map<string, Procedure>,
  readonly functions: Map<string, UserFunction>,
  readonly triggers: Map<string, Trigger>,
  readonly sequences: Map<string, Sequence>,
  readonly identities: Map<string, Identity>,
  readonly rowversion: RowversionState,
  readonly registeredFunctions: Set<string>
}

export type Server = {
  readonly db: DatabaseSync,
  databaseName: string,
  readonly serverName: string,
  readonly version: string,
  readonly initialPath: string,
  readonly storageId: string | undefined,
  /** Logical databases keyed by lowercased SQL name. */
  readonly databases: Map<string, DatabaseState>,
  /** Live sessions, used to protect and synchronize database lifecycle changes. */
  readonly sessions: Set<Session>,
  /** Stored procedures keyed by lowercased `schema.name`. */
  readonly procedures: Map<string, Procedure>,
  /** User functions keyed by lowercased `schema.name`. */
  readonly functions: Map<string, UserFunction>,
  /** DML triggers keyed by lowercased `schema.name`. */
  readonly triggers: Map<string, Trigger>,
  /** Persistent sequence generators keyed by lowercased `schema.name`. */
  readonly sequences: Map<string, Sequence>,
  /** Database-wide timestamp counter shared by every session. */
  readonly rowversion: RowversionState,
  /** SQLite function names whose dispatch callback has been installed. */
  readonly registeredFunctions: Set<string>,
  /** Session whose batch is executing — read by session-scoped UDFs. */
  current: Session | undefined
}

/**
 * Per-connection execution state. Sessions share the server's SQLite
 * connection — SQLite serializes writes; one transaction at a time.
 */
export type Session = {
  readonly server: Server,
  db: DatabaseSync,
  databaseState: DatabaseState,
  /** Database whose write is currently allocating rowversion values. */
  allocationDatabaseState: DatabaseState | undefined,
  readonly spid: number,
  database: string,
  userName: string,
  applicationName: string,
  hostName: string,
  readonly loginTime: string,
  requestDepth: number,
  requestStartedAt: number,
  /** Declared variables keyed by lowercased `@name`. */
  readonly variables: Map<string, Variable>,
  /** Table variables in the active batch or procedure scope. */
  readonly tableVariables: Map<string, TableVariable>,
  /** Declared cursors keyed case-insensitively by name. */
  readonly cursors: Map<string, Cursor>,
  /** Last FETCH status: 0 success, -1 outside rowset, -9 no fetch yet. */
  fetchStatus: number,
  nextTableVariable: number,
  /** Session options set via SET, lowercased. */
  readonly options: Map<string, string>,
  rowCount: number,
  lastIdentity: Value,
  scopeIdentity: Value,
  pendingIdentity: Value,
  identityVersion: number,
  identityInsert: { readonly key: string, readonly display: string } | undefined,
  readonly identityResets: Map<string, {
    readonly identity: Identity,
    readonly last: bigint | null,
    readonly dirty: boolean
  }>,
  transactionCount: number,
  lastError: number,
  caughtError: CaughtError | undefined,
  /** Uncommittable after an error under SET XACT_ABORT ON — XACT_STATE() −1. */
  transactionDoomed: boolean,
  /** RETURN value of the executing procedure scope. */
  returnValue: Value,
  /** Completed status of the most recent procedure call — RPC RETURNSTATUS. */
  lastReturnStatus: number,
  /** Procedure call depth — @@NESTLEVEL. */
  nestLevel: number,
  /** Nested trigger transition rowsets keyed by `inserted` / `deleted`. */
  readonly transitionTables: Map<string, TableVariable>,
  nextTransitionTable: number,
  /** Trigger definitions currently executing; suppresses direct recursion. */
  readonly activeTriggers: Set<string>
}

/** DONE_COUNT visibility captured when a statement completes. */
export const countVisibility =
  (session: Session): { readonly countValid?: false } =>
    session.options.get('nocount') === 'on' ? { countValid: false } : {}

export type t =
  Session

let nextSpid = 51

/** @returns registry key of a procedure name — lowercased `schema.name`. */
export const procedureKey =
  (name: Ast.QualifiedName): string => {
    const parts = name.length > 2 ? name.slice(-2) : [ ...name ]
    return (parts.length === 2 ? `${parts[0]}.${parts[1]}` : `dbo.${parts[0]}`).toLowerCase()
  }

export const functionKey =
  procedureKey

export const triggerKey =
  procedureKey

// Re-registers procedures persisted in sys.sql_modules (file-backed
// databases survive restarts) by re-parsing their stored definitions.
const loadProcedures =
  (state: DatabaseState): void => {
    const rows = state.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type = 'P' AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition).map(value => localize(value, state.name))) {
          if (statement.kind === 'createProcedure') {
            state.procedures.set(procedureKey(statement.name), {
              name: statement.name[statement.name.length - 1] ?? '',
              parameters: statement.parameters,
              body: statement.body,
              definition: row.definition
            })
          }
        }
      } catch {
        // A definition this build can no longer parse stays catalog-only.
      }
    }
  }

const loadUserFunctions =
  (state: DatabaseState): void => {
    const rows = state.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type IN ('FN', 'IF') AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition).map(value => localize(value, state.name))) {
          if (statement.kind === 'createFunction') {
            state.functions.set(functionKey(statement.name), {
              name: statement.name,
              parameters: statement.parameters,
              returns: statement.returns,
              definition: row.definition
            })
          }
        }
      } catch {
        // A definition this build can no longer parse stays catalog-only.
      }
    }
  }

const loadTriggers =
  (state: DatabaseState): void => {
    const rows = state.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type = 'TR' AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition).map(value => localize(value, state.name))) {
          if (statement.kind === 'createTrigger') {
            state.triggers.set(triggerKey(statement.name), {
              name: statement.name,
              target: statement.target,
              timing: statement.timing,
              events: statement.events,
              options: statement.options,
              body: statement.body,
              definition: row.definition
            })
          }
        }
      } catch {
        // A definition this build can no longer parse stays catalog-only.
      }
    }
  }

/** Loads persisted executable definitions into a database-owned runtime state. */
export const hydrateDatabaseState =
  (state: DatabaseState): void => {
    loadProcedures(state)
    loadUserFunctions(state)
    loadTriggers(state)
  }

/** @returns server over a SQLite database path (`:memory:` by default). */
export const server =
  (options: { path?: string, databaseName?: string, serverName?: string } = {}): Server => {
    const requestedPath = options.path ?? ':memory:'
    const storageId = requestedPath === ':memory:' ? randomUUID() : undefined
    const requestedDatabaseName = options.databaseName ?? 'master'
    const initialLocation = storageId === undefined ? requestedPath :
      `file:mssqlite-${storageId}-${Transpile.Quote.databaseAlias(requestedDatabaseName)}?mode=memory&cache=shared`
    const db = new DatabaseSync(initialLocation)
    db.exec('PRAGMA foreign_keys = ON')
    const hasContext = db.prepare(
      `SELECT 1 AS found FROM sqlite_schema
        WHERE type = 'table' AND name = 'sys._database_context'`
    ).get() as { found: number } | undefined
    const persisted = hasContext === undefined ? undefined : db.prepare(
      'SELECT name FROM "sys._database_context" WHERE singleton = 1'
    ).get() as { name: string } | undefined
    const databaseName = persisted?.name ?? requestedDatabaseName
    bootstrap(db, databaseName)
    const databaseRow = db.prepare(
      'SELECT database_id, is_read_only FROM "sys.databases" WHERE name = ?'
    ).get(databaseName) as { database_id: number, is_read_only: number } | undefined
    const initial: DatabaseState = {
      id: databaseRow?.database_id ?? 5,
      name: databaseName,
      alias: Transpile.Quote.databaseAlias(databaseName),
      readOnly: databaseRow?.is_read_only !== 0,
      location: initialLocation,
      engineOwned: false,
      db,
      procedures: new Map(),
      functions: new Map(),
      triggers: new Map(),
      sequences: loadSequences(db),
      identities: loadIdentities(db),
      rowversion: {
        current: BigInt(rowversionValue(db)),
        dirty: false
      },
      registeredFunctions: new Set()
    }
    const server_: Server = {
      get db() {
        return this.current?.databaseState.db ?? initial.db
      },
      databaseName,
      serverName: options.serverName ?? 'mssqlite',
      version: 'Microsoft SQL Server 2019 (mssqlite) - 15.0.2000.5 (X64)',
      initialPath: requestedPath,
      storageId,
      databases: new Map([ [ databaseName.toLowerCase(), initial ] ]),
      sessions: new Set(),
      get procedures() {
        return this.current?.databaseState.procedures ?? initial.procedures
      },
      get functions() {
        return this.current?.databaseState.functions ?? initial.functions
      },
      get triggers() {
        return this.current?.databaseState.triggers ?? initial.triggers
      },
      get sequences() {
        return this.current?.databaseState.sequences ?? initial.sequences
      },
      get rowversion() {
        return this.current?.databaseState.rowversion ?? initial.rowversion
      },
      get registeredFunctions() {
        return this.current?.databaseState.registeredFunctions ?? initial.registeredFunctions
      },
      current: undefined
    }
    registerFunctions(server_, db)
    hydrateDatabaseState(initial)
    try {
      initializeDatabases(server_, initial)
    } catch (error) {
      for (const state of server_.databases.values()) {
        state.db.close()
      }
      throw error
    }
    return server_
  }

/** @returns fresh session on a server. */
export const session =
  (server_: Server): Session => {
    const session_: Session = {
      server: server_,
      db: server_.db,
      databaseState: server_.databases.get(server_.databaseName.toLowerCase()) as DatabaseState,
      allocationDatabaseState: undefined,
      spid: nextSpid++,
      database: server_.databaseName,
      userName: 'sa',
      applicationName: '',
      hostName: '',
      loginTime: new Date().toISOString(),
      requestDepth: 0,
      requestStartedAt: 0,
      variables: new Map(),
      tableVariables: new Map(),
      cursors: new Map(),
      fetchStatus: -9,
      transitionTables: new Map(),
      nextTableVariable: 1,
      nextTransitionTable: 1,
      activeTriggers: new Set(),
      options: new Map(),
      rowCount: 0,
      lastIdentity: null,
      scopeIdentity: null,
      pendingIdentity: null,
      identityVersion: 0,
      identityInsert: undefined,
      identityResets: new Map(),
      transactionCount: 0,
      lastError: 0,
      caughtError: undefined,
      transactionDoomed: false,
      returnValue: null,
      lastReturnStatus: 0,
      nestLevel: 0
    }
    server_.sessions.add(session_)
    syncSession(session_)
    return session_
  }

/** Synchronizes mutable connection identity and counters with sys.dm_exec_sessions. */
const databaseId =
  (session_: Session): number => session_.databaseState.id

const catalogTable =
  (session_: Session, state: DatabaseState, name: string): string =>
    state === session_.databaseState ?
      Transpile.Quote.identifier(name) :
      `${Transpile.Quote.identifier(state.alias)}.${Transpile.Quote.identifier(name)}`

const everyCatalog =
  (session_: Session, run: (table: (name: string) => string) => void): void => {
    for (const state of session_.server.databases.values()) {
      run(name => catalogTable(session_, state, name))
    }
  }

export const syncSession =
  (session_: Session): void => {
    everyCatalog(session_, table => session_.db.prepare(
      `INSERT INTO ${table('sys.dm_exec_sessions')} (
        session_id, login_time, host_name, program_name, client_version,
        client_interface_name, login_name, status, database_id,
        open_transaction_count, row_count, prev_error, original_login_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        host_name = excluded.host_name, program_name = excluded.program_name,
        login_name = excluded.login_name, status = excluded.status,
        database_id = excluded.database_id,
        open_transaction_count = excluded.open_transaction_count,
        row_count = excluded.row_count, prev_error = excluded.prev_error,
        original_login_name = excluded.original_login_name`
    ).run(
      session_.spid, session_.loginTime, session_.hostName || null,
      session_.applicationName || null, 0x74000004, 'TDS', session_.userName,
      session_.requestDepth > 0 ? 'running' : 'sleeping', databaseId(session_),
      session_.transactionCount,
      session_.rowCount, session_.lastError, session_.userName
    ))
  }

const requestCommand =
  (sql: string): string => /^[\s;]*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'UNKNOWN'

/** Registers an outer client request so the request can observe itself in the DMVs. */
export const beginRequest =
  (session_: Session, sql: string): void => {
    const mutable = session_
    mutable.requestDepth++
    if (mutable.requestDepth !== 1) {
      return
    }
    syncSession(session_)
    mutable.requestStartedAt = Date.now()
    everyCatalog(session_, table => session_.db.prepare(
      `INSERT OR REPLACE INTO ${table('sys.dm_exec_requests')} (
        session_id, request_id, start_time, status, command, database_id,
        open_transaction_count, row_count
      ) VALUES (?, 0, ?, 'running', ?, ?, ?, ?)`
    ).run(
      session_.spid, new Date(session_.requestStartedAt).toISOString(),
      requestCommand(sql), databaseId(session_), session_.transactionCount, session_.rowCount
    ))
    everyCatalog(session_, table => session_.db.prepare(
      `UPDATE ${table('sys.dm_exec_sessions')}
        SET status = 'running', last_request_start_time = ?, open_transaction_count = ?
        WHERE session_id = ?`
    ).run(new Date(session_.requestStartedAt).toISOString(), session_.transactionCount, session_.spid))
  }

/** Completes an outer request and leaves the authenticated session sleeping. */
export const endRequest =
  (session_: Session): void => {
    const mutable = session_
    mutable.requestDepth--
    if (mutable.requestDepth !== 0) {
      return
    }
    const ended = new Date().toISOString()
    const elapsed = Math.max(0, Date.now() - session_.requestStartedAt)
    everyCatalog(session_, table => session_.db.prepare(
      `UPDATE ${table('sys.dm_exec_requests')} SET total_elapsed_time = ?, row_count = ?
        WHERE session_id = ? AND request_id = 0`
    ).run(elapsed, session_.rowCount, session_.spid))
    everyCatalog(session_, table => session_.db.prepare(
      `UPDATE ${table('sys.dm_exec_sessions')} SET status = 'sleeping',
        last_request_end_time = ?, open_transaction_count = ?, row_count = ?, prev_error = ?
        WHERE session_id = ?`
    ).run(
      ended, session_.transactionCount, session_.rowCount, session_.lastError, session_.spid
    ))
    everyCatalog(session_, table => session_.db.prepare(
      `DELETE FROM ${table('sys.dm_exec_requests')} WHERE session_id = ? AND request_id = 0`
    ).run(session_.spid))
  }

/** Removes disconnected session/request rows from the dynamic management surface. */
export const closeSession =
  (session_: Session): void => {
    session_.server.sessions.delete(session_)
    try {
      everyCatalog(session_, table => {
        session_.db.prepare(`DELETE FROM ${table('sys.dm_exec_requests')} WHERE session_id = ?`)
          .run(session_.spid)
        session_.db.prepare(`DELETE FROM ${table('sys.dm_exec_sessions')} WHERE session_id = ?`)
          .run(session_.spid)
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('database is not open')) {
        throw error
      }
    }
  }

/** Removes LOCAL cursors declared while `run` owns the active batch/procedure scope. */
export const withCursorScope =
  <T>(session_: Session, run: () => T): T => {
    const existing = new Set(session_.cursors.keys())
    try {
      return run()
    } finally {
      for (const [ name, cursor ] of session_.cursors) {
        if (cursor.scope === 'local' && !existing.has(name)) {
          session_.cursors.delete(name)
        }
      }
    }
  }

/** Async variant used by cooperative server execution. */
export const withCursorScopeAsync =
  async <T>(session_: Session, run: () => Promise<T>): Promise<T> => {
    const existing = new Set(session_.cursors.keys())
    try {
      return await run()
    } finally {
      for (const [ name, cursor ] of session_.cursors) {
        if (cursor.scope === 'local' && !existing.has(name)) {
          session_.cursors.delete(name)
        }
      }
    }
  }
