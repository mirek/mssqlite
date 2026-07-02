/** @returns `size` bytes written into a fresh buffer by `set`. */
export const fixed =
  (size: number, set: (view: DataView) => void): Uint8Array => {
    const bytes = new Uint8Array(size)
    set(new DataView(bytes.buffer))
    return bytes
  }

export default fixed
