import { afterAll, beforeAll, expect, test } from 'vitest'
import { Connection, Request, TYPES } from 'tedious'
import { listen, type Listening } from './server.ts'

let listening: Listening
let connection: Connection

type Row =
  Record<string, unknown>

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
  (sql: string, parameters: { name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown }[] = []): Promise<{ rows: Row[], rowCount: number }> =>
    new Promise((resolve, reject) => {
      const rows: Row[] = []
      const request = new Request(sql, (error, rowCount) => {
        if (error) {
          reject(error)
        } else {
          resolve({ rows, rowCount: rowCount ?? 0 })
        }
      })
      for (const parameter of parameters) {
        request.addParameter(parameter.name, parameter.type, parameter.value)
      }
      request.on('row', columns => {
        const row: Row = {}
        for (const [ name, column ] of Object.entries(columns as Record<string, { value: unknown }>)) {
          row[name] = column.value
        }
        rows.push(row)
      })
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
