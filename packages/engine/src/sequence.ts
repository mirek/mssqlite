import * as Catalog from '@mssqlite/catalog'
import { MssqlError } from './error.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { Server, Session, Value } from './session.ts'

export type Sequence = {
  readonly objectId: number,
  readonly name: Ast.QualifiedName,
  readonly dataType: TypeName.t,
  readonly start: bigint,
  increment: bigint,
  minimum: bigint,
  maximum: bigint,
  cycling: boolean,
  cached: boolean,
  cacheSize: number | null,
  current: bigint,
  lastUsed: bigint | null,
  exhausted: boolean,
  dirty: boolean
}

/** @returns lowercased `schema.name` key for a sequence object. */
export const sequenceKey =
  (name: Ast.QualifiedName | string): string => {
    const parts = typeof name === 'string' ? name.split('.') : [ ...name ]
    const scoped = parts.length > 2 ? parts.slice(-2) : parts
    return (scoped.length === 2 ? `${scoped[0]}.${scoped[1]}` : `dbo.${scoped[0]}`).toLowerCase()
  }

const typeOf =
  (row: Catalog.SequenceRow): TypeName.t => ({
    name: row.type_name,
    args: row.type_name === 'decimal' || row.type_name === 'numeric' ?
      [ row.precision, row.scale ] :
      []
  })

/** Hydrates the server sequence registry from persisted catalog rows. */
export const loadSequences =
  (db: Server['db']): Map<string, Sequence> =>
    new Map(Catalog.sequenceRows(db).map(row => {
      const name = [ row.schema_name, row.name ]
      const sequence: Sequence = {
        objectId: row.object_id,
        name,
        dataType: typeOf(row),
        start: BigInt(row.start_value),
        increment: BigInt(row.increment_value),
        minimum: BigInt(row.minimum_value),
        maximum: BigInt(row.maximum_value),
        cycling: row.is_cycling !== 0,
        cached: row.is_cached !== 0,
        cacheSize: row.cache_size,
        current: BigInt(row.current_value),
        lastUsed: row.last_used_value === null ? null : BigInt(row.last_used_value),
        exhausted: row.is_exhausted !== 0,
        dirty: false
      }
      return [ sequenceKey(name), sequence ]
    }))

/** Writes dirty allocation state once no user transaction can roll it back. */
export const flushSequences =
  (server: Server): void => {
    for (const state of server.databases.values()) {
      if (state.db.isTransaction) {
        continue
      }
      for (const sequence of state.sequences.values()) {
        if (!sequence.dirty) {
          continue
        }
        Catalog.updateSequenceValue(
          state.db,
          sequence.objectId,
          sequence.current.toString(),
          sequence.exhausted,
          sequence.lastUsed?.toString() ?? null
        )
        sequence.dirty = false
      }
    }
  }

/** Atomically reserves and returns one sequence value. */
export const nextSequenceValue =
  (server: Server, name: string): Value => {
    const parts = name.split('.')
    const database = parts.length >= 3 ? parts[parts.length - 3] : undefined
    const state = database === undefined ? server.current?.databaseState :
      server.databases.get(database.toLowerCase())
    if (state?.readOnly === true) {
      throw new MssqlError(
        `Failed to update database '${state.name}' because the database is read-only.`, 3906, 16)
    }
    const sequence = state?.sequences.get(sequenceKey(name))
    if (sequence === undefined) {
      throw new MssqlError(`Object '${name}' is not a sequence object.`, 11726, 16)
    }
    if (sequence.exhausted) {
      throw new MssqlError(
        `The sequence object '${name}' has reached its minimum or maximum value.`, 11728, 16)
    }
    let value: bigint
    if (sequence.lastUsed === null) {
      value = sequence.current
    } else {
      const candidate = sequence.current + sequence.increment
      if (candidate < sequence.minimum || candidate > sequence.maximum) {
        if (!sequence.cycling) {
          sequence.exhausted = true
          sequence.dirty = true
          throw new MssqlError(
            `The sequence object '${name}' has reached its minimum or maximum value.`, 11728, 16)
        }
        value = sequence.increment > 0n ? sequence.minimum : sequence.maximum
      } else {
        value = candidate
      }
    }
    sequence.current = value
    sequence.lastUsed = value
    const next = value + sequence.increment
    sequence.exhausted = !sequence.cycling &&
      (next < sequence.minimum || next > sequence.maximum)
    sequence.dirty = true
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value
  }

/** @returns catalog representation of an in-memory sequence. */
export const catalogState =
  (sequence: Sequence): Catalog.SequenceState => ({
    dataType: sequence.dataType,
    start: sequence.start.toString(),
    increment: sequence.increment.toString(),
    minimum: sequence.minimum.toString(),
    maximum: sequence.maximum.toString(),
    cycling: sequence.cycling,
    cached: sequence.cached,
    cacheSize: sequence.cacheSize,
    current: sequence.current.toString(),
    exhausted: sequence.exhausted,
    lastUsed: sequence.lastUsed?.toString() ?? null
  })

const typeBounds =
  (type: TypeName.t): { readonly minimum: bigint, readonly maximum: bigint } => {
    switch (type.name) {
      case 'tinyint':
        return { minimum: 0n, maximum: 255n }
      case 'smallint':
        return { minimum: -32768n, maximum: 32767n }
      case 'int':
      case 'integer':
        return { minimum: -2147483648n, maximum: 2147483647n }
      case 'bigint':
        return { minimum: -9223372036854775808n, maximum: 9223372036854775807n }
      case 'decimal':
      case 'numeric': {
        const precision = typeof type.args[0] === 'number' ? type.args[0] : 18
        const scale = typeof type.args[1] === 'number' ? type.args[1] : 0
        if (scale !== 0 || precision < 1 || precision > 18) {
          throw new MssqlError(
            'Sequence DECIMAL/NUMERIC types require scale 0 and precision from 1 through 18.',
            11705, 16)
        }
        const maximum = (10n ** BigInt(precision)) - 1n
        return { minimum: -maximum, maximum }
      }
      default:
        throw new MssqlError(`The data type '${type.name}' is invalid for a sequence object.`, 11705, 16)
    }
  }

const oneOption =
  (options: readonly Ast.SequenceOption[], kind: Ast.SequenceOption['kind']): Ast.SequenceOption | undefined => {
    const found = options.filter(option => option.kind === kind)
    if (found.length > 1) {
      throw new MssqlError(`The sequence option ${kind.toUpperCase()} was specified more than once.`, 11708, 16)
    }
    return found[0]
  }

const optionValue =
  (option: Ast.SequenceOption | undefined): bigint | undefined =>
    option !== undefined && 'value' in option && option.value !== undefined ?
      BigInt(option.value) :
      undefined

const cacheOption =
  (option: Ast.SequenceOption | undefined): { cached: boolean, cacheSize: number | null } => {
    if (option?.kind !== 'cache') {
      return { cached: true, cacheSize: null }
    }
    if (!option.enabled) {
      return { cached: false, cacheSize: null }
    }
    const size = option.size === undefined ? null : Number(BigInt(option.size))
    if (size !== null && (!Number.isSafeInteger(size) || size < 2)) {
      throw new MssqlError('The cache size for a sequence object must be at least 2.', 11709, 16)
    }
    return { cached: true, cacheSize: size }
  }

const validateRange =
  (sequence: Pick<Sequence, 'start' | 'increment' | 'minimum' | 'maximum' | 'current'>): void => {
    if (sequence.increment === 0n) {
      throw new MssqlError('The sequence increment cannot be 0.', 11704, 16)
    }
    if (sequence.minimum >= sequence.maximum) {
      throw new MssqlError('The sequence minimum value must be less than its maximum value.', 11706, 16)
    }
    if (sequence.start < sequence.minimum || sequence.start > sequence.maximum ||
      sequence.current < sequence.minimum || sequence.current > sequence.maximum) {
      throw new MssqlError('The sequence start or restart value is outside its bounds.', 11707, 16)
    }
  }

const validateTypeRange =
  (
    bounds: { readonly minimum: bigint, readonly maximum: bigint },
    minimum: bigint,
    maximum: bigint,
    increment: bigint
  ): void => {
    if (minimum < bounds.minimum || maximum > bounds.maximum ||
      increment < bounds.minimum || increment > bounds.maximum) {
      throw new MssqlError('A sequence option is outside the range of its data type.', 11707, 16)
    }
  }

/** Creates a validated sequence in the catalog and server registry. */
export const defineSequence =
  (session: Session, statement: Ast.Statement & { kind: 'createSequence' }): void => {
    const key = sequenceKey(statement.name)
    const finalName = statement.name[statement.name.length - 1] ?? ''
    if (Catalog.objectIdOf(session.db, statement.name) !== undefined) {
      throw new MssqlError(`There is already an object named '${finalName}' in the database.`, 2714, 16)
    }
    if (oneOption(statement.options, 'restart') !== undefined) {
      throw new MssqlError('RESTART is only valid in ALTER SEQUENCE.', 11708, 16)
    }
    const dataType = statement.dataType ?? { name: 'bigint', args: [] }
    const bounds = typeBounds(dataType)
    const increment = optionValue(oneOption(statement.options, 'increment')) ?? 1n
    const minOption = oneOption(statement.options, 'min')
    const maxOption = oneOption(statement.options, 'max')
    const minimum = optionValue(minOption) ?? bounds.minimum
    const maximum = optionValue(maxOption) ?? bounds.maximum
    const start = optionValue(oneOption(statement.options, 'start')) ??
      (increment > 0n ? minimum : maximum)
    const cycle = oneOption(statement.options, 'cycle')
    const cache = cacheOption(oneOption(statement.options, 'cache'))
    validateTypeRange(bounds, minimum, maximum, increment)
    const sequence: Sequence = {
      objectId: 0,
      name: statement.name,
      dataType,
      start,
      increment,
      minimum,
      maximum,
      cycling: cycle?.kind === 'cycle' && cycle.enabled,
      cached: cache.cached,
      cacheSize: cache.cacheSize,
      current: start,
      lastUsed: null,
      exhausted: false,
      dirty: false
    }
    validateRange(sequence)
    const objectId = Catalog.createSequence(session.db, statement.name, catalogState(sequence))
    session.server.sequences.set(key, { ...sequence, objectId })
  }

/** Applies ALTER SEQUENCE options while retaining the original START value. */
export const redefineSequence =
  (session: Session, statement: Ast.Statement & { kind: 'alterSequence' }): void => {
    const key = sequenceKey(statement.name)
    const existing = session.server.sequences.get(key)
    if (existing === undefined) {
      throw new MssqlError(`Object '${statement.name.join('.')}' is not a sequence object.`, 11726, 16)
    }
    if (oneOption(statement.options, 'start') !== undefined) {
      throw new MssqlError('START WITH is only valid in CREATE SEQUENCE.', 11708, 16)
    }
    const bounds = typeBounds(existing.dataType)
    const increment = optionValue(oneOption(statement.options, 'increment')) ?? existing.increment
    const minOption = oneOption(statement.options, 'min')
    const maxOption = oneOption(statement.options, 'max')
    const minimum = minOption === undefined ? existing.minimum : optionValue(minOption) ?? bounds.minimum
    const maximum = maxOption === undefined ? existing.maximum : optionValue(maxOption) ?? bounds.maximum
    const cycle = oneOption(statement.options, 'cycle')
    const cacheOption_ = oneOption(statement.options, 'cache')
    const cache = cacheOption_ === undefined ?
      { cached: existing.cached, cacheSize: existing.cacheSize } :
      cacheOption(cacheOption_)
    const restart = oneOption(statement.options, 'restart')
    const restartValue = restart === undefined ? undefined : optionValue(restart) ?? existing.start
    const current = restartValue ?? existing.current
    validateTypeRange(bounds, minimum, maximum, increment)
    const sequence: Sequence = {
      ...existing,
      increment,
      minimum,
      maximum,
      cycling: cycle?.kind === 'cycle' ? cycle.enabled : existing.cycling,
      cached: cache.cached,
      cacheSize: cache.cacheSize,
      current,
      lastUsed: restart === undefined ? existing.lastUsed : null,
      exhausted: false,
      dirty: false
    }
    validateRange(sequence)
    if (restart === undefined && sequence.lastUsed !== null) {
      const next = sequence.current + sequence.increment
      sequence.exhausted = !sequence.cycling && (next < sequence.minimum || next > sequence.maximum)
    }
    Catalog.alterSequence(session.db, statement.name, catalogState(sequence))
    session.server.sequences.set(key, sequence)
  }

/** Drops a sequence from catalog and runtime registry. */
export const removeSequence =
  (session: Session, name: Ast.QualifiedName, ifExists: boolean): void => {
    const key = sequenceKey(name)
    if (!session.server.sequences.has(key)) {
      if (!ifExists) {
        throw new MssqlError(
          `Cannot drop the sequence '${name.join('.')}', because it does not exist or you do not have permission.`,
          3701, 16)
      }
      return
    }
    Catalog.dropSequence(session.db, name)
    session.server.sequences.delete(key)
  }
