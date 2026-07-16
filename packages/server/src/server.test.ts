import { afterAll, beforeAll, expect, test } from 'vitest'
import { Connection, Request, TYPES } from 'tedious'
import { listen, type Listening } from './server.ts'

let listening: Listening
let connection: Connection

type Row =
  Record<string, unknown>

type WireColumn = {
  readonly name: string,
  readonly type: string,
  readonly length: number | undefined
}

const connect =
  (port: number): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const connection_ = new Connection({
        server: '127.0.0.1',
        authentication: {
          type: 'default',
          options: { userName: 'sa', password: 'secret' }
        },
        options: {
          port,
          database: 'master',
          encrypt: false,
          trustServerCertificate: true,
          rowCollectionOnRequestCompletion: false,
          useColumnNames: true,
          connectTimeout: 5000,
          requestTimeout: 5000
        }
      })
      connection_.connect(error => {
        if (error) {
          reject(error)
        } else {
          resolve(connection_)
        }
      })
    })

const query =
  (sql: string, parameters: {
    name: string,
    type: (typeof TYPES)[keyof typeof TYPES],
    value: unknown,
    options?: { precision?: number, scale?: number }
  }[] = []): Promise<{
    rows: Row[], rowCount: number, columns: WireColumn[], doneCounts: (number | undefined)[]
  }> =>
    new Promise((resolve, reject) => {
      const rows: Row[] = []
      let columns: WireColumn[] = []
      const doneCounts: (number | undefined)[] = []
      const request = new Request(sql, (error, rowCount) => {
        if (error) {
          reject(error)
        } else {
          resolve({ rows, rowCount: rowCount ?? 0, columns, doneCounts })
        }
      })
      for (const parameter of parameters) {
        request.addParameter(parameter.name, parameter.type, parameter.value, parameter.options)
      }
      request.on('row', rowColumns => {
        const row: Row = {}
        for (const [ name, column ] of Object.entries(rowColumns as Record<string, { value: unknown }>)) {
          row[name] = column.value
        }
        rows.push(row)
      })
      request.on('columnMetadata', metadata => {
        columns = Object.values(metadata).map(column => ({
          name: column.colName,
          type: column.type.name,
          length: column.dataLength
        }))
      })
      request.on('done', rowCount => doneCounts.push(rowCount))
      request.on('doneInProc', rowCount => doneCounts.push(rowCount))
      connection.execSql(request)
    })

beforeAll(async () => {
  listening = await listen({ path: ':memory:', port: 0, databaseName: 'master' })
  connection = await connect(listening.port)
}, 20000)

afterAll(async () => {
  connection.close()
  await listening.close()
})

test('login handshake succeeded', () => {
  expect(connection.state.name).toBe('LoggedIn')
})

test('select constants', async () => {
  const result = await query('SELECT 1 AS n, N\'héllo\' AS s, 1.5 AS f, NULL AS z')
  expect(result.rows).toEqual([ { n: 1, s: 'héllo', f: 1.5, z: null } ])
  expect(result.rowCount).toBe(1)
})

test('create, insert, select round trip', async () => {
  await query(`
    CREATE TABLE dbo.users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(100) NOT NULL,
      age INT NULL,
      created DATETIME2 DEFAULT SYSDATETIME()
    )
  `)
  const insert = await query('INSERT INTO users (name, age) VALUES (N\'Alice\', 30), (N\'Bob\', NULL)')
  expect(insert.rowCount).toBe(2)
  const select = await query('SELECT id, name, age FROM users ORDER BY id')
  expect(select.rows).toEqual([
    { id: 1, name: 'Alice', age: 30 },
    { id: 2, name: 'Bob', age: null }
  ])
})

test('computed values and sys.computed_columns metadata cross tedious', async () => {
  await query(`
    CREATE TABLE wire_computed (
      quantity INT,
      price DECIMAL(10,2),
      total AS quantity * price PERSISTED
    )
    INSERT INTO wire_computed (quantity, price) VALUES (3, 1.25)
  `)
  const values = await query('SELECT quantity, price, total FROM wire_computed')
  expect(values.rows).toEqual([ { quantity: 3, price: 1.25, total: 3.75 } ])
  expect(values.columns.map(column => column.type)).toEqual([ 'IntN', 'DecimalN', 'DecimalN' ])
  const catalog = await query(`
    SELECT name, is_computed, definition, is_persisted
    FROM sys.computed_columns WHERE object_id = OBJECT_ID(N'wire_computed')
  `)
  expect(catalog.rows).toEqual([ {
    name: 'total', is_computed: 1, definition: 'quantity * price', is_persisted: 1
  } ])
})

test('collation comparisons, uniqueness and catalog metadata cross tedious', async () => {
  await query(`
    CREATE TABLE wire_collation (
      value NVARCHAR(30) COLLATE Latin1_General_100_CI_AI UNIQUE
    )
    INSERT INTO wire_collation VALUES (N'café')
  `)
  const equivalent = await query(`
    SELECT value FROM wire_collation WHERE value = N'CAFE'
  `)
  expect(equivalent.rows).toEqual([ { value: 'café' } ])
  await expect(query('INSERT INTO wire_collation VALUES (N\'cafe\')'))
    .rejects.toMatchObject({ number: 2627 })
  const catalog = await query(`
    SELECT collation_name FROM sys.columns
    WHERE object_id = OBJECT_ID(N'wire_collation') AND name = N'value'
  `)
  expect(catalog.rows).toEqual([ { collation_name: 'Latin1_General_100_CI_AI' } ])
})

test('parameterized query via sp_executesql rpc', async () => {
  const result = await query('SELECT name FROM users WHERE age > @age', [
    { name: 'age', type: TYPES.Int, value: 18 }
  ])
  expect(result.rows).toEqual([ { name: 'Alice' } ])
})

test('nvarchar and datetime parameters round trip', async () => {
  const result = await query('SELECT @s AS s, @n AS n', [
    { name: 's', type: TYPES.NVarChar, value: 'param ✓' },
    { name: 'n', type: TYPES.Int, value: 42 }
  ])
  expect(result.rows).toEqual([ { s: 'param ✓', n: 42 } ])
})

test('decimal parameters and exact expressions cross TDS with decimal metadata', async () => {
  const result = await query(`
    SELECT CAST(@amount AS DECIMAL(18,2)) + CAST(0.01 AS DECIMAL(18,2)) AS amount,
      CAST(1.005 AS DECIMAL(5,2)) AS rounded
  `, [ {
    name: 'amount', type: TYPES.Decimal, value: 123.45,
    options: { precision: 18, scale: 2 }
  } ])
  expect(result.rows).toEqual([ { amount: 123.46, rounded: 1.01 } ])
  expect(result.columns.map(column => column.type)).toEqual([ 'DecimalN', 'DecimalN' ])
})

test('datetime column values come back as dates', async () => {
  const result = await query('SELECT created FROM users WHERE id = 1')
  expect(result.rows[0]?.['created']).toBeInstanceOf(Date)
})

test('variables and batches', async () => {
  const result = await query(`
    DECLARE @x INT = 40
    SET @x = @x + 2
    SELECT @x AS answer
  `)
  expect(result.rows).toEqual([ { answer: 42 } ])
})

test('NOCOUNT suppresses tedious row counts while preserving rows and nested scope', async () => {
  await query('CREATE TABLE wire_nocount (id INT)')
  const hidden = await query(`
    SET NOCOUNT ON
    INSERT INTO wire_nocount VALUES (1), (2)
    SELECT @@ROWCOUNT AS affected
  `)
  expect(hidden.rows).toEqual([ { affected: 2 } ])
  expect(hidden.rowCount).toBe(0)
  expect(hidden.doneCounts.every(count => count === undefined)).toBe(true)

  await query(`
    CREATE PROCEDURE dbo.wire_nocount_insert AS
      SET NOCOUNT ON
      INSERT INTO wire_nocount VALUES (3)
  `)
  const procedure = await query('EXEC dbo.wire_nocount_insert')
  expect(procedure.rowCount).toBe(0)
  expect(procedure.doneCounts.every(count => count === undefined)).toBe(true)
  const visible = await query('INSERT INTO wire_nocount VALUES (4)')
  expect(visible.rowCount).toBe(1)
  expect(visible.doneCounts).toContain(1)
})

test('table variable workflow over the wire', async () => {
  const result = await query(`
    DECLARE @items TABLE (id INT PRIMARY KEY, name NVARCHAR(20) NOT NULL, qty INT DEFAULT 1)
    INSERT INTO @items (id, name) VALUES (1, N'apple'), (2, N'pear')
    UPDATE @items SET qty += 2 WHERE id = 1
    DELETE FROM @items WHERE id = 2
    SELECT id, name, qty FROM @items
  `)
  expect(result.rows).toEqual([ { id: 1, name: 'apple', qty: 3 } ])
  await expect(query('SELECT * FROM @items')).rejects.toMatchObject({ number: 1087 })
})

test('sys catalog over the wire', async () => {
  const result = await query(`
    SELECT t.name, s.name AS schema_name
    FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE t.name = 'users'
  `)
  expect(result.rows).toEqual([ { name: 'users', schema_name: 'dbo' } ])
})

test('information schema over the wire', async () => {
  const result = await query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'name'
  `)
  expect(result.rows).toEqual([ { COLUMN_NAME: 'name', DATA_TYPE: 'nvarchar' } ])
})

test('errors surface with mssql numbers', async () => {
  await expect(query('SELECT * FROM missing_table')).rejects.toMatchObject({ number: 208 })
  await expect(query('INSERT INTO users (name) VALUES (NULL)')).rejects.toMatchObject({ number: 515 })
})

test('statement errors and successful rows stay ordered over tedious', async () => {
  await query('CREATE TABLE wire_error_order (id INT PRIMARY KEY); INSERT INTO wire_error_order VALUES (1)')
  const events = await new Promise<string[]>((resolve, reject) => {
    const seen: string[] = []
    const onErrorMessage = (error: { number: number }): void => {
      seen.push(`error:${error.number}`)
    }
    connection.on('errorMessage', onErrorMessage)
    const request = new Request(`
      INSERT INTO wire_error_order VALUES (1);
      SELECT 1 AS marker;
      INSERT INTO wire_error_order VALUES (1);
      SELECT 2 AS marker;
    `, error => {
      connection.removeListener('errorMessage', onErrorMessage)
      const reported = error as (Error & {
        readonly number?: number,
        readonly errors?: readonly { readonly number?: number }[]
      }) | null
      const numbers = Array.isArray(reported?.errors) ?
        reported.errors.map(inner => inner.number) :
        [ reported?.number ]
      if (numbers.length !== 2 || numbers.some(number => number !== 2627)) {
        reject(error ?? new Error('Expected a constraint error.'))
      } else {
        resolve(seen)
      }
    })
    request.on('row', columns => {
      const marker = (columns as Record<string, { value: unknown }>)['marker']?.value
      seen.push(`row:${String(marker)}`)
    })
    connection.execSql(request)
  })
  expect(events).toEqual([ 'error:2627', 'row:1', 'error:2627', 'row:2' ])
})

test('arithmetic errors are catchable over tedious', async () => {
  await expect(query('SELECT 1 / 0 AS bad')).rejects.toMatchObject({ number: 8134 })
  const caught = await query(`
    BEGIN TRY
      SELECT 2147483647 + 1 AS bad
    END TRY
    BEGIN CATCH
      SELECT ERROR_NUMBER() AS number
    END CATCH
  `)
  expect(caught.rows).toEqual([ { number: 8115 } ])
})

test('transactions via tedious api', async () => {
  await new Promise<void>((resolve, reject) => {
    connection.beginTransaction(error => error ? reject(error) : resolve())
  })
  await query('INSERT INTO users (name) VALUES (N\'Temp\')')
  await new Promise<void>((resolve, reject) => {
    connection.rollbackTransaction(error => error ? reject(error) : resolve())
  })
  const result = await query('SELECT COUNT(*) AS n FROM users WHERE name = N\'Temp\'')
  expect(result.rows).toEqual([ { n: 0 } ])
})

test('functions over the wire', async () => {
  const result = await query(`
    SELECT
      LEN('hello') AS l,
      UPPER('abc') AS u,
      ISNULL(NULL, 'fallback') AS i,
      DATEDIFF(day, '2026-01-01', '2026-01-31') AS dd,
      CONVERT(varchar(10), CAST('2026-07-01' AS date), 120) AS c
  `)
  expect(result.rows).toEqual([
    { l: 5, u: 'ABC', i: 'fallback', dd: 30, c: '2026-07-01' }
  ])
})

test('table-valued functions over the wire include empty inputs', async () => {
  const split = await query(`
    SELECT value, ordinal
    FROM STRING_SPLIT(N'a,,b', N',', 1)
    ORDER BY ordinal
  `)
  expect(split.rows).toEqual([
    { value: 'a', ordinal: '1' },
    { value: '', ordinal: '2' },
    { value: 'b', ordinal: '3' }
  ])
  expect((await query('SELECT * FROM STRING_SPLIT(NULL, \',\')')).rows).toEqual([])
  expect((await query('SELECT * FROM STRING_SPLIT(\'\', \',\')')).rows).toEqual([])

  const json = await query(`
    SELECT id, name
    FROM OPENJSON('{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}', '$.items')
    WITH (id INT, name NVARCHAR(20))
    ORDER BY id
  `)
  expect(json.rows).toEqual([ { id: 1, name: 'a' }, { id: 2, name: 'b' } ])
  expect((await query('SELECT * FROM OPENJSON(NULL)')).rows).toEqual([])
  expect((await query('SELECT * FROM OPENJSON(\'[]\')')).rows).toEqual([])

  const series = await query('SELECT value FROM GENERATE_SERIES(1, 5, 2)')
  expect(series.rows).toEqual([ { value: 1 }, { value: 3 }, { value: 5 } ])
  expect((await query('SELECT * FROM GENERATE_SERIES(NULL, 3)')).rows).toEqual([])
})

test('apply correlation and null extension over the wire', async () => {
  await query(`
    CREATE TABLE wire_apply_tags (id INT, csv NVARCHAR(20));
    INSERT INTO wire_apply_tags VALUES (1, 'a,b'), (2, NULL);
    CREATE TABLE wire_apply_notes (tag_id INT, note NVARCHAR(20), created INT);
    INSERT INTO wire_apply_notes VALUES (1, 'old', 1), (1, 'new', 2);
  `)
  const split = await query(`
    SELECT t.id, part.value
    FROM wire_apply_tags t OUTER APPLY STRING_SPLIT(t.csv, ',') part
    ORDER BY t.id, part.value
  `)
  expect(split.rows).toEqual([
    { id: 1, value: 'a' }, { id: 1, value: 'b' }, { id: 2, value: null }
  ])
  const latest = await query(`
    SELECT t.id, n.note
    FROM wire_apply_tags t OUTER APPLY (
      SELECT TOP (1) x.note FROM wire_apply_notes x
      WHERE x.tag_id = t.id ORDER BY x.created DESC
    ) n
    ORDER BY t.id
  `)
  expect(latest.rows).toEqual([ { id: 1, note: 'new' }, { id: 2, note: null } ])
})

test('pivot and unpivot values and metadata over the wire', async () => {
  await query(`
    CREATE TABLE wire_sales (region NVARCHAR(20), quarter NVARCHAR(2), amount INT);
    INSERT INTO wire_sales VALUES
      ('east', 'Q1', 10), ('east', 'Q1', 5), ('east', 'Q2', NULL),
      ('west', 'Q2', 7);
  `)
  const pivot = await query(`
    SELECT region, [Q1], [Q2], [Q3]
    FROM wire_sales
    PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY region
  `)
  expect(pivot.rows).toEqual([
    { region: 'east', Q1: 15, Q2: null, Q3: null },
    { region: 'west', Q1: null, Q2: 7, Q3: null }
  ])
  expect(pivot.columns.map(column => [ column.name, column.type ])).toEqual([
    [ 'region', 'NVarChar' ], [ 'Q1', 'IntN' ], [ 'Q2', 'IntN' ], [ 'Q3', 'IntN' ]
  ])

  await query(`
    CREATE TABLE wire_labels (bucket NVARCHAR(2), label NVARCHAR(12));
    INSERT INTO wire_labels VALUES ('Q1', 'first');
  `)
  const labels = await query(`
    SELECT [Q1], [Q2] FROM wire_labels
    PIVOT (MAX(label) FOR bucket IN ([Q1], [Q2])) result
  `)
  expect(labels.rows).toEqual([ { Q1: 'first', Q2: null } ])
  expect(labels.columns).toEqual([
    { name: 'Q1', type: 'NVarChar', length: 24 },
    { name: 'Q2', type: 'NVarChar', length: 24 }
  ])

  await query(`
    CREATE TABLE wire_quarters (id INT, [Q1] INT, [Q2] INT, [Q3] INT);
    INSERT INTO wire_quarters VALUES (1, 10, 20, NULL), (2, NULL, 25, 30);
  `)
  const unpivot = await query(`
    SELECT id, quarter, amount
    FROM wire_quarters
    UNPIVOT (amount FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY id, quarter
  `)
  expect(unpivot.rows).toEqual([
    { id: 1, quarter: 'Q1', amount: 10 },
    { id: 1, quarter: 'Q2', amount: 20 },
    { id: 2, quarter: 'Q2', amount: 25 },
    { id: 2, quarter: 'Q3', amount: 30 }
  ])
  expect(unpivot.columns.map(column => [ column.name, column.type ])).toEqual([
    [ 'id', 'IntN' ], [ 'quarter', 'NVarChar' ], [ 'amount', 'IntN' ]
  ])
})

test('grouping sets values and metadata over the wire', async () => {
  await query(`
    CREATE TABLE wire_grouping (region NVARCHAR(10), product NVARCHAR(10), amount INT);
    INSERT INTO wire_grouping VALUES
      ('east', 'a', 10), ('east', 'b', 20), ('west', 'a', 5), (NULL, 'a', 7);
  `)
  const result = await query(`
    SELECT region, product, SUM(amount) AS total,
      GROUPING(region) AS gr, GROUPING(product) AS gp
    FROM wire_grouping
    GROUP BY ROLLUP(region, product)
    ORDER BY gr, gp, region, product
  `)
  expect(result.rows).toEqual([
    { region: null, product: 'a', total: 7, gr: 0, gp: 0 },
    { region: 'east', product: 'a', total: 10, gr: 0, gp: 0 },
    { region: 'east', product: 'b', total: 20, gr: 0, gp: 0 },
    { region: 'west', product: 'a', total: 5, gr: 0, gp: 0 },
    { region: null, product: null, total: 7, gr: 0, gp: 1 },
    { region: 'east', product: null, total: 30, gr: 0, gp: 1 },
    { region: 'west', product: null, total: 5, gr: 0, gp: 1 },
    { region: null, product: null, total: 42, gr: 1, gp: 1 }
  ])
  expect(result.columns).toEqual([
    { name: 'region', type: 'NVarChar', length: 20 },
    { name: 'product', type: 'NVarChar', length: 20 },
    { name: 'total', type: 'IntN', length: 4 },
    { name: 'gr', type: 'IntN', length: 1 },
    { name: 'gp', type: 'IntN', length: 1 }
  ])
})

test('for json streams large nvarchar max output over the wire', async () => {
  const jsonColumn = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'
  const result = await query(`
    SELECT REPLICATE(N'x', 10000) AS payload, NULL AS omitted
    FOR JSON PATH
  `)
  expect(result.rows).toHaveLength(1)
  expect(JSON.parse(String(result.rows[0]?.[jsonColumn]))).toEqual([
    { payload: 'x'.repeat(10000) }
  ])
  expect(result.columns).toEqual([ {
    name: jsonColumn,
    type: 'NVarChar',
    length: 65535
  } ])
})

test('update and delete counts', async () => {
  const update = await query('UPDATE users SET age = 31 WHERE name = N\'Alice\'')
  expect(update.rowCount).toBe(1)
  const delete_ = await query('DELETE FROM users WHERE name = N\'Bob\'')
  expect(delete_.rowCount).toBe(1)
})

test('print emits info message', async () => {
  const messages: string[] = []
  const onInfo = (info: { message: string }): void => {
    messages.push(info.message)
  }
  connection.on('infoMessage', onInfo)
  try {
    await query('PRINT \'hello from mssqlite\'')
  } finally {
    connection.off('infoMessage', onInfo)
  }
  expect(messages).toContain('hello from mssqlite')
})

test('second connection works concurrently', async () => {
  const other = await connect(listening.port)
  try {
    const result = await new Promise<number>((resolve, reject) => {
      let value = 0
      const request = new Request('SELECT COUNT(*) AS n FROM users', error =>
        error ? reject(error) : resolve(value))
      request.on('row', columns => {
        value = Number((columns as unknown as { n: { value: unknown } }).n.value)
      })
      other.execSql(request)
    })
    expect(result).toBe(1)
  } finally {
    other.close()
  }
})

test('try/catch over the wire returns the catch result set', async () => {
  await query('CREATE TABLE trycatch (email VARCHAR(50) UNIQUE)')
  await query('INSERT INTO trycatch VALUES (\'a\')')
  const result = await query(`
    BEGIN TRY
      INSERT INTO trycatch VALUES ('a')
    END TRY
    BEGIN CATCH
      SELECT ERROR_NUMBER() AS n, XACT_STATE() AS x
    END CATCH
  `)
  expect(result.rows).toEqual([ { n: 2627, x: 0 } ])
})

test('raiserror severity 16 surfaces as a request error', async () => {
  await expect(query('RAISERROR (\'wire fail\', 16, 1)')).rejects.toMatchObject({
    number: 50000,
    message: expect.stringContaining('wire fail') as unknown
  })
})

test('stored procedures execute over the wire via RPC callProcedure', async () => {
  await query(`
    CREATE PROCEDURE dbo.add_numbers @a INT, @b INT, @sum INT OUTPUT AS
    BEGIN
      SET @sum = @a + @b
      RETURN 7
    END
  `)
  const outcome = await new Promise<{ outputs: Record<string, unknown>, rows: Row[] }>((resolve, reject) => {
    const outputs: Record<string, unknown> = {}
    const rows: Row[] = []
    const request = new Request('dbo.add_numbers', error => {
      if (error) {
        reject(error)
      } else {
        resolve({ outputs, rows })
      }
    })
    request.addParameter('a', TYPES.Int, 2)
    request.addParameter('b', TYPES.Int, 40)
    request.addOutputParameter('sum', TYPES.Int)
    request.on('returnValue', (name, value) => {
      outputs[name] = value
    })
    connection.callProcedure(request)
  })
  expect(outcome.outputs['sum']).toBe(42)
})

test('scalar and inline table functions execute over the wire', async () => {
  await query(`
    CREATE FUNCTION dbo.wire_double(@value INT)
    RETURNS BIGINT AS BEGIN RETURN @value * 2 END
  `)
  const scalar = await query('SELECT dbo.wire_double(21) AS value')
  expect(scalar.rows).toEqual([ { value: '42' } ])
  expect(scalar.columns).toEqual([ { name: 'value', type: 'IntN', length: 8 } ])

  await query(`
    CREATE TABLE wire_function_values (id INT, category INT, value INT);
    INSERT INTO wire_function_values VALUES (1, 1, 10), (2, 1, 20), (3, 2, 30);
  `)
  await query(`
    CREATE FUNCTION dbo.wire_values(@category INT)
    RETURNS TABLE AS RETURN (
      SELECT id, value FROM wire_function_values WHERE category = @category
    )
  `)
  const table = await query(`
    SELECT id, value FROM dbo.wire_values(1) AS values_ ORDER BY id
  `)
  expect(table.rows).toEqual([ { id: 1, value: 10 }, { id: 2, value: 20 } ])
})

test('exec with return status over a batch', async () => {
  await query('CREATE PROCEDURE dbo.status_only AS RETURN 5')
  const result = await query('DECLARE @rc INT EXEC @rc = status_only SELECT @rc AS rc')
  expect(result.rows).toEqual([ { rc: 5 } ])
})

test('output clause over the wire', async () => {
  await query('CREATE TABLE oc (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50))')
  const inserted = await query('INSERT INTO oc (name) OUTPUT inserted.id, inserted.name VALUES (N\'a\'), (N\'b\')')
  expect(inserted.rows).toEqual([ { id: 1, name: 'a' }, { id: 2, name: 'b' } ])
  expect(inserted.rowCount).toBe(2)
  const updated = await query(
    'UPDATE oc SET name = name + N\'!\' OUTPUT deleted.name AS was, inserted.name AS became WHERE id = 1')
  expect(updated.rows).toEqual([ { was: 'a', became: 'a!' } ])
  const deleted = await query('DELETE FROM oc OUTPUT deleted.id WHERE id = 2')
  expect(deleted.rows).toEqual([ { id: 2 } ])
})

test('statement-level triggers execute over tedious', async () => {
  await query(`
    CREATE TABLE wire_trigger_source (id INT PRIMARY KEY, value INT);
    CREATE TABLE wire_trigger_audit (id INT, value INT);
  `)
  await query(`
    CREATE TRIGGER dbo.wire_trigger ON wire_trigger_source AFTER INSERT, UPDATE AS
      SET NOCOUNT ON
      INSERT INTO wire_trigger_audit (id, value)
      SELECT id, value FROM inserted
  `)
  const inserted = await query('INSERT INTO wire_trigger_source VALUES (1, 10), (2, 20)')
  expect(inserted.rowCount).toBe(2)
  await query('UPDATE wire_trigger_source SET value += 1')
  const audit = await query('SELECT id, value FROM wire_trigger_audit ORDER BY rowid')
  expect(audit.rows).toEqual([
    { id: 1, value: 10 }, { id: 2, value: 20 },
    { id: 1, value: 11 }, { id: 2, value: 21 }
  ])
})

test('cursor loop executes over tedious', async () => {
  await query(`
    CREATE TABLE wire_cursor_values (n INT);
    INSERT INTO wire_cursor_values VALUES (2), (3), (5);
  `)
  const result = await query(`
    DECLARE @n INT, @sum INT = 0
    DECLARE wire_cursor LOCAL FAST_FORWARD CURSOR FOR
      SELECT n FROM wire_cursor_values ORDER BY n
    OPEN wire_cursor
    FETCH NEXT FROM wire_cursor INTO @n
    WHILE @@FETCH_STATUS = 0
    BEGIN
      SET @sum += @n
      FETCH NEXT FROM wire_cursor INTO @n
    END
    CLOSE wire_cursor
    DEALLOCATE wire_cursor
    SELECT @sum AS total, @@FETCH_STATUS AS status
  `)
  expect(result.rows).toEqual([ { total: 10, status: -1 } ])
})

test('sequences allocate and report exhaustion over tedious', async () => {
  await query(`
    CREATE SEQUENCE dbo.wire_sequence AS INT
      START WITH 41 INCREMENT BY 2 MINVALUE 41 MAXVALUE 43 NO CYCLE NO CACHE
  `)
  expect((await query('SELECT NEXT VALUE FOR dbo.wire_sequence AS id')).rows)
    .toEqual([ { id: 41 } ])
  expect((await query('SELECT NEXT VALUE FOR dbo.wire_sequence AS id')).rows)
    .toEqual([ { id: 43 } ])
  await expect(query('SELECT NEXT VALUE FOR dbo.wire_sequence AS id'))
    .rejects.toMatchObject({ number: 11728 })
  await query('ALTER SEQUENCE dbo.wire_sequence RESTART WITH 42 INCREMENT BY -1')
  expect((await query('SELECT NEXT VALUE FOR dbo.wire_sequence AS id')).rows)
    .toEqual([ { id: 42 } ])
})

test('merge over the wire reports the combined row count', async () => {
  await query(`
    CREATE TABLE stock (sku NVARCHAR(20) PRIMARY KEY, qty INT);
    INSERT INTO stock VALUES (N'a', 1), (N'b', 2);
  `)
  const merged = await query(`
    MERGE stock AS t
    USING (VALUES (N'a', 10), (N'c', 30)) AS s (sku, qty)
    ON t.sku = s.sku
    WHEN MATCHED THEN UPDATE SET qty = s.qty
    WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.sku, s.qty)
    WHEN NOT MATCHED BY SOURCE THEN DELETE;
  `)
  expect(merged.rowCount).toBe(3)
  const result = await query('SELECT sku, qty FROM stock ORDER BY sku')
  expect(result.rows).toEqual([ { sku: 'a', qty: 10 }, { sku: 'c', qty: 30 } ])
})

test('merge output over the wire returns $action with row images', async () => {
  await query(`
    CREATE TABLE mo (id INT PRIMARY KEY, v INT);
    INSERT INTO mo VALUES (1, 10), (2, 20);
  `)
  const merged = await query(`
    MERGE mo AS t
    USING (VALUES (1, 11), (3, 30)) AS s (id, v)
    ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET v = s.v
    WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)
    WHEN NOT MATCHED BY SOURCE THEN DELETE
    OUTPUT $action AS act, deleted.id AS old_id, inserted.id AS new_id;
  `)
  const sorted = [ ...merged.rows ].sort((a, b) =>
    String(a['act']).localeCompare(String(b['act'])))
  expect(sorted).toEqual([
    { act: 'DELETE', old_id: 2, new_id: null },
    { act: 'INSERT', old_id: null, new_id: 3 },
    { act: 'UPDATE', old_id: 1, new_id: 1 }
  ])
})
