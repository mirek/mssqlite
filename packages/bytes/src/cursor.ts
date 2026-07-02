/** Immutable read position over a byte buffer. */
export type Cursor = {
  readonly bytes: Uint8Array,
  readonly view: DataView,
  readonly offset: number
}

export type t =
  Cursor

/** @returns cursor over `bytes` at optional `offset` (defaults to 0). */
export const of =
  (bytes: Uint8Array, offset = 0): Cursor => ({
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset
  })

/** @returns cursor advanced by `advance` bytes, sharing the underlying buffer. */
export const advanced =
  (cursor: Cursor, advance: number): Cursor => ({
    bytes: cursor.bytes,
    view: cursor.view,
    offset: cursor.offset + advance
  })

/** @returns number of bytes remaining after current offset. */
export const remaining =
  (cursor: Cursor): number =>
    cursor.bytes.byteLength - cursor.offset

/** @returns `true` if end of buffer has been reached, `false` otherwise. */
export const end =
  (cursor: Cursor): boolean =>
    remaining(cursor) <= 0

/** @returns byte at `offset` from current position, `undefined` if out of bounds. */
export const peek =
  (cursor: Cursor, offset = 0): undefined | number =>
    cursor.bytes[cursor.offset + offset]

/** @returns subarray of `length` bytes at `offset` relative to current position, sharing the underlying buffer. */
export const slice =
  (cursor: Cursor, offset: number, length: number): Uint8Array =>
    cursor.bytes.subarray(cursor.offset + offset, cursor.offset + offset + length)
