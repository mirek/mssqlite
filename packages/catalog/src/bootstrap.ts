import { tables, views } from './schema.ts'
import * as TypeRow from './type-row.ts'
import type { DatabaseSync } from 'node:sqlite'

const databases = [
  [ 1, 'master' ], [ 2, 'tempdb' ], [ 3, 'model' ], [ 4, 'msdb' ]
] as const

const schemas = [
  [ 1, 'dbo', 1 ], [ 2, 'guest', 2 ], [ 3, 'INFORMATION_SCHEMA', 3 ], [ 4, 'sys', 4 ]
] as const

const databasePrincipals = [
  [ 0, 'public', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 1, 'dbo', 'S', 'SQL_USER', 'dbo', 0 ],
  [ 2, 'guest', 'S', 'SQL_USER', 'guest', 0 ],
  [ 3, 'INFORMATION_SCHEMA', 'S', 'SQL_USER', null, 0 ],
  [ 4, 'sys', 'S', 'SQL_USER', null, 0 ],
  [ 16384, 'db_owner', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16385, 'db_accessadmin', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16386, 'db_securityadmin', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16387, 'db_ddladmin', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16389, 'db_backupoperator', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16390, 'db_datareader', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16391, 'db_datawriter', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16392, 'db_denydatareader', 'R', 'DATABASE_ROLE', null, 1 ],
  [ 16393, 'db_denydatawriter', 'R', 'DATABASE_ROLE', null, 1 ]
] as const

const serverPrincipals = [
  [ 1, 'sa', 'S', 'SQL_LOGIN', 0 ],
  [ 2, 'public', 'R', 'SERVER_ROLE', 1 ],
  [ 3, 'sysadmin', 'R', 'SERVER_ROLE', 1 ],
  [ 4, 'securityadmin', 'R', 'SERVER_ROLE', 1 ],
  [ 5, 'serveradmin', 'R', 'SERVER_ROLE', 1 ],
  [ 6, 'setupadmin', 'R', 'SERVER_ROLE', 1 ],
  [ 7, 'processadmin', 'R', 'SERVER_ROLE', 1 ],
  [ 8, 'diskadmin', 'R', 'SERVER_ROLE', 1 ],
  [ 9, 'dbcreator', 'R', 'SERVER_ROLE', 1 ],
  [ 10, 'bulkadmin', 'R', 'SERVER_ROLE', 1 ]
] as const

/**
 * Creates catalog backing tables, derived views and seed rows. Idempotent —
 * safe to run on every open. The user database registers as database_id 5.
 */
export const bootstrap =
  (db: DatabaseSync, databaseName = 'main'): void => {
    for (const sql of tables) {
      db.exec(sql)
    }
    for (const sql of views) {
      db.exec(sql)
    }
    const insertDatabase = db.prepare(
      'INSERT OR IGNORE INTO "sys.databases" (database_id, name) VALUES (?, ?)'
    )
    for (const [ id, name ] of databases) {
      insertDatabase.run(id, name)
    }
    insertDatabase.run(5, databaseName)
    const insertSchema = db.prepare(
      'INSERT OR IGNORE INTO "sys.schemas" (schema_id, name, principal_id) VALUES (?, ?, ?)'
    )
    for (const [ id, name, principal ] of schemas) {
      insertSchema.run(id, name, principal)
    }
    const insertType = db.prepare(
      `INSERT OR IGNORE INTO "sys.types"
        (user_type_id, name, system_type_id, max_length, precision, scale, collation_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of TypeRow.rows) {
      insertType.run(
        row.userTypeId, row.name, row.systemTypeId,
        row.maxLength, row.precision, row.scale, row.collationName
      )
    }
    const insertDatabasePrincipal = db.prepare(
      `INSERT OR IGNORE INTO "sys.database_principals"
        (principal_id, name, type, type_desc, default_schema_name, is_fixed_role)
        VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const row of databasePrincipals) {
      insertDatabasePrincipal.run(...row)
    }
    const insertServerPrincipal = db.prepare(
      `INSERT OR IGNORE INTO "sys.server_principals"
        (principal_id, name, type, type_desc, is_fixed_role)
        VALUES (?, ?, ?, ?, ?)`
    )
    for (const row of serverPrincipals) {
      insertServerPrincipal.run(...row)
    }
    db.prepare(
      'INSERT OR IGNORE INTO "sys.rowversion_state" (singleton, current_value) VALUES (1, ?)'
    ).run('0')
    const nextId = db.prepare('SELECT next_id FROM "sys._next_id"').get()
    if (nextId === undefined) {
      db.prepare('INSERT INTO "sys._next_id" (next_id) VALUES (?)').run(100000001)
    }
  }

export default bootstrap
