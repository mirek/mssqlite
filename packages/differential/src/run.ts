import { setTimeout as delay } from 'node:timers/promises'
import { listen, type Listening } from '@mssqlite/server'
import type { Connection } from 'tedious'
import { capture } from './capture.ts'
import { close, connect, type Endpoint } from './client.ts'
import { snapshots } from './compare.ts'
import { corpus } from './corpus.ts'
import * as Docker from './docker.ts'
import { execute, successful } from './execute.ts'
import { reproduction } from './reproduction.ts'
import type { CaseResult } from './types.ts'

type Running = {
  readonly container: Docker.Container,
  readonly local: Listening,
  readonly sqlAdmin: Connection,
  readonly sqlServer: Connection,
  readonly mssqlite: Connection,
  readonly database: string
}

const endpoint =
  (
    port: number,
    database: string,
    password: string
  ): Endpoint => ({
    host: '127.0.0.1',
    port,
    database,
    user: 'sa',
    password
  })

const waitForSqlServer =
  async (container: Docker.Container): Promise<Connection> => {
    let lastError: unknown
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        return await connect(endpoint(container.port, 'master', container.password))
      } catch (error) {
        lastError = error
        await delay(1000)
      }
    }
    throw new Error(
      `SQL Server did not become ready: ${String(lastError)}\n${await Docker.logs(container)}`)
  }

const closeConnection =
  async (connection: Connection): Promise<void> => {
    try {
      await close(connection)
    } catch {
      // Continue cleanup when one peer already closed the socket.
    }
  }

const start =
  async (): Promise<Running> => {
    const container = await Docker.start()
    let sqlAdmin: Connection | undefined
    let sqlServer: Connection | undefined
    let local: Listening | undefined
    let mssqlite: Connection | undefined
    try {
      sqlAdmin = await waitForSqlServer(container)
      const database = `mssqlite_differential_${process.pid}`
      const created = await execute(sqlAdmin,
        `CREATE DATABASE [${database}] COLLATE SQL_Latin1_General_CP1_CI_AS`)
      successful(created, 'SQL Server database creation failed')
      sqlServer = await connect(endpoint(container.port, database, container.password))
      local = await listen({
        path: ':memory:',
        port: 0,
        databaseName: database,
        authentication: { type: 'insecure' }
      })
      mssqlite = await connect(endpoint(local.port, database, 'secret'))
      for (const connection of [ sqlServer, mssqlite ]) {
        const initialized = await execute(connection, 'SET NOCOUNT OFF; SET XACT_ABORT OFF')
        successful(initialized, 'session initialization failed')
      }
      return { container, local, sqlAdmin, sqlServer, mssqlite, database }
    } catch (error) {
      if (mssqlite !== undefined) {
        await closeConnection(mssqlite)
      }
      if (local !== undefined) {
        await local.close()
      }
      if (sqlServer !== undefined) {
        await closeConnection(sqlServer)
      }
      if (sqlAdmin !== undefined) {
        await closeConnection(sqlAdmin)
      }
      await Docker.stop(container)
      throw error
    }
  }

const stop =
  async (running: Running): Promise<void> => {
    await closeConnection(running.mssqlite)
    await closeConnection(running.sqlServer)
    try {
      const dropped = await execute(running.sqlAdmin,
        `ALTER DATABASE [${running.database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ` +
        `DROP DATABASE [${running.database}]`)
      successful(dropped, 'SQL Server database cleanup failed')
    } finally {
      await closeConnection(running.sqlAdmin)
      await running.local.close()
      await Docker.stop(running.container)
    }
  }

/** Runs the shared corpus against both TDS endpoints. */
export const run =
  async (): Promise<{ readonly image: string, readonly results: readonly CaseResult[] }> => {
    const running = await start()
    try {
      const results: CaseResult[] = []
      for (const value of corpus) {
        const mssqlite = await capture(running.mssqlite, value)
        const sqlServer = await capture(running.sqlServer, value)
        results.push({
          case: value,
          mssqlite,
          sqlServer,
          comparison: snapshots(mssqlite, sqlServer, value.differences),
          reproduction: reproduction(value)
        })
      }
      return { image: running.container.image, results }
    } finally {
      await stop(running)
    }
  }
