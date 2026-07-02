/**
 * Windows-1252 (the SQL_Latin1_General_CP1 code page) single-byte codec.
 * Differs from ISO-8859-1 only in 0x80–0x9F, which CP1252 maps to printable
 * characters (€, smart quotes, —, …) rather than C1 control codes.
 */

const decoder = new TextDecoder('windows-1252')

/** The 0x80–0x9F code points that differ from ISO-8859-1 (0 = undefined slot). */
const high = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178
] as const

const encodeMap = new Map<number, number>()
for (let i = 0; i < high.length; i++) {
  const codePoint = high[i] ?? 0
  if (codePoint !== 0) {
    encodeMap.set(codePoint, 0x80 + i)
  }
}

/** @returns Windows-1252 bytes of a string; unrepresentable characters become `?`. */
export const encode =
  (value: string): Uint8Array => {
    const bytes = new Uint8Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
        bytes[i] = code
      } else {
        bytes[i] = encodeMap.get(code) ?? 0x3f
      }
    }
    return bytes
  }

/** @returns string decoded from Windows-1252 bytes. */
export const decode =
  (bytes: Uint8Array): string =>
    decoder.decode(bytes)
