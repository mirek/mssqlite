/**
 * @returns little-endian unsigned integer bytes spanning `byteLength` bytes (1-6).
 * Value must stay within `Number.MAX_SAFE_INTEGER`.
 */
export const uintLe =
  (value: number, byteLength: number): Uint8Array => {
    const bytes = new Uint8Array(byteLength)
    let rest = value
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = rest % 0x100
      rest = Math.floor(rest / 0x100)
    }
    return bytes
  }

export default uintLe
