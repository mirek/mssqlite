import { Hex } from '@mssqlite/bytes'

/**
 * Byte positions of the canonical GUID string within the 16 wire bytes —
 * Data1/Data2/Data3 little-endian, Data4 in network order.
 */
const order = [ 3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15 ] as const

/** @returns 16 mixed-endian wire bytes of an `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` GUID string. */
export const encode =
  (guid: string): Uint8Array => {
    const canonical = Hex.of(guid.replaceAll('-', ''))
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      bytes[i] = canonical[order[i] ?? i] ?? 0
    }
    return bytes
  }

/** @returns uppercase canonical GUID string of 16 mixed-endian wire bytes. */
export const decode =
  (bytes: Uint8Array): string => {
    const canonical = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      canonical[order[i] ?? i] = bytes[i] ?? 0
    }
    const hex = Hex.string(canonical).toUpperCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
