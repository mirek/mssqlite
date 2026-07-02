import { expect, test } from 'vitest'
import { Encode, Hex } from '@mssqlite/bytes'
import * as AllHeaders from './all-headers.ts'
import * as Rpc from './rpc.ts'
import * as SqlBatch from './sql-batch.ts'
import * as TransactionManager from './transaction-manager.ts'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

test('all headers encode/decode round trips', () => {
  const bytes = AllHeaders.encode(42n, 1)
  const headers = AllHeaders.decode(bytes)
  expect(headers).toEqual({
    length: 22,
    transactionDescriptor: 42n,
    outstandingRequestCount: 1
  })
})

test('sql batch round trips', () => {
  const payload = SqlBatch.encode('SELECT 1 AS x')
  const batch = SqlBatch.decode(payload)
  expect(batch?.sql).toBe('SELECT 1 AS x')
  expect(batch?.headers.transactionDescriptor).toBe(0n)
})

test('sql batch decodes MS-TDS example headers', () => {
  const payload = Encode.concat(
    Hex.of('16 00 00 00 12 00 00 00 02 00 00 00 00 00 00 00 00 01 00 00 00 00'),
    Encode.ucs2('select 1')
  )
  const batch = SqlBatch.decode(payload)
  expect(batch?.sql).toBe('select 1')
})

test('rpc named procedure with default parameter matches MS-TDS example', () => {
  const payload = Encode.concat(
    AllHeaders.encode(),
    Hex.of('04 00 66 00 6F 00 6F 00 33 00'), // "foo3"
    Hex.of('00 00'), // option flags
    Hex.of('00 02 26 02 00') // unnamed, default value, INTN(2), null
  )
  const rpc = Rpc.decode(payload)
  expect(rpc?.procedure).toBe('foo3')
  expect(rpc?.parameters).toHaveLength(1)
  expect(rpc?.parameters[0]).toMatchObject({
    name: '',
    status: Rpc.ParameterStatus.defaultValue,
    value: null
  })
})

test('rpc sp_executesql by id with typed parameters', () => {
  const sql = 'SELECT @x AS x'
  const payload = Encode.concat(
    AllHeaders.encode(),
    Encode.uint16(0xffff),
    Encode.uint16(Rpc.ProcId.executeSql),
    Encode.uint16(0),
    Encode.bVarchar(''),
    Encode.uint8(0),
    TypeInfo.encode(TypeInfo.nvarchar(sql.length)),
    Value.encode(TypeInfo.nvarchar(sql.length), sql),
    Encode.bVarchar('@x int'),
    Encode.uint8(0),
    TypeInfo.encode(TypeInfo.nvarchar(6)),
    Value.encode(TypeInfo.nvarchar(6), '@x int'),
    Encode.bVarchar('@x'),
    Encode.uint8(0),
    TypeInfo.encode(TypeInfo.intN(4)),
    Value.encode(TypeInfo.intN(4), 42)
  )
  const rpc = Rpc.decode(payload)
  expect(rpc?.procedure).toBe(Rpc.ProcId.executeSql)
  expect(rpc?.parameters.map(parameter => parameter.value)).toEqual([ sql, '@x int', 42 ])
})

test('transaction manager begin/commit/rollback', () => {
  const begin = Encode.concat(
    AllHeaders.encode(),
    Encode.uint16(TransactionManager.Type.beginXact),
    Encode.uint8(TransactionManager.IsolationLevel.readCommitted),
    Encode.uint8(0)
  )
  expect(TransactionManager.decode(begin)).toMatchObject({
    type: TransactionManager.Type.beginXact,
    isolationLevel: TransactionManager.IsolationLevel.readCommitted,
    name: ''
  })
  const commit = Encode.concat(
    AllHeaders.encode(7n),
    Encode.uint16(TransactionManager.Type.commitXact),
    Encode.uint8(0),
    Encode.uint8(0)
  )
  const decoded = TransactionManager.decode(commit)
  expect(decoded).toMatchObject({ type: TransactionManager.Type.commitXact })
  expect(decoded?.headers.transactionDescriptor).toBe(7n)
})
