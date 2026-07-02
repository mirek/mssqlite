import * as Type from './type.ts'
import type { Ast } from '@mssqlite/tsql'

/** Approximate static type of an expression — drives `+` add-vs-concat. */
export type Inferred =
  | 'text'
  | 'number'
  | 'unknown'

const textFunctions = new Set([
  'upper', 'lower', 'ltrim', 'rtrim', 'trim', 'replace', 'substring', 'left', 'right',
  'concat', 'concat_ws', 'replicate', 'reverse', 'stuff', 'space', 'char', 'nchar',
  'str', 'string_agg', 'format', 'quotename', 'translate',
  'user_name', 'suser_sname', 'db_name', 'schema_name', 'object_name', 'type_name',
  'newid', 'current_timestamp', 'getdate', 'getutcdate', 'sysdatetime', 'sysutcdatetime',
  'convert_date'
])

const numberFunctions = new Set([
  'len', 'datalength', 'charindex', 'patindex', 'ascii', 'unicode',
  'abs', 'ceiling', 'floor', 'round', 'power', 'sqrt', 'square', 'sign', 'exp', 'log',
  'log10', 'pi', 'rand', 'degrees', 'radians', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'count', 'count_big', 'sum', 'avg', 'row_number', 'rank', 'dense_rank', 'ntile',
  'datediff', 'datepart', 'year', 'month', 'day', 'isnumeric', 'isdate', 'isjson',
  'object_id', 'schema_id', 'db_id', 'type_id', 'scope_identity', 'ident_current'
])

/** @returns approximate static type of an expression. */
export const infer =
  (expression: Ast.Expression): Inferred => {
    switch (expression.kind) {
      case 'number':
        return 'number'
      case 'string':
        return 'text'
      case 'unary':
        return 'number'
      case 'binaryOp': {
        if (expression.operator === '+') {
          const left = infer(expression.left)
          const right = infer(expression.right)
          if (left === 'text' || right === 'text') {
            return 'text'
          }
          if (left === 'number' && right === 'number') {
            return 'number'
          }
          return 'unknown'
        }
        return 'number'
      }
      case 'call': {
        const name = (expression.name[expression.name.length - 1] ?? '').toLowerCase()
        if (textFunctions.has(name)) {
          return 'text'
        }
        if (numberFunctions.has(name)) {
          return 'number'
        }
        if (name === 'isnull' || name === 'coalesce' || name === 'iif' || name === 'nullif' ||
          name === 'min' || name === 'max' || name === 'choose') {
          const inferred = expression.args.map(infer)
          if (inferred.includes('text')) {
            return 'text'
          }
          if (inferred.length > 0 && inferred.every(value => value === 'number')) {
            return 'number'
          }
          return 'unknown'
        }
        return 'unknown'
      }
      case 'cast':
      case 'convert': {
        switch (Type.category(expression.type)) {
          case 'integer':
          case 'real':
          case 'decimal':
          case 'bit':
            return 'number'
          case 'text':
          case 'ntext':
          case 'date':
          case 'time':
          case 'datetime':
          case 'guid':
            return 'text'
          default:
            return 'unknown'
        }
      }
      case 'case': {
        const branches = [
          ...expression.whens.map(({ then }) => infer(then)),
          ...expression.else_ === undefined ? [] : [ infer(expression.else_) ]
        ]
        if (branches.includes('text')) {
          return 'text'
        }
        if (branches.length > 0 && branches.every(value => value === 'number')) {
          return 'number'
        }
        return 'unknown'
      }
      case 'in':
      case 'like':
      case 'between':
      case 'isNull':
      case 'exists':
        return 'number'
      default:
        return 'unknown'
    }
  }

export default infer
