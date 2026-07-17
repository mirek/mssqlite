import { createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import {
  closeServer, server as engineServer, type Server as EngineServer
} from '@mssqlite/engine'
import { attach } from './connection.ts'
import { authenticator, type AuthenticationOptions } from './authentication.ts'
import { createSecureContext, type SecureContextOptions } from 'node:tls'

export type TlsOptions = SecureContextOptions & {
  /** Required by default; optional permits clients that explicitly cannot encrypt. */
  readonly mode?: 'optional' | 'required',
  readonly requestClientCertificate?: boolean,
  readonly rejectUnauthorized?: boolean
}

/** Server options. */
export type Options = {
  /** SQLite database path, `:memory:` by default. */
  readonly path?: string,
  readonly port?: number,
  readonly host?: string,
  readonly databaseName?: string,
  readonly serverName?: string,
  /** Required explicit SQL-login policy; insecure mode is development-only. */
  readonly authentication: AuthenticationOptions,
  /** TLS is disabled for local development unless a certificate and key are supplied. */
  readonly tls?: TlsOptions
}

/** Running server handle. */
export type Listening = {
  readonly port: number,
  readonly engine: EngineServer,
  readonly net: NetServer,
  readonly close: () => Promise<void>
}

/** Default MSSQL port. */
export const defaultPort = 1433

/** @returns listening TDS server over a SQLite database. */
export const listen =
  (options: Options): Promise<Listening> => {
    if (options.tls !== undefined && (options.tls.key === undefined || options.tls.cert === undefined)) {
      throw new TypeError('TLS requires both key and cert options.')
    }
    if (options.authentication === undefined) {
      throw new TypeError('Explicit authentication configuration is required.')
    }
    if (options.authentication.type === 'password' &&
      (options.tls === undefined || options.tls.mode === 'optional')) {
      throw new TypeError('Password authentication requires required TLS.')
    }
    const authenticate = authenticator(options.authentication)
    const encryption = options.tls === undefined ? undefined : (() => {
      const {
        mode = 'required', requestClientCertificate = false, rejectUnauthorized = false,
        ...secureContext
      } = options.tls
      return {
        context: createSecureContext({ minVersion: 'TLSv1.2', ...secureContext }),
        mode,
        requestClientCertificate,
        rejectUnauthorized
      }
    })()
    const engine = engineServer({
      ...options.path === undefined ? {} : { path: options.path },
      ...options.databaseName === undefined ? {} : { databaseName: options.databaseName },
      ...options.serverName === undefined ? {} : { serverName: options.serverName }
    })
    const net = createServer(socket => {
      attach(socket, engine, encryption, authenticate)
    })
    return new Promise((resolve, reject) => {
      net.once('error', reject)
      net.listen(options.port ?? defaultPort, options.host ?? '127.0.0.1', () => {
        const port = (net.address() as AddressInfo).port
        resolve({
          port,
          engine,
          net,
          close: () =>
            new Promise(resolveClose => {
              net.close(() => {
                closeServer(engine)
                resolveClose()
              })
            })
        })
      })
    })
  }

export default listen
