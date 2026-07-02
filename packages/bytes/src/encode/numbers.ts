import fixed from './fixed.ts'

/** @returns unsigned 8-bit integer bytes. */
export const uint8 =
  (value: number): Uint8Array =>
    fixed(1, view => view.setUint8(0, value))

/** @returns signed 8-bit integer bytes. */
export const int8 =
  (value: number): Uint8Array =>
    fixed(1, view => view.setInt8(0, value))

/** @returns little-endian unsigned 16-bit integer bytes. */
export const uint16 =
  (value: number): Uint8Array =>
    fixed(2, view => view.setUint16(0, value, true))

/** @returns little-endian signed 16-bit integer bytes. */
export const int16 =
  (value: number): Uint8Array =>
    fixed(2, view => view.setInt16(0, value, true))

/** @returns big-endian unsigned 16-bit integer bytes. */
export const uint16be =
  (value: number): Uint8Array =>
    fixed(2, view => view.setUint16(0, value, false))

/** @returns little-endian unsigned 32-bit integer bytes. */
export const uint32 =
  (value: number): Uint8Array =>
    fixed(4, view => view.setUint32(0, value, true))

/** @returns little-endian signed 32-bit integer bytes. */
export const int32 =
  (value: number): Uint8Array =>
    fixed(4, view => view.setInt32(0, value, true))

/** @returns big-endian unsigned 32-bit integer bytes. */
export const uint32be =
  (value: number): Uint8Array =>
    fixed(4, view => view.setUint32(0, value, false))

/** @returns little-endian unsigned 64-bit integer bytes from a bigint or number. */
export const uint64 =
  (value: bigint | number): Uint8Array =>
    fixed(8, view => view.setBigUint64(0, BigInt(value), true))

/** @returns little-endian signed 64-bit integer bytes from a bigint or number. */
export const int64 =
  (value: bigint | number): Uint8Array =>
    fixed(8, view => view.setBigInt64(0, BigInt(value), true))

/** @returns little-endian 32-bit float bytes. */
export const float32 =
  (value: number): Uint8Array =>
    fixed(4, view => view.setFloat32(0, value, true))

/** @returns little-endian 64-bit float bytes. */
export const float64 =
  (value: number): Uint8Array =>
    fixed(8, view => view.setFloat64(0, value, true))
