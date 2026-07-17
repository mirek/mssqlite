import * as Transpile from '@mssqlite/transpile'
import * as Character from './character.ts'
import type { Ast } from '@mssqlite/tsql'

/** @returns target-assignment conversion applied before SQLite storage. */
export const cast =
  (value: Ast.Expression, type: Ast.ColumnDefinition['type'], column = ''): Ast.Expression => {
    if (value.kind === 'default') {
      return value
    }
    if (Character.family(type) !== undefined) {
      const width = Character.width(type, 1)
      return {
        kind: 'call',
        name: [ 'mssqlite_store_character' ],
        args: [
          value,
          { kind: 'string', value: type.name, national: false },
          { kind: 'number', value: String(width) },
          { kind: 'string', value: column, national: false }
        ]
      }
    }
    const category = Transpile.Type.category(type)
    if (category === 'bit') {
      return { kind: 'call', name: [ 'mssqlite_implicit_bit' ], args: [ value ] }
    }
    if (category === 'real') {
      return {
        kind: 'call', name: [ 'mssqlite_implicit_real' ],
        args: [ value, { kind: 'string', value: type.name, national: false } ]
      }
    }
    if ([ 'date', 'time', 'datetime' ].includes(category ?? '') && type.name !== 'datetimeoffset') {
      return {
        kind: 'call', name: [ 'mssqlite_implicit_temporal' ],
        args: [ value, { kind: 'string', value: type.name, national: false } ]
      }
    }
    if (category === 'guid') {
      return { kind: 'call', name: [ 'mssqlite_implicit_guid' ], args: [ value ] }
    }
    return { kind: 'cast', expression: value, type, try_: false }
  }
