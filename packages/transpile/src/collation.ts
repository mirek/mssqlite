import * as Context from './context.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'

export type Sensitivity = {
  readonly caseSensitive: boolean,
  readonly accentSensitive: boolean,
  readonly binary: boolean
}

const supported: Record<string, Sensitivity> = {
  sql_latin1_general_cp1_ci_as: { caseSensitive: false, accentSensitive: true, binary: false },
  latin1_general_100_ci_as: { caseSensitive: false, accentSensitive: true, binary: false },
  latin1_general_100_cs_as: { caseSensitive: true, accentSensitive: true, binary: false },
  latin1_general_100_ci_ai: { caseSensitive: false, accentSensitive: false, binary: false },
  latin1_general_100_cs_ai: { caseSensitive: true, accentSensitive: false, binary: false },
  latin1_general_100_bin2: { caseSensitive: true, accentSensitive: true, binary: true }
}

/** @returns canonical lower-case key for a supported SQL Server collation. */
export const key =
  (name: string): string => {
    const key_ = name.toLowerCase()
    return supported[key_] === undefined ? unsupported(`Invalid collation '${name}'.`) : key_
  }

/** @returns SQLite built-in collation used as the column's baseline. */
export const sqlite =
  (name: string): 'NOCASE' | 'BINARY' =>
    supported[key(name)]?.caseSensitive === false ? 'NOCASE' : 'BINARY'

/** @returns sensitivity flags for a supported collation. */
export const sensitivity =
  (name: string): Sensitivity =>
    supported[key(name)] as Sensitivity

/** @returns explicit or declared collation of an expression. */
export const ofExpression =
  (ctx: Context.t, value: Ast.Expression): string | undefined => {
    switch (value.kind) {
      case 'collate':
        return key(value.collation)
      case 'column':
        return Context.columnCollation(ctx, value.name)
      case 'cast':
      case 'convert':
        return ofExpression(ctx, value.expression)
      case 'unary':
        return ofExpression(ctx, value.operand)
      case 'binaryOp':
        return ofExpression(ctx, value.left) ?? ofExpression(ctx, value.right)
      case 'case':
        return value.whens.flatMap(when => ofExpression(ctx, when.then) ?? [])[0] ??
          (value.else_ === undefined ? undefined : ofExpression(ctx, value.else_))
      case 'call':
        return value.args.flatMap(argument => ofExpression(ctx, argument) ?? [])[0]
      default:
        return undefined
    }
  }

/** Renders the deterministic normalization key used by predicates and indexes. */
export const expressionKey =
  (rendered: string, name: string): string =>
    `mssqlite_collation_key(${rendered}, '${key(name)}')`
