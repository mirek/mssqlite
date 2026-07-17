import { afterAll, beforeAll, expect, test } from 'vitest'
import { Connection, Request } from 'tedious'
import {
  authenticator, hashPassword, listen, type Credential, type Listening, type Options
} from './index.ts'
import { testCertificate, testKey } from './test-certificate.ts'

const connect =
  (
    port: number,
    userName: string,
    password: string,
    encrypt = true,
    database = 'master'
  ): Promise<Connection> =>
    new Promise((resolve, reject) => {
      let loginNumber: number | undefined
      const connection = new Connection({
        server: '127.0.0.1',
        authentication: { type: 'default', options: { userName, password } },
        options: {
          port,
          database,
          encrypt,
          trustServerCertificate: true,
          serverName: 'localhost',
          connectTimeout: 5000,
          requestTimeout: 5000,
          useColumnNames: true
        }
      })
      connection.on('errorMessage', error => {
        loginNumber = error.number
      })
      connection.connect(error => error === undefined ?
        resolve(connection) : reject(Object.assign(error, { number: loginNumber })))
    })

const query =
  (connection: Connection, sql: string): Promise<Record<string, unknown>[]> =>
    new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = []
      const request = new Request(sql, error => error === undefined ? resolve(rows) : reject(error))
      request.on('row', columns => {
        rows.push(Object.fromEntries(Object.entries(columns).map(([ name, column ]) =>
          [ name, (column as { value: unknown }).value ])))
      })
      connection.execSql(request)
    })

test('scrypt hashes validate safely and credential providers rotate atomically', () => {
  const oldHash = hashPassword('old secret')
  const duplicate = hashPassword('old secret')
  expect(oldHash).toMatch(/^mssqlite\$scrypt\$v1\$/)
  expect(oldHash).not.toContain('old secret')
  expect(duplicate).not.toBe(oldHash)

  let credentials: readonly Credential[] = [ { userName: 'Admin', passwordHash: oldHash } ]
  const authenticate = authenticator({ type: 'password', credentials: () => credentials })
  expect(authenticate('admin', 'old secret')).toBe('Admin')
  expect(authenticate('Admin', 'wrong')).toBeUndefined()
  expect(authenticate('missing', 'old secret')).toBeUndefined()

  credentials = [ { userName: 'Admin', passwordHash: hashPassword('new secret') } ]
  expect(authenticate('Admin', 'old secret')).toBeUndefined()
  expect(authenticate('ADMIN', 'new secret')).toBe('Admin')
})

test('credential configuration validates at startup and fails closed on bad reloads', () => {
  expect(() => authenticator({
    type: 'password', credentials: [ { userName: 'sa', passwordHash: 'plaintext' } ]
  })).toThrow('Invalid SQL login credential configuration.')
  const hash = hashPassword('secret')
  expect(() => authenticator({
    type: 'password',
    credentials: [
      { userName: 'sa', passwordHash: hash },
      { userName: 'SA', passwordHash: hash }
    ]
  })).toThrow('Duplicate SQL login credential configuration.')

  let fail = false
  const authenticate = authenticator({
    type: 'password',
    credentials: () => {
      if (fail) {
        throw new Error('reload failed')
      }
      return [ { userName: 'sa', passwordHash: hash } ]
    }
  })
  fail = true
  expect(authenticate('sa', 'secret')).toBeUndefined()
})

test('server startup requires an explicit policy and TLS for password authentication', () => {
  expect(() => listen({ port: 0 } as Options))
    .toThrow('Explicit authentication configuration is required.')
  expect(() => listen({
    port: 0,
    authentication: {
      type: 'password',
      credentials: [ { userName: 'sa', passwordHash: hashPassword('secret') } ]
    }
  })).toThrow('Password authentication requires required TLS.')
})

let listening: Listening
let passwordHash: string

beforeAll(async () => {
  passwordHash = hashPassword('correct horse')
  listening = await listen({
    port: 0,
    authentication: {
      type: 'password', credentials: [ { userName: 'Admin', passwordHash } ]
    },
    tls: { key: testKey, cert: testCertificate }
  })
})

afterAll(async () => {
  await listening.close()
})

test('LOGIN7 establishes the configured canonical session identity', async () => {
  const connection = await connect(listening.port, 'admin', 'correct horse')
  try {
    expect(await query(connection, `
      SELECT SUSER_SNAME() AS login_name,
        (SELECT login_name FROM sys.dm_exec_sessions WHERE session_id = @@SPID) AS catalog_name
    `)).toEqual([ { login_name: 'Admin', catalog_name: 'Admin' } ])
  } finally {
    connection.close()
  }
})

test('LOGIN7 authenticates before resolving its requested database', async () => {
  const selected = await connect(
    listening.port, 'Admin', 'correct horse', true, 'tempdb')
  try {
    expect(await query(selected, 'SELECT DB_NAME() AS database_name'))
      .toEqual([ { database_name: 'tempdb' } ])
    await query(selected, 'USE master')
  } finally {
    selected.close()
  }

  await expect(connect(listening.port, 'missing', 'wrong', true, 'absent_database'))
    .rejects.toMatchObject({ number: 18456 })
  await expect(connect(listening.port, 'Admin', 'correct horse', true, 'absent_database'))
    .rejects.toMatchObject({ number: 4060 })
})

test('LOGIN7 failures share error 18456 and never expose credential material', async () => {
  const attempts = [
    [ 'Admin', 'wrong password' ],
    [ 'missing', 'correct horse' ],
    [ 'Admin', '' ],
    [ '', 'correct horse' ],
    [ '\0malformed', 'correct horse' ]
  ] as const
  const signatures = new Set<string>()
  for (const [ userName, password ] of attempts) {
    let failure: unknown
    try {
      const connection = await connect(listening.port, userName, password)
      connection.close()
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ number: 18456 })
    signatures.add(JSON.stringify({
      message: (failure as Error).message,
      number: (failure as { number: number }).number
    }))
    const exposed = String(failure)
    expect(exposed).not.toContain(passwordHash)
    if (password !== '') {
      expect(exposed).not.toContain(password)
    }
  }
  expect(signatures).toEqual(new Set([ '{"message":"Login failed.","number":18456}' ]))
})

test('a live credential provider rotates wire logins without restart', async () => {
  let credentials: readonly Credential[] = [ {
    userName: 'rotate', passwordHash: hashPassword('first password')
  } ]
  const rotating = await listen({
    port: 0,
    authentication: { type: 'password', credentials: () => credentials },
    tls: { key: testKey, cert: testCertificate }
  })
  try {
    const first = await connect(rotating.port, 'rotate', 'first password')
    first.close()
    credentials = [ { userName: 'rotate', passwordHash: hashPassword('second password') } ]
    await expect(connect(rotating.port, 'rotate', 'first password'))
      .rejects.toMatchObject({ number: 18456 })
    const second = await connect(rotating.port, 'rotate', 'second password')
    second.close()
  } finally {
    await rotating.close()
  }
})

test('insecure development mode is an explicit opt-in', async () => {
  const insecure = await listen({ port: 0, authentication: { type: 'insecure' } })
  try {
    const connection = await connect(insecure.port, 'arbitrary', 'anything', false)
    connection.close()
  } finally {
    await insecure.close()
  }
})
