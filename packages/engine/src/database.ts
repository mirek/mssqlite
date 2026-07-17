import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { DatabaseSync } from 'node:sqlite'
import { parse as parsePath, join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { MssqlError } from './error.ts'
import { registerFunctions } from './udf.ts'
import { loadSequences } from './sequence.ts'
import { loadIdentities } from './identity.ts'
import {
  hydrateDatabaseState,
  syncSession,
  type DatabaseState,
  type Server,
  type Session
} from './session.ts'

type DatabaseRow = {
  readonly database_id: number,
  readonly name: string,
  readonly is_read_only: number
}

type FileRow = {
  readonly database_id: number,
  readonly name: string,
  readonly location: string,
  readonly engine_owned: number
}

const quote =
  (value: string): string => Transpile.Quote.string(value)

const childLocation =
  (server: Server, id: number): string => {
    if (server.storageId !== undefined) {
      return `file:mssqlite-${server.storageId}-db${id}?mode=memory&cache=shared`
    }
    const parsed = parsePath(server.initialPath)
    const extension = parsed.ext === '' ? '.sqlite' : parsed.ext
    const base = parsed.ext === '' ? parsed.base : parsed.name
    return join(parsed.dir, `${base}.db${id}${extension}`)
  }

const openState =
  (
    server: Server,
    row: DatabaseRow,
    location: string,
    engineOwned: boolean
  ): DatabaseState => {
    const db = new DatabaseSync(location)
    db.exec('PRAGMA foreign_keys = ON')
    Catalog.bootstrap(db, row.name)
    const state: DatabaseState = {
      id: row.database_id,
      name: row.name,
      alias: Transpile.Quote.databaseAlias(row.name),
      readOnly: row.is_read_only !== 0,
      location,
      engineOwned,
      db,
      procedures: new Map(),
      functions: new Map(),
      triggers: new Map(),
      sequences: loadSequences(db),
      identities: loadIdentities(db),
      rowversion: {
        current: BigInt(Catalog.rowversionValue(db)),
        dirty: false
      },
      registeredFunctions: new Set()
    }
    registerFunctions(server, db)
    hydrateDatabaseState(state)
    return state
  }

const attached =
  (db: DatabaseSync, alias: string): boolean =>
    (db.prepare('PRAGMA database_list').all() as unknown as { name: string }[])
      .some(row => row.name === alias)

const attach =
  (owner: DatabaseState, target: DatabaseState): void => {
    if (!attached(owner.db, target.alias)) {
      owner.db.exec(
        `ATTACH DATABASE ${quote(target.location)} AS ${Transpile.Quote.identifier(target.alias)}`
      )
    }
  }

const attachEverywhere =
  (states: readonly DatabaseState[]): void => {
    for (const owner of states) {
      for (const target of states) {
        if (owner !== target) {
          attach(owner, target)
        }
      }
    }
  }

const manifest =
  (initial: DatabaseState, state: DatabaseState): void => {
    initial.db.prepare(
      `INSERT INTO "sys._database_files"
        (database_id, name, location, engine_owned) VALUES (?, ?, ?, ?)
        ON CONFLICT(database_id) DO UPDATE SET
          name = excluded.name, location = excluded.location,
          engine_owned = excluded.engine_owned`
    ).run(
      state.id, state.name, state.location, state.engineOwned ? 1 : 0
    )
  }

const synchronizeCatalogs =
  (server: Server, initial: DatabaseState): void => {
    for (const state of server.databases.values()) {
      if (state === initial) {
        continue
      }
      const target = Transpile.Quote.identifier(state.alias)
      initial.db.exec(`DELETE FROM ${target}."sys.databases";
        INSERT INTO ${target}."sys.databases" SELECT * FROM "sys.databases"`)
    }
  }

/** Opens persisted/built-in databases and attaches every store to every primary handle. */
export const initializeDatabases =
  (server: Server, initial: DatabaseState): void => {
    manifest(initial, initial)
    const files = new Map((initial.db.prepare(
      'SELECT database_id, name, location, engine_owned FROM "sys._database_files"'
    ).all() as unknown as FileRow[]).map(row => [ row.database_id, row ]))
    const rows = initial.db.prepare(
      'SELECT database_id, name, is_read_only FROM "sys.databases" ORDER BY database_id'
    ).all() as unknown as DatabaseRow[]
    for (const row of rows) {
      if (row.name.toLowerCase() === initial.name.toLowerCase()) {
        continue
      }
      const file = files.get(row.database_id)
      const location = file?.location ?? childLocation(server, row.database_id)
      const state = openState(server, row, location, file?.engine_owned !== 0)
      server.databases.set(row.name.toLowerCase(), state)
      manifest(initial, state)
    }
    attachEverywhere([ ...server.databases.values() ])
  }

const initialState =
  (server: Server): DatabaseState => {
    const state = server.databases.get(server.databaseName.toLowerCase())
    if (state === undefined) {
      throw new Error('Initial database state is unavailable.')
    }
    return state
  }

/** @returns a logical database by SQL name, case-insensitively. */
export const stateOf =
  (server: Server, name: string): DatabaseState | undefined =>
    server.databases.get(name.toLowerCase())

/** @returns the database owning an object-position qualified name. */
export const stateForName =
  (session: Session, name: readonly string[]): DatabaseState => {
    if (name.length < 3) {
      return session.databaseState
    }
    const database = name[name.length - 3] ?? ''
    const state = stateOf(session.server, database)
    if (state === undefined) {
      throw new MssqlError(`Database '${database}' does not exist.`, 911, 16)
    }
    return state
  }

const hasActiveTransaction =
  (server: Server): boolean =>
    [ ...server.sessions ].some(candidate => candidate.transactionCount > 0)

/** Creates, bootstraps, and attaches an independent SQL database. */
export const createDatabase =
  (session: Session, name: string): DatabaseState => {
    const server = session.server
    if (hasActiveTransaction(server)) {
      throw new MssqlError(
        'CREATE DATABASE statement not allowed within multi-statement transaction.', 226, 16)
    }
    if (stateOf(server, name) !== undefined) {
      throw new MssqlError(`Database '${name}' already exists.`, 1801, 16)
    }
    const initial = initialState(server)
    const maximum = initial.db.prepare(
      'SELECT COALESCE(MAX(database_id), 4) AS id FROM "sys.databases"'
    ).get() as { id: number }
    const id = maximum.id + 1
    const row: DatabaseRow = { database_id: id, name, is_read_only: 0 }
    const location = childLocation(server, id)
    let state: DatabaseState
    try {
      state = openState(server, row, location, true)
    } catch (error) {
      if (server.storageId === undefined && existsSync(location)) {
        unlinkSync(location)
      }
      throw error
    }
    try {
      initial.db.prepare(
        'INSERT INTO "sys.databases" (database_id, name) VALUES (?, ?)'
      ).run(id, name)
      server.databases.set(name.toLowerCase(), state)
      manifest(initial, state)
      attachEverywhere([ ...server.databases.values() ])
      synchronizeCatalogs(server, initial)
      for (const candidate of server.sessions) {
        syncSession(candidate)
      }
      return state
    } catch (error) {
      for (const owner of server.databases.values()) {
        if (owner !== state && attached(owner.db, state.alias)) {
          owner.db.exec(`DETACH DATABASE ${Transpile.Quote.identifier(state.alias)}`)
        }
      }
      server.databases.delete(name.toLowerCase())
      initial.db.prepare('DELETE FROM "sys._database_files" WHERE database_id = ?').run(id)
      initial.db.prepare('DELETE FROM "sys.databases" WHERE database_id = ?').run(id)
      synchronizeCatalogs(server, initial)
      state.db.close()
      if (server.storageId === undefined && existsSync(location)) {
        unlinkSync(location)
      }
      throw error
    }
  }

const systemDatabases =
  new Set([ 'master', 'tempdb', 'model', 'msdb' ])

/** Drops a non-system, non-current database and its engine-owned store. */
export const dropDatabase =
  (session: Session, name: string, ifExists: boolean): void => {
    const state = stateOf(session.server, name)
    if (state === undefined) {
      if (ifExists) {
        return
      }
      throw new MssqlError(`Cannot drop database '${name}' because it does not exist.`, 3701, 16)
    }
    if (systemDatabases.has(state.name.toLowerCase())) {
      throw new MssqlError(`Cannot drop the database '${state.name}' because it is a system database.`, 3708, 16)
    }
    if ([ ...session.server.sessions ].some(candidate => candidate.databaseState === state)) {
      throw new MssqlError(`Cannot drop database '${state.name}' because it is currently in use.`, 3702, 16)
    }
    if (hasActiveTransaction(session.server)) {
      throw new MssqlError('DROP DATABASE statement not allowed within multi-statement transaction.', 226, 16)
    }
    for (const owner of session.server.databases.values()) {
      if (attached(owner.db, state.alias)) {
        owner.db.exec(`DETACH DATABASE ${Transpile.Quote.identifier(state.alias)}`)
      }
    }
    state.db.close()
    session.server.databases.delete(state.name.toLowerCase())
    const initial = initialState(session.server)
    initial.db.prepare('DELETE FROM "sys._database_files" WHERE database_id = ?').run(state.id)
    initial.db.prepare('DELETE FROM "sys.databases" WHERE database_id = ?').run(state.id)
    synchronizeCatalogs(session.server, initial)
    if (state.engineOwned && session.server.storageId === undefined && existsSync(state.location)) {
      unlinkSync(state.location)
    }
  }

/** Renames a database and rebuilds its encoded attachment alias everywhere. */
export const renameDatabase =
  (session: Session, name: string, newName: string): void => {
    const state = stateOf(session.server, name)
    if (state === undefined) {
      throw new MssqlError(`Database '${name}' does not exist.`, 911, 16)
    }
    if (systemDatabases.has(state.name.toLowerCase())) {
      throw new MssqlError(
        `Cannot rename the database '${state.name}' because it is a system database.`, 3708, 16)
    }
    if (stateOf(session.server, newName) !== undefined) {
      throw new MssqlError(`Database '${newName}' already exists.`, 1801, 16)
    }
    if (hasActiveTransaction(session.server)) {
      throw new MssqlError('ALTER DATABASE statement not allowed within multi-statement transaction.', 226, 16)
    }
    const initial = initialState(session.server)
    const oldAlias = state.alias
    for (const owner of session.server.databases.values()) {
      if (attached(owner.db, oldAlias)) {
        owner.db.exec(`DETACH DATABASE ${Transpile.Quote.identifier(oldAlias)}`)
      }
    }
    session.server.databases.delete(state.name.toLowerCase())
    state.name = newName
    state.alias = Transpile.Quote.databaseAlias(newName)
    session.server.databases.set(newName.toLowerCase(), state)
    if (state === initial) {
      session.server.databaseName = newName
    }
    initial.db.prepare('UPDATE "sys.databases" SET name = ? WHERE database_id = ?')
      .run(newName, state.id)
    initial.db.prepare('UPDATE "sys._database_files" SET name = ? WHERE database_id = ?')
      .run(newName, state.id)
    state.db.prepare('UPDATE "sys._database_context" SET name = ? WHERE singleton = 1')
      .run(newName)
    attachEverywhere([ ...session.server.databases.values() ])
    synchronizeCatalogs(session.server, initial)
    for (const candidate of session.server.sessions) {
      if (candidate.databaseState === state) {
        candidate.database = newName
        syncSession(candidate)
      }
    }
  }

/** Updates the mirrored READ_ONLY/READ_WRITE catalog setting. */
export const setDatabaseAccess =
  (session: Session, name: string, readOnly: boolean): void => {
    const state = stateOf(session.server, name)
    if (state === undefined) {
      throw new MssqlError(`Database '${name}' does not exist.`, 911, 16)
    }
    if (session.transactionCount > 0) {
      throw new MssqlError('ALTER DATABASE statement not allowed within multi-statement transaction.', 226, 16)
    }
    const initial = initialState(session.server)
    initial.db.prepare('UPDATE "sys.databases" SET is_read_only = ? WHERE database_id = ?')
      .run(readOnly ? 1 : 0, state.id)
    state.readOnly = readOnly
    synchronizeCatalogs(session.server, initial)
  }

/** Rejects writes to a database whose catalog access mode is READ_ONLY. */
export const assertWritable =
  (state: DatabaseState): void => {
    if (state.readOnly) {
      throw new MssqlError(
        `Failed to update database '${state.name}' because the database is read-only.`, 3906, 16)
    }
  }

/** Changes the selected database after validating transaction and online state. */
export const useDatabase =
  (session: Session, name: string): void => {
    const state = stateOf(session.server, name)
    if (state === undefined) {
      throw new MssqlError(
        `Database '${name}' does not exist. Make sure that the name is entered correctly.`, 911, 16)
    }
    if (session.transactionCount > 0) {
      throw new MssqlError('USE statement is not allowed within a transaction.', 226, 16)
    }
    session.databaseState = state
    session.database = state.name
    session.db = state.db
    syncSession(session)
  }

/** Runs engine work under a database state and restores the caller context. */
export const withState =
  <T>(session: Session, state: DatabaseState, run: () => T): T => {
    if (state === session.databaseState) {
      return run()
    }
    const saved = {
      state: session.databaseState,
      database: session.database,
      db: session.db
    }
    session.databaseState = state
    session.database = state.name
    session.db = state.db
    try {
      return run()
    } finally {
      session.databaseState = saved.state
      session.database = saved.database
      session.db = saved.db
    }
  }

/** Closes every database handle owned by a server. */
export const closeServer =
  (server: Server): void => {
    for (const state of server.databases.values()) {
      state.db.close()
    }
    server.sessions.clear()
  }
