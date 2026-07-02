import fixed from './fixed.ts'
import type * as Read from '../read.ts'

/** Little-endian unsigned 8-bit integer decoder. */
export const uint8: Read.t<number> =
  fixed(1, (view, offset) => view.getUint8(offset))

/** Little-endian signed 8-bit integer decoder. */
export const int8: Read.t<number> =
  fixed(1, (view, offset) => view.getInt8(offset))

/** Little-endian unsigned 16-bit integer decoder. */
export const uint16: Read.t<number> =
  fixed(2, (view, offset) => view.getUint16(offset, true))

/** Little-endian signed 16-bit integer decoder. */
export const int16: Read.t<number> =
  fixed(2, (view, offset) => view.getInt16(offset, true))

/** Big-endian unsigned 16-bit integer decoder. */
export const uint16be: Read.t<number> =
  fixed(2, (view, offset) => view.getUint16(offset, false))

/** Little-endian unsigned 32-bit integer decoder. */
export const uint32: Read.t<number> =
  fixed(4, (view, offset) => view.getUint32(offset, true))

/** Little-endian signed 32-bit integer decoder. */
export const int32: Read.t<number> =
  fixed(4, (view, offset) => view.getInt32(offset, true))

/** Big-endian unsigned 32-bit integer decoder. */
export const uint32be: Read.t<number> =
  fixed(4, (view, offset) => view.getUint32(offset, false))

/** Little-endian unsigned 64-bit integer decoder producing a bigint. */
export const uint64: Read.t<bigint> =
  fixed(8, (view, offset) => view.getBigUint64(offset, true))

/** Little-endian signed 64-bit integer decoder producing a bigint. */
export const int64: Read.t<bigint> =
  fixed(8, (view, offset) => view.getBigInt64(offset, true))

/** Little-endian 32-bit float decoder. */
export const float32: Read.t<number> =
  fixed(4, (view, offset) => view.getFloat32(offset, true))

/** Little-endian 64-bit float decoder. */
export const float64: Read.t<number> =
  fixed(8, (view, offset) => view.getFloat64(offset, true))
