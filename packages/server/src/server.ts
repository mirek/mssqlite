import { createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { server as engineServer, type Server as EngineServer } from '@mssqlite/engine'
import { attach } from './connection.ts'

/** Server options. */
export type Options = {
  /** SQLite database path, `:memory:` by default. */
  readonly path?: string,
  readonly port?: number,
  readonly host?: string,
  readonly databaseName?: string,
  readonly serverName?: string
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
  (options: Options = {}): Promise<Listening> => {
    const engine = engineServer({
      ...options.path === undefined ? {} : { path: options.path },
      ...options.databaseName === undefined ? {} : { databaseName: options.databaseName },
      ...options.serverName === undefined ? {} : { serverName: options.serverName }
    })
    const net = createServer(socket => {
      attach(socket, engine)
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
                engine.db.close()
                resolveClose()
              })
            })
        })
      })
    })
  }

export default listen
