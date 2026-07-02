/** @returns bytes parsed from a hex string, ignoring whitespace. */
export const of =
  (hex: string): Uint8Array => {
    const compact = hex.replace(/\s+/g, '')
    const bytes = new Uint8Array(compact.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(compact.slice(i * 2, (i * 2) + 2), 16)
    }
    return bytes
  }

/** @returns lowercase hex string of provided bytes. */
export const string =
  (bytes: Uint8Array): string =>
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
