import { bootstrap } from '@mssqlite/catalog'
import { parse } from '@mssqlite/tsql'
import { registerFunctions } from './udf.ts'
import { DatabaseSync } from 'node:sqlite'
import type { Ast, TypeName } from '@mssqlite/tsql'

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
  readonly constraints: readonly Ast.TableConstraint[]
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

/** Server-wide state shared by sessions. */
export type Server = {
  readonly db: DatabaseSync,
  readonly databaseName: string,
  readonly serverName: string,
  readonly version: string,
  /** Stored procedures keyed by lowercased `schema.name`. */
  readonly procedures: Map<string, Procedure>,
  /** User functions keyed by lowercased `schema.name`. */
  readonly functions: Map<string, UserFunction>,
  /** DML triggers keyed by lowercased `schema.name`. */
  readonly triggers: Map<string, Trigger>,
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
  readonly db: DatabaseSync,
  readonly spid: number,
  database: string,
  userName: string,
  applicationName: string,
  hostName: string,
  /** Declared variables keyed by lowercased `@name`. */
  readonly variables: Map<string, Variable>,
  /** Table variables in the active batch or procedure scope. */
  readonly tableVariables: Map<string, TableVariable>,
  nextTableVariable: number,
  /** Session options set via SET, lowercased. */
  readonly options: Map<string, string>,
  rowCount: number,
  lastIdentity: Value,
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
  (server_: Server): void => {
    const rows = server_.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type = 'P' AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition)) {
          if (statement.kind === 'createProcedure') {
            server_.procedures.set(procedureKey(statement.name), {
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
  (server_: Server): void => {
    const rows = server_.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type IN ('FN', 'IF') AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition)) {
          if (statement.kind === 'createFunction') {
            server_.functions.set(functionKey(statement.name), {
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
  (server_: Server): void => {
    const rows = server_.db.prepare(
      `SELECT m.definition FROM "sys.sql_modules" m
        JOIN "sys.objects" o ON o.object_id = m.object_id
        WHERE o.type = 'TR' AND m.definition IS NOT NULL`
    ).all() as { definition: string }[]
    for (const row of rows) {
      try {
        for (const statement of parse(row.definition)) {
          if (statement.kind === 'createTrigger') {
            server_.triggers.set(triggerKey(statement.name), {
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
      procedures: new Map(),
      functions: new Map(),
      triggers: new Map(),
      registeredFunctions: new Set(),
      current: undefined
    }
    registerFunctions(server_)
    loadProcedures(server_)
    loadUserFunctions(server_)
    loadTriggers(server_)
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
      tableVariables: new Map(),
      transitionTables: new Map(),
      nextTableVariable: 1,
      nextTransitionTable: 1,
      activeTriggers: new Set(),
      options: new Map(),
      rowCount: 0,
      lastIdentity: null,
      transactionCount: 0,
      lastError: 0,
      caughtError: undefined,
      transactionDoomed: false,
      returnValue: null,
      lastReturnStatus: 0,
      nestLevel: 0
    })
