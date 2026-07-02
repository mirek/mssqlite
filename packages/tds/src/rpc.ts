import { Cursor, Decode, Result } from '@mssqlite/bytes'
import * as AllHeaders from './all-headers.ts'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

/** Well-known system stored procedure ids. */
export const ProcId = {
  cursor: 1,
  cursorOpen: 2,
  cursorPrepare: 3,
  cursorExecute: 4,
  cursorPrepExec: 5,
  cursorUnprepare: 6,
  cursorFetch: 7,
  cursorOption: 8,
  cursorClose: 9,
  executeSql: 10,
  prepare: 11,
  execute: 12,
  prepExec: 13,
  prepExecRpc: 14,
  unprepare: 15
} as const

/** Parameter status flags. */
export const ParameterStatus = {
  byRefValue: 0x01,
  defaultValue: 0x02,
  encrypted: 0x08
} as const

/** Decoded RPC parameter. */
export type Parameter = {
  readonly name: string,
  readonly status: number,
  readonly typeInfo: TypeInfo.t,
  readonly value: Value.t
}

/** Decoded RPC request. */
export type Rpc = {
  readonly headers: AllHeaders.t,
  /** Procedure name, or well-known id when addressed by ProcID. */
  readonly procedure: string | number,
  readonly optionFlags: number,
  readonly parameters: readonly Parameter[]
}

export type t =
  Rpc

/** @returns decoded RPC request from a full message payload, `undefined` on malformed input. */
export const decode =
  (payload: Uint8Array): Rpc | undefined => {
    const headers = AllHeaders.decode(payload)
    if (headers === undefined) {
      return undefined
    }
    let cursor = Cursor.of(payload, headers.length)
    const nameLength = Decode.uint16(cursor)
    if (Result.failed(nameLength)) {
      return undefined
    }
    let procedure: string | number
    if (nameLength.value === 0xffff) {
      const procId = Decode.uint16(nameLength.cursor)
      if (Result.failed(procId)) {
        return undefined
      }
      procedure = procId.value
      cursor = procId.cursor
    } else {
      const name = Decode.ucs2Chars(nameLength.value)(nameLength.cursor)
      if (Result.failed(name)) {
        return undefined
      }
      procedure = name.value
      cursor = name.cursor
    }
    const flags = Decode.uint16(cursor)
    if (Result.failed(flags)) {
      return undefined
    }
    const optionFlags = flags.value
    cursor = flags.cursor
    const parameters: Parameter[] = []
    while (!Cursor.end(cursor)) {
      const name = Decode.bVarchar(cursor)
      if (Result.failed(name)) {
        return undefined
      }
      const status = Decode.uint8(name.cursor)
      if (Result.failed(status)) {
        return undefined
      }
      const typeInfo = TypeInfo.decode(status.cursor)
      if (Result.failed(typeInfo)) {
        return undefined
      }
      const value = Value.decode(typeInfo.value)(typeInfo.cursor)
      if (Result.failed(value)) {
        return undefined
      }
      parameters.push({
        name: name.value,
        status: status.value,
        typeInfo: typeInfo.value,
        value: value.value
      })
      cursor = value.cursor
    }
    return { headers, procedure, optionFlags, parameters }
  }
