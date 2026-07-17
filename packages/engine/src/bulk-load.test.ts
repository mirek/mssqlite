import { afterEach, expect, test } from 'vitest'
import { BulkLoad as TdsBulkLoad, Token, TypeInfo } from '@mssqlite/tds'
import {
  abortBulkLoad,
  beginBulkLoad,
  closeServer,
  executeBatch,
  finishBulkLoad,
  prepareBulkLoad,
  server,
  session,
  writeBulkRows,
  type Server
} from './index.ts'

const servers: Server[] = []

afterEach(() => {
  for (const value of servers.splice(0)) {
    closeServer(value)
  }
})

const setup = () => {
  const engine = server()
  servers.push(engine)
  const active = session(engine)
  executeBatch(active, `
    CREATE TABLE bulk_rows (
      id int PRIMARY KEY,
      note nvarchar(5) NULL,
      amount decimal(10, 2) NOT NULL,
      fallback int NOT NULL DEFAULT 9
    )
  `)
  return active
}

const requiredPlan =
  (value: ReturnType<typeof prepareBulkLoad>) => {
    expect(value).toBeDefined()
    if (value === undefined) {
      throw new Error('Expected a bulk plan.')
    }
    return value
  }

const metadata: readonly TdsBulkLoad.Column[] = [
  { name: 'id', userType: 0, flags: Token.Flags.updateableReadWrite, typeInfo: TypeInfo.intN(4) },
  { name: 'note', userType: 0, flags: Token.Flags.nullable, typeInfo: TypeInfo.nvarchar(5) },
  { name: 'amount', userType: 0, flags: 0, typeInfo: TypeInfo.decimalN(10, 2) },
  { name: 'fallback', userType: 0, flags: 0, typeInfo: TypeInfo.intN(4) }
]

const sql = `INSERT BULK [dbo].[bulk_rows] (
  [id] int,
  [note] nvarchar(5),
  [amount] decimal(10, 2),
  [fallback] int
)`

test('bulk plans validate targets and execute mixed rows through cached inserts', () => {
  const active = setup()
  expect(prepareBulkLoad(active, 'SELECT 1')).toBeUndefined()
  expect(() => prepareBulkLoad(active, 'INSERT BULK missing ([id] int)'))
    .toThrowError(/Invalid object name/)
  expect(() => prepareBulkLoad(active, 'INSERT BULK bulk_rows ([missing] int)'))
    .toThrowError(/Invalid column name/)

  const plan = prepareBulkLoad(active, sql)
  expect(plan).toBeDefined()
  const loader = beginBulkLoad(requiredPlan(plan), metadata)
  writeBulkRows(loader, [
    [ 1, 'one', '12.30', null ],
    [ 2, null, '-0.25', 4 ]
  ])
  expect(finishBulkLoad(loader)).toBe(2)
  expect(executeBatch(active,
    'SELECT id, note, amount, fallback FROM bulk_rows ORDER BY id')[0]).toMatchObject({
    kind: 'rows',
    rows: [ [ 1, 'one', '12.30', 9 ], [ 2, null, '-0.25', 4 ] ]
  })
  expect(active.rowCount).toBe(2)
  expect(active.lastIdentity).toBeNull()
})

test('bulk failure and explicit cancellation roll back every row in the request', () => {
  const active = setup()
  const plan = requiredPlan(prepareBulkLoad(active, sql))
  const failed = beginBulkLoad(plan, metadata)
  expect(() => writeBulkRows(failed, [
    [ 1, 'first', '1.00', 1 ],
    [ 1, 'again', '2.00', 2 ]
  ])).toThrowError(/UNIQUE constraint/)
  abortBulkLoad(failed)
  expect(executeBatch(active, 'SELECT COUNT(*) AS count FROM bulk_rows')[0])
    .toMatchObject({ rows: [ [ 0 ] ] })

  const canceled = beginBulkLoad(plan, metadata)
  writeBulkRows(canceled, Array.from({ length: 5000 }, (_, index) =>
    [ index, `n${index % 100}`, `${index}.00`, index ]))
  abortBulkLoad(canceled)
  expect(executeBatch(active, 'SELECT COUNT(*) AS count FROM bulk_rows')[0])
    .toMatchObject({ rows: [ [ 0 ] ] })
})

test('bulk metadata, identity, null/default, conversion, and length invariants are enforced', () => {
  const active = setup()
  const plan = requiredPlan(prepareBulkLoad(active, sql))
  expect(() => beginBulkLoad(plan, metadata.slice(0, 3))).toThrowError(/metadata/)
  expect(() => prepareBulkLoad(active,
    'INSERT BULK bulk_rows ([id] int, [id] int)')).toThrowError(/Incorrect syntax/)

  const keepNulls = requiredPlan(prepareBulkLoad(active, `${sql} WITH (KEEP_NULLS)`))
  const nullLoader = beginBulkLoad(keepNulls, metadata)
  expect(() => writeBulkRows(nullLoader, [ [ 1, null, '1.00', null ] ]))
    .toThrowError(/NOT NULL constraint/)
  abortBulkLoad(nullLoader)

  const lengthLoader = beginBulkLoad(plan, metadata)
  expect(() => writeBulkRows(lengthLoader, [ [ 1, 'too long', '1.00', 1 ] ]))
    .toThrowError(/truncated/)
  abortBulkLoad(lengthLoader)

  executeBatch(active, 'CREATE TABLE identities (id int IDENTITY PRIMARY KEY, value int)')
  expect(() => prepareBulkLoad(active,
    'INSERT BULK identities ([id] int, [value] int)')).toThrowError(/KEEPIDENTITY/)
  expect(prepareBulkLoad(active,
    'INSERT BULK identities ([id] int, [value] int) WITH (KEEPIDENTITY)')).toBeDefined()
})

test('bulk load enforces and pads declared character widths', () => {
  const active = setup()
  executeBatch(active, 'CREATE TABLE bulk_characters (id int PRIMARY KEY, value char(5))')
  const plan = requiredPlan(prepareBulkLoad(active,
    'INSERT BULK bulk_characters ([id] int, [value] char(5))'))
  const columns: readonly TdsBulkLoad.Column[] = [
    { name: 'id', userType: 0, flags: 0, typeInfo: TypeInfo.intN(4) },
    { name: 'value', userType: 0, flags: 0, typeInfo: TypeInfo.char(5) }
  ]
  const loaded = beginBulkLoad(plan, columns)
  writeBulkRows(loaded, [ [ 1, 'a' ] ])
  finishBulkLoad(loaded)
  expect(executeBatch(active,
    'SELECT value, DATALENGTH(value) AS bytes FROM bulk_characters')[0])
    .toMatchObject({ rows: [ [ 'a    ', 5 ] ] })

  const overlong = beginBulkLoad(plan, columns)
  expect(() => writeBulkRows(overlong, [ [ 2, 'toolong' ] ]))
    .toThrowError(expect.objectContaining({ number: 2628 }) as Error)
  abortBulkLoad(overlong)
})

test('empty, transactional, and cross-database bulk requests retain engine semantics', () => {
  const active = setup()
  const plan = requiredPlan(prepareBulkLoad(active, sql))
  expect(finishBulkLoad(beginBulkLoad(plan, metadata))).toBe(0)

  executeBatch(active, 'BEGIN TRANSACTION')
  const transactional = beginBulkLoad(plan, metadata)
  writeBulkRows(transactional, [ [ 1, 'one', '1.00', 1 ] ])
  finishBulkLoad(transactional)
  executeBatch(active, 'ROLLBACK TRANSACTION')
  expect(executeBatch(active, 'SELECT COUNT(*) AS count FROM bulk_rows')[0])
    .toMatchObject({ rows: [ [ 0 ] ] })

  executeBatch(active, 'CREATE DATABASE bulk_other')
  executeBatch(active, 'CREATE TABLE bulk_other.dbo.items (id INT PRIMARY KEY, value INT)')
  const cross = requiredPlan(prepareBulkLoad(active,
    'INSERT BULK bulk_other.dbo.items ([id] int, [value] int)'))
  const crossMetadata: readonly TdsBulkLoad.Column[] = [
    { name: 'id', userType: 0, flags: 0, typeInfo: TypeInfo.intN(4) },
    { name: 'value', userType: 0, flags: 0, typeInfo: TypeInfo.intN(4) }
  ]
  const crossLoader = beginBulkLoad(cross, crossMetadata)
  writeBulkRows(crossLoader, [ [ 1, 42 ] ])
  finishBulkLoad(crossLoader)
  expect(executeBatch(active, 'SELECT id, value FROM bulk_other.dbo.items')[0])
    .toMatchObject({ rows: [ [ 1, 42 ] ] })

  executeBatch(active, 'BEGIN TRANSACTION')
  const crossTransactional = beginBulkLoad(cross, crossMetadata)
  writeBulkRows(crossTransactional, [ [ 2, 84 ] ])
  finishBulkLoad(crossTransactional)
  executeBatch(active, 'ROLLBACK TRANSACTION')
  expect(executeBatch(active, 'SELECT id, value FROM bulk_other.dbo.items ORDER BY id')[0])
    .toMatchObject({ rows: [ [ 1, 42 ] ] })
})
