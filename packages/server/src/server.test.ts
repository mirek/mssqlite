import { afterAll, beforeAll, expect, test } from 'vitest'
import { Connection, Request, TYPES } from 'tedious'
import mssql from 'mssql'
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

type ProcedureResult = {
  readonly columns: readonly string[],
  readonly rows: readonly (readonly unknown[])[]
}

const connect =
  (port: number, useColumnNames = true): Promise<Connection> =>
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
          useColumnNames,
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

const queryArrays =
  (connection_: Connection, sql: string): Promise<{ rows: unknown[][], columns: WireColumn[] }> =>
    new Promise((resolve, reject) => {
      const rows: unknown[][] = []
      let columns: WireColumn[] = []
      const request = new Request(sql, error => {
        if (error) {
          reject(error)
        } else {
          resolve({ rows, columns })
        }
      })
      request.on('row', row => rows.push(
        (Array.isArray(row) ? row : Object.values(row))
          .map((column: { value: unknown }) => column.value)
      ))
      request.on('columnMetadata', metadata => {
        columns = Object.values(metadata).map(column => ({
          name: column.colName,
          type: column.type.name,
          length: column.dataLength
        }))
      })
      connection_.execSql(request)
    })

const callSystem =
  (name: string, parameters: readonly { readonly name: string, readonly value: unknown }[] = []):
  Promise<readonly ProcedureResult[]> =>
    new Promise((resolve, reject) => {
      const result: { columns: string[], rows: unknown[][] }[] = []
      const request = new Request(name, error => error ? reject(error) : resolve(result))
      for (const parameter of parameters) {
        request.addParameter(parameter.name, TYPES.NVarChar, parameter.value)
      }
      request.on('columnMetadata', metadata => {
        result.push({
          columns: Object.values(metadata).map(column => column.colName),
          rows: []
        })
      })
      request.on('row', row => {
        result[result.length - 1]?.rows.push(
          Object.values(row as Record<string, { value: unknown }>).map(column => column.value)
        )
      })
      connection.callProcedure(request)
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

const bulk =
  (
    table: string,
    configure: (load: ReturnType<Connection['newBulkLoad']>) => void,
    rows: Iterable<unknown[] | Record<string, unknown>> |
      AsyncIterable<unknown[] | Record<string, unknown>>,
    options: { keepNulls?: boolean, checkConstraints?: boolean, fireTriggers?: boolean } = {}
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      const load = connection.newBulkLoad(table, options, (error, rowCount) => {
        if (error) {
          reject(error)
        } else {
          resolve(rowCount ?? 0)
        }
      })
      configure(load)
      connection.execBulkLoad(load, rows)
    })

const yieldEventLoop =
  (): Promise<void> => new Promise(resolve => setImmediate(resolve))

beforeAll(async () => {
  listening = await listen({
    path: ':memory:', port: 0, databaseName: 'master', authentication: { type: 'insecure' }
  })
  connection = await connect(listening.port)
}, 20000)

afterAll(async () => {
  connection.close()
  await listening.close()
})

test('login handshake succeeded', () => {
  expect(connection.state.name).toBe('LoggedIn')
})

test('tedious streams large mixed and PLP bulk loads with defaults and row counts', async () => {
  await query(`
    CREATE TABLE wire_bulk (
      id INT PRIMARY KEY,
      note NVARCHAR(MAX) NULL,
      amount DECIMAL(12, 2) NOT NULL,
      payload VARBINARY(MAX) NULL,
      fallback INT NOT NULL DEFAULT 9
    )
  `)
  const long = 'bulk-'.repeat(5000)
  const rows = Array.from({ length: 2500 }, (_, index) => ({
    id: index,
    note: index === 0 ? long : index % 7 === 0 ? null : `row-${index}`,
    amount: index + 0.25,
    payload: index % 3 === 0 ? Buffer.from([ index & 0xff, 2, 3 ]) : null,
    fallback: index % 5 === 0 ? null : index
  }))
  const count = await bulk('dbo.wire_bulk', load => {
    load.addColumn('id', TYPES.Int, { nullable: false })
    load.addColumn('note', TYPES.NVarChar, { length: Infinity, nullable: true })
    load.addColumn('amount', TYPES.Decimal, { precision: 12, scale: 2, nullable: false })
    load.addColumn('payload', TYPES.VarBinary, { length: Infinity, nullable: true })
    load.addColumn('fallback', TYPES.Int, { nullable: true })
  }, rows)
  expect(count).toBe(2500)
  expect((await query(`
    SELECT COUNT(*) AS count, MAX(LEN(note)) AS longest,
      SUM(CASE WHEN fallback = 9 THEN 1 ELSE 0 END) AS defaults
    FROM wire_bulk
  `)).rows).toEqual([ { count: 2500, longest: long.length, defaults: 501 } ])
})

test('tedious bulk constraint failures and cancel roll back the active load', async () => {
  await query('CREATE TABLE wire_bulk_rollback (id INT PRIMARY KEY, value INT NOT NULL)')
  await expect(bulk('wire_bulk_rollback', load => {
    load.addColumn('id', TYPES.Int, { nullable: false })
    load.addColumn('value', TYPES.Int, { nullable: false })
  }, [ { id: 1, value: 1 }, { id: 1, value: 2 } ]))
    .rejects.toBeDefined()
  expect((await query('SELECT COUNT(*) AS count FROM wire_bulk_rollback')).rows)
    .toEqual([ { count: 0 } ])

  let cancel: (() => void) | undefined
  const canceled = new Promise<Error | undefined>(resolve => {
    const load = connection.newBulkLoad('wire_bulk_rollback', error => resolve(error ?? undefined))
    load.addColumn('id', TYPES.Int, { nullable: false })
    load.addColumn('value', TYPES.Int, { nullable: false })
    cancel = () => load.cancel()
    connection.execBulkLoad(load, (async function * () {
      for (let index = 0; index < 20_000; index++) {
        if (index % 100 === 0) {
          await yieldEventLoop()
        }
        yield { id: index, value: index }
      }
    })())
  })
  setTimeout(() => cancel?.(), 10)
  expect(await canceled).toBeDefined()
  expect((await query('SELECT COUNT(*) AS count FROM wire_bulk_rollback')).rows)
    .toEqual([ { count: 0 } ])
}, 20000)

test('node-mssql SqlBulkCopy-style API and FIRE_TRIGGERS interoperate', async () => {
  await query(`
    CREATE TABLE wire_bulk_api (id INT PRIMARY KEY, value NVARCHAR(30));
    CREATE TABLE wire_bulk_audit (id INT);
    CREATE TRIGGER wire_bulk_api_insert ON wire_bulk_api AFTER INSERT AS
    BEGIN
      INSERT INTO wire_bulk_audit SELECT id FROM inserted
    END
  `)
  await bulk('wire_bulk_api', load => {
    load.addColumn('id', TYPES.Int, { nullable: false })
    load.addColumn('value', TYPES.NVarChar, { length: 30, nullable: true })
  }, [ { id: 1, value: 'triggered' } ], { fireTriggers: true, checkConstraints: true })

  const pool = await new mssql.ConnectionPool({
    server: '127.0.0.1',
    port: listening.port,
    user: 'sa',
    password: 'anything',
    database: 'master',
    options: { encrypt: false, trustServerCertificate: true },
    pool: { min: 0, max: 1, idleTimeoutMillis: 1000 }
  }).connect()
  try {
    const table = new mssql.Table('wire_bulk_api')
    table.create = false
    table.columns.add('id', mssql.Int, { nullable: false })
    const nvarchar = mssql.NVarChar
    table.columns.add('value', nvarchar(30), { nullable: true })
    table.rows.add(2, 'node-mssql')
    table.rows.add(3, null)
    expect((await pool.request().bulk(table)).rowsAffected).toBe(2)
  } finally {
    await pool.close()
  }
  expect((await query('SELECT id, value FROM wire_bulk_api ORDER BY id')).rows).toEqual([
    { id: 1, value: 'triggered' },
    { id: 2, value: 'node-mssql' },
    { id: 3, value: null }
  ])
  expect((await query('SELECT id FROM wire_bulk_audit ORDER BY id')).rows).toEqual([ { id: 1 } ])
})

test('multiple sessions switch databases and query three-part names independently', async () => {
  await query(`
    CREATE DATABASE wire_sales
    CREATE TABLE wire_sales.dbo.orders (id INT, label NVARCHAR(20))
    INSERT INTO wire_sales.dbo.orders VALUES (1, N'first')
  `)
  const selected = await connect(listening.port, false)
  try {
    await queryArrays(selected, 'USE wire_sales')
    const context = await queryArrays(selected,
      'SELECT DB_NAME() AS database_name, DB_ID() AS database_id')
    expect(context.rows).toEqual([ [ 'wire_sales', 5 ] ])
    const local = await queryArrays(selected, 'SELECT id, label FROM dbo.orders')
    expect(local.rows).toEqual([ [ 1, 'first' ] ])
    expect(local.columns.map(column => column.type)).toEqual([ 'IntN', 'NVarChar' ])

    const original = await queryArrays(connection, 'SELECT DB_NAME() AS database_name')
    expect(original.rows).toEqual([ [ 'master' ] ])
    const cross = await queryArrays(connection,
      'SELECT id, label FROM wire_sales.dbo.orders')
    expect(cross.rows).toEqual([ [ 1, 'first' ] ])

    await queryArrays(selected, 'USE master')
    await query('DROP DATABASE wire_sales')
  } finally {
    selected.close()
  }
})

test('select constants', async () => {
  const result = await query('SELECT 1 AS n, N\'héllo\' AS s, 1.5 AS f, NULL AS z')
  expect(result.rows).toEqual([ { n: 1, s: 'héllo', f: 1.5, z: null } ])
  expect(result.rowCount).toBe(1)
})

test('duplicate result labels retain every value for tedious column arrays', async () => {
  await query(`
    CREATE TABLE wire_duplicate_left (id INT, value INT)
    CREATE TABLE wire_duplicate_right (id BIGINT, value NVARCHAR(20))
    INSERT INTO wire_duplicate_left VALUES (1, 10)
    INSERT INTO wire_duplicate_right VALUES (1, N'right')
  `)
  const positional = await connect(listening.port, false)
  try {
    const result = await queryArrays(positional, `
      SELECT * FROM wire_duplicate_left AS l
      JOIN wire_duplicate_right AS r ON r.id = l.id
    `)
    expect(result.columns.map(column => [ column.name, column.type ])).toEqual([
      [ 'id', 'IntN' ], [ 'value', 'IntN' ], [ 'id', 'IntN' ], [ 'value', 'NVarChar' ]
    ])
    expect(result.rows).toEqual([ [ 1, 10, '1', 'right' ] ])

    const aliases = await queryArrays(positional,
      'SELECT 1 AS duplicate, N\'two\' AS duplicate, 3 AS duplicate')
    expect(aliases.columns.map(column => column.name)).toEqual([
      'duplicate', 'duplicate', 'duplicate'
    ])
    expect(aliases.rows).toEqual([ [ 1, 'two', 3 ] ])
  } finally {
    positional.close()
  }
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

test('identity seed, session functions, and explicit-value errors cross tedious', async () => {
  await query(`
    CREATE TABLE wire_identity_semantics (
      id INT IDENTITY(10, 5),
      value NVARCHAR(20) UNIQUE
    )
  `)
  await query('INSERT INTO wire_identity_semantics (value) VALUES (N\'a\'), (N\'b\')')
  const values = await query(`
    SELECT id, value, IDENT_CURRENT('wire_identity_semantics') AS current_value,
      @@IDENTITY AS global_value, SCOPE_IDENTITY() AS scope_value
    FROM wire_identity_semantics ORDER BY id
  `)
  expect(values.rows).toEqual([
    { id: 10, value: 'a', current_value: 15, global_value: 15, scope_value: 15 },
    { id: 15, value: 'b', current_value: 15, global_value: 15, scope_value: 15 }
  ])
  await expect(query(
    'INSERT INTO wire_identity_semantics (id, value) VALUES (100, N\'explicit\')'))
    .rejects.toMatchObject({ number: 544 })
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

test('datetimeoffset values and parameters round trip through tedious', async () => {
  await query('CREATE TABLE wire_offsets (happened_at DATETIMEOFFSET(7))')
  const instant = new Date(Date.UTC(2026, 6, 1, 8, 30, 15, 123))
  await query('INSERT INTO wire_offsets VALUES (@happened_at)', [ {
    name: 'happened_at',
    type: TYPES.DateTimeOffset,
    value: instant,
    options: { scale: 7 }
  } ])
  const parameter = await query('SELECT @happened_at AS happened_at', [ {
    name: 'happened_at',
    type: TYPES.DateTimeOffset,
    value: instant,
    options: { scale: 7 }
  } ])
  expect(parameter.columns.map(column => column.type)).toEqual([ 'DateTimeOffset' ])
  expect(parameter.rows[0]?.['happened_at']).toBeInstanceOf(Date)
  expect((parameter.rows[0]?.['happened_at'] as Date).toISOString()).toBe(instant.toISOString())

  const values = await query(`
    SELECT happened_at,
      CASE WHEN CAST('2026-07-01 10:30:15.1230000 +02:00' AS DATETIMEOFFSET) =
        CAST('2026-07-01 08:30:15.1230000 +00:00' AS DATETIMEOFFSET)
        THEN 1 ELSE 0 END AS equal_instants
    FROM wire_offsets
  `)
  expect(values.columns[0]?.type).toBe('DateTimeOffset')
  expect((values.rows[0]?.['happened_at'] as Date).toISOString()).toBe(instant.toISOString())
  expect(values.rows[0]?.['equal_instants']).toBe(1)
})

test('rowversion values and metadata round trip through tedious', async () => {
  await query(`
    CREATE TABLE wire_versions (
      id INT,
      required_version ROWVERSION
    )
    CREATE TABLE wire_nullable_versions (nullable_version TIMESTAMP NULL)
    INSERT INTO wire_versions (id) VALUES (1)
    INSERT INTO wire_nullable_versions DEFAULT VALUES
  `)
  const required = await query('SELECT required_version FROM wire_versions')
  expect(required.columns).toEqual([
    { name: 'required_version', type: 'Binary', length: 8 }
  ])
  expect(Buffer.from(required.rows[0]?.['required_version'] as Uint8Array))
    .toEqual(Buffer.from('0000000000000001', 'hex'))
  const nullable = await query('SELECT nullable_version FROM wire_nullable_versions')
  expect(nullable.columns).toEqual([
    { name: 'nullable_version', type: 'VarBinary', length: 8 }
  ])
  expect(Buffer.from(nullable.rows[0]?.['nullable_version'] as Uint8Array))
    .toEqual(Buffer.from('0000000000000002', 'hex'))

  await query('UPDATE wire_versions SET id = id')
  expect(Buffer.from((await query('SELECT required_version FROM wire_versions')).rows[0]?.['required_version'] as Uint8Array))
    .toEqual(Buffer.from('0000000000000003', 'hex'))
})

test('opaque special types retain native wire identity through tedious', async () => {
  await query(`
    CREATE TABLE wire_opaque (
      variant_value SQL_VARIANT,
      xml_value XML,
      hierarchy_value HIERARCHYID,
      geometry_value GEOMETRY,
      geography_value GEOGRAPHY
    )
    INSERT INTO wire_opaque VALUES (
      42, N'<root>hé</root>', 0x010203, 0x040506, 0x070809
    )
  `)
  const result = await query(`
    SELECT variant_value, xml_value, hierarchy_value, geometry_value, geography_value
    FROM wire_opaque
  `)
  expect(result.columns.map(column => column.type)).toEqual([
    'Variant', 'Xml', 'UDT', 'UDT', 'UDT'
  ])
  expect(result.rows).toEqual([ {
    variant_value: 42,
    xml_value: '<root>hé</root>',
    hierarchy_value: Buffer.from('010203', 'hex'),
    geometry_value: Buffer.from('040506', 'hex'),
    geography_value: Buffer.from('070809', 'hex')
  } ])

  for (const [ type, value ] of [
    [ TYPES.Xml, '<x />' ],
    [ TYPES.UDT, Buffer.from('01', 'hex') ],
    [ TYPES.Variant, 1 ]
  ] as const) {
    await expect(query('SELECT @value AS value', [ {
      name: 'value', type, value
    } ])).rejects.toThrow(/not implemented/)
  }
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

test('expanded catalog relationships and metadata cross tedious', async () => {
  await query(`
    CREATE TABLE wire_catalog_parent (
      id INT, CONSTRAINT PK_wire_catalog_parent PRIMARY KEY (id)
    )
    CREATE TABLE wire_catalog_child (
      id INT CONSTRAINT DF_wire_catalog_child_id DEFAULT 9,
      parent_id INT,
      CONSTRAINT PK_wire_catalog_child PRIMARY KEY (id),
      CONSTRAINT FK_wire_catalog_child_parent FOREIGN KEY (parent_id)
        REFERENCES wire_catalog_parent (id) ON DELETE CASCADE
    )
    CREATE VIEW wire_catalog_view AS SELECT id FROM wire_catalog_child
  `)
  await query('CREATE PROCEDURE wire_catalog_proc AS SELECT 1')
  await query('CREATE FUNCTION wire_catalog_fn() RETURNS INT AS BEGIN RETURN 1 END')

  const constraints = await query(`
    SELECT CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = 'wire_catalog_child' ORDER BY CONSTRAINT_NAME
  `)
  expect(constraints.rows).toEqual([
    { CONSTRAINT_NAME: 'FK_wire_catalog_child_parent', COLUMN_NAME: 'parent_id', ORDINAL_POSITION: 1 },
    { CONSTRAINT_NAME: 'PK_wire_catalog_child', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }
  ])
  expect(constraints.columns.map(column => column.name)).toEqual([
    'CONSTRAINT_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION'
  ])
  expect(constraints.columns.map(column => column.type)).toEqual([
    'NVarChar', 'NVarChar', 'IntN'
  ])

  const definitions = await query(`
    SELECT v.TABLE_NAME, v.VIEW_DEFINITION, r.ROUTINE_NAME, r.ROUTINE_TYPE
    FROM INFORMATION_SCHEMA.VIEWS v
    CROSS JOIN INFORMATION_SCHEMA.ROUTINES r
    WHERE v.TABLE_NAME = 'wire_catalog_view' AND r.ROUTINE_NAME = 'wire_catalog_fn'
  `)
  expect(definitions.rows[0]).toMatchObject({
    TABLE_NAME: 'wire_catalog_view',
    VIEW_DEFINITION: expect.stringContaining('CREATE VIEW'),
    ROUTINE_NAME: 'wire_catalog_fn',
    ROUTINE_TYPE: 'FUNCTION'
  })
})

test('dynamic session and current request metadata cross tedious', async () => {
  const observer = await connect(listening.port)
  try {
    const sessions = await query(`
      SELECT COUNT(*) AS session_count
      FROM sys.dm_exec_sessions
    `)
    expect(Number(sessions.rows[0]?.['session_count'])).toBeGreaterThanOrEqual(2)

    const request = await query(`
      SELECT session_id, request_id, status, command
      FROM sys.dm_exec_requests WHERE session_id = @@SPID
    `)
    expect(request.rows).toEqual([ {
      session_id: expect.any(Number), request_id: 0, status: 'running', command: 'SELECT'
    } ])
    expect(request.columns.map(column => column.type)).toEqual([
      'IntN', 'IntN', 'NVarChar', 'NVarChar'
    ])
  } finally {
    observer.close()
  }
})

test('errors surface with mssql numbers', async () => {
  await expect(query('SELECT * FROM missing_table')).rejects.toMatchObject({ number: 208 })
  await expect(query('INSERT INTO users (name) VALUES (NULL)')).rejects.toMatchObject({ number: 515 })
})

test('merge validation errors retain SQL Server TDS metadata and atomicity', async () => {
  await query(`
    CREATE TABLE wire_merge_target (id INT PRIMARY KEY, value INT)
    CREATE TABLE wire_merge_source (id INT, value INT)
    INSERT INTO wire_merge_target VALUES (1, 10)
    INSERT INTO wire_merge_source VALUES (1, 20)
  `)
  await expect(query(`
    MERGE wire_merge_target AS t USING wire_merge_source AS s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET value = s.value
  `)).rejects.toMatchObject({ number: 10713, class: 15, state: 1 })
  await expect(query(`
    MERGE wire_merge_target AS t USING wire_merge_source AS s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET value = s.value
    WHEN MATCHED AND s.value > 0 THEN DELETE;
  `)).rejects.toMatchObject({ number: 5324, class: 16, state: 1 })
  await expect(query(`
    MERGE wire_merge_target AS t USING wire_merge_source AS s ON t.id = s.id
    WHEN MATCHED AND s.value > 0 THEN DELETE
    WHEN MATCHED THEN DELETE;
  `)).rejects.toMatchObject({ number: 10714, class: 15, state: 1 })
  expect((await query('SELECT id, value FROM wire_merge_target')).rows)
    .toEqual([ { id: 1, value: 10 } ])
})

test('values table sources preserve common wire types and conversion errors', async () => {
  const result = await query(`
    SELECT source.value, source.label
    FROM (VALUES
      (CAST(1 AS TINYINT), N'a'),
      (@input, N'hello'),
      (NULL, NULL)
    ) AS source(value, label)
    ORDER BY source.value
  `, [ { name: 'input', type: TYPES.BigInt, value: 2 } ])
  expect(result.rows.map(row => row.label)).toEqual([ null, 'a', 'hello' ])
  expect(result.columns).toEqual([
    { name: 'value', type: 'IntN', length: 8 },
    { name: 'label', type: 'NVarChar', length: 10 }
  ])
  await expect(query(
    'SELECT value FROM (VALUES (1), (\'not an int\')) AS source(value)'))
    .rejects.toMatchObject({ number: 245, class: 16, state: 1 })
  await expect(query('SELECT * FROM (VALUES (1)) AS source'))
    .rejects.toMatchObject({ number: 8155, class: 16, state: 2 })
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

test('string function edge cases cross the tedious boundary', async () => {
  const values = await query(`
    SELECT
      SUBSTRING('abcdef', -1, 3) AS substring_value,
      REPLICATE('x', -1) AS replicate_value,
      SPACE(-1) AS space_value,
      QUOTENAME('a"b', '"') AS quoted,
      QUOTENAME(REPLICATE('x', 129)) AS overlong
  `)
  expect(values.rows).toEqual([ {
    substring_value: 'a',
    replicate_value: null,
    space_value: null,
    quoted: '"a""b"',
    overlong: null
  } ])
  await expect(query('SELECT LEFT(\'abcdef\', -1) AS value'))
    .rejects.toMatchObject({ number: 536 })
  await expect(query('SELECT RIGHT(\'abcdef\', -1) AS value'))
    .rejects.toMatchObject({ number: 536 })
})

test('LIKE character classes and ESCAPE cross the tedious boundary', async () => {
  const result = await query(`
    SELECT CASE WHEN 'b' LIKE '[a-c]' THEN 1 ELSE 0 END AS range_hit,
      CASE WHEN 'z' LIKE '[^a-c]' THEN 1 ELSE 0 END AS negated_hit,
      CASE WHEN '[' LIKE '[[]' THEN 1 ELSE 0 END AS bracket_hit,
      CASE WHEN '%' LIKE '!%' ESCAPE '!' THEN 1 ELSE 0 END AS escaped_hit,
      CASE WHEN 'B' LIKE '[a-c]' THEN 1 ELSE 0 END AS folded_hit
  `)
  expect(result.rows).toEqual([ {
    range_hit: 1, negated_hit: 1, bracket_hit: 1, escaped_hit: 1, folded_hit: 1
  } ])

  const rpc = await query(`
    SELECT CASE WHEN @value LIKE @pattern THEN 1 ELSE 0 END AS matched
  `, [
    { name: 'value', type: TYPES.VarChar, value: 'c' },
    { name: 'pattern', type: TYPES.VarChar, value: '[a-c]' }
  ])
  expect(rpc.rows).toEqual([ { matched: 1 } ])
  await expect(query('SELECT 1 WHERE \'a\' LIKE \'a\' ESCAPE \'xx\''))
    .rejects.toMatchObject({ number: 506 })
})

test('character widths and fixed families cross the tedious boundary', async () => {
  const casts = await query(`
    SELECT
      CAST('abcdef' AS varchar(3)) AS varchar_value,
      CAST(N'abcdef' AS nvarchar(3)) AS nvarchar_value,
      CAST('a' AS char(3)) AS char_value,
      CAST(N'a' AS nchar(3)) AS nchar_value
  `)
  expect(casts.rows).toEqual([ {
    varchar_value: 'abc',
    nvarchar_value: 'abc',
    char_value: 'a  ',
    nchar_value: 'a  '
  } ])
  expect(casts.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'VarChar', 3 ], [ 'NVarChar', 6 ], [ 'Char', 3 ], [ 'NChar', 6 ]
  ])

  await query('CREATE TABLE wire_width (id int PRIMARY KEY, value varchar(3))')
  await expect(query('INSERT wire_width VALUES (1, \'toolong\')'))
    .rejects.toMatchObject({ number: 2628 })
  const count = await query('SELECT COUNT(*) AS count FROM wire_width')
  expect(count.rows).toEqual([ { count: 0 } ])

  const parameter = await query(`
    DECLARE @value varchar(3) = @input
    SELECT @value AS value
  `, [ { name: 'input', type: TYPES.NVarChar, value: 'abcdef' } ])
  expect(parameter.rows).toEqual([ { value: 'abc' } ])
  expect(parameter.columns).toMatchObject([ { type: 'VarChar', length: 3 } ])
})

test('ASCII and CHAR expose Windows-1252 values and varchar metadata over tedious', async () => {
  const result = await query(`
    SELECT ASCII('€') AS euro_byte, ASCII('A') AS ascii_byte,
      CHAR(128) AS euro_character, CHAR(65) AS ascii_character,
      CHAR(-1) AS negative_value, CHAR(256) AS overflow_value
  `)
  expect(result.rows).toEqual([ {
    euro_byte: 128,
    ascii_byte: 65,
    euro_character: '€',
    ascii_character: 'A',
    negative_value: null,
    overflow_value: null
  } ])
  expect(result.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'IntN', 4 ], [ 'IntN', 4 ],
    [ 'VarChar', 1 ], [ 'VarChar', 1 ], [ 'VarChar', 1 ], [ 'VarChar', 1 ]
  ])
})

test('UTF-16 code-unit string semantics cross the tedious boundary', async () => {
  const result = await query(`
    SELECT UNICODE(N'😀') AS first_unit, LEN(N'😀') AS unit_length,
      NCHAR(128512) AS out_of_range, NCHAR(55357) AS high_surrogate,
      SUBSTRING(N'A😀B', 3, 1) AS low_surrogate,
      LEFT(N'A😀B', 2) AS left_units,
      RIGHT(N'A😀B', 2) AS right_units,
      STUFF(N'A😀B', 2, 1, N'X') AS stuffed,
      REVERSE(N'A😀B') AS reversed
  `)
  expect(result.rows).toEqual([ {
    first_unit: 55357,
    unit_length: 2,
    out_of_range: null,
    high_surrogate: '\ud83d',
    low_surrogate: '\ude00',
    left_units: 'A\ud83d',
    right_units: '\ude00B',
    stuffed: 'AX\ude00B',
    reversed: 'B\ude00\ud83dA'
  } ])

  const rpc = await query('SELECT LEN(@value) AS length, UNICODE(@value) AS first_unit', [
    { name: 'value', type: TYPES.NVarChar, value: '😀' }
  ])
  expect(rpc.rows).toEqual([ { length: 2, first_unit: 55357 } ])
})

test('integer cast coercion crosses literals, empty text, and decimal RPC input', async () => {
  const result = await query(`
    SELECT CAST(1.9 AS int) AS positive_value,
      CAST(-1.9 AS int) AS negative_value,
      CAST('' AS smallint) AS empty_value,
      CAST('   ' AS bigint) AS spaces_value,
      TRY_CAST('bad' AS int) AS attempted
  `)
  expect(result.rows).toEqual([ {
    positive_value: 1,
    negative_value: -1,
    empty_value: 0,
    spaces_value: '0',
    attempted: null
  } ])
  expect(result.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'IntN', 4 ], [ 'IntN', 4 ], [ 'IntN', 2 ], [ 'IntN', 8 ], [ 'IntN', 4 ]
  ])

  const rpc = await query('SELECT CAST(@value AS int) AS value', [ {
    name: 'value', type: TYPES.Decimal, value: 9.9,
    options: { precision: 2, scale: 1 }
  } ])
  expect(rpc.rows).toEqual([ { value: 9 } ])
  await expect(query('SELECT CAST(2147483648 AS int) AS value'))
    .rejects.toMatchObject({ number: 8115 })
})

test('integer AVG and COUNT_BIG retain values and widths over tedious', async () => {
  const result = await query(`
    CREATE TABLE tedious_integer_aggregates (value int, big_value bigint)
    INSERT INTO tedious_integer_aggregates VALUES (1, 1), (2, 2), (NULL, NULL)
    SELECT AVG(value) AS average, AVG(big_value) AS big_average,
      COUNT_BIG(*) AS big_count
    FROM tedious_integer_aggregates
  `)
  expect(result.rows).toEqual([ { average: 1, big_average: '1', big_count: '3' } ])
  expect(result.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'IntN', 4 ], [ 'IntN', 8 ], [ 'IntN', 8 ]
  ])

  const empty = await query(`
    SELECT AVG(value) AS average, COUNT_BIG(*) AS big_count
    FROM tedious_integer_aggregates WHERE 1 = 0
  `)
  expect(empty.rows).toEqual([ { average: null, big_count: '0' } ])
  expect(empty.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'IntN', 4 ], [ 'IntN', 8 ]
  ])
})

test('implicit type precedence crosses predicates, RPC parameters and result metadata', async () => {
  const result = await query(`
    SELECT
      '1' + 2 AS arithmetic_value,
      CASE WHEN 1 = '1' THEN 1 ELSE 0 END AS comparison_value,
      CAST(1.5 AS decimal(4,1)) + CAST('2.5' AS varchar(3)) AS decimal_value,
      CAST(1.5 AS float) + CAST('2.5' AS varchar(3)) AS float_value,
      CAST(0x01 AS varbinary(1)) + CAST(0x02 AS varbinary(1)) AS binary_value
  `)
  expect(result.rows).toEqual([ {
    arithmetic_value: 3,
    comparison_value: 1,
    decimal_value: 4,
    float_value: 4,
    binary_value: Buffer.from([ 1, 2 ])
  } ])
  expect(result.columns.map(column => [ column.type, column.length ])).toEqual([
    [ 'IntN', 4 ], [ 'IntN', 4 ], [ 'DecimalN', 5 ], [ 'FloatN', 8 ], [ 'VarBinary', 2 ]
  ])

  const parameter = await query(
    'SELECT CASE WHEN @value = 2 THEN 1 ELSE 0 END AS matched',
    [ { name: 'value', type: TYPES.VarChar, value: '2' } ])
  expect(parameter.rows).toEqual([ { matched: 1 } ])
  await expect(query(
    'SELECT CASE WHEN @value = 2 THEN 1 ELSE 0 END AS matched',
    [ { name: 'value', type: TYPES.VarChar, value: 'x' } ]))
    .rejects.toMatchObject({ number: 245 })
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

test('tedious Attention cancels queued and running work while preserving transactions', async () => {
  await query('CREATE TABLE attention_rows (id INT PRIMARY KEY)')
  await new Promise<void>((resolve, reject) => {
    connection.beginTransaction(error => error ? reject(error) : resolve())
  })
  let leakedRows = 0
  const running = await new Promise<Error | undefined>(resolve => {
    const request = new Request(`
      INSERT INTO attention_rows VALUES (1)
      DECLARE @i INT = 0
      WHILE @i < 1000000 SET @i += 1
      SELECT @i AS leaked
    `, error => resolve(error ?? undefined))
    request.on('row', () => leakedRows++)
    connection.execSql(request)
    setTimeout(() => request.cancel(), 10)
  })
  expect(running).toMatchObject({ code: 'ECANCEL' })
  expect(leakedRows).toBe(0)
  expect((await query('SELECT COUNT(*) AS count FROM attention_rows')).rows)
    .toEqual([ { count: 1 } ])
  await new Promise<void>((resolve, reject) => {
    connection.rollbackTransaction(error => error ? reject(error) : resolve())
  })
  expect((await query('SELECT COUNT(*) AS count FROM attention_rows')).rows)
    .toEqual([ { count: 0 } ])

  const queued = await new Promise<Error | undefined>(resolve => {
    const request = new Request(
      'SELECT 99 AS never_returned', error => resolve(error ?? undefined))
    connection.execSql(request)
    request.cancel()
  })
  expect(queued).toMatchObject({ code: 'ECANCEL' })
  expect((await query('SELECT 7 AS reusable')).rows).toEqual([ { reusable: 7 } ])
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

test('system stored procedures execute through RPC with ODBC-style metadata', async () => {
  await query(`
    CREATE TABLE wire_system_items (
      id INT IDENTITY(1,1) PRIMARY KEY,
      label NVARCHAR(30) NOT NULL
    )
    INSERT INTO wire_system_items (label) VALUES (N'one'), (N'two')
  `)
  await query(`
    CREATE PROCEDURE dbo.wire_system_definition AS SELECT 1 AS one
  `)

  const help = await callSystem('SP_HELP', [ { name: 'objname', value: 'wire_system_items' } ])
  expect(help[0]?.columns).toEqual([ 'Name', 'Owner', 'Type', 'Created_datetime' ])
  expect(help[1]?.rows.map(row => row[0])).toEqual([ 'id', 'label' ])

  const helptext = await callSystem('sp_helptext', [
    { name: 'objname', value: 'dbo.wire_system_definition' }
  ])
  expect(helptext[0]?.columns).toEqual([ 'Text' ])
  expect(helptext[0]?.rows.map(row => row[0]).join('')).toContain('CREATE PROCEDURE')

  const columns = await callSystem('sp_columns', [
    { name: 'table_name', value: 'wire_system_items' }
  ])
  expect(columns[0]?.columns).toHaveLength(19)
  expect(columns[0]?.rows.map(row => row[3])).toEqual([ 'id', 'label' ])

  const tables = await callSystem('sp_tables', [
    { name: 'table_name', value: 'wire_system_items' }
  ])
  expect(tables[0]?.rows).toContainEqual([ 'master', 'dbo', 'wire_system_items', 'TABLE', null ])

  const who = await callSystem('sp_who')
  expect(who[0]?.columns).toContain('spid')
  expect(who[0]?.rows[0]?.[3]).toBe('sa')

  const helpdb = await callSystem('sp_helpdb', [ { name: 'dbname', value: 'master' } ])
  expect(helpdb).toHaveLength(2)
  expect(helpdb[0]?.rows[0]?.[0]).toBe('master')

  const space = await callSystem('sp_spaceused', [
    { name: 'objname', value: 'wire_system_items' }
  ])
  expect(space[0]?.rows[0]?.slice(0, 2)).toEqual([ 'wire_system_items', '2' ])

  await callSystem('sp_rename', [
    { name: 'objname', value: 'dbo.wire_system_items.label' },
    { name: 'newname', value: 'renamed_label' },
    { name: 'objtype', value: 'COLUMN' }
  ])
  expect((await query('SELECT renamed_label FROM wire_system_items ORDER BY id')).rows)
    .toEqual([ { renamed_label: 'one' }, { renamed_label: 'two' } ])
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
