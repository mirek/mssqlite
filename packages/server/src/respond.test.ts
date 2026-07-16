import { expect, test } from 'vitest'
import { Hex } from '@mssqlite/bytes'
import { batchResponse, rpcResponse } from './respond.ts'
import type { Item } from '@mssqlite/engine'

const hidden: Item =
  { kind: 'count', rowCount: 3, countValid: false }

test('NOCOUNT clears DONE_COUNT and zeroes the batch DONE row count', () => {
  expect(batchResponse([ hidden ], 'mssqlite')).toEqual(Hex.of(
    'FD 00 00 C3 00 00 00 00 00 00 00 00 00'))
  expect(batchResponse([ { kind: 'count', rowCount: 3 } ], 'mssqlite')).toEqual(Hex.of(
    'FD 10 00 C3 00 03 00 00 00 00 00 00 00'))
})

test('NOCOUNT clears DONEINPROC count while preserving final DONEPROC', () => {
  expect(rpcResponse([ hidden ], 'mssqlite')).toEqual(Hex.of(`
    FF 01 00 C3 00 00 00 00 00 00 00 00 00
    79 00 00 00 00
    FE 00 00 E0 00 00 00 00 00 00 00 00 00
  `))
})

test('mid-batch count visibility is encoded independently per DONE token', () => {
  const items: Item[] = [ hidden, { kind: 'count', rowCount: 2 } ]
  expect(batchResponse(items, 'mssqlite')).toEqual(Hex.of(`
    FD 01 00 C3 00 00 00 00 00 00 00 00 00
    FD 10 00 C3 00 02 00 00 00 00 00 00 00
  `))
})
