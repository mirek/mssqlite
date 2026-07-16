import { Encode } from '@mssqlite/bytes'
import { Token, TypeInfo } from '@mssqlite/tds'
import type { Item, MssqlError, Value } from '@mssqlite/engine'

/** Column flags for engine metadata. */
const flagsOf =
  (nullable: boolean): number =>
    Token.flags({ nullable })

/** @returns token stream chunks for engine result items. */
export const itemTokens =
  (items: readonly Item[], serverName: string, inProcedure = false): Uint8Array[] => {
    const chunks: Uint8Array[] = []
    const doneToken = inProcedure ? Token.doneInProc : Token.done
    items.forEach((item, index) => {
      const last = index === items.length - 1
      const more = !last || inProcedure ? Token.Status.more : Token.Status.final
      switch (item.kind) {
        case 'rows': {
          const columns = item.columns.map(column => ({
            name: column.name,
            typeInfo: column.typeInfo,
            flags: flagsOf(column.nullable)
          }))
          chunks.push(Token.colMetadata(columns))
          for (const row of item.rows) {
            chunks.push(Token.row(columns, row))
          }
          chunks.push(doneToken(more | Token.Status.count, 0xc1, BigInt(item.rowCount)))
          break
        }
        case 'count':
          chunks.push(doneToken(more | Token.Status.count, 0xc3, BigInt(item.rowCount)))
          break
        case 'message':
          chunks.push(Token.info({
            number: 0,
            state: 1,
            class: 0,
            message: item.text,
            serverName
          }))
          if (last && !inProcedure) {
            chunks.push(doneToken(Token.Status.final, 0, 0n))
          }
          break
        case 'error':
          chunks.push(Token.error({
            number: item.error.number,
            state: item.error.state,
            class: item.error.severity,
            message: item.error.message,
            serverName,
            lineNumber: 1
          }))
          chunks.push(doneToken(more | Token.Status.error, 0, 0n))
          break
        default:
          break
      }
    })
    if (items.length === 0 && !inProcedure) {
      chunks.push(Token.done(Token.Status.final, 0, 0n))
    }
    return chunks
  }

/** @returns full response payload for a SQL batch. */
export const batchResponse =
  (items: readonly Item[], serverName: string): Uint8Array =>
    Encode.concat(...itemTokens(items, serverName))

/** @returns full response payload for an RPC — DONEINPROC stream, RETURNVALUEs, RETURNSTATUS, DONEPROC. */
export const rpcResponse =
  (items: readonly Item[], serverName: string, outputs: readonly { name: string, value: Value }[] = [], returnStatus = 0): Uint8Array =>
    Encode.concat(
      ...itemTokens(items, serverName, true),
      ...outputs.map((output, index) =>
        Token.returnValue({
          ordinal: index,
          name: output.name,
          typeInfo: outputTypeInfo(output.value),
          value: output.value
        })),
      Token.returnStatus(returnStatus),
      Token.doneProc(Token.Status.final, 0xe0, 0n)
    )

const outputTypeInfo =
  (value: Value): TypeInfo.t => {
    if (typeof value === 'number') {
      return Number.isInteger(value) && Math.abs(value) <= 2147483647 ?
        TypeInfo.intN(4) :
        TypeInfo.floatN(8)
    }
    if (typeof value === 'bigint') {
      return TypeInfo.intN(8)
    }
    if (typeof value === 'boolean') {
      return TypeInfo.bitN()
    }
    if (value instanceof Uint8Array) {
      return TypeInfo.varbinary('max')
    }
    return TypeInfo.nvarchar('max')
  }

/** @returns error response payload — ERROR token and a final DONE with the error flag. */
export const errorResponse =
  (error: MssqlError, serverName: string, inProcedure = false): Uint8Array =>
    Encode.concat(
      Token.error({
        number: error.number,
        state: error.state,
        class: error.severity,
        message: error.message,
        serverName,
        lineNumber: 1
      }),
      inProcedure ?
        Token.doneProc(Token.Status.final | Token.Status.error, 0, 0n) :
        Token.done(Token.Status.final | Token.Status.error, 0, 0n)
    )
