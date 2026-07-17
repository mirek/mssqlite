import { afterAll, beforeAll, expect, test } from 'vitest'
import { Connection, Request, type ConnectionConfiguration } from 'tedious'
import { ConnectionPool } from 'mssql'
import { connect as connectSocket } from 'node:net'
import { Message, Packet, Prelogin } from '@mssqlite/tds'
import { listen, type Listening } from './server.ts'
import { testCertificate, testKey } from './test-certificate.ts'

let listening: Listening

const connect =
  (port: number, overrides: Partial<ConnectionConfiguration> = {}): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const connection = new Connection({
        server: '127.0.0.1',
        authentication: {
          type: 'default',
          options: { userName: 'sa', password: 'secret' }
        },
        ...overrides,
        options: {
          port,
          database: 'master',
          trustServerCertificate: true,
          serverName: 'localhost',
          connectTimeout: 5000,
          requestTimeout: 5000,
          ...overrides.options
        }
      })
      connection.on('error', () => undefined)
      connection.connect(error => error ? reject(error) : resolve(connection))
    })

const scalar =
  (connection: Connection, sql: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let value: unknown
      const request = new Request(sql, error => error ? reject(error) : resolve(value))
      request.on('row', columns => {
        value = columns[0]?.value
      })
      connection.execSql(request)
    })

const negotiate =
  (port: number, encryption: number): Promise<number | undefined> =>
    new Promise(resolve => {
      const socket = connectSocket(port, '127.0.0.1')
      let state = Message.initial
      let settled = false
      const finish = (value: number | undefined): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        socket.destroy()
        resolve(value)
      }
      const timeout = setTimeout(() => finish(undefined), 1000)
      socket.once('connect', () => {
        const payload = Prelogin.encode({
          version: { major: 15, minor: 0, build: 2000 },
          encryption
        })
        for (const packet of Packet.split(Packet.Type.prelogin, payload)) {
          socket.write(packet)
        }
      })
      socket.on('data', chunk => {
        const result = Message.push(state, chunk)
        state = result.state
        const response = result.messages[0]
        if (response !== undefined) {
          finish(Prelogin.decode(response.payload)?.encryption)
        }
      })
      socket.once('close', () => finish(undefined))
      socket.once('error', () => finish(undefined))
    })

beforeAll(async () => {
  listening = await listen({
    path: ':memory:',
    port: 0,
    databaseName: 'master',
    tls: { key: testKey, cert: testCertificate }
  })
})

afterAll(async () => {
  await listening.close()
})

test('TLS requires a key and certificate', () => {
  expect(() => listen({ port: 0, tls: { key: testKey } }))
    .toThrow('TLS requires both key and cert options.')
})

test('prelogin encryption modes negotiate on the wire', async () => {
  expect(await negotiate(listening.port, Prelogin.Encryption.on))
    .toBe(Prelogin.Encryption.required)
  expect(await negotiate(listening.port, Prelogin.Encryption.off)).toBeUndefined()

  const optional = await listen({
    port: 0,
    tls: { key: testKey, cert: testCertificate, mode: 'optional' }
  })
  const plaintext = await listen({ port: 0 })
  try {
    expect(await negotiate(optional.port, Prelogin.Encryption.notSupported))
      .toBe(Prelogin.Encryption.notSupported)
    expect(await negotiate(plaintext.port, Prelogin.Encryption.off))
      .toBe(Prelogin.Encryption.notSupported)
    const upgraded = await connect(optional.port, { options: { encrypt: false } })
    const localDevelopment = await connect(plaintext.port, { options: { encrypt: false } })
    try {
      expect(await scalar(upgraded, 'SELECT N\'encrypted\'')).toBe('encrypted')
      expect(await scalar(localDevelopment, 'SELECT N\'plaintext\'')).toBe('plaintext')
    } finally {
      upgraded.close()
      localDevelopment.close()
    }
  } finally {
    await optional.close()
    await plaintext.close()
  }
})

test('current tedious encryption default connects through a self-signed certificate', async () => {
  const connection = await connect(listening.port)
  try {
    expect(connection.state.name).toBe('LoggedIn')
    expect(await scalar(connection, 'SELECT 42')).toBe(42)
    await expect(scalar(connection, 'SELECT 1 / 0'))
      .rejects.toMatchObject({ number: 8134 })
    expect(await scalar(connection, 'SELECT 43')).toBe(43)
  } finally {
    connection.close()
  }
})

test('trusted certificate authority and matching server name connect', async () => {
  const connection = await connect(listening.port, {
    options: {
      encrypt: true,
      trustServerCertificate: false,
      cryptoCredentialsDetails: { ca: testCertificate }
    }
  })
  try {
    expect(await scalar(connection, 'SELECT N\'trusted\'')).toBe('trusted')
  } finally {
    connection.close()
  }
})

test('a trusted certificate with a mismatched server name is rejected', async () => {
  await expect(connect(listening.port, {
    options: {
      encrypt: true,
      trustServerCertificate: false,
      serverName: 'wrong.example',
      cryptoCredentialsDetails: { ca: testCertificate }
    }
  })).rejects.toThrow(/not cert's CN|not in the cert's altnames|Hostname\/IP does not match/)
}, 10000)

test('required TLS rejects a plaintext negotiation', async () => {
  await expect(connect(listening.port, {
    options: { encrypt: false }
  })).rejects.toThrow()
})

test('mssql client connects and queries over TLS', async () => {
  const pool = await new ConnectionPool({
    server: '127.0.0.1',
    port: listening.port,
    user: 'sa',
    password: 'secret',
    database: 'master',
    connectionTimeout: 5000,
    requestTimeout: 5000,
    options: { encrypt: true, trustServerCertificate: true, serverName: 'localhost' }
  }).connect()
  try {
    const result = await pool.query<{ answer: number }>('SELECT 42 AS answer')
    expect(result.recordset).toEqual([ { answer: 42 } ])
  } finally {
    await pool.close()
  }
})
