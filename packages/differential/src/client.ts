import { Connection } from 'tedious'

export type Endpoint = {
  readonly host: string,
  readonly port: number,
  readonly database: string,
  readonly user: string,
  readonly password: string
}

/** Opens the tedious configuration shared by both comparison targets. */
export const connect =
  (endpoint: Endpoint): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const connection = new Connection({
        server: endpoint.host,
        authentication: {
          type: 'default',
          options: { userName: endpoint.user, password: endpoint.password }
        },
        options: {
          port: endpoint.port,
          database: endpoint.database,
          encrypt: false,
          trustServerCertificate: true,
          useColumnNames: false,
          rowCollectionOnRequestCompletion: false,
          connectTimeout: 5000,
          requestTimeout: 15000
        }
      })
      connection.connect(error => error === undefined ? resolve(connection) : reject(error))
    })

export const close =
  (connection: Connection): Promise<void> =>
    new Promise(resolve => {
      connection.once('end', resolve)
      connection.close()
    })
