import { TypeInfo, Value as TdsValue } from '@mssqlite/tds'
import { MssqlError } from './error.ts'
import * as Implicit from './implicit.ts'
import type { TypeName } from '@mssqlite/tsql'
import type { Value } from './session.ts'

type Family =
  | 'char'
  | 'varchar'
  | 'nchar'
  | 'nvarchar'

const names: Readonly<Record<string, Family>> = {
  char: 'char',
  character: 'char',
  varchar: 'varchar',
  'character varying': 'varchar',
  nchar: 'nchar',
  'national char': 'nchar',
  'national character': 'nchar',
  nvarchar: 'nvarchar',
  'national char varying': 'nvarchar',
  'national character varying': 'nvarchar'
}

/** @returns canonical character family, `undefined` for another SQL type. */
export const family =
  (type: TypeName.t): Family | undefined =>
    names[type.name]

/** @returns declared character width, using the supplied contextual default. */
export const width =
  (type: TypeName.t, default_: number): number =>
    type.args[0] === 'max' ? -1 :
      typeof type.args[0] === 'number' ? type.args[0] : default_

/** @returns canonical character type with its contextual default width. */
export const normalize =
  (type: TypeName.t, defaultWidth: number): TypeName.t | undefined => {
    const family_ = family(type)
    if (family_ === undefined) {
      return undefined
    }
    const maximum = width(type, defaultWidth)
    return { name: family_, args: [ maximum < 0 ? 'max' : maximum ] }
  }

const text =
  (value: Exclude<Value, null>): string =>
    typeof value === 'boolean' ? value ? '1' : '0' :
      value instanceof Uint8Array ? Buffer.from(value).toString('hex').toUpperCase() :
        String(value)

const typeInfo =
  (family_: Family): TypeInfo.t =>
    family_.startsWith('n') ? TypeInfo.nvarchar('max') : TypeInfo.varchar('max')

const encoded =
  (family_: Family, value: string): Uint8Array =>
    TdsValue.encodeBare(typeInfo(family_), value)

const decoded =
  (family_: Family, value: Uint8Array): string =>
    String(TdsValue.decodeBare(typeInfo(family_), value))

const converted =
  (family_: Family, value: Exclude<Value, null>, maximum: number): string => {
    const bytes = value instanceof Uint8Array ? value : encoded(family_, text(value))
    const unicode = family_.startsWith('n')
    const limit = maximum < 0 ? bytes.byteLength : maximum * (unicode ? 2 : 1)
    const result = decoded(family_, bytes.slice(0, limit))
    if ((family_ === 'char' || family_ === 'nchar') && maximum >= 0) {
      return result.padEnd(maximum, ' ')
    }
    return result
  }

/** @returns a value explicitly converted to a character type. */
export const cast =
  (value: Value, type: TypeName.t, defaultWidth = 1): Value => {
    if (value === null) {
      return null
    }
    const family_ = family(type)
    return family_ === undefined ? value : converted(family_, value, width(type, defaultWidth))
  }

/** @returns a value converted for storage, rejecting truncation with error 2628. */
export const store =
  (value: Value, type: TypeName.t, column: string): Value => {
    if (value === null) {
      return null
    }
    const family_ = family(type)
    if (family_ === undefined) {
      return value
    }
    const maximum = width(type, 1)
    const bytes = value instanceof Uint8Array ? value : encoded(family_, text(value))
    const maximumBytes = maximum * (family_.startsWith('n') ? 2 : 1)
    if (maximum >= 0 && bytes.byteLength > maximumBytes) {
      throw new MssqlError(
        `String or binary data would be truncated in column '${column}'.`,
        2628, 16, 1, { statementTerminating: true })
    }
    return converted(family_, value, maximum)
  }

/** @returns storage byte length using the effective SQL character family. */
export const dataLength =
  (value: Value, typeName?: string): number | null => {
    if (value === null) {
      return null
    }
    const family_ = typeName === undefined ? undefined : names[typeName]
    if (family_ !== undefined) {
      return encoded(family_, text(value)).byteLength
    }
    if (typeof value === 'string') {
      return value.length * 2
    }
    if (value instanceof Uint8Array) {
      return value.byteLength
    }
    if (typeof value === 'bigint') {
      return 8
    }
    return Number.isInteger(value) ? 4 : 8
  }

/** @returns the Windows-1252 byte of the leftmost character. */
export const ascii =
  (value: Value): number | null => {
    if (value === null) {
      return null
    }
    return encoded('varchar', text(value))[0] ?? null
  }

/** @returns the one-byte Windows-1252 character for an integer code. */
export const char =
  (value: Value): string | null => {
    const converted_ = Implicit.integer(value, 'int')
    if (converted_ === null) {
      return null
    }
    const code = Number(converted_)
    return code < 0 || code > 255 ? null : decoded('varchar', Uint8Array.of(code))
  }
