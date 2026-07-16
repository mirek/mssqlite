import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parseStatement } from '@mssqlite/tsql'
import {
  addColumns, bootstrap, createFunction, createIndex, createTable, createView,
  createTrigger, dropColumns, dropFunction, dropIndex, dropTable, dropTrigger,
  objectIdOf, tableColumns
} from './index.ts'
import type { Ast } from '@mssqlite/tsql'

const open =
  (): DatabaseSync => {
    const db = new DatabaseSync(':memory:')
    bootstrap(db, 'test')
    return db
  }

const createUsers =
  (db: DatabaseSync): number =>
    createTable(db, parseStatement(`
      CREATE TABLE dbo.users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE,
        score DECIMAL(10,2) DEFAULT 0,
        created DATETIME2 NULL CHECK (created IS NOT NULL OR 1 = 1)
      )
    `) as Ast.Statement & { kind: 'createTable' })

test('bootstrap seeds schemas, types, databases and principals', () => {
  const db = open()
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.schemas"').get()).toEqual({ n: 4 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.types"').get()).toEqual({ n: 31 })
  expect(db.prepare('SELECT name FROM "sys.databases" WHERE database_id = 5').get())
    .toEqual({ name: 'test' })
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.server_principals"').get()).toEqual({ n: 10 })
  // Idempotent.
  bootstrap(db, 'test')
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.schemas"').get()).toEqual({ n: 4 })
})

test('create table populates objects, columns, constraints and indexes', () => {
  const db = open()
  const objectId = createUsers(db)
  expect(objectIdOf(db, [ 'dbo', 'users' ])).toBe(objectId)
  expect(objectIdOf(db, [ 'USERS' ])).toBe(objectId)
  const columns = tableColumns(db, objectId)
  expect(columns.map(column => [ column.name, column.system_type_id, column.is_nullable ])).toEqual([
    [ 'id', 56, 0 ],
    [ 'name', 231, 0 ],
    [ 'email', 167, 1 ],
    [ 'score', 106, 1 ],
    [ 'created', 42, 1 ]
  ])
  expect(columns[1]?.max_length).toBe(200)
  expect(columns[3]).toMatchObject({ precision: 10, scale: 2 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.tables"').get()).toEqual({ n: 1 })
  expect(db.prepare(
    'SELECT COUNT(*) AS n FROM "sys.indexes" WHERE object_id = ? AND is_primary_key = 1'
  ).get(objectId)).toEqual({ n: 1 })
  expect(db.prepare(
    'SELECT COUNT(*) AS n FROM "sys.objects" WHERE parent_object_id = ? AND type = \'UQ\''
  ).get(objectId)).toEqual({ n: 1 })
  expect(db.prepare(
    'SELECT COUNT(*) AS n FROM "sys.objects" WHERE parent_object_id = ? AND type = \'D\''
  ).get(objectId)).toEqual({ n: 1 })
  expect(db.prepare(
    'SELECT seed_value FROM "sys.identity_columns" WHERE object_id = ?'
  ).get(objectId)).toEqual({ seed_value: '1' })
})

test('foreign keys register with actions and column mappings', () => {
  const db = open()
  createTable(db, parseStatement('CREATE TABLE teams (id INT PRIMARY KEY, name NVARCHAR(50))') as
    Ast.Statement & { kind: 'createTable' })
  const usersId = createTable(db, parseStatement(`
    CREATE TABLE users (
      id INT PRIMARY KEY,
      team_id INT REFERENCES teams (id) ON DELETE CASCADE
    )
  `) as Ast.Statement & { kind: 'createTable' })
  const fk = db.prepare(
    `SELECT fk.delete_referential_action_desc AS action, o.parent_object_id AS parent
      FROM "sys.foreign_keys" fk JOIN "sys.objects" o ON o.object_id = fk.object_id`
  ).get() as { action: string, parent: number }
  expect(fk).toEqual({ action: 'CASCADE', parent: usersId })
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.foreign_key_columns"').get()).toEqual({ n: 1 })
})

test('drop table cleans up all dependent rows', () => {
  const db = open()
  createUsers(db)
  dropTable(db, [ 'users' ])
  for (const table of [ 'sys.objects', 'sys.columns', 'sys.indexes', 'sys.index_columns', 'sys.key_constraints', 'sys.identity_columns_extra' ]) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE 1 = 1`).get()).toEqual({ n: 0 })
  }
})

test('indexes, views and alter column maintenance', () => {
  const db = open()
  const objectId = createUsers(db)
  createIndex(db, parseStatement('CREATE UNIQUE INDEX ix_users_name ON users (name DESC)') as
    Ast.Statement & { kind: 'createIndex' })
  const index = db.prepare('SELECT * FROM "sys.indexes" WHERE name = ?').get('ix_users_name') as
    { object_id: number, is_unique: number }
  expect(index).toMatchObject({ object_id: objectId, is_unique: 1 })
  dropIndex(db, 'ix_users_name')
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.indexes" WHERE name = ?').get('ix_users_name'))
    .toEqual({ n: 0 })
  createView(db, [ 'dbo', 'v_users' ])
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.views"').get()).toEqual({ n: 1 })
  addColumns(db, [ 'users' ], [ { name: 'age', type: { name: 'int', args: [] } } ])
  expect(tableColumns(db, objectId).map(column => column.name)).toContain('age')
  dropColumns(db, [ 'users' ], [ 'age' ])
  expect(tableColumns(db, objectId).map(column => column.name)).not.toContain('age')
})

test('information schema views work', () => {
  const db = open()
  createUsers(db)
  expect(db.prepare(
    'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM "information_schema.tables"'
  ).all()).toEqual([
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE' }
  ])
  const columns = db.prepare(
    `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
      FROM "information_schema.columns" WHERE TABLE_NAME = 'users' ORDER BY ORDINAL_POSITION`
  ).all()
  expect(columns[0]).toEqual({ COLUMN_NAME: 'id', DATA_TYPE: 'int', CHARACTER_MAXIMUM_LENGTH: 4, IS_NULLABLE: 'NO' })
  expect(columns[1]).toEqual({ COLUMN_NAME: 'name', DATA_TYPE: 'nvarchar', CHARACTER_MAXIMUM_LENGTH: 100, IS_NULLABLE: 'NO' })
})

test('typical sys catalog query joins', () => {
  const db = open()
  createUsers(db)
  const rows = db.prepare(`
    SELECT t.name AS table_name, s.name AS schema_name, c.name AS column_name
    FROM "sys.tables" t
    JOIN "sys.schemas" s ON t.schema_id = s.schema_id
    JOIN "sys.columns" c ON c.object_id = t.object_id
    WHERE t.is_ms_shipped = 0
    ORDER BY c.column_id LIMIT 2
  `).all()
  expect(rows).toEqual([
    { table_name: 'users', schema_name: 'dbo', column_name: 'id' },
    { table_name: 'users', schema_name: 'dbo', column_name: 'name' }
  ])
})

test('user function modules register object types and drop cleanly', () => {
  const db = open()
  const scalar = createFunction(db, [ 'dbo', 'scalar_fn' ], 'CREATE FUNCTION scalar_fn', false)
  const inline = createFunction(db, [ 'dbo', 'inline_fn' ], 'CREATE FUNCTION inline_fn', true)
  expect(db.prepare(
    'SELECT name, type, type_desc FROM "sys.objects" WHERE object_id IN (?, ?) ORDER BY name'
  ).all(scalar, inline)).toEqual([
    { name: 'inline_fn', type: 'IF', type_desc: 'SQL_INLINE_TABLE_VALUED_FUNCTION' },
    { name: 'scalar_fn', type: 'FN', type_desc: 'SQL_SCALAR_FUNCTION' }
  ])
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.sql_modules"').get()).toEqual({ n: 2 })
  dropFunction(db, [ 'dbo', 'scalar_fn' ])
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.sql_modules"').get()).toEqual({ n: 1 })
})

test('trigger modules register against their parent table and clean up', () => {
  const db = open()
  const table = createUsers(db)
  const trigger = createTrigger(
    db, [ 'dbo', 'users_audit' ], [ 'dbo', 'users' ], 'CREATE TRIGGER users_audit')
  expect(db.prepare(
    'SELECT type, type_desc, parent_object_id FROM "sys.objects" WHERE object_id = ?'
  ).get(trigger)).toEqual({
    type: 'TR',
    type_desc: 'SQL_TRIGGER',
    parent_object_id: table
  })
  dropTrigger(db, [ 'dbo', 'users_audit' ])
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.sql_modules"').get()).toEqual({ n: 0 })
  createTrigger(db, [ 'dbo', 'users_audit' ], [ 'dbo', 'users' ], 'CREATE TRIGGER users_audit')
  dropTable(db, [ 'dbo', 'users' ])
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.sql_modules"').get()).toEqual({ n: 0 })
})
