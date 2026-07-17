import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  closeServer,
  executeBatch,
  server,
  session,
  type Item,
  type Rows
} from './index.ts'

const rowsOf =
  (items: readonly Item[]): Rows => {
    const found = items.find((item): item is Rows => item.kind === 'rows')
    if (found === undefined) {
      throw new Error('Expected a result set.')
    }
    return found
  }

test('identity supports non-key columns, signed increments, and exact decimal values', () => {
  const active = session(server())
  executeBatch(active, `
    CREATE TABLE ascending (value int, id int IDENTITY(10, 5));
    CREATE TABLE descending (id int IDENTITY(10, -3), value int);
    CREATE TABLE exact_identity (
      id decimal(38, 0) IDENTITY(99999999999999999999999999999999999999, -1),
      value int
    );
    INSERT INTO ascending (value) VALUES (1), (2);
    INSERT INTO descending (value) VALUES (1), (2), (3);
    INSERT INTO exact_identity (value) VALUES (1), (2);
  `)

  expect(rowsOf(executeBatch(active, 'SELECT id FROM ascending ORDER BY value')).rows)
    .toEqual([ [ 10 ], [ 15 ] ])
  expect(rowsOf(executeBatch(active, 'SELECT id FROM descending ORDER BY value')).rows)
    .toEqual([ [ 10 ], [ 7 ], [ 4 ] ])
  expect(rowsOf(executeBatch(active, 'SELECT id FROM exact_identity ORDER BY value')).rows)
    .toEqual([
      [ '99999999999999999999999999999999999999' ],
      [ '99999999999999999999999999999999999998' ]
    ])
})

test('identity insert is session-scoped and explicit values reseed directionally', () => {
  const engine = server()
  const active = session(engine)
  const other = session(engine)
  executeBatch(active, `
    CREATE TABLE explicit_values (id int IDENTITY(10, 5), value int);
    CREATE TABLE second_identity (id int IDENTITY, value int);
    CREATE TABLE plain_values (id int);
    INSERT INTO explicit_values (value) VALUES (1);
  `)

  expect(() => executeBatch(active, 'INSERT INTO explicit_values (id, value) VALUES (100, 2)'))
    .toThrowError(expect.objectContaining({ number: 544 }) as Error)
  expect(() => executeBatch(active, 'SET IDENTITY_INSERT plain_values ON'))
    .toThrowError(expect.objectContaining({ number: 8106 }) as Error)

  executeBatch(active, 'SET IDENTITY_INSERT explicit_values ON')
  expect(() => executeBatch(active, 'SET IDENTITY_INSERT second_identity ON'))
    .toThrowError(expect.objectContaining({ number: 8107 }) as Error)
  expect(() => executeBatch(other, 'INSERT INTO explicit_values (id, value) VALUES (95, 3)'))
    .toThrowError(expect.objectContaining({ number: 544 }) as Error)
  executeBatch(active, `
    INSERT INTO explicit_values (id, value) VALUES (100, 2), (50, 3);
    SET IDENTITY_INSERT explicit_values OFF;
    INSERT INTO explicit_values (value) VALUES (4);
  `)

  expect(rowsOf(executeBatch(active, `
    SELECT id, value FROM explicit_values ORDER BY value;
  `)).rows).toEqual([ [ 10, 1 ], [ 100, 2 ], [ 50, 3 ], [ 105, 4 ] ])
  expect(rowsOf(executeBatch(active, `
    SELECT IDENT_CURRENT('explicit_values') AS current_value,
      @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value;
  `)).rows).toEqual([ [ 105, 105, 105 ] ])
  expect(rowsOf(executeBatch(active, `
    SELECT seed_value, increment_value, last_value
    FROM sys.identity_columns
    WHERE object_id = OBJECT_ID('explicit_values');
  `)).rows).toEqual([ [ '10', '5', '105' ] ])
})

test('failed statements and rollbacks leave gaps without publishing failed values', () => {
  const active = session(server())
  executeBatch(active, `
    CREATE TABLE identity_gaps (id int IDENTITY PRIMARY KEY, value int UNIQUE);
    INSERT INTO identity_gaps (value) VALUES (1);
  `)
  expect(() => executeBatch(active, 'INSERT INTO identity_gaps (value) VALUES (2), (2)'))
    .toThrowError()
  expect(rowsOf(executeBatch(active, `
    SELECT IDENT_CURRENT('identity_gaps') AS current_value,
      @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value;
  `)).rows).toEqual([ [ 3, 1, 1 ] ])

  executeBatch(active, 'INSERT INTO identity_gaps (value) VALUES (4)')
  executeBatch(active, `
    BEGIN TRANSACTION;
    INSERT INTO identity_gaps (value) VALUES (5);
    ROLLBACK TRANSACTION;
    INSERT INTO identity_gaps (value) VALUES (6);
  `)
  expect(rowsOf(executeBatch(active, 'SELECT id, value FROM identity_gaps ORDER BY id')).rows)
    .toEqual([ [ 1, 1 ], [ 4, 4 ], [ 6, 6 ] ])

  executeBatch(active, 'DELETE FROM identity_gaps; INSERT INTO identity_gaps (value) VALUES (7)')
  expect(rowsOf(executeBatch(active, 'SELECT id FROM identity_gaps')).rows).toEqual([ [ 7 ] ])
  executeBatch(active, 'TRUNCATE TABLE identity_gaps; INSERT INTO identity_gaps (value) VALUES (8)')
  expect(rowsOf(executeBatch(active, 'SELECT id FROM identity_gaps')).rows).toEqual([ [ 1 ] ])

  executeBatch(active, `
    BEGIN TRANSACTION;
    TRUNCATE TABLE identity_gaps;
    INSERT INTO identity_gaps (value) VALUES (9);
    ROLLBACK TRANSACTION;
    INSERT INTO identity_gaps (value) VALUES (10);
  `)
  expect(rowsOf(executeBatch(active, 'SELECT id, value FROM identity_gaps ORDER BY id')).rows)
    .toEqual([ [ 1, 8 ], [ 2, 10 ] ])
})

test('trigger identity changes global identity while preserving the caller scope', () => {
  const active = session(server())
  executeBatch(active, `
    CREATE TABLE identity_parent (id int IDENTITY(10, 1), value int);
    CREATE TABLE identity_audit (id int IDENTITY(100, 1), parent_id int);
    CREATE TRIGGER identity_parent_audit ON identity_parent AFTER INSERT AS
      INSERT INTO identity_audit (parent_id) SELECT id FROM inserted;
  `)
  executeBatch(active, 'INSERT INTO identity_parent (value) VALUES (1)')
  expect(rowsOf(executeBatch(active, `
    SELECT @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value,
      IDENT_CURRENT('identity_parent') AS parent_value,
      IDENT_CURRENT('identity_audit') AS audit_value;
  `)).rows).toEqual([ [ 100, 10, 10, 100 ] ])
})

test('procedure and dynamic SQL identities do not replace the caller scope identity', () => {
  const active = session(server())
  executeBatch(active, `
    CREATE TABLE scoped_identity (id int IDENTITY, value int);
    INSERT INTO scoped_identity (value) VALUES (1);
  `)
  executeBatch(active, `
    CREATE PROCEDURE insert_scoped_identity AS
      INSERT INTO scoped_identity (value) VALUES (2);
  `)
  executeBatch(active, 'EXEC insert_scoped_identity')
  expect(rowsOf(executeBatch(active,
    'SELECT @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value')).rows)
    .toEqual([ [ 2, 1 ] ])

  executeBatch(active,
    'EXEC sp_executesql N\'INSERT INTO scoped_identity (value) VALUES (3)\'')
  expect(rowsOf(executeBatch(active,
    'SELECT @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value')).rows)
    .toEqual([ [ 3, 1 ] ])
})

test('identity allocation is shared by sessions and persists across restart', () => {
  const path = join(tmpdir(), `mssqlite-identity-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`)
  try {
    const firstServer = server({ path })
    const first = session(firstServer)
    const concurrent = session(firstServer)
    executeBatch(first, 'CREATE TABLE persistent_identity (id bigint IDENTITY(20, 2), value int)')
    executeBatch(first, 'INSERT INTO persistent_identity (value) VALUES (1)')
    executeBatch(concurrent, 'INSERT INTO persistent_identity (value) VALUES (2)')
    closeServer(firstServer)

    const secondServer = server({ path })
    const restarted = session(secondServer)
    executeBatch(restarted, 'INSERT INTO persistent_identity (value) VALUES (3)')
    expect(rowsOf(executeBatch(restarted,
      'SELECT id FROM persistent_identity ORDER BY value')).rows)
      .toEqual([ [ 20 ], [ 22 ], [ 24 ] ])
    closeServer(secondServer)
  } finally {
    rmSync(path, { force: true })
  }
})

test('identity validates definitions and reports allocation overflow', () => {
  const active = session(server())
  expect(() => executeBatch(active, 'CREATE TABLE two_ids (a int IDENTITY, b int IDENTITY)'))
    .toThrowError(expect.objectContaining({ number: 2744 }) as Error)
  expect(() => executeBatch(active, 'CREATE TABLE wrong_type (id nvarchar(10) IDENTITY)'))
    .toThrowError(expect.objectContaining({ number: 2749 }) as Error)
  expect(() => executeBatch(active, 'CREATE TABLE zero_step (id int IDENTITY(1, 0))'))
    .toThrowError(expect.objectContaining({ number: 2747 }) as Error)
  executeBatch(active, 'CREATE TABLE tiny_identity (id tinyint IDENTITY(255, 1), value int)')
  executeBatch(active, 'INSERT INTO tiny_identity (value) VALUES (1)')
  expect(() => executeBatch(active, 'INSERT INTO tiny_identity (value) VALUES (2)'))
    .toThrowError(expect.objectContaining({ number: 8115 }) as Error)
  expect(rowsOf(executeBatch(active, `
    SELECT IDENT_CURRENT('tiny_identity') AS current_value,
      @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value;
  `)).rows).toEqual([ [ 255, 255, 255 ] ])
})

test('table variables allocate their declared identity sequence', () => {
  const active = session(server())
  const result = rowsOf(executeBatch(active, `
    DECLARE @values TABLE (id int IDENTITY(5, 2), value int);
    INSERT INTO @values (value) VALUES (1), (2), (3);
    SELECT id, value FROM @values ORDER BY id;
  `))
  expect(result.rows).toEqual([ [ 5, 1 ], [ 7, 2 ], [ 9, 3 ] ])
})

test('merge uses the same generated and explicit identity rules as insert', () => {
  const active = session(server())
  executeBatch(active, 'CREATE TABLE merge_identity (id int IDENTITY, value int)')
  executeBatch(active, `
    MERGE merge_identity AS target
    USING (VALUES (1), (2)) AS source (value)
    ON 1 = 0
    WHEN NOT MATCHED THEN INSERT (value) VALUES (source.value);
  `)
  expect(() => executeBatch(active, `
    MERGE merge_identity AS target
    USING (VALUES (100, 3)) AS source (id, value)
    ON 1 = 0
    WHEN NOT MATCHED THEN INSERT (id, value) VALUES (source.id, source.value);
  `)).toThrowError(expect.objectContaining({ number: 544 }) as Error)
  executeBatch(active, `
    SET IDENTITY_INSERT merge_identity ON;
    MERGE merge_identity AS target
    USING (VALUES (100, 3), (50, 4)) AS source (id, value)
    ON 1 = 0
    WHEN NOT MATCHED THEN INSERT (id, value) VALUES (source.id, source.value);
    SET IDENTITY_INSERT merge_identity OFF;
    INSERT INTO merge_identity (value) VALUES (5);
  `)
  expect(rowsOf(executeBatch(active, 'SELECT id, value FROM merge_identity ORDER BY value')).rows)
    .toEqual([ [ 1, 1 ], [ 2, 2 ], [ 100, 3 ], [ 50, 4 ], [ 101, 5 ] ])
})
