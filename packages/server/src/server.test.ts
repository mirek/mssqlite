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
