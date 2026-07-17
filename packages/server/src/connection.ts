import { Encode } from '@mssqlite/bytes'
import {
  Collation, DataType, Login7, Message, Packet, Prelogin, Rpc, SqlBatch, Token, TransactionManager
} from '@mssqlite/tds'
import {
  BatchError, closeSession, errorOf, executeBatch, executeSql, session, syncSession,
  type Parameter, type Server, type Session, type Value
} from '@mssqlite/engine'
import { batchResponse, errorResponse, rpcResponse } from './respond.ts'
import createTlsTransport, { type Transport as TlsTransport } from './tls-transport.ts'
import type { Socket } from 'node:net'
import type { SecureContext, TLSSocket } from 'node:tls'

export type EncryptionOptions = {
  readonly context: SecureContext,
  readonly mode: 'optional' | 'required',
  readonly requestClientCertificate: boolean,
  readonly rejectUnauthorized: boolean
}

/** Per-connection state. */
type Connection = {
  readonly network: Socket,
  stream: Socket | TLSSocket,
  readonly engine: Server,
  readonly encryption?: EncryptionOptions,
  phase: 'prelogin' | 'tls' | 'plaintext' | 'encrypted',
  tls: TlsTransport | undefined,
  session: Session | undefined,
  state: Message.State,
  packetSize: number,
  /** Prepared statement handles for sp_prepare / sp_execute. */
  readonly prepared: Map<number, string>,
  nextHandle: number,
  transactionDescriptor: bigint
}

const productVersion = { major: 15, minor: 0, build: 2000 }

const send =
  (connection: Connection, type: number, payload: Uint8Array): void => {
    for (const packet of Packet.split(type, payload, connection.packetSize, connection.session?.spid ?? 0)) {
      connection.stream.write(packet)
    }
  }

const respond =
  (connection: Connection, payload: Uint8Array): void =>
    send(connection, Packet.Type.tabularResult, payload)

const onPrelogin =
  (connection: Connection, payload: Uint8Array): void => {
    if (connection.phase === 'tls') {
      connection.tls?.feed(payload)
      return
    }
    if (connection.phase !== 'prelogin') {
      connection.network.destroy()
      return
    }
    const prelogin = Prelogin.decode(payload)
    if (prelogin === undefined) {
      connection.network.destroy()
      return
    }
    const serverMode = connection.encryption?.mode ?? 'unsupported'
    const negotiation = Prelogin.negotiateEncryption(
      prelogin.encryption ?? Prelogin.Encryption.off, serverMode)
    if (negotiation === undefined) {
      connection.network.destroy()
      return
    }
    respond(connection, Prelogin.encode({
      version: { ...productVersion, subBuild: 0 },
      encryption: negotiation.response,
      instance: '',
      mars: false,
      ...prelogin?.fedAuthRequired === undefined ? {} : { fedAuthRequired: false }
    }))
    if (!negotiation.tls) {
      connection.phase = 'plaintext'
      return
    }
    const encryption = connection.encryption
    if (encryption === undefined) {
      connection.network.destroy()
      return
    }
    connection.phase = 'tls'
    let secured = false
    const activate = (): void => {
      if (connection.phase !== 'tls') {
        return
      }
      connection.phase = 'encrypted'
      connection.stream = tls.socket
      connection.state = Message.initial
    }
    const tls = createTlsTransport(
      encryption.context,
      bytes => {
        if (connection.phase === 'tls') {
          for (const packet of Packet.split(
            Packet.Type.prelogin, bytes, connection.packetSize, 0)) {
            connection.network.write(packet)
          }
          if (secured) {
            activate()
          }
        } else {
          connection.network.write(bytes)
        }
      },
      {
        request: encryption.requestClientCertificate,
        rejectUnauthorized: encryption.rejectUnauthorized
      }
    )
    connection.tls = tls
    tls.socket.on('data', (chunk: Buffer) => consume(connection, chunk))
    tls.socket.once('secure', () => {
      secured = true
      setImmediate(activate)
    })
    tls.socket.on('error', () => connection.network.destroy())
  }

const onLogin =
  (connection: Connection, payload: Uint8Array): void => {
    const login = Login7.decode(payload)
    if (login === undefined) {
      connection.network.destroy()
      return
    }
    const session_ = session(connection.engine)
    session_.userName = login.userName === '' ? 'sa' : login.userName
    session_.applicationName = login.appName
    session_.hostName = login.hostName
    if (login.database !== '') {
      session_.database = login.database
    }
    syncSession(session_)
    connection.session = session_
    if (login.packetSize >= 512 && login.packetSize <= 32767) {
      connection.packetSize = login.packetSize
    }
    respond(connection, Encode.concat(
      Token.EnvChange.database(session_.database, 'master'),
      Token.EnvChange.collation(Collation.encode(Collation.default_)),
      Token.EnvChange.language('us_english'),
      Token.loginAck({
        interface: 1,
        tdsVersion: Token.tdsVersion74,
        progName: 'Microsoft SQL Server',
        version: {
          major: productVersion.major,
          minor: productVersion.minor,
          buildHigh: productVersion.build >> 8,
          buildLow: productVersion.build & 0xff
        }
      }),
      Token.EnvChange.packetSize(connection.packetSize, connection.packetSize),
      Token.done(Token.Status.final, 0, 0n)
    ))
  }

const onSqlBatch =
  (connection: Connection, session_: Session, payload: Uint8Array): void => {
    const batch = SqlBatch.decode(payload)
    if (batch === undefined) {
      respond(connection, errorResponse(errorOf(new Error('Malformed SQL batch.')), connection.engine.serverName))
      return
    }
    try {
      const items = executeBatch(session_, batch.sql)
      respond(connection, batchResponse(items, connection.engine.serverName))
    } catch (error) {
      const mapped = errorOf(error)
      respond(connection, error instanceof BatchError ?
        batchResponse(error.items, connection.engine.serverName) :
        errorResponse(mapped, connection.engine.serverName))
      if (mapped.severity >= 20) {
        connection.stream.end()
      }
    }
  }

const parameterValues =
  (parameters: readonly Rpc.Parameter[]): Parameter[] =>
    parameters.map((parameter, index) => ({
      name: parameter.name === '' ? `@p${index + 1}` : parameter.name,
      value: parameter.value as Value,
      output: (parameter.status & Rpc.ParameterStatus.byRefValue) !== 0,
      ...parameter.typeInfo.type === DataType.DataType.datetimeOffsetN ? {
        type: { name: 'datetimeoffset', args: [ parameter.typeInfo.scale ?? 7 ] }
      } : {}
    }))

const onRpc =
  (connection: Connection, session_: Session, payload: Uint8Array): void => {
    const rpc = Rpc.decode(payload)
    if (rpc === undefined) {
      respond(connection, errorResponse(errorOf(new Error('Malformed RPC request.')), connection.engine.serverName))
      return
    }
    const procedure = typeof rpc.procedure === 'string' ? rpc.procedure.toLowerCase() : rpc.procedure
    try {
      switch (procedure) {
        case Rpc.ProcId.executeSql:
        case 'sp_executesql': {
          const [ statement, , ...rest ] = rpc.parameters
          const sql = typeof statement?.value === 'string' ? statement.value : ''
          const result = executeSql(session_, sql, parameterValues(rest))
          respond(connection, rpcResponse(result.items, connection.engine.serverName, result.outputs))
          return
        }
        case Rpc.ProcId.prepare:
        case 'sp_prepare': {
          // Parameters: @handle OUTPUT, @params, @stmt, [@options].
          const [ , , statement ] = rpc.parameters
          const sql = typeof statement?.value === 'string' ? statement.value : ''
          const handle = connection.nextHandle++
          connection.prepared.set(handle, sql)
          respond(connection, rpcResponse([], connection.engine.serverName, [
            { name: rpc.parameters[0]?.name ?? '@handle', value: handle }
          ]))
          return
        }
        case Rpc.ProcId.execute:
        case 'sp_execute': {
          const [ handleParameter, ...rest ] = rpc.parameters
          const handle = Number(handleParameter?.value ?? 0)
          const sql = connection.prepared.get(handle)
          if (sql === undefined) {
            throw errorOf(new Error(`Prepared handle ${handle} not found.`))
          }
          const result = executeSql(session_, sql, parameterValues(rest))
          respond(connection, rpcResponse(result.items, connection.engine.serverName, result.outputs))
          return
        }
        case Rpc.ProcId.unprepare:
        case 'sp_unprepare': {
          const handle = Number(rpc.parameters[0]?.value ?? 0)
          connection.prepared.delete(handle)
          respond(connection, rpcResponse([], connection.engine.serverName))
          return
        }
        case 'sp_reset_connection':
          respond(connection, rpcResponse([], connection.engine.serverName))
          return
        default: {
          // Fall back to EXEC procedure via the engine (raises 2812 for unknown).
          // Parameters bind as shadowed variables and pass through by name so
          // OUTPUT values flow back as RETURNVALUE tokens.
          const name = typeof rpc.procedure === 'string' ? rpc.procedure : `#${rpc.procedure}`
          const parameters = parameterValues(rpc.parameters)
          const rendered = rpc.parameters.map((parameter, index) => {
            const bound = parameters[index]?.name ?? `@p${index + 1}`
            const output = parameters[index]?.output === true ? ' OUTPUT' : ''
            return parameter.name === '' ? `${bound}${output}` : `${parameter.name} = ${bound}${output}`
          })
          const argumentList = rendered.length > 0 ? ` ${rendered.join(', ')}` : ''
          const sql = `EXEC ${name}${argumentList}`
          const result = executeSql(session_, sql, parameters)
          respond(connection, rpcResponse(
            result.items, connection.engine.serverName, result.outputs, session_.lastReturnStatus))
          return
        }
      }
    } catch (error) {
      const mapped = errorOf(error)
      respond(connection, error instanceof BatchError ?
        rpcResponse(error.items, connection.engine.serverName) :
        errorResponse(mapped, connection.engine.serverName, true))
      if (mapped.severity >= 20) {
        connection.stream.end()
      }
    }
  }

const onTransactionManager =
  (connection: Connection, session_: Session, payload: Uint8Array): void => {
    const request = TransactionManager.decode(payload)
    if (request === undefined) {
      respond(connection, errorResponse(errorOf(new Error('Malformed transaction manager request.')), connection.engine.serverName))
      return
    }
    try {
      switch (request.type) {
        case TransactionManager.Type.beginXact: {
          executeBatch(session_, 'BEGIN TRANSACTION')
          connection.transactionDescriptor += 1n
          respond(connection, Encode.concat(
            Token.EnvChange.beginTransaction(connection.transactionDescriptor),
            Token.done(Token.Status.final, 0, 0n)
          ))
          return
        }
        case TransactionManager.Type.commitXact:
          executeBatch(session_, 'COMMIT TRANSACTION')
          respond(connection, Encode.concat(
            Token.EnvChange.commitTransaction(connection.transactionDescriptor),
            Token.done(Token.Status.final, 0, 0n)
          ))
          return
        case TransactionManager.Type.rollbackXact:
          executeBatch(session_, 'ROLLBACK TRANSACTION')
          respond(connection, Encode.concat(
            Token.EnvChange.rollbackTransaction(connection.transactionDescriptor),
            Token.done(Token.Status.final, 0, 0n)
          ))
          return
        case TransactionManager.Type.saveXact:
          executeBatch(session_, `SAVE TRANSACTION [${request.name ?? 'sp'}]`)
          respond(connection, Token.done(Token.Status.final, 0, 0n))
          return
        default:
          respond(connection, Token.done(Token.Status.final, 0, 0n))
          return
      }
    } catch (error) {
      respond(connection, errorResponse(errorOf(error), connection.engine.serverName))
    }
  }

const onMessage =
  (connection: Connection, message: Message.t): void => {
    switch (message.type) {
      case Packet.Type.prelogin:
        onPrelogin(connection, message.payload)
        return
      case Packet.Type.login7:
        onLogin(connection, message.payload)
        return
      case Packet.Type.attention:
        respond(connection, Token.done(Token.Status.attention, 0, 0n))
        return
      default:
        break
    }
    const session_ = connection.session
    if (session_ === undefined) {
      connection.network.destroy()
      return
    }
    switch (message.type) {
      case Packet.Type.sqlBatch:
        onSqlBatch(connection, session_, message.payload)
        return
      case Packet.Type.rpc:
        onRpc(connection, session_, message.payload)
        return
      case Packet.Type.transactionManager:
        onTransactionManager(connection, session_, message.payload)
        return
      default:
        respond(connection, errorResponse(
          errorOf(new Error(`Unsupported packet type 0x${message.type.toString(16)}.`)),
          connection.engine.serverName
        ))
    }
  }

const consume =
  (connection: Connection, chunk: Uint8Array): void => {
    try {
      const { state, messages } = Message.push(connection.state, chunk)
      connection.state = state
      for (const message of messages) {
        onMessage(connection, message)
      }
    } catch (error) {
      respond(connection, errorResponse(errorOf(error), connection.engine.serverName))
      connection.network.destroy()
    }
  }

/** Attaches TDS protocol handling to an accepted socket. */
export const attach =
  (socket: Socket, engine: Server, encryption?: EncryptionOptions): void => {
    const connection: Connection = {
      network: socket,
      stream: socket,
      engine,
      ...encryption === undefined ? {} : { encryption },
      phase: 'prelogin',
      tls: undefined,
      session: undefined,
      state: Message.initial,
      packetSize: Packet.defaultPacketSize,
      prepared: new Map(),
      nextHandle: 1,
      transactionDescriptor: 0n
    }
    socket.on('data', (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      if (connection.phase === 'encrypted') {
        connection.tls?.feed(bytes)
      } else {
        consume(connection, bytes)
      }
    })
    socket.on('end', () => connection.tls?.end())
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      if (connection.session !== undefined) {
        closeSession(connection.session)
      }
    })
  }
