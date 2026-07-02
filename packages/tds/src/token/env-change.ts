import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** ENVCHANGE types. */
export const Type = {
  database: 1,
  language: 2,
  characterSet: 3,
  packetSize: 4,
  collation: 7,
  beginTransaction: 8,
  commitTransaction: 9,
  rollbackTransaction: 10
} as const

const envChange =
  (body: Uint8Array): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.envChange),
      Encode.uint16(body.byteLength),
      body
    )

const varcharPair =
  (type: number, newValue: string, oldValue: string): Uint8Array =>
    envChange(Encode.concat(
      Encode.uint8(type),
      Encode.bVarchar(newValue),
      Encode.bVarchar(oldValue)
    ))

/** @returns ENVCHANGE database token bytes. */
export const database =
  (newValue: string, oldValue: string): Uint8Array =>
    varcharPair(Type.database, newValue, oldValue)

/** @returns ENVCHANGE language token bytes. */
export const language =
  (newValue: string, oldValue = ''): Uint8Array =>
    varcharPair(Type.language, newValue, oldValue)

/** @returns ENVCHANGE packet size token bytes. */
export const packetSize =
  (newValue: number, oldValue: number): Uint8Array =>
    varcharPair(Type.packetSize, String(newValue), String(oldValue))

/** @returns ENVCHANGE SQL collation token bytes — values are raw 5-byte collations. */
export const collation =
  (newValue: Uint8Array, oldValue = new Uint8Array(0)): Uint8Array =>
    envChange(Encode.concat(
      Encode.uint8(Type.collation),
      Encode.bVarbyte(newValue),
      Encode.bVarbyte(oldValue)
    ))

/** @returns ENVCHANGE begin transaction token bytes with an 8-byte descriptor. */
export const beginTransaction =
  (descriptor: bigint): Uint8Array =>
    envChange(Encode.concat(
      Encode.uint8(Type.beginTransaction),
      Encode.bVarbyte(Encode.uint64(descriptor)),
      Encode.uint8(0)
    ))

/** @returns ENVCHANGE commit transaction token bytes. */
export const commitTransaction =
  (descriptor: bigint): Uint8Array =>
    envChange(Encode.concat(
      Encode.uint8(Type.commitTransaction),
      Encode.uint8(0),
      Encode.bVarbyte(Encode.uint64(descriptor))
    ))

/** @returns ENVCHANGE rollback transaction token bytes. */
export const rollbackTransaction =
  (descriptor: bigint): Uint8Array =>
    envChange(Encode.concat(
      Encode.uint8(Type.rollbackTransaction),
      Encode.uint8(0),
      Encode.bVarbyte(Encode.uint64(descriptor))
    ))
