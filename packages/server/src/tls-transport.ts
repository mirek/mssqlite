import { Duplex } from 'node:stream'
import { TLSSocket, type SecureContext } from 'node:tls'

export type Transport = {
  readonly socket: TLSSocket,
  readonly feed: (bytes: Uint8Array) => void,
  readonly end: () => void
}

/** Bridges Node TLS records to the TDS prelogin wrapper used during negotiation. */
export const transport =
  (
    secureContext: SecureContext,
    encryptedOutput: (bytes: Uint8Array) => void,
    clientCertificate: { readonly request: boolean, readonly rejectUnauthorized: boolean }
  ): Transport => {
    const encrypted = new Duplex({
      read: () => undefined,
      write: (chunk: Buffer, _encoding, callback) => {
        encryptedOutput(Uint8Array.from(chunk))
        callback()
      }
    })
    const socket = new TLSSocket(encrypted, {
      isServer: true,
      secureContext,
      requestCert: clientCertificate.request,
      rejectUnauthorized: clientCertificate.rejectUnauthorized
    })
    return {
      socket,
      feed: bytes => encrypted.push(Buffer.from(bytes)),
      end: () => encrypted.push(null)
    }
  }

export default transport
