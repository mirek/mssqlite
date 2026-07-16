import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { DataType, SqlVariant } from '@mssqlite/tds'
import { BatchError, executeBatch, executeSql, MssqlError, server, session } from './index.ts'
import type { Item, Rows } from './execute.ts'

const open =
  (): ReturnType<typeof session> =>
    session(server())

const rowsOf =
  (items: readonly Item[]): Rows => {
    const found = items.find((item): item is Rows => item.kind === 'rows')
    if (found === undefined) {
      throw new Error('Expected a result set.')
    }
    return found
  }

test('select constants with metadata', () => {
  const s = open()
  const result = rowsOf(executeBatch(s, 'SELECT 1 AS n, \'x\' AS t, 1.5 AS f, NULL AS z'))
  expect(result.columns.map(column => column.name)).toEqual([ 'n', 't', 'f', 'z' ])
  expect(result.columns[0]?.typeInfo.type).toBe(DataType.DataType.intN)
  expect(result.columns[1]?.typeInfo.type).toBe(DataType.DataType.nvarchar)
  expect(result.columns[2]?.typeInfo.type).toBe(DataType.DataType.decimalN)
  expect(result.rows).toEqual([ [ 1, 'x', '1.5', null ] ])
})

test('create, insert, select round trip with catalog metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE dbo.users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(100) NOT NULL,
      age INT NULL
    )
  `)
  const insert = executeBatch(s, 'INSERT INTO users (name, age) VALUES (N\'Alice\', 30), (N\'Bob\', NULL)')
  expect(insert[0]).toMatchObject({ kind: 'count', rowCount: 2 })
  const result = rowsOf(executeBatch(s, 'SELECT id, name, age FROM users ORDER BY id'))
  expect(result.columns[0]).toMatchObject({
    typeInfo: { type: DataType.DataType.intN, maxLength: 4 },
    nullable: false
  })
  expect(result.columns[1]).toMatchObject({
    typeInfo: { type: DataType.DataType.nvarchar, maxLength: 200 },
    nullable: false
  })
  expect(result.rows).toEqual([ [ 1, 'Alice', 30 ], [ 2, 'Bob', null ] ])
})

test('opaque special types preserve storage and native result metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE opaque_values (
      id INT PRIMARY KEY,
      variant_value SQL_VARIANT,
      xml_value XML,
      hierarchy_value HIERARCHYID,
      geometry_value GEOMETRY,
      geography_value GEOGRAPHY
    );
    INSERT INTO opaque_values VALUES (
      1, CAST(42 AS bigint), N'<root>hé</root>',
      0x010203, 0x040506, 0x070809
    )
  `)
  const result = rowsOf(executeBatch(s, `
    SELECT variant_value, xml_value, hierarchy_value, geometry_value, geography_value
    FROM opaque_values
  `))
  expect(result.columns.map(column => column.typeInfo.type)).toEqual([
    DataType.DataType.sqlVariant,
    DataType.DataType.xml,
    DataType.DataType.udt,
    DataType.DataType.udt,
    DataType.DataType.udt
  ])
  expect(result.columns[2]?.typeInfo.udt).toMatchObject({ name: 'hierarchyid', maxByteSize: 892 })
  expect(result.columns[3]?.typeInfo.udt).toMatchObject({ name: 'geometry', maxByteSize: 0xffff })
  const row = result.rows[0]
  expect(SqlVariant.decode(row?.[0] as Uint8Array)).toMatchObject({ value: 42n })
  expect(row?.[1]).toBe('<root>hé</root>')
  expect(row?.[2]).toEqual(Uint8Array.from([ 1, 2, 3 ]))
  expect(row?.[3]).toEqual(Uint8Array.from([ 4, 5, 6 ]))
  expect(row?.[4]).toEqual(Uint8Array.from([ 7, 8, 9 ]))

  expect(rowsOf(executeBatch(s,
    'SELECT CAST(variant_value AS bigint) AS value FROM opaque_values')).rows)
    .toEqual([ [ 42 ] ])
})

test('opaque special types reject representation loss and unsupported operators', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE opaque_errors (x XML, g GEOMETRY)')
  expect(() => executeBatch(s, 'INSERT INTO opaque_errors VALUES (N\'<x/>\', N\'POINT (1 2)\')'))
    .toThrow(/native binary serialization/)
  executeBatch(s, 'INSERT INTO opaque_errors VALUES (N\'<x/>\', 0x01)')
  expect(() => executeBatch(s, 'SELECT * FROM opaque_errors WHERE x = x'))
    .toThrow(/not supported for xml values/)
  expect(() => executeBatch(s, 'SELECT * FROM opaque_errors WHERE g = g'))
    .toThrow(/not supported for udt values/)
})

test('opaque special types and catalog identities survive database restart', () => {
  const path = join(tmpdir(), `mssqlite-opaque-${process.pid}-${Date.now()}.db`)
  try {
    const firstServer = server({ path })
    const first = session(firstServer)
    executeBatch(first, `
      CREATE TABLE persisted_opaque (v SQL_VARIANT, x XML, h HIERARCHYID)
      INSERT INTO persisted_opaque VALUES (CAST(N'hé' AS nvarchar(2)), N'<x/>', 0x0102)
    `)
    firstServer.db.close()

    const secondServer = server({ path })
    const result = rowsOf(executeBatch(session(secondServer),
      'SELECT v, x, h FROM persisted_opaque'))
    expect(result.columns.map(column => [ column.typeInfo.type, column.userType ])).toEqual([
      [ DataType.DataType.sqlVariant, 98 ],
      [ DataType.DataType.xml, 241 ],
      [ DataType.DataType.udt, 128 ]
    ])
    expect(SqlVariant.decode(result.rows[0]?.[0] as Uint8Array)).toMatchObject({ value: 'hé' })
    expect(result.rows[0]?.slice(1)).toEqual([ '<x/>', Uint8Array.from([ 1, 2 ]) ])
    secondServer.db.close()
  } finally {
    rmSync(path, { force: true })
  }
})

test('computed columns infer types, recompute, index and expose catalog metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE computed_products (
      name NVARCHAR(20),
      quantity INT,
      price DECIMAL(10,2),
      total AS quantity * price PERSISTED,
      normalized AS UPPER(name)
    )
    INSERT INTO computed_products (name, quantity, price)
      VALUES (N'apple', 3, 1.25), (N'pear', 2, 2.50)
    CREATE INDEX ix_computed_total ON computed_products (total)
    UPDATE computed_products SET quantity = 4 WHERE name = N'apple'
  `)
  const result = rowsOf(executeBatch(s, `
    SELECT name, total, normalized FROM computed_products ORDER BY total
  `))
  expect(result.rows).toEqual([
    [ 'apple', '5.00', 'APPLE' ], [ 'pear', '5.00', 'PEAR' ]
  ])
  expect(result.columns[1]?.typeInfo).toMatchObject({ precision: 21, scale: 2 })
  expect(result.columns[2]?.typeInfo.type).toBe(DataType.DataType.nvarchar)
  expect(rowsOf(executeBatch(s, `
    SELECT name, is_computed, definition, is_persisted
    FROM sys.computed_columns
    WHERE object_id = OBJECT_ID(N'computed_products')
    ORDER BY column_id
  `)).rows).toEqual([
    [ 'total', 1, 'quantity * price', 1 ],
    [ 'normalized', 1, 'UPPER ( name )', 0 ]
  ])
  const hidden = s.db.prepare('PRAGMA table_xinfo("computed_products")').all() as
    { name: string, hidden: number }[]
  expect(hidden.filter(column => column.hidden !== 0).map(column => [ column.name, column.hidden ]))
    .toEqual([ [ 'total', 3 ], [ 'normalized', 2 ] ])
  expect(s.db.prepare(
    'SELECT COUNT(*) AS n FROM "sys.index_columns" ic JOIN "sys.columns" c ' +
    'ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE c.name = \'total\''
  ).get()).toEqual({ n: 1 })
})

test('computed columns reject direct writes and nondeterministic persistence', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE computed_guard (base INT, doubled AS base * 2)')
  expect(() => executeBatch(s, 'INSERT INTO computed_guard (base, doubled) VALUES (1, 2)'))
    .toThrowError(expect.objectContaining({ number: 271 }) as Error)
  executeBatch(s, 'INSERT INTO computed_guard VALUES (2)')
  expect(() => executeBatch(s, 'UPDATE computed_guard SET doubled = 8'))
    .toThrowError(expect.objectContaining({ number: 271 }) as Error)
  expect(() => executeBatch(s, 'CREATE TABLE bad_computed (base INT, value AS RAND() PERSISTED)'))
    .toThrowError(expect.objectContaining({ number: 4936 }) as Error)
  expect(() => executeBatch(s, `
    CREATE TABLE bad_computed_query (base INT, value AS (SELECT MAX(base)))
  `)).toThrowError(expect.objectContaining({ number: 1046 }) as Error)
})

test('computed columns support ALTER, table variables and database restart', () => {
  const path = join(tmpdir(), `mssqlite-computed-${process.pid}-${Date.now()}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, `
      CREATE TABLE computed_restart (base INT, stored AS base + 1 PERSISTED);
      ALTER TABLE computed_restart ADD virtual AS base * 2;
      INSERT INTO computed_restart VALUES (5)
    `)
    const tableVariable = rowsOf(executeBatch(first, `
      DECLARE @values TABLE (base INT, calculated AS base + 10)
      INSERT INTO @values VALUES (1), (2)
      SELECT calculated FROM @values ORDER BY calculated
    `))
    expect(tableVariable.rows).toEqual([ [ 11 ], [ 12 ] ])
    const second = session(server({ path }))
    expect(rowsOf(executeBatch(second, `
      SELECT base, stored, virtual FROM computed_restart
    `)).rows).toEqual([ [ 5, 6, 10 ] ])
    expect(rowsOf(executeBatch(second, `
      SELECT name, is_persisted FROM sys.computed_columns
      WHERE object_id = OBJECT_ID(N'computed_restart') ORDER BY column_id
    `)).rows).toEqual([ [ 'stored', 1 ], [ 'virtual', 0 ] ])
  } finally {
    rmSync(path, { force: true })
  }
})

test('declared collations control case, accent, binary ordering and indexes', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE collated_names (
      id INT PRIMARY KEY,
      flexible NVARCHAR(30) COLLATE Latin1_General_100_CI_AI,
      exact NVARCHAR(30) COLLATE Latin1_General_100_CS_AS,
      binary_name NVARCHAR(30) COLLATE Latin1_General_100_BIN2
    )
    INSERT INTO collated_names VALUES
      (1, N'café', N'Alpha', N'a'),
      (2, N'CAFE', N'alpha', N'A'),
      (3, N'cafe', N'Alpha', N'á')
    CREATE INDEX ix_collated_flexible ON collated_names (flexible)
  `)
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM collated_names WHERE flexible = N'CAFÉ' ORDER BY id
  `)).rows).toEqual([ [ 1 ], [ 2 ], [ 3 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM collated_names WHERE flexible LIKE N'CAF_' ORDER BY id
  `)).rows).toEqual([ [ 1 ], [ 2 ], [ 3 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM collated_names WHERE exact = N'Alpha' ORDER BY id
  `)).rows).toEqual([ [ 1 ], [ 3 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM collated_names
    WHERE exact COLLATE Latin1_General_100_CI_AI = N'álpha' ORDER BY id
  `)).rows).toEqual([ [ 1 ], [ 2 ], [ 3 ] ])
  expect(() => executeBatch(s, 'SELECT id FROM collated_names WHERE flexible = exact'))
    .toThrowError(expect.objectContaining({ number: 468 }) as Error)
  expect(rowsOf(executeBatch(s, `
    SELECT binary_name FROM collated_names ORDER BY binary_name
  `)).rows).toEqual([ [ 'A' ], [ 'a' ], [ 'á' ] ])
  const plan = s.db.prepare(
    'EXPLAIN QUERY PLAN SELECT * FROM "collated_names" WHERE ' +
    'mssqlite_collation_key("flexible", \'latin1_general_100_ci_ai\') = ' +
    'mssqlite_collation_key(\'cafe\', \'latin1_general_100_ci_ai\')'
  ).all() as { detail: string }[]
  expect(plan.some(row => row.detail.includes('ix_collated_flexible'))).toBe(true)
  expect(rowsOf(executeBatch(s, `
    SELECT collation_name FROM sys.columns
    WHERE object_id = OBJECT_ID(N'collated_names') AND name = N'flexible'
  `)).rows).toEqual([ [ 'Latin1_General_100_CI_AI' ] ])
})

test('collation-aware uniqueness rejects case and accent equivalents', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE unique_names (
      value NVARCHAR(30) COLLATE Latin1_General_100_CI_AI UNIQUE
    )
    INSERT INTO unique_names VALUES (N'café')
  `)
  expect(() => executeBatch(s, 'INSERT INTO unique_names VALUES (N\'CAFE\')'))
    .toThrowError(expect.objectContaining({ number: 2627 }) as Error)
  expect(() => executeBatch(s, `CREATE TABLE bad_collation (
    value NVARCHAR(10) COLLATE Unknown_Collation
  )`)).toThrowError(expect.objectContaining({ number: 448 }) as Error)
})

test('variables, set and select assignment', () => {
  const s = open()
  executeBatch(s, 'DECLARE @x INT = 1 SET @x = @x + 10')
  const result = rowsOf(executeBatch(s, 'SELECT @x AS x'))
  expect(result.rows).toEqual([ [ 11 ] ])
  executeBatch(s, 'CREATE TABLE t (v INT); INSERT INTO t VALUES (5), (7)')
  executeBatch(s, 'DECLARE @m INT SELECT @m = MAX(v) FROM t')
  expect(rowsOf(executeBatch(s, 'SELECT @m AS m')).rows).toEqual([ [ 7 ] ])
})

test('table variables support DML, constraints and declared metadata', () => {
  const s = open()
  const items = executeBatch(s, `
    DECLARE @items TABLE (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(20) NOT NULL,
      qty INT DEFAULT 1,
      UNIQUE (name)
    )
    INSERT INTO @items (name) VALUES (N'apple'), (N'pear')
    UPDATE @items SET name = name + N'!', qty += 2 WHERE id = 1
    DELETE FROM @items WHERE id = 2
    SELECT id, name, qty FROM @items ORDER BY id
  `)
  const result = rowsOf(items)
  expect(result.rows).toEqual([ [ 1, 'apple!', 3 ] ])
  expect(result.columns[0]).toMatchObject({ nullable: false, typeInfo: { maxLength: 4 } })
  expect(result.columns[1]).toMatchObject({ nullable: false, typeInfo: { maxLength: 40 } })
  expect(s.lastIdentity).toBe(2)
})

test('cursor lifecycle materializes rows and fetches into variables', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE cursor_items (id INT PRIMARY KEY, name NVARCHAR(20));
    INSERT INTO cursor_items VALUES (1, N'a'), (2, N'b'), (3, N'c');
  `)
  const items = executeBatch(s, `
    DECLARE @id INT, @name NVARCHAR(20)
    DECLARE item_cursor LOCAL SCROLL CURSOR STATIC READ_ONLY FOR
      SELECT id, name FROM cursor_items ORDER BY id
    OPEN item_cursor
    FETCH FIRST FROM item_cursor INTO @id, @name
    SELECT @id AS id, @name AS name, @@FETCH_STATUS AS status
    FETCH LAST FROM item_cursor INTO @id, @name
    SELECT @id AS id, @name AS name, @@FETCH_STATUS AS status
    FETCH PRIOR FROM item_cursor INTO @id, @name
    SELECT @id AS id, @name AS name, @@FETCH_STATUS AS status
    CLOSE item_cursor
    DEALLOCATE item_cursor
  `)
  expect(items.filter((item): item is Rows => item.kind === 'rows').map(item => item.rows)).toEqual([
    [ [ 1, 'a', 0 ] ],
    [ [ 3, 'c', 0 ] ],
    [ [ 2, 'b', 0 ] ]
  ])
})

test('cursor fetch returns rows, handles bounds, and preserves failed INTO targets', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE cursor_values (n INT); INSERT INTO cursor_values VALUES (10), (20)')
  const items = executeBatch(s, `
    DECLARE @n INT = 99
    DECLARE values_cursor SCROLL CURSOR FOR SELECT n FROM cursor_values ORDER BY n
    OPEN values_cursor
    FETCH ABSOLUTE -1 FROM values_cursor
    FETCH NEXT FROM values_cursor INTO @n
    SELECT @n AS n, @@FETCH_STATUS AS status, @@ROWCOUNT AS rc
    CLOSE values_cursor
    DEALLOCATE values_cursor
  `)
  const rows = items.filter((item): item is Rows => item.kind === 'rows')
  expect(rows[0]?.rows).toEqual([ [ 20 ] ])
  expect(rows[1]?.rows).toEqual([ [ 99, -1, 0 ] ])
})

test('cursor state errors and LOCAL/GLOBAL cleanup follow scope', () => {
  const s = open()
  expect(() => executeBatch(s, 'OPEN missing_cursor'))
    .toThrowError(expect.objectContaining({ number: 16916 }) as Error)
  executeBatch(s, 'DECLARE local_cursor LOCAL CURSOR FOR SELECT 1 AS n')
  expect(() => executeBatch(s, 'OPEN local_cursor'))
    .toThrowError(expect.objectContaining({ number: 16916 }) as Error)

  executeBatch(s, 'DECLARE global_cursor GLOBAL CURSOR FOR SELECT 1 AS n')
  expect(() => executeBatch(s, 'DECLARE global_cursor GLOBAL CURSOR FOR SELECT 2 AS n'))
    .toThrowError(expect.objectContaining({ number: 16915 }) as Error)
  executeBatch(s, 'OPEN global_cursor')
  expect(() => executeBatch(s, 'OPEN global_cursor'))
    .toThrowError(expect.objectContaining({ number: 16905 }) as Error)
  expect(() => executeBatch(s, 'FETCH PRIOR FROM global_cursor'))
    .toThrowError(expect.objectContaining({ number: 16911 }) as Error)
  executeBatch(s, 'CLOSE global_cursor')
  expect(() => executeBatch(s, 'FETCH NEXT FROM global_cursor'))
    .toThrowError(expect.objectContaining({ number: 16917 }) as Error)
  executeBatch(s, 'DEALLOCATE global_cursor')
  expect(() => executeBatch(s, 'DEALLOCATE global_cursor'))
    .toThrowError(expect.objectContaining({ number: 16916 }) as Error)
})

test('empty cursors set failed fetch status and validate INTO width', () => {
  const s = open()
  const result = executeBatch(s, `
    DECLARE @a INT = 7, @b INT = 8
    DECLARE empty_cursor LOCAL STATIC CURSOR FOR SELECT 1 AS n WHERE 1 = 0
    OPEN empty_cursor
    FETCH NEXT FROM empty_cursor INTO @a
    SELECT @a AS a, @@FETCH_STATUS AS status
    CLOSE empty_cursor
    DEALLOCATE empty_cursor
  `)
  expect(rowsOf(result).rows).toEqual([ [ 7, -1 ] ])
  expect(() => executeBatch(s, `
    DECLARE @a INT, @b INT
    DECLARE width_cursor LOCAL CURSOR FOR SELECT 1 AS n
    OPEN width_cursor
    FETCH NEXT FROM width_cursor INTO @a, @b
  `)).toThrowError(expect.objectContaining({ number: 16924 }) as Error)
})

test('OPEN snapshots cursor rows and reopening refreshes the snapshot', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE cursor_snapshot (n INT);
    INSERT INTO cursor_snapshot VALUES (1);
    DECLARE snapshot_cursor GLOBAL CURSOR STATIC FOR SELECT n FROM cursor_snapshot ORDER BY n;
    OPEN snapshot_cursor;
  `)
  executeBatch(s, 'INSERT INTO cursor_snapshot VALUES (2)')
  expect(rowsOf(executeBatch(s, 'FETCH NEXT FROM snapshot_cursor')).rows).toEqual([ [ 1 ] ])
  expect(rowsOf(executeBatch(s, 'FETCH NEXT FROM snapshot_cursor')).rows).toEqual([])
  executeBatch(s, 'CLOSE snapshot_cursor; OPEN snapshot_cursor')
  expect(rowsOf(executeBatch(s, 'FETCH LAST FROM snapshot_cursor')).rows).toEqual([ [ 2 ] ])
  executeBatch(s, 'DEALLOCATE snapshot_cursor')
})

test('sequences allocate values and expose sys.sequences metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE SEQUENCE dbo.order_ids AS INT
      START WITH 10 INCREMENT BY 5 MINVALUE 10 MAXVALUE 30 NO CYCLE CACHE 4
  `)
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR dbo.order_ids AS id')).rows).toEqual([ [ 10 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR order_ids AS id')).rows).toEqual([ [ 15 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT type, type_desc, start_value, increment, minimum_value, maximum_value,
      current_value, last_used_value, is_cycling, is_cached, cache_size
    FROM sys.sequences WHERE name = N'order_ids'
  `)).rows).toEqual([ [ 'SO', 'SEQUENCE_OBJECT', 10, 5, 10, 30, 15, 15, 0, 1, 4 ] ])
})

test('rowversion allocates database-wide binary values across tables and sessions', () => {
  const server_ = server()
  const first = session(server_)
  const second = session(server_)
  executeBatch(first, `
    CREATE TABLE versioned_a (id INT, version ROWVERSION)
    CREATE TABLE versioned_b (id INT, version TIMESTAMP NULL)
    INSERT INTO versioned_a (id) VALUES (1), (2)
  `)
  executeBatch(second, 'INSERT INTO versioned_b (id) VALUES (3)')
  const values = rowsOf(executeBatch(first, `
    SELECT id, HEX(version) AS version FROM versioned_a
    UNION ALL
    SELECT id, HEX(version) FROM versioned_b
    ORDER BY id
  `))
  expect(values.rows).toEqual([
    [ 1, '0000000000000001' ],
    [ 2, '0000000000000002' ],
    [ 3, '0000000000000003' ]
  ])
  expect(rowsOf(executeBatch(first, 'SELECT HEX(@@DBTS) AS dbts')).rows)
    .toEqual([ [ '0000000000000003' ] ])

  const required = rowsOf(executeBatch(first, 'SELECT version FROM versioned_a'))
  expect(required.columns[0]).toMatchObject({
    typeInfo: { type: DataType.DataType.bigBinary, maxLength: 8 }, nullable: false
  })
  const nullable = rowsOf(executeBatch(first, 'SELECT version FROM versioned_b'))
  expect(nullable.columns[0]).toMatchObject({
    typeInfo: { type: DataType.DataType.bigVarbinary, maxLength: 8 }, nullable: true
  })
  expect(rowsOf(executeBatch(first, `
    SELECT o.name AS object_name, c.is_nullable, c.is_identity, c.is_computed,
      c.system_type_id, t.name AS type_name
    FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.name = N'version'
    ORDER BY o.name
  `)).rows).toEqual([
    [ 'versioned_a', 0, 0, 0, 189, 'timestamp' ],
    [ 'versioned_b', 1, 0, 0, 189, 'timestamp' ]
  ])
})

test('rowversion advances on every update and keeps rollback gaps across restarts', () => {
  const path = join(tmpdir(), `mssqlite-rowversion-${process.pid}-${Date.now()}.db`)
  try {
    const firstServer = server({ path })
    const first = session(firstServer)
    executeBatch(first, `
      CREATE TABLE persisted_versions (id INT, version ROWVERSION)
      INSERT INTO persisted_versions (id) VALUES (1)
      BEGIN TRANSACTION
      UPDATE persisted_versions SET id = id
      ROLLBACK TRANSACTION
    `)
    expect(rowsOf(executeBatch(first, `
      SELECT id, HEX(version), HEX(@@DBTS) FROM persisted_versions
    `)).rows).toEqual([ [ 1, '0000000000000001', '0000000000000002' ] ])
    firstServer.db.close()

    const secondServer = server({ path })
    const second = session(secondServer)
    executeBatch(second, 'INSERT INTO persisted_versions (id) VALUES (2)')
    expect(rowsOf(executeBatch(second, `
      SELECT id, HEX(version) FROM persisted_versions ORDER BY id
    `)).rows).toEqual([
      [ 1, '0000000000000001' ], [ 2, '0000000000000003' ]
    ])
    secondServer.db.close()
  } finally {
    rmSync(path, { force: true })
  }
})

test('rowversion guards explicit writes and stamps ALTER, MERGE and table variables', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE altered_versions (id INT)
    INSERT INTO altered_versions VALUES (1), (2)
    ALTER TABLE altered_versions ADD version ROWVERSION
  `)
  expect(rowsOf(executeBatch(s, `
    SELECT id, HEX(version) FROM altered_versions ORDER BY id
  `)).rows).toEqual([
    [ 1, '0000000000000001' ], [ 2, '0000000000000002' ]
  ])
  expect(() => executeBatch(s, 'ALTER TABLE altered_versions ADD another ROWVERSION'))
    .toThrowError(expect.objectContaining({ number: 2738 }) as Error)
  expect(() => executeBatch(s, 'CREATE TABLE two_versions (a ROWVERSION, b TIMESTAMP)'))
    .toThrowError(expect.objectContaining({ number: 2738 }) as Error)
  expect(() => executeBatch(s, 'CREATE TABLE default_version (v ROWVERSION DEFAULT 0x01)'))
    .toThrowError(expect.objectContaining({ number: 1755 }) as Error)
  expect(() => executeBatch(s, 'CREATE TABLE sized_version (v ROWVERSION(8))'))
    .toThrowError(expect.objectContaining({ number: 2716 }) as Error)
  expect(() => executeBatch(s, 'CREATE TABLE identity_version (v ROWVERSION IDENTITY)'))
    .toThrowError(expect.objectContaining({ number: 2749 }) as Error)
  executeBatch(s, `
    CREATE TABLE constrained_version (
      id INT,
      version ROWVERSION UNIQUE CHECK (DATALENGTH(version) = 8)
    )
    INSERT INTO constrained_version (id) VALUES (1)
  `)

  expect(() => executeBatch(s, `
    INSERT INTO altered_versions (id, version) VALUES (3, 0x0000000000000003)
  `)).toThrowError(expect.objectContaining({ number: 273 }) as Error)
  executeBatch(s, 'INSERT INTO altered_versions (id, version) VALUES (3, DEFAULT)')
  expect(() => executeBatch(s, 'UPDATE altered_versions SET version = DEFAULT WHERE id = 1'))
    .toThrowError(expect.objectContaining({ number: 272 }) as Error)

  executeBatch(s, 'CREATE TABLE merge_versions (id INT PRIMARY KEY, value INT, version ROWVERSION)')
  executeBatch(s, `
    MERGE merge_versions AS target
    USING (VALUES (1, 10)) AS source (id, value)
    ON target.id = source.id
    WHEN NOT MATCHED THEN INSERT (id, value) VALUES (source.id, source.value)
  `)
  const inserted = rowsOf(executeBatch(s, 'SELECT HEX(version) FROM merge_versions')).rows[0]?.[0]
  executeBatch(s, `
    MERGE merge_versions AS target
    USING (VALUES (1, 20)) AS source (id, value)
    ON target.id = source.id
    WHEN MATCHED THEN UPDATE SET value = source.value
  `)
  const updated = rowsOf(executeBatch(s, 'SELECT value, HEX(version) FROM merge_versions'))
  expect(updated.rows[0]?.[0]).toBe(20)
  expect(updated.rows[0]?.[1]).not.toBe(inserted)
  expect(() => executeBatch(s, `
    MERGE merge_versions AS target
    USING (VALUES (1, 30)) AS source (id, value)
    ON target.id = source.id
    WHEN MATCHED THEN UPDATE SET version = 0x01
  `)).toThrowError(expect.objectContaining({ number: 272 }) as Error)

  const tableVariable = rowsOf(executeBatch(s, `
    DECLARE @versions TABLE (id INT, version ROWVERSION)
    INSERT INTO @versions (id) VALUES (1)
    UPDATE @versions SET id = id
    SELECT id, DATALENGTH(version) FROM @versions
  `))
  expect(tableVariable.rows).toEqual([ [ 1, 8 ] ])
})

test('descending and cycling sequences wrap at the type bounds', () => {
  const s = open()
  executeBatch(s, `
    CREATE SEQUENCE descending_ids AS SMALLINT
      START WITH 3 INCREMENT BY -2 MINVALUE -1 MAXVALUE 3 CYCLE NO CACHE
  `)
  const values = Array.from({ length: 4 }, () =>
    rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR descending_ids AS id')).rows[0]?.[0])
  expect(values).toEqual([ 3, 1, -1, 3 ])
})

test('sequence exhaustion and ALTER RESTART follow configured bounds', () => {
  const s = open()
  executeBatch(s, `
    CREATE SEQUENCE finite_ids AS INT
      START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 2 NO CYCLE
  `)
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id')).rows).toEqual([ [ 1 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id')).rows).toEqual([ [ 2 ] ])
  expect(() => executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id'))
    .toThrowError(expect.objectContaining({ number: 11728 }) as Error)
  expect(rowsOf(executeBatch(s, `
    SELECT current_value, is_exhausted FROM sys.sequences WHERE name = N'finite_ids'
  `)).rows).toEqual([ [ 2, 1 ] ])
  executeBatch(s, 'ALTER SEQUENCE finite_ids RESTART WITH 2 INCREMENT BY -1 MINVALUE 0')
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id')).rows).toEqual([ [ 1 ] ])
  executeBatch(s, 'ALTER SEQUENCE finite_ids RESTART')
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR finite_ids AS id')).rows).toEqual([ [ 1 ] ])
})

test('sequence allocations survive rollback and are atomic across sessions', () => {
  const srv = server()
  const first = session(srv)
  const second = session(srv)
  executeBatch(first, 'CREATE SEQUENCE shared_ids AS INT START WITH 100')
  executeBatch(first, 'BEGIN TRAN')
  expect(rowsOf(executeBatch(first, 'SELECT NEXT VALUE FOR shared_ids AS id')).rows).toEqual([ [ 100 ] ])
  executeBatch(first, 'ROLLBACK')
  expect(rowsOf(executeBatch(second, 'SELECT NEXT VALUE FOR shared_ids AS id')).rows).toEqual([ [ 101 ] ])
  expect(rowsOf(executeBatch(first, `
    SELECT current_value, last_used_value FROM sys.sequences WHERE name = N'shared_ids'
  `)).rows).toEqual([ [ 101, 101 ] ])
})

test('sequences persist across restart and drop cleanly', () => {
  const path = join(tmpdir(), `mssqlite-sequence-${process.pid}-${Date.now()}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, 'CREATE SEQUENCE persisted_ids AS INT START WITH 7 INCREMENT BY 3')
    expect(rowsOf(executeBatch(first, 'SELECT NEXT VALUE FOR persisted_ids AS id')).rows).toEqual([ [ 7 ] ])
    const second = session(server({ path }))
    expect(rowsOf(executeBatch(second, 'SELECT NEXT VALUE FOR persisted_ids AS id')).rows).toEqual([ [ 10 ] ])
    executeBatch(second, 'DROP SEQUENCE persisted_ids')
    expect(() => executeBatch(second, 'SELECT NEXT VALUE FOR persisted_ids AS id'))
      .toThrowError(expect.objectContaining({ number: 11726 }) as Error)
    expect(rowsOf(executeBatch(second, 'SELECT COUNT(*) AS n FROM sys.sequences')).rows).toEqual([ [ 0 ] ])
  } finally {
    rmSync(path, { force: true })
  }
})

test('sequence DDL rejects invalid increments and duplicate options', () => {
  const s = open()
  expect(() => executeBatch(s, 'CREATE SEQUENCE zero_step AS INT INCREMENT BY 0'))
    .toThrowError(expect.objectContaining({ number: 11704 }) as Error)
  expect(() => executeBatch(s, `
    CREATE SEQUENCE duplicate_start AS INT START WITH 1 START WITH 2
  `)).toThrowError(expect.objectContaining({ number: 11708 }) as Error)
})

test('table variable backing tables clean up at batch end', () => {
  const s = open()
  executeBatch(s, 'DECLARE @t TABLE (id INT); INSERT INTO @t VALUES (1)')
  const remaining = s.db.prepare(
    'SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE \'#__mssqlite_table_%\''
  ).get() as { n: number }
  expect(remaining.n).toBe(0)
  expect(() => executeBatch(s, 'SELECT * FROM @t')).toThrowError(
    expect.objectContaining({ number: 1087 }) as Error
  )
  expect(rowsOf(executeBatch(s, 'DECLARE @t TABLE (id INT); SELECT * FROM @t')).rows).toEqual([])
})

test('table variables are isolated across procedure and dynamic batch scopes', () => {
  const s = open()
  executeBatch(s, `
    CREATE PROCEDURE dbo.local_table AS
    BEGIN
      DECLARE @t TABLE (id INT)
      INSERT INTO @t VALUES (2)
      SELECT id FROM @t
    END
  `)
  const items = executeBatch(s, `
    DECLARE @t TABLE (id INT)
    INSERT INTO @t VALUES (1)
    EXEC local_table
    SELECT id FROM @t
  `).filter((item): item is Rows => item.kind === 'rows')
  expect(items.map(item => item.rows)).toEqual([ [ [ 2 ] ], [ [ 1 ] ] ])

  executeBatch(s, 'CREATE PROCEDURE dbo.read_caller AS SELECT * FROM @caller')
  expect(() => executeBatch(s, 'DECLARE @caller TABLE (id INT); EXEC read_caller')).toThrowError(
    expect.objectContaining({ number: 1087 }) as Error
  )

  const dynamic = executeBatch(s, `
    DECLARE @outer TABLE (id INT)
    INSERT INTO @outer VALUES (7)
    BEGIN TRY
      EXEC sp_executesql N'SELECT * FROM @outer'
    END TRY
    BEGIN CATCH
      SELECT ERROR_NUMBER() AS error_number
    END CATCH
    SELECT id FROM @outer
  `).filter((item): item is Rows => item.kind === 'rows')
  expect(dynamic.map(item => item.rows)).toEqual([ [ [ 1087 ] ], [ [ 7 ] ] ])
})

test('globals', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, v INT)')
  executeBatch(s, 'INSERT INTO t (v) VALUES (1), (2), (3)')
  const result = rowsOf(executeBatch(s, `
    SELECT @@ROWCOUNT AS rc, @@IDENTITY AS id, @@TRANCOUNT AS tc,
      @@SPID AS spid, @@FETCH_STATUS AS fs
  `))
  expect(result.rows[0]?.[0]).toBe(3)
  expect(result.rows[0]?.[1]).toBe(3)
  expect(result.rows[0]?.[2]).toBe(0)
  expect(result.rows[0]?.[4]).toBe(-9)
  expect(rowsOf(executeBatch(s, 'SELECT SCOPE_IDENTITY() AS i')).rows).toEqual([ [ 3 ] ])
})

test('control flow', () => {
  const s = open()
  const items = executeBatch(s, `
    DECLARE @i INT = 0, @sum INT = 0
    WHILE @i < 5
    BEGIN
      SET @i = @i + 1
      IF @i = 3 CONTINUE
      IF @i = 5 BREAK
      SET @sum = @sum + @i
    END
    SELECT @sum AS total
  `)
  expect(rowsOf(items).rows).toEqual([ [ 1 + 2 + 4 ] ])
})

test('if else and print', () => {
  const s = open()
  const items = executeBatch(s, 'IF 1 > 2 PRINT \'yes\' ELSE PRINT \'no\'')
  expect(items).toEqual([ { kind: 'message', text: 'no' } ])
})

test('transactions with nesting and rollback', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (v INT)')
  executeBatch(s, 'BEGIN TRAN INSERT INTO t VALUES (1) BEGIN TRAN INSERT INTO t VALUES (2) COMMIT COMMIT')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 2 ] ])
  executeBatch(s, 'BEGIN TRAN INSERT INTO t VALUES (3) ROLLBACK')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 2 ] ])
})

test('savepoints', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (v INT)')
  executeBatch(s, `
    BEGIN TRAN
    INSERT INTO t VALUES (1)
    SAVE TRAN sp1
    INSERT INTO t VALUES (2)
    ROLLBACK TRAN sp1
    COMMIT
  `)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 1 ] ])
})

test('sql errors map to mssql numbers', () => {
  const s = open()
  expect(() => executeBatch(s, 'SELECT * FROM missing')).toThrowError(
    expect.objectContaining({ number: 208 }) as Error
  )
  executeBatch(s, 'CREATE TABLE u (email VARCHAR(50) UNIQUE)')
  executeBatch(s, 'INSERT INTO u VALUES (\'a\')')
  expect(() => executeBatch(s, 'INSERT INTO u VALUES (\'a\')')).toThrowError(
    expect.objectContaining({ number: 2627 }) as Error
  )
  expect(() => executeBatch(s, 'SELEC 1')).toThrowError(MssqlError)
  // @@ERROR reports the previous statement's error before this one resets it.
  expect(rowsOf(executeBatch(s, 'SELECT @@ERROR AS e')).rows).toEqual([ [ 102 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT @@ERROR AS e')).rows).toEqual([ [ 0 ] ])
})

test('statement-terminating errors continue the batch in result order', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE continuation (id INT PRIMARY KEY); INSERT INTO continuation VALUES (1)')
  let failure: BatchError | undefined
  try {
    executeBatch(s, `
      INSERT INTO continuation VALUES (1)
      SELECT @@ERROR AS error_number, @@ROWCOUNT AS row_count
      INSERT INTO continuation VALUES (1)
      SELECT COUNT(*) AS total, @@ERROR AS error_number FROM continuation
    `)
  } catch (error) {
    failure = error as BatchError
  }
  expect(failure).toBeInstanceOf(BatchError)
  expect(failure?.items.map(item => item.kind)).toEqual([ 'error', 'rows', 'error', 'rows' ])
  expect(failure?.items.filter(item => item.kind === 'error').map(item => item.error.number))
    .toEqual([ 2627, 2627 ])
  const rows = failure?.items.filter((item): item is Rows => item.kind === 'rows') ?? []
  expect(rows.map(item => item.rows)).toEqual([ [ [ 2627, 0 ] ], [ [ 1, 2627 ] ] ])
  expect(rowsOf(executeBatch(s, 'SELECT @@ERROR AS e')).rows).toEqual([ [ 0 ] ])
})

test('conversion failures continue while TRY_CAST returns NULL', () => {
  const s = open()
  let failure: BatchError | undefined
  try {
    executeBatch(s, `
      SELECT CAST('not an integer' AS INT) AS bad
      SELECT 7 AS after_error
      SELECT TRY_CAST('still bad' AS INT) AS attempted
    `)
  } catch (error) {
    failure = error as BatchError
  }
  expect(failure?.items.map(item => item.kind)).toEqual([ 'error', 'rows', 'rows' ])
  expect(failure?.items.find(item => item.kind === 'error')).toMatchObject({
    error: { number: 245 }
  })
  const rows = failure?.items.filter((item): item is Rows => item.kind === 'rows') ?? []
  expect(rows.map(item => item.rows)).toEqual([ [ [ 7 ] ], [ [ null ] ] ])
})

test('divide by zero is catchable, continues, and evaluates operands once', () => {
  const s = open()
  executeBatch(s, 'CREATE SEQUENCE arithmetic_seq AS INT START WITH 1')
  let failure: BatchError | undefined
  try {
    executeBatch(s, `
      SELECT NEXT VALUE FOR arithmetic_seq / 0 AS bad
      SELECT 7 AS after_error
    `)
  } catch (error) {
    failure = error as BatchError
  }
  expect(failure?.items.map(item => item.kind)).toEqual([ 'error', 'rows' ])
  expect(failure?.items.find(item => item.kind === 'error')).toMatchObject({
    error: { number: 8134 }
  })
  expect(rowsOf(executeBatch(s, 'SELECT NEXT VALUE FOR arithmetic_seq AS n')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, `
    BEGIN TRY SELECT 1 / 0 AS bad END TRY
    BEGIN CATCH SELECT ERROR_NUMBER() AS n END CATCH
  `)).rows).toEqual([ [ 8134 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT NULL / 0 AS n')).rows).toEqual([ [ null ] ])
})

test('checked integer arithmetic raises overflow while bigint succeeds', () => {
  const s = open()
  for (const sql of [
    'SELECT 2147483647 + 1 AS n',
    'SELECT 50000 * 50000 AS n',
    'SELECT CAST(-2147483648 AS INT) / -1 AS n'
  ]) {
    expect(() => executeBatch(s, sql))
      .toThrowError(expect.objectContaining({ number: 8115 }) as Error)
  }
  expect(rowsOf(executeBatch(s, `
    SELECT CAST(2147483647 AS BIGINT) + 1 AS n
  `)).rows).toEqual([ [ 2147483648 ] ])
})

test('SUM checks int width and explicit bigint widens the accumulator', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE sum_values (n INT); INSERT INTO sum_values VALUES (2147483647), (1)')
  expect(() => executeBatch(s, 'SELECT SUM(n) AS total FROM sum_values'))
    .toThrowError(expect.objectContaining({ number: 8115 }) as Error)
  expect(rowsOf(executeBatch(s, `
    SELECT SUM(CAST(n AS BIGINT)) AS total FROM sum_values
  `)).rows).toEqual([ [ 2147483648 ] ])
})

test('decimal casts and arithmetic stay exact with SQL precision and scale metadata', () => {
  const s = open()
  const result = rowsOf(executeBatch(s, `
    SELECT
      CAST('9999999999999999.99' AS DECIMAL(18,2)) AS boundary,
      CAST(0.10 AS DECIMAL(10,2)) + CAST(0.20 AS DECIMAL(10,2)) AS added,
      CAST(1 AS DECIMAL(10,2)) / CAST(8 AS DECIMAL(10,2)) AS divided,
      CAST(1.005 AS DECIMAL(5,2)) AS rounded
  `))
  expect(result.rows).toEqual([ [
    '9999999999999999.99', '0.30', '0.1250000000000', '1.01'
  ] ])
  expect(result.columns.map(column => [ column.typeInfo.precision, column.typeInfo.scale ])).toEqual([
    [ 18, 2 ], [ 11, 2 ], [ 23, 13 ], [ 5, 2 ]
  ])
  expect(() => executeBatch(s, 'SELECT CAST(\'1000\' AS DECIMAL(3,0)) AS n'))
    .toThrowError(expect.objectContaining({ number: 8115 }) as Error)
})

test('decimal storage, parameters, comparison, ordering and aggregates remain exact', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE exact_values (amount DECIMAL(20,2))')
  executeSql(s, 'INSERT INTO exact_values VALUES (@amount)', [
    { name: '@amount', value: '9999999999999999.99' }
  ])
  executeBatch(s, `
    INSERT INTO exact_values VALUES (2), (-3), (10), (0.10), (0.20)
    UPDATE exact_values SET amount += 0.01 WHERE amount = 0.20
  `)
  const ordered = rowsOf(executeBatch(s, `
    SELECT amount FROM exact_values WHERE amount > -4 ORDER BY amount
  `))
  expect(ordered.rows).toEqual([ [ '-3.00' ], [ '0.10' ], [ '0.21' ], [ '2.00' ], [ '10.00' ],
    [ '9999999999999999.99' ] ])
  const aggregate = rowsOf(executeBatch(s, `
    SELECT SUM(amount) AS total, AVG(amount) AS average,
      MIN(amount) AS minimum, MAX(amount) AS maximum
    FROM exact_values
  `))
  expect(aggregate.rows).toEqual([ [
    '10000000000000009.30', '1666666666666668.216667', '-3.00', '9999999999999999.99'
  ] ])
})

test('decimal values and declared metadata survive a database restart', () => {
  const path = join(tmpdir(), `mssqlite-decimal-${process.pid}-${Date.now()}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, `
      CREATE TABLE persisted_decimal (
        amount DECIMAL(38,10) DEFAULT 1234567890123456789012345678.1234567890
      );
      INSERT INTO persisted_decimal DEFAULT VALUES
    `)
    const second = session(server({ path }))
    const result = rowsOf(executeBatch(second, 'SELECT amount FROM persisted_decimal'))
    expect(result.rows).toEqual([ [ '1234567890123456789012345678.1234567890' ] ])
    expect(result.columns[0]?.typeInfo).toMatchObject({ precision: 38, scale: 10 })
  } finally {
    rmSync(path, { force: true })
  }
})

test('datetimeoffset compares and orders UTC instants while preserving offsets', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE offset_values (
      id INT PRIMARY KEY,
      happened_at DATETIMEOFFSET(7),
      UNIQUE (happened_at)
    );
    INSERT INTO offset_values VALUES
      (1, '2026-01-01 09:30:00.1234567 +02:00'),
      (2, '2026-01-01 08:00:00.0000000 +00:00'),
      (3, '2026-01-01 04:00:00.0000000 -05:00');
    CREATE INDEX ix_offset_instant ON offset_values (happened_at)
  `)
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM offset_values ORDER BY happened_at
  `)).rows).toEqual([ [ 1 ], [ 2 ], [ 3 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT id FROM offset_values
    WHERE happened_at = '2026-01-01 07:30:00.1234567 +00:00'
      AND happened_at IN ('2026-01-01 02:30:00.1234567 -05:00')
      AND happened_at BETWEEN '2026-01-01 07:30:00.1234567 +00:00'
        AND '2026-01-01 07:30:00.1234567 +00:00'
  `)).rows).toEqual([ [ 1 ] ])
  expect(() => executeBatch(s, `
    INSERT INTO offset_values VALUES (4, '2026-01-01 02:30:00.1234567 -05:00')
  `)).toThrowError(expect.objectContaining({ number: 2627 }) as Error)
})

test('datetimeoffset casts, variables, parameters, defaults and storage retain scale and offset', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE offset_storage (
      happened_at DATETIMEOFFSET(3)
        DEFAULT '2026-01-01 00:00:00.1236 -04:30'
    )
  `)
  executeSql(s, 'INSERT INTO offset_storage VALUES (@happened_at)', [ {
    name: '@happened_at',
    value: '2026-12-31 23:59:59.9999999 +05:30',
    type: { name: 'datetimeoffset', args: [ 7 ] }
  } ])
  const parameter = rowsOf(executeSql(s, 'SELECT @happened_at AS happened_at', [ {
    name: '@happened_at',
    value: '2026-07-01 02:30:00.1234567 +05:30',
    type: { name: 'datetimeoffset', args: [ 7 ] }
  } ]).items)
  expect(parameter.rows).toEqual([ [ '2026-07-01 02:30:00.1234567 +05:30' ] ])
  expect(parameter.columns[0]?.typeInfo).toMatchObject({
    type: DataType.DataType.datetimeOffsetN,
    scale: 7
  })
  const result = rowsOf(executeBatch(s, `
    DECLARE @value DATETIMEOFFSET(3) = '2026-07-01 02:30:00.1236 -04:30'
    SELECT @value AS variable,
      CAST('2026-07-01 02:30:00.1236 +05:30' AS DATETIMEOFFSET(3)) AS casted,
      happened_at AS persisted
    FROM offset_storage
  `))
  expect(result.rows).toEqual([ [
    '2026-07-01 02:30:00.124 -04:30',
    '2026-07-01 02:30:00.124 +05:30',
    '2027-01-01 00:00:00.000 +05:30'
  ] ])
  expect(result.columns.map(column => column.typeInfo.scale)).toEqual([ 3, 3, 3 ])
  executeBatch(s, 'INSERT INTO offset_storage DEFAULT VALUES')
  expect(rowsOf(executeBatch(s, `
    SELECT happened_at FROM offset_storage ORDER BY rowid DESC
  `)).rows[0]).toEqual([ '2026-01-01 00:00:00.124 -04:30' ])
})

test('datetimeoffset date functions preserve local offset and use UTC boundaries', () => {
  const s = open()
  const result = rowsOf(executeBatch(s, `
    SELECT
      DATEADD(nanosecond, 50,
        CAST('2026-03-29 01:59:59.1234567 +01:00' AS DATETIMEOFFSET(7))) AS ticked,
      DATEADD(day, 1,
        CAST('2026-03-29 01:59:59.1234567 +01:00' AS DATETIMEOFFSET(7))) AS next_day,
      DATEDIFF(hour,
        CAST('2026-01-01 10:00 +02:00' AS DATETIMEOFFSET),
        CAST('2026-01-01 09:00 +00:00' AS DATETIMEOFFSET)) AS elapsed_hours,
      DATEDIFF(nanosecond,
        CAST('2026-01-01 00:00:00.0000000 +00:00' AS DATETIMEOFFSET),
        CAST('2026-01-01 00:00:00.0000001 +00:00' AS DATETIMEOFFSET)) AS elapsed_ns,
      DATEPART(tzoffset,
        CAST('2026-01-01 00:00 +05:30' AS DATETIMEOFFSET)) AS offset_minutes,
      DATENAME(tzoffset,
        CAST('2026-01-01 00:00 -04:30' AS DATETIMEOFFSET)) AS offset_name
  `))
  expect(result.rows).toEqual([ [
    '2026-03-29 01:59:59.1234568 +01:00',
    '2026-03-30 01:59:59.1234567 +01:00',
    1,
    100,
    330,
    '-04:30'
  ] ])
  expect(result.columns[0]?.typeInfo).toMatchObject({
    type: DataType.DataType.datetimeOffsetN,
    scale: 7
  })
})

test('datetimeoffset rejects invalid local or UTC ranges and TRY_CAST returns null', () => {
  const s = open()
  for (const invalid of [
    '2026-02-29 00:00 +00:00',
    '2026-01-01 00:00 +14:01',
    '0001-01-01 00:00 +14:00',
    '9999-12-31 23:59 -14:00'
  ]) {
    expect(() => executeBatch(s, `SELECT CAST('${invalid}' AS DATETIMEOFFSET)`))
      .toThrowError(expect.objectContaining({ number: 241 }) as Error)
  }
  expect(rowsOf(executeBatch(s, `
    SELECT TRY_CAST('not a date' AS DATETIMEOFFSET(4)) AS attempted
  `)).rows).toEqual([ [ null ] ])
  expect(() => executeBatch(s, `
    SELECT TRY_CAST('2026-01-01 +00:00' AS DATETIMEOFFSET(8))
  `)).toThrowError(expect.objectContaining({ number: 1005 }) as Error)
})

test('datetimeoffset persisted values and metadata survive a database restart', () => {
  const path = join(tmpdir(), `mssqlite-datetimeoffset-${process.pid}-${Date.now()}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, `
      CREATE TABLE persisted_offset (happened_at DATETIMEOFFSET(6));
      INSERT INTO persisted_offset VALUES ('2026-07-01 02:30:00.1234567 +05:30')
    `)
    const second = session(server({ path }))
    const result = rowsOf(executeBatch(second, 'SELECT happened_at FROM persisted_offset'))
    expect(result.rows).toEqual([ [ '2026-07-01 02:30:00.123457 +05:30' ] ])
    expect(result.columns[0]?.typeInfo).toMatchObject({
      type: DataType.DataType.datetimeOffsetN,
      scale: 6
    })
  } finally {
    rmSync(path, { force: true })
  }
})

test('ARITHABORT and ANSI_WARNINGS OFF return NULL for arithmetic failures', () => {
  const s = open()
  executeBatch(s, 'SET ARITHABORT OFF; SET ANSI_WARNINGS OFF')
  expect(rowsOf(executeBatch(s, `
    SELECT 1 / 0 AS divided, 2147483647 + 1 AS overflowed
  `)).rows).toEqual([ [ null, null ] ])
  executeBatch(s, 'SET ANSI_WARNINGS ON')
  expect(() => executeBatch(s, 'SELECT 1 / 0 AS divided'))
    .toThrowError(expect.objectContaining({ number: 8134 }) as Error)
})

test('constraint errors leave XACT_ABORT OFF transactions committable', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE xact_continue (id INT PRIMARY KEY)')
  let failure: BatchError | undefined
  try {
    executeBatch(s, `
      BEGIN TRAN;
      INSERT INTO xact_continue VALUES (1)
      INSERT INTO xact_continue VALUES (1)
      INSERT INTO xact_continue VALUES (2)
      COMMIT
      SELECT COUNT(*) AS n, @@TRANCOUNT AS tc FROM xact_continue
    `)
  } catch (error) {
    failure = error as BatchError
  }
  expect(failure?.items.filter(item => item.kind === 'error')).toHaveLength(1)
  const result = failure?.items.find((item): item is Rows => item.kind === 'rows')
  expect(result?.rows).toEqual([ [ 2, 0 ] ])
})

test('XACT_ABORT ON rolls back and aborts after a qualifying runtime error', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE xact_abort_rows (id INT PRIMARY KEY); SET XACT_ABORT ON')
  expect(() => executeBatch(s, `
    BEGIN TRAN
    INSERT INTO xact_abort_rows VALUES (1)
    INSERT INTO xact_abort_rows VALUES (1)
    INSERT INTO xact_abort_rows VALUES (2)
  `)).toThrowError(expect.objectContaining({ number: 2627 }) as Error)
  expect(rowsOf(executeBatch(s, `
    SELECT COUNT(*) AS n, @@TRANCOUNT AS tc, XACT_STATE() AS xs FROM xact_abort_rows
  `)).rows).toEqual([ [ 0, 0, 0 ] ])
})

test('RAISERROR continues and ignores XACT_ABORT while THROW aborts', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE raised_rows (id INT); SET XACT_ABORT ON')
  let raised: BatchError | undefined
  try {
    executeBatch(s, `
      BEGIN TRAN
      RAISERROR ('keep going', 16, 1)
      INSERT INTO raised_rows VALUES (1)
      COMMIT
      SELECT COUNT(*) AS n FROM raised_rows
    `)
  } catch (error) {
    raised = error as BatchError
  }
  expect(raised?.items.map(item => item.kind)).toEqual([ 'error', 'count', 'rows' ])
  expect(raised?.items.find((item): item is Rows => item.kind === 'rows')?.rows).toEqual([ [ 1 ] ])

  expect(() => executeBatch(s, `
    THROW 51000, 'stop now', 1
    INSERT INTO raised_rows VALUES (2)
  `)).toThrowError(expect.objectContaining({ number: 51000 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM raised_rows')).rows).toEqual([ [ 1 ] ])

  expect(() => executeBatch(s, `
    RAISERROR ('fatal', 20, 1)
    INSERT INTO raised_rows VALUES (3)
  `)).toThrowError(expect.objectContaining({ severity: 20 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM raised_rows')).rows).toEqual([ [ 1 ] ])
})

test('syntax errors compile-abort before any statement executes', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE syntax_rows (id INT)')
  expect(() => executeBatch(s, 'INSERT INTO syntax_rows VALUES (1); SELEC 1'))
    .toThrowError(expect.objectContaining({ number: 102 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM syntax_rows')).rows).toEqual([ [ 0 ] ])
})

test('undeclared variable errors', () => {
  const s = open()
  expect(() => executeBatch(s, 'SELECT @nope AS x')).toThrowError(
    expect.objectContaining({ number: 137 }) as Error
  )
})

test('executeSql binds parameters and returns outputs', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT PRIMARY KEY, name NVARCHAR(50))')
  executeSql(s, 'INSERT INTO t VALUES (@id, @name)', [
    { name: '@id', value: 1 },
    { name: '@name', value: 'x' }
  ])
  const result = executeSql(s, 'SELECT name FROM t WHERE id = @id', [ { name: '@id', value: 1 } ])
  expect(rowsOf(result.items).rows).toEqual([ [ 'x' ] ])
  const output = executeSql(s, 'SET @total = (SELECT COUNT(*) FROM t)', [
    { name: '@total', value: null, output: true }
  ])
  expect(output.outputs).toEqual([ { name: '@total', value: 1 } ])
})

test('exec sp_executesql from tsql', () => {
  const s = open()
  const items = executeBatch(s, 'EXEC sp_executesql N\'SELECT @v AS v\', N\'@v int\', @v = 42')
  expect(rowsOf(items).rows).toEqual([ [ 42 ] ])
})

test('date and string udfs through full pipeline', () => {
  const s = open()
  const result = rowsOf(executeBatch(s, `
    SELECT
      DATEADD(month, 1, '2026-01-31') AS m,
      DATEDIFF(day, '2026-01-01', '2026-02-01') AS d,
      DATEPART(quarter, '2026-07-01') AS q,
      DATENAME(month, '2026-07-01') AS mn,
      RIGHT('hello', 2) AS r,
      REPLICATE('ab', 3) AS rep,
      REVERSE('abc') AS rev,
      STUFF('abcdef', 2, 3, 'x') AS st,
      PATINDEX('%c%', 'abc') AS pi,
      CHARINDEX('l', 'hello', 4) AS ci
  `))
  expect(result.rows[0]).toEqual([
    '2026-02-28 00:00:00.000', 31, 3, 'July', 'lo', 'ababab', 'cba', 'axef', 3, 4
  ])
})

test('table-valued functions return rows and metadata through the engine', () => {
  const s = open()
  const split = rowsOf(executeBatch(s, `
    SELECT value, ordinal
    FROM STRING_SPLIT(N'a,,b', N',', 1)
    ORDER BY ordinal
  `))
  expect(split.rows).toEqual([ [ 'a', 1 ], [ '', 2 ], [ 'b', 3 ] ])
  expect(split.columns).toMatchObject([
    { name: 'value', typeInfo: { type: DataType.DataType.nvarchar, maxLength: 8 } },
    { name: 'ordinal', typeInfo: { type: DataType.DataType.intN, maxLength: 8 } }
  ])
  const emptySplit = rowsOf(executeBatch(s, 'SELECT * FROM STRING_SPLIT(NULL, \',\', 1)'))
  expect(emptySplit.rows).toEqual([])
  expect(emptySplit.columns.map(column => column.name)).toEqual([ 'value', 'ordinal' ])

  const json = rowsOf(executeBatch(s, `
    SELECT [key], value, type
    FROM OPENJSON('{"name":"Ada","active":true,"items":[1]}')
    ORDER BY [key]
  `))
  expect(json.rows).toEqual([
    [ 'active', 'true', 3 ],
    [ 'items', '[1]', 4 ],
    [ 'name', 'Ada', 1 ]
  ])
  expect(json.columns.map(column => column.name)).toEqual([ 'key', 'value', 'type' ])
  const shaped = rowsOf(executeBatch(s, `
    SELECT id, name
    FROM OPENJSON('{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}', '$.items')
    WITH (id INT, name NVARCHAR(20))
    ORDER BY id
  `))
  expect(shaped.rows).toEqual([ [ 1, 'a' ], [ 2, 'b' ] ])
  expect(shaped.columns[1]).toMatchObject({
    typeInfo: { type: DataType.DataType.nvarchar, maxLength: 40 }
  })
  expect(rowsOf(executeBatch(s, 'SELECT * FROM OPENJSON(NULL)')).rows).toEqual([])

  const series = rowsOf(executeBatch(s, 'SELECT value FROM GENERATE_SERIES(5, 1, -2)'))
  expect(series.rows).toEqual([ [ 5 ], [ 3 ], [ 1 ] ])
  expect(series.columns[0]).toMatchObject({
    typeInfo: { type: DataType.DataType.intN, maxLength: 4 }
  })
  expect(rowsOf(executeBatch(s, 'SELECT * FROM GENERATE_SERIES(NULL, 3)')).rows).toEqual([])
})

test('apply preserves correlated row elimination and null extension', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE apply_tags (id INT, csv NVARCHAR(20));
    INSERT INTO apply_tags VALUES (1, 'a,b'), (2, NULL), (3, 'c');
    CREATE TABLE apply_notes (tag_id INT, note NVARCHAR(20), created INT);
    INSERT INTO apply_notes VALUES (1, 'old', 1), (1, 'new', 2), (3, 'only', 1);
  `)
  expect(rowsOf(executeBatch(s, `
    SELECT t.id, part.value
    FROM apply_tags t CROSS APPLY STRING_SPLIT(t.csv, ',') part
    ORDER BY t.id, part.value
  `)).rows).toEqual([ [ 1, 'a' ], [ 1, 'b' ], [ 3, 'c' ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT t.id, latest.note
    FROM apply_tags t OUTER APPLY (
      SELECT TOP (1) n.note FROM apply_notes n
      WHERE n.tag_id = t.id ORDER BY n.created DESC
    ) latest
    ORDER BY t.id
  `)).rows).toEqual([ [ 1, 'new' ], [ 2, null ], [ 3, 'only' ] ])
})

test('pivot and unpivot expose generated values and metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE transform_sales (region NVARCHAR(20), quarter NVARCHAR(2), amount INT);
    INSERT INTO transform_sales VALUES
      ('east', 'Q1', 10), ('east', 'Q1', 5), ('east', 'Q2', NULL),
      ('west', 'Q2', 7);
  `)
  const pivot = rowsOf(executeBatch(s, `
    SELECT region, [Q1], [Q2], [Q3]
    FROM transform_sales
    PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY region
  `))
  expect(pivot.rows).toEqual([
    [ 'east', 15, null, null ],
    [ 'west', null, 7, null ]
  ])
  expect(pivot.columns.map(column => column.name)).toEqual([ 'region', 'Q1', 'Q2', 'Q3' ])
  expect(pivot.columns.slice(1).map(column => column.typeInfo.type))
    .toEqual([ DataType.DataType.intN, DataType.DataType.intN, DataType.DataType.intN ])

  executeBatch(s, `
    CREATE TABLE transform_labels (bucket NVARCHAR(2), label NVARCHAR(12));
    INSERT INTO transform_labels VALUES ('Q1', 'first');
  `)
  const labels = rowsOf(executeBatch(s, `
    SELECT [Q1], [Q2] FROM transform_labels
    PIVOT (MAX(label) FOR bucket IN ([Q1], [Q2])) result
  `))
  expect(labels.rows).toEqual([ [ 'first', null ] ])
  expect(labels.columns.map(column => column.typeInfo)).toMatchObject([
    { type: DataType.DataType.nvarchar, maxLength: 24 },
    { type: DataType.DataType.nvarchar, maxLength: 24 }
  ])

  executeBatch(s, `
    CREATE TABLE transform_quarters (id INT, [Q1] INT, [Q2] INT, [Q3] INT);
    INSERT INTO transform_quarters VALUES (1, 10, 20, NULL), (2, NULL, 25, 30);
  `)
  const unpivot = rowsOf(executeBatch(s, `
    SELECT id, quarter, amount
    FROM transform_quarters
    UNPIVOT (amount FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY id, quarter
  `))
  expect(unpivot.rows).toEqual([
    [ 1, 'Q1', 10 ], [ 1, 'Q2', 20 ], [ 2, 'Q2', 25 ], [ 2, 'Q3', 30 ]
  ])
  expect(unpivot.columns.map(column => column.name)).toEqual([ 'id', 'quarter', 'amount' ])
  expect(unpivot.columns[2]?.typeInfo.type).toBe(DataType.DataType.intN)

  executeBatch(s, 'CREATE TABLE transform_mixed (id INT, a INT, b REAL)')
  expect(() => executeBatch(s, `
    SELECT * FROM transform_mixed
    UNPIVOT (value FOR name IN (a, b)) result
  `)).toThrowError(expect.objectContaining({ number: 40000 }) as Error)
})

test('grouping sets preserve subtotal indicators and metadata', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE grouping_sales (region NVARCHAR(10), product NVARCHAR(10), amount INT);
    INSERT INTO grouping_sales VALUES
      ('east', 'a', 10), ('east', 'b', 20), ('west', 'a', 5), (NULL, 'a', 7);
  `)
  const result = rowsOf(executeBatch(s, `
    SELECT region, product, SUM(amount) AS total,
      GROUPING(region) AS gr, GROUPING(product) AS gp
    FROM grouping_sales
    GROUP BY ROLLUP(region, product)
    ORDER BY gr, gp, region, product
  `))
  expect(result.rows).toEqual([
    [ null, 'a', 7, 0, 0 ],
    [ 'east', 'a', 10, 0, 0 ], [ 'east', 'b', 20, 0, 0 ],
    [ 'west', 'a', 5, 0, 0 ],
    [ null, null, 7, 0, 1 ],
    [ 'east', null, 30, 0, 1 ], [ 'west', null, 5, 0, 1 ],
    [ null, null, 42, 1, 1 ]
  ])
  expect(result.columns.map(column => [
    column.name, column.typeInfo.type, column.typeInfo.maxLength
  ])).toEqual([
    [ 'region', DataType.DataType.nvarchar, 20 ],
    [ 'product', DataType.DataType.nvarchar, 20 ],
    [ 'total', DataType.DataType.intN, 4 ],
    [ 'gr', DataType.DataType.intN, 1 ],
    [ 'gp', DataType.DataType.intN, 1 ]
  ])
})

test('for json returns one nvarchar max value with nested path objects', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE engine_json_people (id INT, name NVARCHAR(20), nick NVARCHAR(20));
    INSERT INTO engine_json_people VALUES (1, 'Ada', NULL), (2, 'Bob', 'b');
  `)
  const result = rowsOf(executeBatch(s, `
    SELECT id, name AS [info.name], nick AS [info.nick]
    FROM engine_json_people ORDER BY id FOR JSON PATH, ROOT('people')
  `))
  expect(result.columns).toMatchObject([ {
    name: 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B',
    typeInfo: { type: DataType.DataType.nvarchar, maxLength: 65535 },
    nullable: false
  } ])
  expect(JSON.parse(String(result.rows[0]?.[0]))).toEqual({
    people: [
      { id: 1, info: { name: 'Ada' } },
      { id: 2, info: { name: 'Bob', nick: 'b' } }
    ]
  })
})

test('newid produces guids, rand in range', () => {
  const s = open()
  const result = rowsOf(executeBatch(s, 'SELECT NEWID() AS g, RAND() AS r'))
  expect(String(result.rows[0]?.[0])).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
  expect(Number(result.rows[0]?.[1])).toBeGreaterThanOrEqual(0)
  expect(Number(result.rows[0]?.[1])).toBeLessThan(1)
})

test('select into creates table and registers catalog', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE src (v INT); INSERT INTO src VALUES (1), (2)')
  executeBatch(s, 'SELECT v INTO dst FROM src')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM dst')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM sys.tables WHERE name = \'dst\'')).rows)
    .toEqual([ [ 1 ] ])
})

test('truncate resets identity', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, v INT)')
  executeBatch(s, 'INSERT INTO t (v) VALUES (1), (2)')
  executeBatch(s, 'TRUNCATE TABLE t')
  executeBatch(s, 'INSERT INTO t (v) VALUES (9)')
  expect(rowsOf(executeBatch(s, 'SELECT id FROM t')).rows).toEqual([ [ 1 ] ])
})

test('catalog queries work end to end', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE users (id INT PRIMARY KEY, name NVARCHAR(50))')
  const result = rowsOf(executeBatch(s, `
    SELECT t.name, c.name AS col
    FROM sys.tables t
    JOIN sys.columns c ON c.object_id = t.object_id
    ORDER BY c.column_id
  `))
  expect(result.rows).toEqual([ [ 'users', 'id' ], [ 'users', 'name' ] ])
  expect(rowsOf(executeBatch(s, 'SELECT OBJECT_ID(\'users\') AS id')).rows[0]?.[0]).toBeGreaterThan(100000000)
  expect(rowsOf(executeBatch(s, 'SELECT DB_NAME() AS d')).rows).toEqual([ [ 'master' ] ])
  expect(rowsOf(executeBatch(s, 'SELECT SERVERPROPERTY(\'ProductVersion\') AS v')).rows)
    .toEqual([ [ '15.0.2000.5' ] ])
})

test('use and session options', () => {
  const s = open()
  executeBatch(s, 'SET NOCOUNT ON')
  expect(s.options.get('nocount')).toBe('on')
  executeBatch(s, 'USE tempdb')
  expect(s.database).toBe('tempdb')
})

test('NOCOUNT captures count visibility per statement without changing @@ROWCOUNT', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE nocount_values (id INT)')
  const items = executeBatch(s, `
    INSERT INTO nocount_values VALUES (1)
    SET NOCOUNT ON
    INSERT INTO nocount_values VALUES (2), (3)
    SELECT @@ROWCOUNT AS affected
    SET NOCOUNT OFF
    INSERT INTO nocount_values VALUES (4)
  `)
  expect(items.map(item => item.kind === 'rows' ? {
    kind: item.kind, rows: item.rows, countValid: item.countValid
  } : item)).toEqual([
    { kind: 'count', rowCount: 1 },
    { kind: 'count', rowCount: 2, countValid: false },
    { kind: 'rows', rows: [ [ 2 ] ], countValid: false },
    { kind: 'count', rowCount: 1 }
  ])
})

test('NOCOUNT changes are scoped across procedures, dynamic SQL, and triggers', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE nocount_nested (id INT);
    CREATE TABLE nocount_audit (id INT);
  `)
  executeBatch(s, `
    CREATE PROCEDURE dbo.nocount_insert AS
      SET NOCOUNT ON
      INSERT INTO nocount_nested VALUES (1)
  `)
  const procedure = executeBatch(s, 'EXEC dbo.nocount_insert; INSERT INTO nocount_nested VALUES (2)')
  expect(procedure).toEqual([
    { kind: 'count', rowCount: 1, countValid: false },
    { kind: 'count', rowCount: 1 }
  ])
  expect(s.options.get('nocount')).toBeUndefined()

  const dynamic = executeBatch(s, `
    EXEC sp_executesql N'SET NOCOUNT ON; INSERT INTO nocount_nested VALUES (3)'
    INSERT INTO nocount_nested VALUES (4)
  `)
  expect(dynamic).toEqual([
    { kind: 'count', rowCount: 1, countValid: false },
    { kind: 'count', rowCount: 1 }
  ])

  executeBatch(s, `
    CREATE TRIGGER dbo.nocount_trigger ON nocount_nested AFTER INSERT AS
      SET NOCOUNT ON
      INSERT INTO nocount_audit SELECT id FROM inserted
  `)
  const trigger = executeBatch(s, 'INSERT INTO nocount_nested VALUES (5), (6)')
  expect(trigger).toEqual([
    { kind: 'count', rowCount: 2, countValid: false },
    { kind: 'count', rowCount: 2 }
  ])
  expect(s.options.get('nocount')).toBeUndefined()
})

test('throw raises mssql error', () => {
  const s = open()
  expect(() => executeBatch(s, 'THROW 51000, \'custom\', 2')).toThrowError(
    expect.objectContaining({ number: 51000, message: 'custom', state: 2 }) as Error
  )
})

test('zero-row insert into identity table leaves @@IDENTITY unchanged', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE ident (id INT IDENTITY(1,1) PRIMARY KEY, v INT)')
  executeBatch(s, 'CREATE TABLE plain (x INT)')
  executeBatch(s, 'INSERT INTO ident (v) VALUES (7), (8), (9)')
  executeBatch(s, 'INSERT INTO plain VALUES (100), (200)')
  // Zero-row insert into the identity table must not adopt plain's rowid.
  executeBatch(s, 'INSERT INTO ident (v) SELECT x FROM plain WHERE x > 1000')
  expect(rowsOf(executeBatch(s, 'SELECT @@IDENTITY AS i, SCOPE_IDENTITY() AS s')).rows)
    .toEqual([ [ 3, 3 ] ])
})

test('select assignment of one column to two variables', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (x INT, y INT)')
  executeBatch(s, 'INSERT INTO t VALUES (10, 20)')
  const rows = rowsOf(executeBatch(s, 'DECLARE @c INT, @d INT SELECT @c = x, @d = x FROM t SELECT @c AS c, @d AS d')).rows
  expect(rows).toEqual([ [ 10, 10 ] ])
})

test('datepart weekday is correct for pre-epoch dates', () => {
  const s = open()
  // 1900-01-01 was a Monday → 2 with the default DATEFIRST 7.
  expect(rowsOf(executeBatch(s, 'SELECT DATEPART(weekday, \'1900-01-01\') AS w, DATENAME(weekday, \'1900-01-01\') AS n')).rows)
    .toEqual([ [ 2, 'Monday' ] ])
})

test('exec sp_executesql binds positional params and returns OUTPUT', () => {
  const s = open()
  // Positional arg binds to the declared name @x, not @p1.
  expect(rowsOf(executeBatch(s, 'EXEC sp_executesql N\'SELECT @x AS v\', N\'@x int\', 42')).rows)
    .toEqual([ [ 42 ] ])
  // OUTPUT flows back to the caller's variable.
  const rows = rowsOf(executeBatch(s, `
    DECLARE @out INT
    EXEC sp_executesql N'SET @v = 42', N'@v int OUTPUT', @v = @out OUTPUT
    SELECT @out AS o
  `)).rows
  expect(rows).toEqual([ [ 42 ] ])
})

test('save transaction with no active transaction stays consistent', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (v INT)')
  // SAVE TRAN with no BEGIN must open and track a transaction, not desync.
  executeBatch(s, 'SAVE TRANSACTION sp INSERT INTO t VALUES (1) COMMIT')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 1 ] ])
  // A following BEGIN TRAN must not throw "transaction within a transaction".
  executeBatch(s, 'BEGIN TRAN INSERT INTO t VALUES (2) COMMIT')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 2 ] ])
})

test('try/catch catches a thrown error and exposes ERROR_* in catch scope', () => {
  const s = open()
  const items = executeBatch(s, `
    BEGIN TRY
      THROW 51000, 'boom', 2
    END TRY
    BEGIN CATCH
      SELECT ERROR_NUMBER() AS n, ERROR_MESSAGE() AS m, ERROR_SEVERITY() AS sev, ERROR_STATE() AS st
    END CATCH
  `)
  expect(rowsOf(items).rows).toEqual([ [ 51000, 'boom', 16, 2 ] ])
  // Outside a CATCH block the error functions return NULL.
  expect(rowsOf(executeBatch(s, 'SELECT ERROR_NUMBER() AS n')).rows).toEqual([ [ null ] ])
})

test('try/catch catches constraint violations and continues the batch', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (email VARCHAR(50) UNIQUE); INSERT INTO t VALUES (\'a\')')
  const items = executeBatch(s, `
    DECLARE @n INT = 0
    BEGIN TRY
      INSERT INTO t VALUES ('a')
      SET @n = 99
    END TRY
    BEGIN CATCH
      SET @n = ERROR_NUMBER()
    END CATCH
    SELECT @n AS n
  `)
  expect(rowsOf(items).rows).toEqual([ [ 2627 ] ])
})

test('bare throw rethrows inside catch and errors outside', () => {
  const s = open()
  expect(() => executeBatch(s, `
    BEGIN TRY
      THROW 51000, 'boom', 2
    END TRY
    BEGIN CATCH
      THROW
    END CATCH
  `)).toThrowError(expect.objectContaining({ number: 51000, message: 'boom', state: 2 }) as Error)
  expect(() => executeBatch(s, 'THROW')).toThrowError(
    expect.objectContaining({ number: 10704 }) as Error
  )
})

test('raiserror formats, prints low severities and throws high ones', () => {
  const s = open()
  const items = executeBatch(s, 'RAISERROR (\'at %d of %s\', 10, 1, 5, \'load\') WITH NOWAIT')
  expect(items).toEqual([ { kind: 'message', text: 'at 5 of load' } ])
  expect(() => executeBatch(s, 'RAISERROR (\'fail %s\', 16, 2, \'hard\')')).toThrowError(
    expect.objectContaining({ number: 50000, severity: 16, state: 2, message: 'fail hard' }) as Error
  )
  // Caught by TRY/CATCH like any error.
  const caught = executeBatch(s, `
    BEGIN TRY
      RAISERROR ('caught', 16, 1)
    END TRY
    BEGIN CATCH
      SELECT ERROR_MESSAGE() AS m
    END CATCH
  `)
  expect(rowsOf(caught).rows).toEqual([ [ 'caught' ] ])
})

test('xact_state reflects doomed transactions under xact_abort', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (email VARCHAR(50) UNIQUE); INSERT INTO t VALUES (\'a\')')
  expect(rowsOf(executeBatch(s, 'SELECT XACT_STATE() AS x')).rows).toEqual([ [ 0 ] ])
  const items = executeBatch(s, `
    SET XACT_ABORT ON
    BEGIN TRANSACTION
    BEGIN TRY
      INSERT INTO t VALUES ('a')
    END TRY
    BEGIN CATCH
      SELECT XACT_STATE() AS x
    END CATCH
  `)
  expect(rowsOf(items).rows).toEqual([ [ -1 ] ])
  expect(() => executeBatch(s, 'COMMIT')).toThrowError(
    expect.objectContaining({ number: 3930 }) as Error
  )
  executeBatch(s, 'ROLLBACK')
  expect(rowsOf(executeBatch(s, 'SELECT XACT_STATE() AS x')).rows).toEqual([ [ 0 ] ])
})

test('stored procedures: defaults, named args, output and return status', () => {
  const s = open()
  executeBatch(s, `
    CREATE PROCEDURE dbo.add_numbers @a INT, @b INT = 10, @sum INT OUTPUT AS
    BEGIN
      SET @sum = @a + @b
      RETURN 7
    END
  `)
  const items = executeBatch(s, `
    DECLARE @result INT, @rc INT
    EXEC @rc = add_numbers @a = 5, @sum = @result OUTPUT
    SELECT @result AS total, @rc AS rc
  `)
  expect(rowsOf(items).rows).toEqual([ [ 15, 7 ] ])
  // Positional arguments and result sets from the body.
  executeBatch(s, 'CREATE PROCEDURE dbo.double_it @n INT AS SELECT @n * 2 AS d')
  expect(rowsOf(executeBatch(s, 'EXEC double_it 21')).rows).toEqual([ [ 42 ] ])
  // Missing required parameter.
  expect(() => executeBatch(s, 'EXEC add_numbers')).toThrowError(
    expect.objectContaining({ number: 201 }) as Error
  )
})

test('procedure scope is isolated from the caller', () => {
  const s = open()
  executeBatch(s, 'CREATE PROCEDURE dbo.leaky AS SELECT @x AS x')
  expect(() => executeBatch(s, 'DECLARE @x INT = 1 EXEC leaky')).toThrowError(
    expect.objectContaining({ number: 137 }) as Error
  )
  // Caller variables survive the call unchanged.
  executeBatch(s, 'CREATE PROCEDURE dbo.shadow @x INT AS SET @x = 99')
  const items = executeBatch(s, 'DECLARE @x INT = 1 EXEC shadow @x SELECT @x AS x')
  expect(rowsOf(items).rows).toEqual([ [ 1 ] ])
})

test('nested procedures report @@NESTLEVEL', () => {
  const s = open()
  executeBatch(s, 'CREATE PROCEDURE dbo.inner_level AS SELECT @@NESTLEVEL AS level')
  executeBatch(s, 'CREATE PROCEDURE dbo.outer_level AS EXEC inner_level')
  expect(rowsOf(executeBatch(s, 'EXEC outer_level')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT @@NESTLEVEL AS level')).rows).toEqual([ [ 0 ] ])
})

test('procedures register in the catalog and drop cleanly', () => {
  const s = open()
  executeBatch(s, 'CREATE PROCEDURE dbo.listed AS SELECT 1 AS one')
  expect(rowsOf(executeBatch(s, 'SELECT name FROM sys.procedures')).rows).toEqual([ [ 'listed' ] ])
  const definition = rowsOf(executeBatch(s, 'SELECT OBJECT_DEFINITION(OBJECT_ID(\'listed\')) AS d'))
  expect(String(definition.rows[0]?.[0])).toContain('CREATE PROCEDURE')
  // CREATE over an existing name fails; CREATE OR ALTER replaces.
  expect(() => executeBatch(s, 'CREATE PROCEDURE dbo.listed AS SELECT 2 AS two')).toThrowError(
    expect.objectContaining({ number: 2714 }) as Error
  )
  executeBatch(s, 'CREATE OR ALTER PROCEDURE dbo.listed AS SELECT 2 AS two')
  expect(rowsOf(executeBatch(s, 'EXEC listed')).rows).toEqual([ [ 2 ] ])
  executeBatch(s, 'DROP PROCEDURE listed')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM sys.procedures')).rows).toEqual([ [ 0 ] ])
  expect(() => executeBatch(s, 'EXEC listed')).toThrowError(
    expect.objectContaining({ number: 2812 }) as Error
  )
  expect(() => executeBatch(s, 'DROP PROCEDURE listed')).toThrowError(
    expect.objectContaining({ number: 3701 }) as Error
  )
  executeBatch(s, 'DROP PROCEDURE IF EXISTS listed')
})

test('procedures reload from sys.sql_modules on server restart', () => {
  const path = join(tmpdir(), `mssqlite-procs-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, 'CREATE PROCEDURE dbo.hello AS SELECT 42 AS answer')
    const second = session(server({ path }))
    expect(rowsOf(executeBatch(second, 'EXEC hello')).rows).toEqual([ [ 42 ] ])
  } finally {
    rmSync(path, { force: true })
  }
})

test('scalar functions persist, alter, recurse and isolate local scope', () => {
  const s = open()
  executeBatch(s, `
    CREATE FUNCTION dbo.factorial(@n INT, @scale INT = 1)
    RETURNS INT AS
    BEGIN
      IF @n <= 1 RETURN @scale
      RETURN @n * dbo.factorial(@n - 1, @scale)
    END
  `)
  expect(rowsOf(executeBatch(s, 'SELECT dbo.factorial(5) AS value')).rows)
    .toEqual([ [ 120 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT dbo.factorial(3, DEFAULT) AS value')).rows)
    .toEqual([ [ 6 ] ])
  expect(rowsOf(executeBatch(s, `
    SELECT o.type, OBJECT_DEFINITION(o.object_id) AS definition
    FROM sys.objects o WHERE o.name = 'factorial'
  `)).rows).toEqual([ [ 'FN', expect.stringContaining('CREATE FUNCTION') ] ])

  executeBatch(s, `
    ALTER FUNCTION dbo.factorial(@n INT, @scale INT = 2)
    RETURNS INT AS BEGIN RETURN @n * @scale END
  `)
  expect(rowsOf(executeBatch(s, 'SELECT dbo.factorial(4) AS value')).rows)
    .toEqual([ [ 8 ] ])
  executeBatch(s, 'DROP FUNCTION dbo.factorial')
  expect(rowsOf(executeBatch(s, `
    SELECT COUNT(*) AS n FROM sys.objects WHERE name = 'factorial'
  `)).rows).toEqual([ [ 0 ] ])
  expect(() => executeBatch(s, 'DROP FUNCTION dbo.factorial')).toThrowError(
    expect.objectContaining({ number: 3701 }) as Error
  )
})

test('inline table functions substitute parameters as derived sources', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE function_orders (id INT, customer_id INT, amount INT);
    INSERT INTO function_orders VALUES (1, 1, 10), (2, 1, 20), (3, 2, 30);
  `)
  executeBatch(s, `
    CREATE FUNCTION dbo.orders_for(@customer INT)
    RETURNS TABLE AS RETURN (
      SELECT id, amount FROM function_orders WHERE customer_id = @customer
    )
  `)
  const result = rowsOf(executeBatch(s, `
    SELECT f.order_id, f.total
    FROM dbo.orders_for(1) AS f (order_id, total)
    ORDER BY f.order_id
  `))
  expect(result.rows).toEqual([ [ 1, 10 ], [ 2, 20 ] ])
  executeBatch(s, `
    CREATE TABLE function_customers (id INT);
    INSERT INTO function_customers VALUES (1), (2), (3);
  `)
  expect(rowsOf(executeBatch(s, `
    SELECT c.id, f.id AS order_id, f.amount
    FROM function_customers c OUTER APPLY dbo.orders_for(c.id) f
    ORDER BY c.id, order_id
  `)).rows).toEqual([
    [ 1, 1, 10 ], [ 1, 2, 20 ], [ 2, 3, 30 ], [ 3, null, null ]
  ])
  expect(rowsOf(executeBatch(s, `
    SELECT type FROM sys.objects WHERE name = 'orders_for'
  `)).rows).toEqual([ [ 'IF' ] ])
})

test('user functions reload from sys.sql_modules on server restart', () => {
  const path = join(tmpdir(), `mssqlite-functions-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, `
      CREATE TABLE persisted_values (id INT, value INT);
      INSERT INTO persisted_values VALUES (1, 10), (2, 20);
    `)
    executeBatch(first, `
      CREATE FUNCTION dbo.persisted_double(@value INT)
      RETURNS INT AS BEGIN RETURN @value * 2 END
    `)
    executeBatch(first, `
      CREATE FUNCTION dbo.persisted_rows(@minimum INT)
      RETURNS TABLE AS RETURN (
        SELECT id, value FROM persisted_values WHERE value >= @minimum
      )
    `)
    const second = session(server({ path }))
    expect(rowsOf(executeBatch(second, 'SELECT dbo.persisted_double(4) AS value')).rows)
      .toEqual([ [ 8 ] ])
    expect(rowsOf(executeBatch(second, `
      SELECT id FROM dbo.persisted_rows(15) AS rows ORDER BY id
    `)).rows).toEqual([ [ 2 ] ])
  } finally {
    rmSync(path, { force: true })
  }
})

test('scalar functions reject side-effecting bodies', () => {
  const s = open()
  expect(() => executeBatch(s, `
    CREATE FUNCTION dbo.bad_function(@value INT)
    RETURNS INT AS BEGIN
      INSERT INTO missing VALUES (@value)
      RETURN @value
    END
  `)).toThrowError(expect.objectContaining({ number: 443 }) as Error)
})

test('insert output returns rows, advances identity and @@ROWCOUNT', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50) NOT NULL)')
  const items = executeBatch(s, `
    INSERT INTO t (name) OUTPUT inserted.id, inserted.name VALUES (N'a'), (N'b');
    SELECT @@ROWCOUNT AS rc, @@IDENTITY AS id
  `)
  const [ output, globals ] = items.filter((item): item is Rows => item.kind === 'rows')
  expect(output?.columns.map(column => column.name)).toEqual([ 'id', 'name' ])
  expect(output?.rows).toEqual([ [ 1, 'a' ], [ 2, 'b' ] ])
  expect(output?.rowCount).toBe(2)
  expect(globals?.rows).toEqual([ [ 2, 2 ] ])
})

test('update output joins deleted and inserted values', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE p (id INT PRIMARY KEY, price INT);
    INSERT INTO p VALUES (1, 10), (2, 20), (3, 30)
  `)
  const items = executeBatch(s, `
    DECLARE @limit INT = 3;
    UPDATE p SET price = price * 2
    OUTPUT deleted.id, deleted.price AS old_price, inserted.price AS new_price
    WHERE id < @limit;
    SELECT @@ROWCOUNT AS rc
  `)
  const [ output, globals ] = items.filter((item): item is Rows => item.kind === 'rows')
  expect(output?.columns.map(column => column.name)).toEqual([ 'id', 'old_price', 'new_price' ])
  expect(output?.rows).toEqual([ [ 1, 10, 20 ], [ 2, 20, 40 ] ])
  expect(globals?.rows).toEqual([ [ 2 ] ])
  // The snapshot temp table is cleaned up.
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM p')).rows).toEqual([ [ 3 ] ])
  expect(() => executeBatch(s, 'SELECT * FROM __mssqlite_output')).toThrow()
  // deleted.* expands to the target's columns; zero-row updates return empty sets.
  const star = rowsOf(executeBatch(s, 'UPDATE p SET price = 0 OUTPUT deleted.* WHERE id = 3'))
  expect(star.columns.map(column => column.name)).toEqual([ 'id', 'price' ])
  expect(star.rows).toEqual([ [ 3, 30 ] ])
  const empty = rowsOf(executeBatch(s, 'UPDATE p SET price = 1 OUTPUT deleted.price WHERE id = 99'))
  expect(empty.rows).toEqual([])
})

test('delete output returns the removed rows', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE t (id INT PRIMARY KEY, name NVARCHAR(50));
    INSERT INTO t VALUES (1, N'a'), (2, N'b'), (3, N'c')
  `)
  const result = rowsOf(executeBatch(s, 'DELETE FROM t OUTPUT deleted.* WHERE id <= 2'))
  expect(result.columns.map(column => column.name)).toEqual([ 'id', 'name' ])
  expect(result.rows).toEqual([ [ 1, 'a' ], [ 2, 'b' ] ])
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 1 ] ])
})

test('output into routes rows into a table instead of the client', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50));
    CREATE TABLE audit (id INT, name NVARCHAR(50))
  `)
  const items = executeBatch(s,
    'INSERT INTO t (name) OUTPUT inserted.id, inserted.name INTO audit (id, name) VALUES (N\'a\'), (N\'b\')')
  expect(items).toEqual([ { kind: 'count', rowCount: 2 } ])
  expect(rowsOf(executeBatch(s, 'SELECT id, name FROM audit ORDER BY id')).rows)
    .toEqual([ [ 1, 'a' ], [ 2, 'b' ] ])
  // UPDATE OUTPUT deleted ... INTO exercises the snapshot path with routing.
  executeBatch(s, 'UPDATE t SET name = N\'z\' OUTPUT deleted.id, deleted.name INTO audit WHERE id = 1')
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM audit')).rows).toEqual([ [ 3 ] ])
})

test('merge upserts from a table source', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE inventory (id INT PRIMARY KEY, qty INT, name NVARCHAR(50));
    CREATE TABLE staging (id INT, qty INT, name NVARCHAR(50));
    INSERT INTO inventory VALUES (1, 10, N'apple'), (2, 5, N'pear');
    INSERT INTO staging VALUES (1, 42, N'apple'), (3, 7, N'plum');
  `)
  const items = executeBatch(s, `
    MERGE inventory AS t
    USING staging AS s
    ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET t.qty = s.qty
    WHEN NOT MATCHED BY TARGET THEN INSERT (id, qty, name) VALUES (s.id, s.qty, s.name);
  `)
  expect(items).toEqual([ { kind: 'count', rowCount: 2 } ])
  expect(rowsOf(executeBatch(s, 'SELECT @@ROWCOUNT AS rc')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT id, qty, name FROM inventory ORDER BY id')).rows).toEqual([
    [ 1, 42, 'apple' ],
    [ 2, 5, 'pear' ],
    [ 3, 7, 'plum' ]
  ])
})

test('merge with values source, arm conditions and by source delete', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE prices (sku NVARCHAR(20) PRIMARY KEY, price INT);
    INSERT INTO prices VALUES (N'a', 100), (N'b', 200), (N'c', 300);
  `)
  const items = executeBatch(s, `
    MERGE prices WITH (HOLDLOCK) AS t
    USING (VALUES (N'a', 110), (N'b', 0), (N'd', 400)) AS s (sku, price)
    ON t.sku = s.sku
    WHEN MATCHED AND s.price = 0 THEN DELETE
    WHEN MATCHED THEN UPDATE SET price = s.price
    WHEN NOT MATCHED THEN INSERT (sku, price) VALUES (s.sku, s.price)
    WHEN NOT MATCHED BY SOURCE THEN DELETE;
  `)
  // a updated, b deleted, d inserted, c deleted by source.
  expect(items).toEqual([ { kind: 'count', rowCount: 4 } ])
  expect(rowsOf(executeBatch(s, 'SELECT sku, price FROM prices ORDER BY sku')).rows).toEqual([
    [ 'a', 110 ],
    [ 'd', 400 ]
  ])
})

test('merge by source update sees only unmatched target rows', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE flags (id INT PRIMARY KEY, active INT);
    INSERT INTO flags VALUES (1, 1), (2, 1), (3, 0);
  `)
  executeBatch(s, `
    MERGE flags AS t
    USING (SELECT 1 AS id) AS s
    ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET active = active + 10
    WHEN NOT MATCHED BY SOURCE AND t.active = 1 THEN UPDATE SET t.active = 0;
  `)
  expect(rowsOf(executeBatch(s, 'SELECT id, active FROM flags ORDER BY id')).rows).toEqual([
    [ 1, 11 ],
    [ 2, 0 ],
    [ 3, 0 ]
  ])
})

test('merge evaluates against the pre-merge state', () => {
  const s = open()
  // The inserted row must not become visible to the UPDATE arm's snapshot.
  executeBatch(s, `
    CREATE TABLE t (id INT PRIMARY KEY, v INT);
    INSERT INTO t VALUES (1, 1);
    MERGE t USING (SELECT 1 AS a UNION ALL SELECT 2) AS s
    ON t.id = s.a
    WHEN MATCHED THEN UPDATE SET v = (SELECT COUNT(*) FROM t)
    WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.a, 99);
  `)
  expect(rowsOf(executeBatch(s, 'SELECT id, v FROM t ORDER BY id')).rows).toEqual([
    [ 1, 1 ],
    [ 2, 99 ]
  ])
})

test('merge with variables, derived rename and identity', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50), age INT);
    INSERT INTO users (name, age) VALUES (N'Alice', 30);
  `)
  executeBatch(s, `
    DECLARE @bump INT = 5
    MERGE users AS t
    USING (SELECT N'Alice' AS x, 31 AS y UNION ALL SELECT N'Bob', 22) AS s (source_name, source_age)
    ON t.name = s.source_name
    WHEN MATCHED THEN UPDATE SET age = s.source_age + @bump
    WHEN NOT MATCHED THEN INSERT (name, age) VALUES (s.source_name, s.source_age);
  `)
  expect(rowsOf(executeBatch(s, 'SELECT name, age FROM users ORDER BY id')).rows).toEqual([
    [ 'Alice', 36 ],
    [ 'Bob', 22 ]
  ])
  expect(rowsOf(executeBatch(s, 'SELECT @@IDENTITY AS i')).rows).toEqual([ [ 2 ] ])
})

test('merge rejects multiple source matches for one target row', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE t (id INT PRIMARY KEY, v INT);
    CREATE TABLE s2 (id INT, v INT);
    INSERT INTO t VALUES (1, 0);
    INSERT INTO s2 VALUES (1, 10), (1, 20);
  `)
  expect(() => executeBatch(s, `
    MERGE t USING s2 ON t.id = s2.id
    WHEN MATCHED THEN UPDATE SET v = s2.v;
  `)).toThrowError(expect.objectContaining({ number: 8672 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT v FROM t')).rows).toEqual([ [ 0 ] ])
})

test('merge is atomic when a later arm fails', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL);
    INSERT INTO t VALUES (1, 1);
  `)
  // The UPDATE arm applies before the INSERT arm fails on the NULL value —
  // the whole MERGE must roll back.
  expect(() => executeBatch(s, `
    MERGE t USING (VALUES (1, 5), (2, NULL)) AS s (id, v)
    ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET v = s.v
    WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v);
  `)).toThrowError(expect.objectContaining({ number: 515 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT id, v FROM t')).rows).toEqual([ [ 1, 1 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT @@TRANCOUNT AS tc')).rows).toEqual([ [ 0 ] ])
})

test('merge validates arms', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT PRIMARY KEY); CREATE TABLE src (id INT)')
  expect(() => executeBatch(s, `
    MERGE t USING src ON t.id = src.id
    WHEN MATCHED THEN DELETE
    WHEN MATCHED AND t.id > 1 THEN DELETE;
  `)).toThrowError(expect.objectContaining({ number: 10714 }) as Error)
  expect(() => executeBatch(s, `
    MERGE t USING src ON t.id = src.id
    WHEN NOT MATCHED THEN INSERT (id) VALUES (src.id, 1);
  `)).toThrowError(expect.objectContaining({ number: 110 }) as Error)
})

test('merge output returns $action with inserted and deleted images', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE prices (sku NVARCHAR(20) PRIMARY KEY, price INT);
    INSERT INTO prices VALUES (N'a', 100), (N'b', 200);
  `)
  const result = rowsOf(executeBatch(s, `
    MERGE prices AS t
    USING (VALUES (N'a', 110), (N'd', 400)) AS s (sku, price)
    ON t.sku = s.sku
    WHEN MATCHED THEN UPDATE SET price = s.price
    WHEN NOT MATCHED THEN INSERT (sku, price) VALUES (s.sku, s.price)
    WHEN NOT MATCHED BY SOURCE THEN DELETE
    OUTPUT $action, deleted.sku AS old_sku, deleted.price AS old_price,
      inserted.sku AS new_sku, inserted.price AS new_price;
  `))
  expect(result.columns.map(column => column.name))
    .toEqual([ '$action', 'old_sku', 'old_price', 'new_sku', 'new_price' ])
  const sorted = [ ...result.rows ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  expect(sorted).toEqual([
    [ 'DELETE', 'b', 200, null, null ],
    [ 'INSERT', null, null, 'd', 400 ],
    [ 'UPDATE', 'a', 100, 'a', 110 ]
  ])
  expect(rowsOf(executeBatch(s, 'SELECT @@ROWCOUNT AS rc')).rows).toEqual([ [ 3 ] ])
})

test('merge output expands stars and sees identity values', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50));
    INSERT INTO users (name) VALUES (N'a');
  `)
  const result = rowsOf(executeBatch(s, `
    MERGE users AS t
    USING (VALUES (N'a'), (N'b')) AS s (name)
    ON t.name = s.name
    WHEN MATCHED THEN UPDATE SET name = s.name + N'!'
    WHEN NOT MATCHED THEN INSERT (name) VALUES (s.name)
    OUTPUT inserted.*;
  `))
  expect(result.columns.map(column => column.name)).toEqual([ 'id', 'name' ])
  expect([ ...result.rows ].sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
    [ 1, 'a!' ],
    [ 2, 'b' ]
  ])
  expect(rowsOf(executeBatch(s, 'SELECT @@IDENTITY AS i')).rows).toEqual([ [ 2 ] ])
})

test('merge output with insert default values captures each row', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE d (id INT IDENTITY(1,1) PRIMARY KEY, tag NVARCHAR(10) DEFAULT N'x');
  `)
  const result = rowsOf(executeBatch(s, `
    MERGE d AS t
    USING (VALUES (1), (2)) AS s (n)
    ON t.id = s.n
    WHEN NOT MATCHED THEN INSERT DEFAULT VALUES
    OUTPUT $action AS act, inserted.id, inserted.tag;
  `))
  expect([ ...result.rows ].sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
    [ 'INSERT', 1, 'x' ],
    [ 'INSERT', 2, 'x' ]
  ])
})

test('merge output into routes rows and stays atomic', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE stock (sku NVARCHAR(20) PRIMARY KEY, qty INT);
    CREATE TABLE audit (act NVARCHAR(10), sku NVARCHAR(20), qty INT);
    INSERT INTO stock VALUES (N'a', 1);
  `)
  const items = executeBatch(s, `
    MERGE stock AS t
    USING (VALUES (N'a', 2), (N'b', 3)) AS s (sku, qty)
    ON t.sku = s.sku
    WHEN MATCHED THEN UPDATE SET qty = s.qty
    WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.sku, s.qty)
    OUTPUT $action, inserted.sku, inserted.qty INTO audit (act, sku, qty);
  `)
  expect(items).toEqual([ { kind: 'count', rowCount: 2 } ])
  expect(rowsOf(executeBatch(s, 'SELECT act, sku, qty FROM audit ORDER BY sku')).rows).toEqual([
    [ 'UPDATE', 'a', 2 ],
    [ 'INSERT', 'b', 3 ]
  ])
  // A failing INTO write rolls the whole merge back.
  executeBatch(s, 'CREATE TABLE strict_audit (sku NVARCHAR(20) NOT NULL)')
  expect(() => executeBatch(s, `
    MERGE stock AS t
    USING (VALUES (N'c', NULL)) AS s (sku, qty)
    ON t.sku = s.sku
    WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.sku, s.qty)
    OUTPUT inserted.qty INTO strict_audit (sku);
  `)).toThrowError(expect.objectContaining({ number: 515 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM stock')).rows).toEqual([ [ 2 ] ])
  expect(rowsOf(executeBatch(s, 'SELECT @@TRANCOUNT AS tc')).rows).toEqual([ [ 0 ] ])
})

test('merge output rejects source columns and $action outside merge', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT PRIMARY KEY); INSERT INTO t VALUES (0)')
  expect(() => executeBatch(s, `
    MERGE t USING (VALUES (1)) AS s (id) ON t.id = s.id
    WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)
    OUTPUT s.id;
  `)).toThrowError(expect.objectContaining({ number: 40000 }) as Error)
  expect(() => executeBatch(s, 'INSERT INTO t OUTPUT $action, inserted.id VALUES (2)'))
    .toThrowError(expect.objectContaining({ number: 40000 }) as Error)
  // Failed merges leave no partial rows behind.
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 1 ] ])
})

test('merge inside an explicit transaction respects rollback', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE t (id INT PRIMARY KEY, v INT);
    INSERT INTO t VALUES (1, 1);
  `)
  executeBatch(s, `
    BEGIN TRAN
    MERGE t USING (VALUES (1, 100)) AS s (id, v) ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET v = s.v;
    ROLLBACK
  `)
  expect(rowsOf(executeBatch(s, 'SELECT v FROM t')).rows).toEqual([ [ 1 ] ])
})

test('AFTER triggers expose statement-level inserted and deleted rowsets', () => {
  const s = open()
  executeBatch(s, `
    CREATE TABLE orders (id INT PRIMARY KEY, amount INT);
    CREATE TABLE audit (event NVARCHAR(10), id INT, old_amount INT, new_amount INT);
  `)
  executeBatch(s, `
    CREATE TRIGGER dbo.orders_insert ON dbo.orders AFTER INSERT AS
      INSERT INTO audit (event, id, new_amount)
      SELECT N'insert', id, amount FROM inserted
  `)
  expect(executeBatch(s, 'INSERT INTO orders VALUES (1, 10), (2, 20)')).toEqual([
    { kind: 'count', rowCount: 2 },
    { kind: 'count', rowCount: 2 }
  ])
  executeBatch(s, `
    CREATE TRIGGER dbo.orders_update ON dbo.orders AFTER UPDATE AS
      INSERT INTO audit (event, id, old_amount, new_amount)
      SELECT N'update', deleted.id, deleted.amount, inserted.amount
      FROM deleted JOIN inserted ON deleted.id = inserted.id
  `)
  executeBatch(s, 'UPDATE orders SET amount = amount + 5')
  executeBatch(s, `
    CREATE TRIGGER dbo.orders_delete ON dbo.orders AFTER DELETE AS
      INSERT INTO audit (event, id, old_amount)
      SELECT N'delete', id, amount FROM deleted
  `)
  executeBatch(s, 'DELETE FROM orders WHERE id = 2')
  expect(rowsOf(executeBatch(s, `
    SELECT event, id, old_amount, new_amount FROM audit ORDER BY rowid
  `)).rows).toEqual([
    [ 'insert', 1, null, 10 ],
    [ 'insert', 2, null, 20 ],
    [ 'update', 1, 10, 15 ],
    [ 'update', 2, 20, 25 ],
    [ 'delete', 2, 25, null ]
  ])
})

test('INSTEAD OF triggers replace DML', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE guarded (id INT PRIMARY KEY, value INT)')
  executeBatch(s, `
    CREATE TRIGGER dbo.guard_insert ON guarded INSTEAD OF INSERT AS
      INSERT INTO guarded (id, value) SELECT id, value * 2 FROM inserted
  `)
  executeBatch(s, 'INSERT INTO guarded VALUES (1, 5), (2, 7)')
  expect(rowsOf(executeBatch(s, 'SELECT * FROM guarded ORDER BY id')).rows).toEqual([
    [ 1, 10 ], [ 2, 14 ]
  ])
})

test('trigger transition tables are read-only and a trigger fires for zero affected rows', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE t (id INT PRIMARY KEY); CREATE TABLE fired (n INT)')
  executeBatch(s, `
    CREATE TRIGGER dbo.zero_delete ON t AFTER DELETE AS
      INSERT INTO fired SELECT COUNT(*) FROM deleted
  `)
  expect(executeBatch(s, 'DELETE FROM t WHERE id = 99')).toEqual([
    { kind: 'count', rowCount: 1 },
    { kind: 'count', rowCount: 0 }
  ])
  expect(rowsOf(executeBatch(s, 'SELECT n FROM fired')).rows).toEqual([ [ 0 ] ])
  executeBatch(s, `
    CREATE TRIGGER dbo.readonly_inserted ON t AFTER INSERT AS
      UPDATE inserted SET id = id + 1
  `)
  expect(() => executeBatch(s, 'INSERT INTO t VALUES (1)'))
    .toThrowError(expect.objectContaining({ number: 286 }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM t')).rows).toEqual([ [ 0 ] ])
})

test('trigger errors roll back the originating statement', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE protected (id INT PRIMARY KEY)')
  executeBatch(s, `
    CREATE TRIGGER dbo.reject_insert ON protected AFTER INSERT AS
      RAISERROR (N'rejected', 16, 1)
  `)
  expect(() => executeBatch(s, 'INSERT INTO protected VALUES (1), (2)'))
    .toThrowError(expect.objectContaining({ message: 'rejected' }) as Error)
  expect(rowsOf(executeBatch(s, 'SELECT COUNT(*) AS n FROM protected')).rows).toEqual([ [ 0 ] ])
})

test('an unhandled trigger error rolls back the enclosing transaction', () => {
  const s = open()
  executeBatch(s, 'CREATE TABLE before_trigger (id INT); CREATE TABLE rejected (id INT)')
  executeBatch(s, `
    CREATE TRIGGER dbo.reject_transaction ON rejected AFTER INSERT AS
      THROW 50001, N'trigger failed', 1
  `)
  executeBatch(s, 'BEGIN TRAN; INSERT INTO before_trigger VALUES (1)')
  expect(() => executeBatch(s, 'INSERT INTO rejected VALUES (1)'))
    .toThrowError(expect.objectContaining({ number: 50001 }) as Error)
  expect(rowsOf(executeBatch(s, `
    SELECT (SELECT COUNT(*) FROM before_trigger) AS n, @@TRANCOUNT AS tc
  `)).rows).toEqual([ [ 0, 0 ] ])
})

test('triggers alter, drop, persist, and register SQL_TRIGGER metadata', () => {
  const path = join(tmpdir(), `mssqlite-trigger-${process.pid}-${Date.now()}.db`)
  try {
    const first = session(server({ path }))
    executeBatch(first, 'CREATE TABLE source (id INT); CREATE TABLE log (id INT)')
    executeBatch(first, `
      CREATE TRIGGER dbo.persisted_trigger ON source AFTER INSERT AS
        INSERT INTO log SELECT id FROM inserted
    `)
    expect(rowsOf(executeBatch(first, `
      SELECT type, type_desc, parent_object_id FROM sys.objects
      WHERE name = N'persisted_trigger'
    `)).rows[0]).toEqual([ 'TR', 'SQL_TRIGGER', expect.any(Number) ])

    const second = session(server({ path }))
    executeBatch(second, 'INSERT INTO source VALUES (1)')
    expect(rowsOf(executeBatch(second, 'SELECT id FROM log')).rows).toEqual([ [ 1 ] ])
    executeBatch(second, `
      ALTER TRIGGER dbo.persisted_trigger ON source AFTER INSERT AS
        INSERT INTO log SELECT id + 10 FROM inserted
    `)
    executeBatch(second, 'INSERT INTO source VALUES (2)')
    executeBatch(second, 'DROP TRIGGER dbo.persisted_trigger')
    executeBatch(second, 'INSERT INTO source VALUES (3)')
    expect(rowsOf(executeBatch(second, 'SELECT id FROM log ORDER BY id')).rows).toEqual([
      [ 1 ], [ 12 ]
    ])
  } finally {
    rmSync(path, { force: true })
  }
})
