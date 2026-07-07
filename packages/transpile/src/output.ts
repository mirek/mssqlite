import * as Quote from './quote.ts'
import { expression } from './expression.ts'
import { unsupported } from './error.ts'
import type * as Context from './context.ts'
import type { Ast } from '@mssqlite/tsql'

/** @returns the pseudo-table a column reference reads, if it names one. */
const pseudoTable =
  (name: Ast.QualifiedName): 'inserted' | 'deleted' | undefined => {
    const first = (name[0] ?? '').toLowerCase()
    return name.length === 2 && (first === 'inserted' || first === 'deleted') ?
      first :
      undefined
  }

const readsDeletedExpression =
  (expression_: Ast.Expression): boolean => {
    switch (expression_.kind) {
      case 'column':
        return pseudoTable(expression_.name) === 'deleted'
      case 'unary':
        return readsDeletedExpression(expression_.operand)
      case 'binaryOp':
        return readsDeletedExpression(expression_.left) || readsDeletedExpression(expression_.right)
      case 'call':
        return expression_.args.some(readsDeletedExpression)
      case 'cast':
      case 'convert':
        return readsDeletedExpression(expression_.expression)
      case 'case':
        return (expression_.operand !== undefined && readsDeletedExpression(expression_.operand)) ||
          expression_.whens.some(({ when, then }) =>
            readsDeletedExpression(when) || readsDeletedExpression(then)) ||
          (expression_.else_ !== undefined && readsDeletedExpression(expression_.else_))
      case 'in':
        return readsDeletedExpression(expression_.expression) ||
          (Array.isArray(expression_.values) && expression_.values.some(readsDeletedExpression))
      case 'like':
        return readsDeletedExpression(expression_.expression) ||
          readsDeletedExpression(expression_.pattern) ||
          (expression_.escape !== undefined && readsDeletedExpression(expression_.escape))
      case 'between':
        return readsDeletedExpression(expression_.expression) ||
          readsDeletedExpression(expression_.low) ||
          readsDeletedExpression(expression_.high)
      case 'isNull':
        return readsDeletedExpression(expression_.expression)
      default:
        return false
    }
  }

/**
 * @returns true when any OUTPUT item reads the pre-change DELETED pseudo-table
 * — those values have no SQLite RETURNING rendering for UPDATE, so the engine
 * snapshots the affected rows instead.
 */
export const readsDeleted =
  (output: Ast.Output): boolean =>
    output.items.some(item =>
      item.kind === 'star' ?
        (item.qualifier?.[item.qualifier.length - 1] ?? '').toLowerCase() === 'deleted' :
        item.kind === 'expression' && readsDeletedExpression(item.expression))

/** Statement kind for OUTPUT validation messages. */
export type StatementName =
  'INSERT' | 'UPDATE' | 'DELETE'

const disallowedPseudo =
  (pseudo: string, statementName: StatementName): never =>
    unsupported(
      `The ${pseudo.toUpperCase()} pseudo-table cannot be referenced in the OUTPUT clause of ` +
      `${statementName === 'INSERT' ? 'an' : 'a'} ${statementName} statement.`)

// Strips the allowed pseudo-table qualifier off column references so they
// resolve against the RETURNING statement's target table.
const rewrite =
  (expression_: Ast.Expression, allowed: 'inserted' | 'deleted', statementName: StatementName): Ast.Expression => {
    const inner = (nested: Ast.Expression): Ast.Expression => rewrite(nested, allowed, statementName)
    switch (expression_.kind) {
      case 'column': {
        const pseudo = pseudoTable(expression_.name)
        if (pseudo === allowed) {
          return { kind: 'column', name: expression_.name.slice(1) }
        }
        if (pseudo !== undefined) {
          return disallowedPseudo(pseudo, statementName)
        }
        return unsupported(
          `OUTPUT column ${expression_.name.join('.')} must be qualified with the INSERTED or DELETED pseudo-table.`)
      }
      case 'unary':
        return { ...expression_, operand: inner(expression_.operand) }
      case 'binaryOp':
        return { ...expression_, left: inner(expression_.left), right: inner(expression_.right) }
      case 'call':
        return { ...expression_, args: expression_.args.map(inner) }
      case 'cast':
      case 'convert':
        return { ...expression_, expression: inner(expression_.expression) }
      case 'case':
        return {
          ...expression_,
          ...expression_.operand === undefined ? {} : { operand: inner(expression_.operand) },
          whens: expression_.whens.map(({ when, then }) => ({ when: inner(when), then: inner(then) })),
          ...expression_.else_ === undefined ? {} : { else_: inner(expression_.else_) }
        }
      case 'in':
        return Array.isArray(expression_.values) ?
          { ...expression_, expression: inner(expression_.expression), values: expression_.values.map(inner) } :
          unsupported('Subqueries are not allowed in an OUTPUT clause.')
      case 'like':
        return {
          ...expression_,
          expression: inner(expression_.expression),
          pattern: inner(expression_.pattern),
          ...expression_.escape === undefined ? {} : { escape: inner(expression_.escape) }
        }
      case 'between':
        return {
          ...expression_,
          expression: inner(expression_.expression),
          low: inner(expression_.low),
          high: inner(expression_.high)
        }
      case 'isNull':
        return { ...expression_, expression: inner(expression_.expression) }
      case 'exists':
      case 'subquery':
        return unsupported('Subqueries are not allowed in an OUTPUT clause.')
      default:
        return expression_
    }
  }

/**
 * @returns ` RETURNING …` clause of a DML statement whose OUTPUT items read
 * only the `allowed` pseudo-table — the values SQLite RETURNING exposes.
 */
export const returning =
  (ctx: Context.t, output: Ast.Output, allowed: 'inserted' | 'deleted', statementName: StatementName): string => {
    const items = output.items.map(item => {
      switch (item.kind) {
        case 'star': {
          const qualifier = (item.qualifier?.[item.qualifier.length - 1] ?? '').toLowerCase()
          if (qualifier === allowed) {
            return '*'
          }
          return qualifier === 'inserted' || qualifier === 'deleted' ?
            disallowedPseudo(qualifier, statementName) :
            unsupported('OUTPUT * must be qualified with the INSERTED or DELETED pseudo-table.')
        }
        case 'expression': {
          const rendered = expression(ctx, rewrite(item.expression, allowed, statementName))
          return item.alias === undefined ? rendered : `${rendered} AS ${Quote.identifier(item.alias)}`
        }
        default:
          return unsupported('Variable assignment is not allowed in an OUTPUT clause.')
      }
    })
    return ` RETURNING ${items.join(', ')}`
  }
