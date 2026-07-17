import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parseStatement } from '@mssqlite/tsql'
import {
  addColumns, alterColumn, bootstrap, createFunction, createIndex, createSequence, createTable, createView,
  createProcedure, createTrigger, dropColumns, dropFunction, dropIndex, dropTable, dropTrigger,
  dropSequence, objectIdOf, rowversionValue, sequenceRows, tableColumns,
  updateRowversionValue, updateSequenceValue, rename
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
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.types"').get()).toEqual({ n: 34 })
  expect(db.prepare(
    `SELECT name, system_type_id, user_type_id, is_assembly_type
     FROM "sys.types" WHERE name IN ('hierarchyid', 'geometry', 'geography') ORDER BY user_type_id`
  ).all()).toEqual([
    { name: 'hierarchyid', system_type_id: 240, user_type_id: 128, is_assembly_type: 1 },
    { name: 'geometry', system_type_id: 240, user_type_id: 129, is_assembly_type: 1 },
    { name: 'geography', system_type_id: 240, user_type_id: 130, is_assembly_type: 1 }
  ])
  expect(db.prepare('SELECT name FROM "sys.databases" WHERE database_id = 5').get())
    .toEqual({ name: 'test' })
  expect(db.prepare('SELECT COUNT(*) AS n FROM "sys.server_principals"').get()).toEqual({ n: 10 })
  expect(rowversionValue(db)).toBe('0')
  updateRowversionValue(db, '42')
  expect(rowversionValue(db)).toBe('42')
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
  const originalColumnId = tableColumns(db, objectId).find(column => column.name === 'name')?.column_id
  alterColumn(
    db, [ 'users' ], 'name', { name: 'nvarchar', args: [ 200 ] },
    'Latin1_General_100_CS_AS', true)
  expect(tableColumns(db, objectId).find(column => column.name === 'name')).toMatchObject({
    column_id: originalColumnId,
    system_type_id: 231,
    max_length: 400,
    collation_name: 'Latin1_General_100_CS_AS',
    is_nullable: 1
  })
  dropColumns(db, [ 'users' ], [ 'age' ])
  expect(tableColumns(db, objectId).map(column => column.name)).not.toContain('age')
})

test('rename moves physical tables, columns and indexes with catalog metadata', () => {
  const db = open()
  const objectId = createUsers(db)
  createIndex(db, parseStatement('CREATE INDEX ix_users_name ON users (name)') as
    Ast.Statement & { kind: 'createIndex' })
  db.exec('CREATE TABLE users (id INTEGER, name TEXT, email TEXT, score TEXT, created TEXT)')
  db.exec('CREATE INDEX ix_users_name ON users (name)')

  rename(db, 'dbo.users.name', 'display_name', 'column')
  rename(db, 'dbo.users.ix_users_name', 'ix_users_display_name', 'index')
  rename(db, 'dbo.users', 'people', 'object')

  expect(db.prepare('SELECT display_name FROM people').all()).toEqual([])
  expect(db.prepare(
    `SELECT o.name AS object_name, c.name AS column_name, i.name AS index_name
      FROM "sys.objects" o
      JOIN "sys.columns" c ON c.object_id = o.object_id
      JOIN "sys.indexes" i ON i.object_id = o.object_id
      WHERE o.object_id = ? AND c.column_id = 2 AND i.name = 'ix_users_display_name'`
  ).get(objectId)).toEqual({
    object_name: 'people',
    column_name: 'display_name',
    index_name: 'ix_users_display_name'
  })
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

test('routine, view and constraint schemas preserve catalog relationships', () => {
  const db = open()
  const render = (): string => 'catalog_expression'
  createTable(db, parseStatement(`
    CREATE TABLE teams (
      id INT,
      CONSTRAINT PK_teams PRIMARY KEY (id)
    )
  `) as Ast.Statement & { kind: 'createTable' }, render)
  createTable(db, parseStatement(`
    CREATE TABLE members (
      id INT CONSTRAINT DF_members_id DEFAULT 7,
      team_id INT,
      CONSTRAINT PK_members PRIMARY KEY (id),
      CONSTRAINT FK_members_teams FOREIGN KEY (team_id) REFERENCES teams (id)
        ON DELETE CASCADE,
      CONSTRAINT CK_members_id CHECK (id > 0)
    )
  `) as Ast.Statement & { kind: 'createTable' }, render)
  createView(db, [ 'dbo', 'member_view' ], 'CREATE VIEW member_view AS SELECT id FROM members')
  createProcedure(db, [ 'dbo', 'member_proc' ], 'CREATE PROCEDURE member_proc AS SELECT 1')
  createFunction(
    db, [ 'dbo', 'member_fn' ], 'CREATE FUNCTION member_fn RETURNS INT', false,
    { name: 'int', args: [] })

  expect(db.prepare(
    `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM "information_schema.table_constraints"
      WHERE TABLE_NAME = 'members' ORDER BY CONSTRAINT_NAME`
  ).all()).toEqual([
    { CONSTRAINT_NAME: 'CK_members_id', CONSTRAINT_TYPE: 'CHECK' },
    { CONSTRAINT_NAME: 'FK_members_teams', CONSTRAINT_TYPE: 'FOREIGN KEY' },
    { CONSTRAINT_NAME: 'PK_members', CONSTRAINT_TYPE: 'PRIMARY KEY' }
  ])
  expect(db.prepare(
    `SELECT CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION
      FROM "information_schema.key_column_usage"
      WHERE TABLE_NAME = 'members' ORDER BY CONSTRAINT_NAME`
  ).all()).toEqual([
    { CONSTRAINT_NAME: 'FK_members_teams', COLUMN_NAME: 'team_id', ORDINAL_POSITION: 1 },
    { CONSTRAINT_NAME: 'PK_members', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }
  ])
  expect(db.prepare(
    `SELECT CONSTRAINT_NAME, UNIQUE_CONSTRAINT_NAME, DELETE_RULE
      FROM "information_schema.referential_constraints"`
  ).get()).toEqual({
    CONSTRAINT_NAME: 'FK_members_teams',
    UNIQUE_CONSTRAINT_NAME: 'PK_teams',
    DELETE_RULE: 'CASCADE'
  })
  expect(db.prepare(
    `SELECT name, parent_object_id, parent_column_id, definition, is_system_named
      FROM "sys.default_constraints"`
  ).get()).toMatchObject({
    name: 'DF_members_id',
    parent_column_id: 1,
    definition: '(catalog_expression)',
    is_system_named: 0
  })
  expect(db.prepare(
    'SELECT TABLE_NAME, VIEW_DEFINITION FROM "information_schema.views"'
  ).get()).toEqual({
    TABLE_NAME: 'member_view',
    VIEW_DEFINITION: 'CREATE VIEW member_view AS SELECT id FROM members'
  })
  expect(db.prepare(
    `SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE
      FROM "information_schema.routines" ORDER BY ROUTINE_NAME`
  ).all()).toEqual([
    { ROUTINE_NAME: 'member_fn', ROUTINE_TYPE: 'FUNCTION', DATA_TYPE: 'int' },
    { ROUTINE_NAME: 'member_proc', ROUTINE_TYPE: 'PROCEDURE', DATA_TYPE: null }
  ])
  expect(db.prepare(
    `SELECT is_inlineable, inline_type FROM "sys.sql_modules"
      WHERE object_id = (SELECT object_id FROM "sys.objects" WHERE name = 'member_fn')`
  ).get()).toEqual({ is_inlineable: 0, inline_type: 0 })
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

test('sequence state backs sys.sequences and allocation updates', () => {
  const db = open()
  const objectId = createSequence(db, [ 'dbo', 'numbers' ], {
    dataType: { name: 'int', args: [] },
    start: '10', increment: '2', minimum: '0', maximum: '20',
    cycling: true, cached: false, cacheSize: null,
    current: '10', exhausted: false, lastUsed: null
  })
  expect(sequenceRows(db)[0]).toMatchObject({
    object_id: objectId,
    schema_name: 'dbo',
    name: 'numbers',
    type_name: 'int',
    current_value: '10'
  })
  updateSequenceValue(db, objectId, '12', false, '12')
  expect(db.prepare(
    'SELECT type, current_value, last_used_value, is_cycling FROM "sys.sequences"'
  ).get()).toEqual({ type: 'SO', current_value: 12, last_used_value: 12, is_cycling: 1 })
  dropSequence(db, [ 'dbo', 'numbers' ])
  expect(sequenceRows(db)).toEqual([])
})
