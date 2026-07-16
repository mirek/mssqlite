import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { DataType } from '@mssqlite/tds'
import { executeBatch, executeSql, MssqlError, server, session } from './index.ts'
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
  expect(result.columns[2]?.typeInfo.type).toBe(DataType.DataType.floatN)
  expect(result.rows).toEqual([ [ 1, 'x', 1.5, null ] ])
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
  const result = rowsOf(executeBatch(s, 'SELECT @@ROWCOUNT AS rc, @@IDENTITY AS id, @@TRANCOUNT AS tc, @@SPID AS spid'))
  expect(result.rows[0]?.[0]).toBe(3)
  expect(result.rows[0]?.[1]).toBe(3)
  expect(result.rows[0]?.[2]).toBe(0)
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
