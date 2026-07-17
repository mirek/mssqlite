import { Cursor, Encode, Result } from '@mssqlite/bytes'
import {
  BulkLoad as TdsBulkLoad, Collation, DataType, Login7, Message, Packet, Prelogin, Rpc, Smp,
  SqlBatch, Token, TransactionManager
} from '@mssqlite/tds'
import {
  abortBulkLoad, BatchError, beginBulkLoad, CancellationError, closeSession, errorOf, executeBatch,
  executeBatchAsync, executeSqlAsync, finishBulkLoad, MssqlError, prepareBulkLoad,
  session, syncSession, useDatabase, writeBulkRows, type BulkLoader, type BulkPlan, type Parameter,
  type Server, type Session, type Value
} from '@mssqlite/engine'
import { batchResponse, errorResponse, rpcResponse } from './respond.ts'
import createTlsTransport, { type Transport as TlsTransport } from './tls-transport.ts'
import type { Socket } from 'node:net'
import type { SecureContext, TLSSocket } from 'node:tls'
import type { Authenticator } from './authentication.ts'

export type EncryptionOptions = {
  readonly context: SecureContext,
  readonly mode: 'optional' | 'required',
  readonly requestClientCertificate: boolean,
  readonly rejectUnauthorized: boolean
}

type BulkState = {
  decoder: TdsBulkLoad.State,
  loader: BulkLoader | undefined,
  error: MssqlError | undefined
}

/** Per-MARS-session request framing and response flow-control state. */
type LogicalSession = {
  readonly id: number | undefined,
  state: Message.State,
  bulkPlan: BulkPlan | undefined,
  bulk: BulkState | undefined,
  sendSequence: number,
  receiveSequence: number,
  sendWindow: number,
  receiveWindow: number,
  readonly outgoing: Uint8Array[],
  cancellation: AbortController | undefined
}

const logicalSession =
  (id: number | undefined, window = 4): LogicalSession => ({
    id,
    state: Message.initial,
    bulkPlan: undefined,
    bulk: undefined,
    sendSequence: 0,
    receiveSequence: 0,
    sendWindow: window,
    receiveWindow: 4,
    outgoing: [],
    cancellation: undefined
  })

/** Per-physical-connection state. */
type Connection = {
  readonly network: Socket,
  stream: Socket | TLSSocket,
  readonly engine: Server,
  readonly encryption?: EncryptionOptions,
  readonly authenticate: Authenticator,
  phase: 'prelogin' | 'tls' | 'plaintext' | 'encrypted',
  tls: TlsTransport | undefined,
  session: Session | undefined,
  readonly defaultSession: LogicalSession,
  marsRequested: boolean,
  mars: boolean,
  smp: Smp.State,
  readonly logicalSessions: Map<number, LogicalSession>,
  nextOutputSession: number,
  execution: Promise<void>,
  packetSize: number,
  /** Prepared statement handles for sp_prepare / sp_execute. */
  readonly prepared: Map<number, string>,
  nextHandle: number,
  transactionDescriptor: bigint,
}

const productVersion = { major: 15, minor: 0, build: 2000 }

const schedule =
  (
    connection: Connection,
    logical: LogicalSession,
    run: (signal: AbortSignal) => Promise<void> | void
  ): void => {
    const request = logical
    const cancellation = new AbortController()
    request.cancellation = cancellation
    const execute = async (): Promise<void> => {
      try {
        await run(cancellation.signal)
      } catch (error) {
        if (error instanceof CancellationError) {
          request.outgoing.length = 0
          // The client is already reading the canceled request's response.
          // Finish that message before sending the Attention acknowledgement
          // as its own response message.
          respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
          respond(connection, Token.done(Token.Status.attention, 0, 0n), logical)
        } else {
          respond(connection, errorResponse(errorOf(error), connection.engine.serverName), logical)
        }
      } finally {
        if (request.cancellation === cancellation) {
          request.cancellation = undefined
        }
      }
    }
    connection.execution = connection.execution.then(execute, execute)
  }

const flushMars =
  (connection: Connection): void => {
    const sessions = [ ...connection.logicalSessions.values() ]
    if (sessions.length === 0) {
      return
    }
    let sent = true
    while (sent) {
      sent = false
      for (let offset = 0; offset < sessions.length; offset++) {
        const index = (connection.nextOutputSession + offset) % sessions.length
        const logical = sessions[index]
        if (logical === undefined || logical.outgoing.length === 0 ||
          logical.sendSequence >= logical.sendWindow) {
          continue
        }
        const packet = logical.outgoing.shift()
        if (packet === undefined || logical.id === undefined) {
          continue
        }
        logical.sendSequence += 1
        connection.stream.write(Smp.encode(
          Smp.Type.data, logical.id, logical.sendSequence, logical.receiveWindow, packet))
        connection.nextOutputSession = (index + 1) % sessions.length
        sent = true
        break
      }
    }
  }

const send =
  (
    connection: Connection,
    type: number,
    payload: Uint8Array,
    logical = connection.defaultSession
  ): void => {
    const packets = Packet.split(
      type, payload, connection.packetSize, connection.session?.spid ?? 0)
    if (!connection.mars || logical.id === undefined) {
      for (const packet of packets) {
        connection.stream.write(packet)
      }
      return
    }
    logical.outgoing.push(...packets)
    flushMars(connection)
  }

const respond =
  (connection: Connection, payload: Uint8Array, logical = connection.defaultSession): void =>
    send(connection, Packet.Type.tabularResult, payload, logical)

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
    connection.marsRequested = prelogin.mars === true
    respond(connection, Prelogin.encode({
      version: { ...productVersion, subBuild: 0 },
      encryption: negotiation.response,
      instance: '',
      mars: connection.marsRequested,
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
      connection.defaultSession.state = Message.initial
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
    const userName = connection.authenticate(login.userName, login.password)
    if (userName === undefined) {
      respond(connection, errorResponse(
        new MssqlError('Login failed.', 18456, 14, 1), connection.engine.serverName))
      connection.stream.end()
      return
    }
    const session_ = session(connection.engine)
    session_.userName = userName
    session_.applicationName = login.appName
    session_.hostName = login.hostName
    const previousDatabase = session_.database
    if (login.database !== '') {
      try {
        useDatabase(session_, login.database)
      } catch {
        closeSession(session_)
        respond(connection, errorResponse(new MssqlError(
          `Cannot open database "${login.database}" requested by the login.`, 4060, 11, 1
        ), connection.engine.serverName))
        connection.stream.end()
        return
      }
    }
    syncSession(session_)
    connection.session = session_
    if (login.packetSize >= 512 && login.packetSize <= 32767) {
      connection.packetSize = login.packetSize
    }
    respond(connection, Encode.concat(
      Token.EnvChange.database(session_.database, previousDatabase),
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
    connection.mars = connection.marsRequested
  }

const onSqlBatch =
  async (
    connection: Connection,
    logical: LogicalSession,
    session_: Session,
    payload: Uint8Array,
    signal: AbortSignal
  ): Promise<void> => {
    const request = logical
    const batch = SqlBatch.decode(payload)
    if (batch === undefined) {
      respond(connection,
        errorResponse(errorOf(new Error('Malformed SQL batch.')), connection.engine.serverName), logical)
      return
    }
    try {
      if (signal.aborted) {
        throw new CancellationError()
      }
      const bulkPlan = prepareBulkLoad(session_, batch.sql)
      if (bulkPlan !== undefined) {
        if (request.bulkPlan !== undefined || request.bulk !== undefined) {
          throw new MssqlError('A bulk load request is already pending.', 4815, 16)
        }
        request.bulkPlan = bulkPlan
        respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
        return
      }
      const items = await executeBatchAsync(session_, batch.sql, { signal })
      respond(connection, batchResponse(items, connection.engine.serverName), logical)
    } catch (error) {
      if (error instanceof CancellationError) {
        throw error
      }
      const mapped = errorOf(error)
      respond(connection, error instanceof BatchError ?
        batchResponse(error.items, connection.engine.serverName) :
        errorResponse(mapped, connection.engine.serverName), logical)
      if (mapped.severity >= 20) {
        connection.stream.end()
      }
    }
  }

const clearBulk =
  (logical: LogicalSession): void => {
    const request = logical
    if (request.bulk?.loader !== undefined) {
      abortBulkLoad(request.bulk.loader)
    }
    request.bulk = undefined
    request.bulkPlan = undefined
  }

const finishBulkError =
  (connection: Connection, logical: LogicalSession, error: MssqlError): void => {
    const request = logical
    respond(connection, errorResponse(error, connection.engine.serverName), logical)
    request.bulk = undefined
    request.bulkPlan = undefined
  }

const onBulkFragment =
  (connection: Connection, logical: LogicalSession, fragment: Message.Fragment): void => {
    const request = logical
    const session_ = connection.session
    if (session_ === undefined) {
      connection.network.destroy()
      return
    }
    if (fragment.ignore) {
      clearBulk(logical)
      // A client that cancels before finishing the request terminates it with
      // IGNORE and does not send Attention; it still waits for a normal reply.
      if (fragment.eom) {
        respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
      }
      return
    }
    const plan = request.bulkPlan
    if (plan === undefined) {
      if (fragment.eom) {
        finishBulkError(connection, logical,
          new MssqlError('Bulk load data arrived without INSERT BULK.', 4815, 16))
      }
      return
    }
    const bulk = request.bulk ?? {
      decoder: TdsBulkLoad.initial,
      loader: undefined,
      error: undefined
    }
    request.bulk = bulk
    if (bulk.error !== undefined) {
      if (fragment.eom) {
        finishBulkError(connection, logical, bulk.error)
      }
      return
    }
    try {
      // FreeTDS/freebcp ends the stream at a ROW boundary without the
      // specification's client DONE; the standalone codec stays strict.
      const decoded = TdsBulkLoad.push(bulk.decoder, fragment.payload, fragment.eom, true)
      if (Result.failed(decoded)) {
        throw new MssqlError(`Invalid bulk load data: ${decoded.reason}`, 4816, 16)
      }
      bulk.decoder = decoded.value.state
      if (bulk.loader === undefined && bulk.decoder.columns !== undefined) {
        bulk.loader = beginBulkLoad(plan, bulk.decoder.columns)
      }
      if (bulk.loader !== undefined && decoded.value.rows.length > 0) {
        writeBulkRows(bulk.loader, decoded.value.rows)
      }
      if (fragment.eom) {
        if (bulk.loader === undefined || !bulk.decoder.done) {
          throw new MssqlError('Invalid or truncated bulk load data.', 4816, 16)
        }
        const count = finishBulkLoad(bulk.loader)
        respond(connection, Token.done(
          Token.Status.final | Token.Status.count, 0xf0, BigInt(count)), logical)
        request.bulk = undefined
        request.bulkPlan = undefined
      }
    } catch (error) {
      const mapped = errorOf(error)
      if (bulk.loader !== undefined) {
        abortBulkLoad(bulk.loader)
        bulk.loader = undefined
      }
      bulk.error = mapped
      if (fragment.eom) {
        finishBulkError(connection, logical, mapped)
      }
    }
  }

const parameterType =
  (typeInfo: Rpc.Parameter['typeInfo']): Parameter['type'] => {
    const length = typeInfo.maxLength === 0xffff ? 'max' : typeInfo.maxLength
    switch (typeInfo.type) {
      case DataType.DataType.int1:
        return { name: 'tinyint', args: [] }
      case DataType.DataType.int2:
        return { name: 'smallint', args: [] }
      case DataType.DataType.int4:
        return { name: 'int', args: [] }
      case DataType.DataType.int8:
        return { name: 'bigint', args: [] }
      case DataType.DataType.intN:
        return {
          name: typeInfo.maxLength === 1 ? 'tinyint' : typeInfo.maxLength === 2 ? 'smallint' :
            typeInfo.maxLength === 8 ? 'bigint' : 'int',
          args: []
        }
      case DataType.DataType.bit:
      case DataType.DataType.bitN:
        return { name: 'bit', args: [] }
      case DataType.DataType.float4:
        return { name: 'real', args: [] }
      case DataType.DataType.float8:
        return { name: 'float', args: [] }
      case DataType.DataType.floatN:
        return { name: typeInfo.maxLength === 4 ? 'real' : 'float', args: [] }
      case DataType.DataType.decimalN:
      case DataType.DataType.numericN:
        return { name: 'decimal', args: [ typeInfo.precision ?? 18, typeInfo.scale ?? 0 ] }
      case DataType.DataType.money4:
        return { name: 'smallmoney', args: [] }
      case DataType.DataType.money:
      case DataType.DataType.moneyN:
        return { name: typeInfo.maxLength === 4 ? 'smallmoney' : 'money', args: [] }
      case DataType.DataType.datetime4:
        return { name: 'smalldatetime', args: [] }
      case DataType.DataType.datetime:
      case DataType.DataType.datetimeN:
        return { name: typeInfo.maxLength === 4 ? 'smalldatetime' : 'datetime', args: [] }
      case DataType.DataType.dateN:
        return { name: 'date', args: [] }
      case DataType.DataType.timeN:
        return { name: 'time', args: [ typeInfo.scale ?? 7 ] }
      case DataType.DataType.datetime2N:
        return { name: 'datetime2', args: [ typeInfo.scale ?? 7 ] }
      case DataType.DataType.datetimeOffsetN:
        return { name: 'datetimeoffset', args: [ typeInfo.scale ?? 7 ] }
      case DataType.DataType.guid:
        return { name: 'uniqueidentifier', args: [] }
      case DataType.DataType.bigVarchar:
        return { name: 'varchar', args: [ length ?? 1 ] }
      case DataType.DataType.bigChar:
        return { name: 'char', args: [ length ?? 1 ] }
      case DataType.DataType.nvarchar:
        return { name: 'nvarchar', args: [ length === 'max' ? 'max' : (length ?? 2) / 2 ] }
      case DataType.DataType.nchar:
        return { name: 'nchar', args: [ length === 'max' ? 'max' : (length ?? 2) / 2 ] }
      case DataType.DataType.bigVarbinary:
        return { name: 'varbinary', args: [ length ?? 1 ] }
      case DataType.DataType.bigBinary:
        return { name: 'binary', args: [ length ?? 1 ] }
      case DataType.DataType.text:
        return { name: 'text', args: [] }
      case DataType.DataType.ntext:
        return { name: 'ntext', args: [] }
      case DataType.DataType.image:
        return { name: 'image', args: [] }
      case DataType.DataType.xml:
        return { name: 'xml', args: [] }
      case DataType.DataType.sqlVariant:
        return { name: 'sql_variant', args: [] }
      default:
        return undefined
    }
  }

const parameterValues =
  (parameters: readonly Rpc.Parameter[]): Parameter[] =>
    parameters.map((parameter, index) => {
      const type = parameterType(parameter.typeInfo)
      return {
        name: parameter.name === '' ? `@p${index + 1}` : parameter.name,
        value: parameter.value as Value,
        output: (parameter.status & Rpc.ParameterStatus.byRefValue) !== 0,
        ...type === undefined ? {} : { type }
      }
    })

const onRpc =
  async (
    connection: Connection,
    logical: LogicalSession,
    session_: Session,
    payload: Uint8Array,
    signal: AbortSignal
  ): Promise<void> => {
    const rpc = Rpc.decode(payload)
    if (rpc === undefined) {
      respond(connection,
        errorResponse(errorOf(new Error('Malformed RPC request.')), connection.engine.serverName), logical)
      return
    }
    const procedure = typeof rpc.procedure === 'string' ? rpc.procedure.toLowerCase() : rpc.procedure
    try {
      if (signal.aborted) {
        throw new CancellationError()
      }
      switch (procedure) {
        case Rpc.ProcId.executeSql:
        case 'sp_executesql': {
          const [ statement, , ...rest ] = rpc.parameters
          const sql = typeof statement?.value === 'string' ? statement.value : ''
          const result = await executeSqlAsync(
            session_, sql, parameterValues(rest), { signal })
          respond(connection, rpcResponse(
            result.items, connection.engine.serverName, result.outputs), logical)
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
          ]), logical)
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
          const result = await executeSqlAsync(
            session_, sql, parameterValues(rest), { signal })
          respond(connection, rpcResponse(
            result.items, connection.engine.serverName, result.outputs), logical)
          return
        }
        case Rpc.ProcId.unprepare:
        case 'sp_unprepare': {
          const handle = Number(rpc.parameters[0]?.value ?? 0)
          connection.prepared.delete(handle)
          respond(connection, rpcResponse([], connection.engine.serverName), logical)
          return
        }
        case 'sp_reset_connection':
          respond(connection, rpcResponse([], connection.engine.serverName), logical)
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
          const result = await executeSqlAsync(session_, sql, parameters, { signal })
          respond(connection, rpcResponse(
            result.items, connection.engine.serverName, result.outputs, session_.lastReturnStatus), logical)
          return
        }
      }
    } catch (error) {
      if (error instanceof CancellationError) {
        throw error
      }
      const mapped = errorOf(error)
      respond(connection, error instanceof BatchError ?
        rpcResponse(error.items, connection.engine.serverName) :
        errorResponse(mapped, connection.engine.serverName, true), logical)
      if (mapped.severity >= 20) {
        connection.stream.end()
      }
    }
  }

const onTransactionManager =
  (
    connection: Connection,
    logical: LogicalSession,
    session_: Session,
    payload: Uint8Array
  ): void => {
    const request = TransactionManager.decode(payload)
    if (request === undefined) {
      respond(connection, errorResponse(
        errorOf(new Error('Malformed transaction manager request.')),
        connection.engine.serverName), logical)
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
          ), logical)
          return
        }
        case TransactionManager.Type.commitXact:
          executeBatch(session_, 'COMMIT TRANSACTION')
          respond(connection, Encode.concat(
            Token.EnvChange.commitTransaction(connection.transactionDescriptor),
            Token.done(Token.Status.final, 0, 0n)
          ), logical)
          return
        case TransactionManager.Type.rollbackXact:
          executeBatch(session_, 'ROLLBACK TRANSACTION')
          respond(connection, Encode.concat(
            Token.EnvChange.rollbackTransaction(connection.transactionDescriptor),
            Token.done(Token.Status.final, 0, 0n)
          ), logical)
          return
        case TransactionManager.Type.saveXact:
          executeBatch(session_, `SAVE TRANSACTION [${request.name ?? 'sp'}]`)
          respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
          return
        default:
          respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
          return
      }
    } catch (error) {
      respond(connection, errorResponse(errorOf(error), connection.engine.serverName), logical)
    }
  }

const onMessage =
  (connection: Connection, logical: LogicalSession, message: Message.t): void => {
    const request = logical
    if (message.ignore) {
      clearBulk(logical)
      // Cancellation before the request was fully sent uses IGNORE instead
      // of Attention. Do not execute its partial payload; close the request
      // with an ordinary response so the client can become reusable.
      respond(connection, Token.done(Token.Status.final, 0, 0n), logical)
      return
    }
    if (logical.id !== undefined &&
      (message.type === Packet.Type.prelogin || message.type === Packet.Type.login7)) {
      throw new Error('Login messages are forbidden inside SMP sessions.')
    }
    switch (message.type) {
      case Packet.Type.prelogin:
        onPrelogin(connection, message.payload)
        return
      case Packet.Type.login7:
        onLogin(connection, message.payload)
        return
      case Packet.Type.attention:
        clearBulk(logical)
        request.outgoing.length = 0
        if (request.cancellation === undefined) {
          respond(connection, Token.done(Token.Status.attention, 0, 0n), logical)
        } else {
          request.cancellation.abort()
        }
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
        schedule(connection, logical, signal =>
          onSqlBatch(connection, logical, session_, message.payload, signal))
        return
      case Packet.Type.rpc:
        schedule(connection, logical, signal =>
          onRpc(connection, logical, session_, message.payload, signal))
        return
      case Packet.Type.transactionManager:
        schedule(connection, logical, () =>
          onTransactionManager(connection, logical, session_, message.payload))
        return
      default:
        respond(connection, errorResponse(
          errorOf(new Error(`Unsupported packet type 0x${message.type.toString(16)}.`)),
          connection.engine.serverName
        ), logical)
    }
  }

const consumeTds =
  (connection: Connection, logical: LogicalSession, chunk: Uint8Array): void => {
    const request = logical
    const { state, messages, fragments } = Message.push(
      request.state, chunk, [ Packet.Type.bulkLoad ])
    request.state = state
    for (const fragment of fragments) {
      onBulkFragment(connection, logical, fragment)
    }
    for (const message of messages) {
      onMessage(connection, logical, message)
    }
  }

const smpControl =
  (connection: Connection, logical: LogicalSession, type: Smp.Type): void => {
    if (logical.id === undefined) {
      return
    }
    connection.stream.write(Smp.encode(
      type, logical.id, logical.sendSequence, logical.receiveWindow))
  }

const openMarsSession =
  (connection: Connection, packet: Smp.Packet): void => {
    if (packet.sequence !== 0 || connection.logicalSessions.has(packet.sessionId)) {
      throw new Error(`Invalid or duplicate SMP SYN for session ${packet.sessionId}.`)
    }
    connection.logicalSessions.set(
      packet.sessionId, logicalSession(packet.sessionId, packet.window))
  }

const marsData =
  (connection: Connection, logical: LogicalSession, packet: Smp.Packet): void => {
    const request = logical
    if (packet.sequence !== request.receiveSequence + 1) {
      throw new Error(`Out-of-sequence SMP DATA for session ${packet.sessionId}.`)
    }
    if (packet.window < request.sendWindow) {
      throw new Error(`SMP window moved backwards for session ${packet.sessionId}.`)
    }
    const header = Packet.decodeHeader(Cursor.of(packet.data))
    if (Result.failed(header) || header.value.length !== packet.data.byteLength) {
      throw new Error('SMP DATA must contain exactly one complete TDS packet.')
    }
    request.sendWindow = packet.window
    request.receiveSequence = packet.sequence
    if (request.receiveSequence + 2 >= request.receiveWindow) {
      request.receiveWindow = request.receiveSequence + 4
      smpControl(connection, logical, Smp.Type.ack)
    }
    consumeTds(connection, logical, packet.data)
    flushMars(connection)
  }

const closeMarsSession =
  (connection: Connection, logical: LogicalSession, packet: Smp.Packet): void => {
    if (packet.sequence !== logical.receiveSequence) {
      throw new Error(`Out-of-sequence SMP FIN for session ${packet.sessionId}.`)
    }
    logical.cancellation?.abort()
    clearBulk(logical)
    smpControl(connection, logical, Smp.Type.fin)
    connection.logicalSessions.delete(packet.sessionId)
  }

const consumeMars =
  (connection: Connection, chunk: Uint8Array): void => {
    const decoded = Smp.push(connection.smp, chunk)
    connection.smp = decoded.state
    for (const packet of decoded.packets) {
      if (packet.type === Smp.Type.syn) {
        openMarsSession(connection, packet)
        continue
      }
      const logical = connection.logicalSessions.get(packet.sessionId)
      if (logical === undefined) {
        throw new Error(`SMP packet references unknown session ${packet.sessionId}.`)
      }
      if (packet.type === Smp.Type.data) {
        marsData(connection, logical, packet)
      } else if (packet.type === Smp.Type.ack) {
        if (packet.window < logical.sendWindow) {
          throw new Error(`SMP window moved backwards for session ${packet.sessionId}.`)
        }
        logical.sendWindow = packet.window
        flushMars(connection)
      } else if (packet.type === Smp.Type.fin) {
        closeMarsSession(connection, logical, packet)
      }
    }
  }

const consume =
  (connection: Connection, chunk: Uint8Array): void => {
    try {
      if (connection.mars) {
        consumeMars(connection, chunk)
      } else {
        consumeTds(connection, connection.defaultSession, chunk)
      }
    } catch (error) {
      if (!connection.mars) {
        respond(connection, errorResponse(errorOf(error), connection.engine.serverName))
      }
      connection.network.destroy()
    }
  }

/** Attaches TDS protocol handling to an accepted socket. */
export const attach =
  (
    socket: Socket,
    engine: Server,
    encryption: EncryptionOptions | undefined,
    authenticate: Authenticator
  ): void => {
    const connection: Connection = {
      network: socket,
      stream: socket,
      engine,
      ...encryption === undefined ? {} : { encryption },
      authenticate,
      phase: 'prelogin',
      tls: undefined,
      session: undefined,
      defaultSession: logicalSession(undefined),
      marsRequested: false,
      mars: false,
      smp: Smp.initial,
      logicalSessions: new Map(),
      nextOutputSession: 0,
      execution: Promise.resolve(),
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
      connection.defaultSession.cancellation?.abort()
      clearBulk(connection.defaultSession)
      for (const logical of connection.logicalSessions.values()) {
        logical.cancellation?.abort()
        clearBulk(logical)
      }
      if (connection.session !== undefined) {
        closeSession(connection.session)
      }
    })
  }
