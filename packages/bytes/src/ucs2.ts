import { Buffer } from 'node:buffer'

/** @returns UTF-16LE (UCS-2) bytes of provided string. */
export const encode =
  (value: string): Uint8Array => {
    const buffer = Buffer.from(value, 'utf16le')
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

/** @returns string decoded from UTF-16LE (UCS-2) bytes. */
export const decode =
  (bytes: Uint8Array): string =>
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf16le')
