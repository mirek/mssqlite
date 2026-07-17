import { execFile as execFile_, type ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFile_)

export const defaultImage =
  'mcr.microsoft.com/mssql/server:2025-latest@sha256:' +
  '86cc6144ef39bb0fbed2329e1ad79b13ee82e7b2e4739213a0db0800e668a74a'

export type Container = {
  readonly name: string,
  readonly port: number,
  readonly password: string,
  readonly image: string
}

const output =
  async (...args: readonly string[]): Promise<string> => {
    const result = await execFile('docker', args)
    return result.stdout.trim()
  }

/** Starts the pinned SQL Server Developer image with a random loopback port. */
export const start =
  async (): Promise<Container> => {
    await output('info')
    const name = `mssqlite-differential-${process.pid}-${Date.now()}`
    const password = process.env.MSSQLITE_DIFFERENTIAL_PASSWORD ??
      'MssqliteDifferential2026!'
    const image = process.env.MSSQLITE_DIFFERENTIAL_IMAGE ?? defaultImage
    const platform = process.arch === 'arm64' ? [ '--platform', 'linux/amd64' ] : []
    await output(
      'run', '--detach', '--rm', '--name', name,
      ...platform,
      '--env', 'ACCEPT_EULA=Y',
      '--env', `MSSQL_SA_PASSWORD=${password}`,
      '--env', 'MSSQL_PID=Developer',
      '--env', 'TZ=UTC',
      '--publish', '127.0.0.1::1433',
      image
    )
    const binding = await output('port', name, '1433/tcp')
    const port = Number(binding.slice(binding.lastIndexOf(':') + 1))
    if (!Number.isInteger(port)) {
      await stop({ name, port, password, image })
      throw new Error(`Could not parse SQL Server port from: ${binding}`)
    }
    return { name, port, password, image }
  }

export const logs =
  async (container: Container): Promise<string> => {
    try {
      return await output('logs', container.name)
    } catch (error) {
      return (error as ExecFileException).message
    }
  }

export const stop =
  async (container: Container): Promise<void> => {
    try {
      await output('stop', '--time', '10', container.name)
    } catch {
      // A failed or externally removed container is already cleaned up.
    }
  }
