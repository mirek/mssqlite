/** @returns single buffer with all provided chunks concatenated. */
export const concat =
  (...chunks: readonly Uint8Array[]): Uint8Array => {
    let length = 0
    for (const chunk of chunks) {
      length += chunk.byteLength
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

export default concat
