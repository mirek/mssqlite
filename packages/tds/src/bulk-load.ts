import { Cursor, Decode, Encode, Result, type Read } from '@mssqlite/bytes'
import * as DataType from './data-type.ts'
import * as Decimal from './decimal.ts'
import { Token } from './token.ts'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

const maximumColumns = 1024
const maximumPendingBytes = 16 * 1024 * 1024

/** Client-declared bulk column metadata. */
export type Column = {
  readonly name: string,
  readonly userType: number,
  readonly flags: number,
  readonly typeInfo: TypeInfo.t
}

export type State = {
  /** At most one incomplete metadata/value token; complete rows are emitted immediately. */
  readonly pending: Uint8Array,
  readonly columns: readonly Column[] | undefined,
  readonly done: boolean
}

export type Chunk = {
  readonly state: State,
  readonly rows: readonly (readonly Value.t[])[]
}

export const initial: State = {
  pending: new Uint8Array(0),
  columns: undefined,
  done: false
}

const incomplete =
  (reason: string): boolean => reason.includes('Expected ')

const unsupported =
  (cursor: Cursor.t, message: string): Result.Fail => Result.fail(cursor, message)

const numericLengths: Record<number, readonly number[]> = {
  [DataType.DataType.guid]: [ 16 ],
  [DataType.DataType.intN]: [ 1, 2, 4, 8 ],
  [DataType.DataType.bitN]: [ 1 ],
  [DataType.DataType.floatN]: [ 4, 8 ],
  [DataType.DataType.moneyN]: [ 4, 8 ],
  [DataType.DataType.datetimeN]: [ 4, 8 ]
}

const validDecimal =
  ({ maxLength, precision, scale }: TypeInfo.t): boolean =>
    precision !== undefined && precision >= 1 && precision <= 38 &&
    scale !== undefined && scale >= 0 && scale <= precision &&
    maxLength === Decimal.length(precision)

const validUnicodeLength =
  ({ type, maxLength }: TypeInfo.t): boolean =>
    ![ DataType.DataType.nvarchar, DataType.DataType.nchar, DataType.DataType.ntext ]
      .includes(type as never) || maxLength === undefined ||
    maxLength === TypeInfo.plpMarker || maxLength % 2 === 0

const validType =
  (typeInfo: TypeInfo.t): boolean => {
    const { type, maxLength, scale } = typeInfo
    if (type === DataType.DataType.xml || type === DataType.DataType.udt ||
      type === DataType.DataType.json || type === DataType.DataType.nullType) {
      return false
    }
    if (maxLength !== undefined && maxLength < 0) {
      return false
    }
    if (DataType.family(type) === 'decimal') {
      return validDecimal(typeInfo)
    }
    if (DataType.family(type) === 'scaled') {
      return scale !== undefined && scale >= 0 && scale <= 7
    }
    const allowed = numericLengths[type]
    if (allowed !== undefined) {
      return maxLength !== undefined && allowed.includes(maxLength)
    }
    return validUnicodeLength(typeInfo) && DataType.family(type) !== undefined
  }

const metadataColumn: Read.t<Column> =
  cursor => {
    const header = Decode.seq(Decode.uint32, Decode.uint16)(cursor)
    if (Result.failed(header)) {
      return header
    }
    const [ userType, flags ] = header.value
    if ((flags & 0x0800) !== 0) {
      return unsupported(cursor, 'Encrypted bulk columns are unsupported.')
    }
    const type = TypeInfo.decode(header.cursor)
    if (Result.failed(type)) {
      return type
    }
    if (!validType(type.value)) {
      return unsupported(cursor,
        `Unsupported bulk TYPE_INFO 0x${type.value.type.toString(16)}.`)
    }
    let next = type.cursor
    if ([ DataType.DataType.image, DataType.DataType.text, DataType.DataType.ntext ]
      .includes(type.value.type as never)) {
      const tableName = Decode.usVarchar(next)
      if (Result.failed(tableName)) {
        return tableName
      }
      next = tableName.cursor
    }
    const name = Decode.bVarchar(next)
    return Result.failed(name) ? name : Result.ok(name.cursor, {
      name: name.value,
      userType,
      flags,
      typeInfo: type.value
    })
  }

const metadata: Read.t<readonly Column[]> =
  cursor => {
    const token = Decode.uint8(cursor)
    if (Result.failed(token)) {
      return token
    }
    if (token.value !== Token.colMetadata) {
      return unsupported(cursor, 'Bulk load must begin with COLMETADATA.')
    }
    const count = Decode.uint16(token.cursor)
    if (Result.failed(count)) {
      return count
    }
    if (count.value === 0xffff || count.value > maximumColumns) {
      return unsupported(cursor, `Invalid bulk column count ${count.value}.`)
    }
    let next = count.cursor
    const columns: Column[] = []
    for (let index = 0; index < count.value; index++) {
      const column = metadataColumn(next)
      if (Result.failed(column)) {
        return column
      }
      columns.push(column.value)
      next = column.cursor
    }
    return Result.ok(next, columns)
  }

const legacyValue =
  (typeInfo: TypeInfo.t): Read.t<Value.t> =>
    cursor => {
      const pointerLength = Decode.uint8(cursor)
      if (Result.failed(pointerLength)) {
        return pointerLength
      }
      if (pointerLength.value === 0) {
        return Result.ok(pointerLength.cursor, null)
      }
      const prefix = Decode.bytes(pointerLength.value + 8)(pointerLength.cursor)
      return Result.failed(prefix) ? prefix : Value.decode(typeInfo)(prefix.cursor)
    }

const row =
  (columns: readonly Column[]): Read.t<readonly Value.t[]> =>
    cursor => {
      const token = Decode.uint8(cursor)
      if (Result.failed(token)) {
        return token
      }
      if (token.value !== Token.row) {
        return unsupported(cursor, 'Expected a bulk ROW token.')
      }
      let next = token.cursor
      const values: Value.t[] = []
      for (const column of columns) {
        const reader = [ DataType.DataType.image, DataType.DataType.text, DataType.DataType.ntext ]
          .includes(column.typeInfo.type as never) ? legacyValue(column.typeInfo) : Value.decode(column.typeInfo)
        const value = reader(next)
        if (Result.failed(value)) {
          return value
        }
        values.push(value.value)
        next = value.cursor
      }
      return Result.ok(next, values)
    }

const done: Read.t<void> =
  cursor => {
    const value = Decode.seq(Decode.uint8, Decode.uint16, Decode.uint16, Decode.uint64)(cursor)
    if (Result.failed(value)) {
      return value
    }
    const [ token, status ] = value.value
    if (token !== Token.done || (status & 0x0001) !== 0) {
      return unsupported(cursor, 'Bulk load must end with a final DONE token.')
    }
    return Result.ok(value.cursor, undefined)
  }

const retained =
  (bytes: Uint8Array, offset: number): Uint8Array =>
    offset >= bytes.byteLength ? new Uint8Array(0) : Uint8Array.from(bytes.subarray(offset))

type DecodedRows = {
  readonly cursor: Cursor.t,
  readonly rows: readonly (readonly Value.t[])[],
  readonly complete: boolean
}

const decodeRows =
  (columns: readonly Column[], start: Cursor.t, end: boolean, alreadyDone: boolean): Result.t<DecodedRows> => {
    let cursor = start
    let complete = alreadyDone
    const rows: (readonly Value.t[])[] = []
    while (!complete && !Cursor.end(cursor)) {
      const at = cursor.offset
      const token = Cursor.peek(cursor)
      const decoded = token === Token.done ? done(cursor) :
        token === Token.nbcRow ? unsupported(cursor, 'NBCROW is forbidden in bulk load streams.') :
          row(columns)(cursor)
      if (Result.failed(decoded)) {
        if (!end && incomplete(decoded.reason)) {
          return Result.ok(Cursor.of(cursor.bytes, at), {
            cursor: Cursor.of(cursor.bytes, at), rows, complete
          })
        }
        return decoded
      }
      if (token === Token.done) {
        complete = true
      } else {
        rows.push(decoded.value as readonly Value.t[])
      }
      cursor = decoded.cursor
    }
    return Result.ok(cursor, { cursor, rows, complete })
  }

/**
 * Incrementally decodes one BulkLoadBCP stream. Complete rows are returned on
 * every push and removed from decoder memory. Set `end` on the EOM packet.
 */
export const push =
  (
    state: State,
    input: Uint8Array,
    end = false,
    allowEomWithoutDone = false
  ): Result.t<Chunk> => {
    if (state.done && input.byteLength > 0) {
      return Result.fail(Cursor.of(input), 'Trailing bytes follow the bulk DONE token.')
    }
    const bytes = state.pending.byteLength === 0 ? input : Encode.concat(state.pending, input)
    if (bytes.byteLength > maximumPendingBytes) {
      return Result.fail(Cursor.of(bytes),
        `An incomplete bulk value exceeds ${maximumPendingBytes} buffered bytes.`)
    }
    let cursor = Cursor.of(bytes)
    let columns = state.columns
    const noRows: readonly (readonly Value.t[])[] = []
    if (columns === undefined) {
      const decoded = metadata(cursor)
      if (Result.failed(decoded)) {
        if (!end && incomplete(decoded.reason)) {
          return Result.ok(Cursor.of(input), {
            state: { ...state, pending: Uint8Array.from(bytes) }, rows: noRows
          })
        }
        return Result.fail(Cursor.of(input), decoded.reason)
      }
      columns = decoded.value
      cursor = decoded.cursor
    }
    const decodedRows = decodeRows(columns, cursor, end, state.done)
    if (Result.failed(decodedRows)) {
      return Result.fail(Cursor.of(input), decodedRows.reason)
    }
    cursor = decodedRows.value.cursor
    const rows = decodedRows.value.rows
    let complete = decodedRows.value.complete
    const pending = retained(bytes, cursor.offset)
    if (complete && pending.byteLength > 0) {
      return Result.fail(Cursor.of(input), 'Trailing bytes follow the bulk DONE token.')
    }
    if (end && !complete && allowEomWithoutDone && pending.byteLength === 0 && columns !== undefined) {
      complete = true
    }
    if (end && (!complete || pending.byteLength > 0)) {
      return Result.fail(Cursor.of(input), 'Truncated bulk load stream.')
    }
    return Result.ok(Cursor.of(input), {
      state: { pending, columns, done: complete },
      rows
    })
  }
