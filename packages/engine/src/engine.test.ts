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
