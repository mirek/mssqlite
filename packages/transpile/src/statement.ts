import * as Context from './context.ts'
import * as Quote from './quote.ts'
import * as Type from './type.ts'
import expression, { useSelectRender } from './expression.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'

const tableSource =
  (ctx: Context.t, source: Ast.TableSource): string => {
    switch (source.kind) {
      case 'table': {
        const alias = source.alias === undefined ? '' : ` AS ${Quote.identifier(source.alias)}`
        return `${Quote.objectName(source.name)}${alias}`
      }
      case 'derived':
        return `(${select(ctx, source.select)}) AS ${Quote.identifier(source.alias)}`
      case 'join': {
        const left = tableSource(ctx, source.left)
        const right = tableSource(ctx, source.right)
        switch (source.join) {
          case 'cross':
            return `${left} CROSS JOIN ${right}`
          case 'full':
            return `${left} FULL JOIN ${right} ON ${expression(ctx, source.on ?? { kind: 'null' })}`
          default:
            return `${left} ${source.join.toUpperCase()} JOIN ${right} ON ${expression(ctx, source.on ?? { kind: 'null' })}`
        }
      }
      default:
        return unsupported('Unsupported table source.')
    }
  }

const selectItem =
  (ctx: Context.t, item: Ast.SelectItem): string => {
    switch (item.kind) {
      case 'star':
        return item.qualifier === undefined ?
          '*' :
          `${Quote.identifier(item.qualifier[item.qualifier.length - 1] ?? '')}.*`
      case 'expression': {
        const alias = item.alias === undefined ? '' : ` AS ${Quote.identifier(item.alias)}`
        return `${expression(ctx, item.expression)}${alias}`
      }
      case 'assign':
        // Variable-assignment items are rewritten by the engine; render the value.
        return expression(ctx, item.expression)
      default:
        return unsupported('Unsupported select item.')
    }
  }

const orderBy =
  (ctx: Context.t, items: readonly Ast.OrderBy[]): string =>
    `ORDER BY ${items
      .map(item => `${expression(ctx, item.expression)}${item.descending ? ' DESC' : ''}`)
      .join(', ')}`

const selectCore =
  (ctx: Context.t, select_: Ast.Select): string => {
    if (select_.top?.percent === true) {
      return unsupported('TOP ... PERCENT is not supported.')
    }
    const parts: string[] = [
      'SELECT',
      ...select_.distinct ? [ 'DISTINCT' ] : [],
      select_.items.map(item => selectItem(ctx, item)).join(', ')
    ]
    if (select_.from !== undefined) {
      parts.push(`FROM ${tableSource(ctx, select_.from)}`)
    }
    if (select_.where !== undefined) {
      parts.push(`WHERE ${expression(ctx, select_.where)}`)
    }
    if (select_.groupBy !== undefined) {
      parts.push(`GROUP BY ${select_.groupBy.map(value => expression(ctx, value)).join(', ')}`)
    }
    if (select_.having !== undefined) {
      parts.push(`HAVING ${expression(ctx, select_.having)}`)
    }
    return parts.join(' ')
  }

/** @returns SQLite SELECT — CTEs, set operations, TOP/OFFSET/FETCH become LIMIT. */
export const select =
  (ctx: Context.t, select_: Ast.Select): string => {
    const parts: string[] = []
    if (select_.ctes !== undefined) {
      const ctes = select_.ctes
        .map(cte => {
          const columns = cte.columns === undefined ?
            '' :
            ` (${cte.columns.map(Quote.identifier).join(', ')})`
          return `${Quote.identifier(cte.name)}${columns} AS (${select(ctx, cte.select)})`
        })
        .join(', ')
      parts.push(`WITH ${ctes}`)
    }
    parts.push(selectCore(ctx, select_))
    for (let union = select_.union; union !== undefined; union = union.select.union) {
      const keyword = {
        union: 'UNION',
        unionAll: 'UNION ALL',
        except: 'EXCEPT',
        intersect: 'INTERSECT'
      }[union.kind]
      parts.push(keyword, selectCore(ctx, union.select))
    }
    if (select_.orderBy !== undefined) {
      parts.push(orderBy(ctx, select_.orderBy))
    }
    if (select_.offset !== undefined) {
      const fetch = select_.fetch === undefined ? '-1' : expression(ctx, select_.fetch)
      parts.push(`LIMIT ${fetch} OFFSET ${expression(ctx, select_.offset)}`)
    } else if (select_.top !== undefined) {
      parts.push(`LIMIT ${expression(ctx, select_.top.count)}`)
    }
    return parts.join(' ')
  }

useSelectRender(select)

const insert =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'insert' }): string => {
    const table = Quote.objectName(statement_.table)
    const columns = statement_.columns === undefined ?
      '' :
      ` (${statement_.columns.map(Quote.identifier).join(', ')})`
    switch (statement_.source.kind) {
      case 'defaultValues':
        return `INSERT INTO ${table}${columns} DEFAULT VALUES`
      case 'select':
        return `INSERT INTO ${table}${columns} ${select(ctx, statement_.source.select)}`
      case 'values': {
        const rows = statement_.source.rows
          .map(row =>
            `(${row.map(value =>
              value.kind === 'default' ?
                unsupported('DEFAULT in VALUES is not supported.') :
                expression(ctx, value)).join(', ')})`)
          .join(', ')
        return `INSERT INTO ${table}${columns} VALUES ${rows}`
      }
      default:
        return unsupported('Unsupported INSERT source.')
    }
  }

const update =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'update' }): string => {
    if (statement_.top !== undefined) {
      return unsupported('UPDATE TOP is not supported.')
    }
    const assignments = statement_.set
      .map(({ target, operator, value }) => {
        if (target.kind === 'variable') {
          return unsupported('Variable assignment in UPDATE is not supported.')
        }
        const column = Quote.identifier(target.name[target.name.length - 1] ?? '')
        const rendered = expression(ctx, value)
        return operator === '=' ?
          `${column} = ${rendered}` :
          `${column} = ${column} ${operator.slice(0, -1)} ${rendered}`
      })
      .join(', ')
    const from = statement_.from === undefined ?
      '' :
      ` FROM ${tableSource(ctx, statement_.from)}`
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    return `UPDATE ${Quote.objectName(statement_.target)} SET ${assignments}${from}${where}`
  }

const delete_ =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'delete' }): string => {
    if (statement_.top !== undefined) {
      return unsupported('DELETE TOP is not supported.')
    }
    if (statement_.from !== undefined) {
      return unsupported('DELETE with a second FROM clause is not supported.')
    }
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    return `DELETE FROM ${Quote.objectName(statement_.target)}${where}`
  }

const referentialAction =
  (action: Ast.ReferentialAction): string =>
    ({
      noAction: 'NO ACTION',
      cascade: 'CASCADE',
      setNull: 'SET NULL',
      setDefault: 'SET DEFAULT'
    })[action]

const referencesClause =
  (references: NonNullable<Ast.ColumnDefinition['references']>): string => {
    const columns = references.columns === undefined ?
      '' :
      ` (${references.columns.map(Quote.identifier).join(', ')})`
    const onDelete = references.onDelete === undefined ?
      '' :
      ` ON DELETE ${referentialAction(references.onDelete)}`
    const onUpdate = references.onUpdate === undefined ?
      '' :
      ` ON UPDATE ${referentialAction(references.onUpdate)}`
    return `REFERENCES ${Quote.objectName(references.table)}${columns}${onDelete}${onUpdate}`
  }

const columnDefinition =
  (ctx: Context.t, column: Ast.ColumnDefinition, primaryKeyColumns: readonly string[]): string => {
    const parts: string[] = [ Quote.identifier(column.name) ]
    const isPrimaryKey = column.primaryKey === true ||
      (primaryKeyColumns.length === 1 && primaryKeyColumns[0]?.toLowerCase() === column.name.toLowerCase())
    if (column.identity !== undefined) {
      if (Type.category(column.type) !== 'integer') {
        return unsupported('IDENTITY requires an integer column.')
      }
      if (!isPrimaryKey) {
        return unsupported('IDENTITY is only supported on the primary key column.')
      }
      // Rowid alias with AUTOINCREMENT gives MSSQL-like never-reused ids.
      parts.push('INTEGER PRIMARY KEY AUTOINCREMENT')
    } else {
      const type = Type.columnType(column.type)
      if (type !== '') {
        parts.push(type)
      }
      if (column.primaryKey === true) {
        parts.push('PRIMARY KEY')
      }
    }
    if (column.nullable === false && column.identity === undefined) {
      parts.push('NOT NULL')
    }
    if (column.unique === true) {
      parts.push('UNIQUE')
    }
    if (column.default_ !== undefined) {
      parts.push(`DEFAULT (${expression(ctx, column.default_)})`)
    }
    if (column.check !== undefined) {
      parts.push(`CHECK (${expression(ctx, column.check)})`)
    }
    if (column.references !== undefined) {
      parts.push(referencesClause(column.references))
    }
    return parts.join(' ')
  }

const tableConstraint =
  (ctx: Context.t, constraint: Ast.TableConstraint, columnsWithIdentity: readonly string[]): string | undefined => {
    const name = constraint.name === undefined ?
      '' :
      `CONSTRAINT ${Quote.identifier(constraint.name)} `
    switch (constraint.kind) {
      case 'primaryKey': {
        // A single-column PK over the identity column is already declared inline.
        if (constraint.columns.length === 1 &&
          columnsWithIdentity.some(column =>
            column.toLowerCase() === constraint.columns[0]?.name.toLowerCase())) {
          return undefined
        }
        return `${name}PRIMARY KEY (${constraint.columns
          .map(column => `${Quote.identifier(column.name)}${column.descending ? ' DESC' : ''}`)
          .join(', ')})`
      }
      case 'unique':
        return `${name}UNIQUE (${constraint.columns
          .map(column => `${Quote.identifier(column.name)}${column.descending ? ' DESC' : ''}`)
          .join(', ')})`
      case 'foreignKey':
        return `${name}FOREIGN KEY (${constraint.columns.map(Quote.identifier).join(', ')}) ${referencesClause(constraint.references)}`
      case 'check':
        return `${name}CHECK (${expression(ctx, constraint.expression)})`
      default:
        return unsupported('Unsupported table constraint.')
    }
  }

const createTable =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'createTable' }): string => {
    const primaryKey = statement_.constraints.find(
      (constraint): constraint is Ast.TableConstraint & { kind: 'primaryKey' } =>
        constraint.kind === 'primaryKey'
    )
    const primaryKeyColumns = primaryKey?.columns.map(column => column.name) ?? []
    const identityColumns = statement_.columns
      .filter(column => column.identity !== undefined)
      .map(column => column.name)
    const members = [
      ...statement_.columns.map(column => columnDefinition(ctx, column, primaryKeyColumns)),
      ...statement_.constraints
        .map(constraint => tableConstraint(ctx, constraint, identityColumns))
        .filter((rendered): rendered is string => rendered !== undefined)
    ]
    return `CREATE TABLE ${Quote.objectName(statement_.name)} (${members.join(', ')})`
  }

const createIndex =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'createIndex' }): string => {
    const unique = statement_.unique ? 'UNIQUE ' : ''
    const columns = statement_.columns
      .map(column => `${Quote.identifier(column.name)}${column.descending ? ' DESC' : ''}`)
      .join(', ')
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    // INCLUDE columns have no SQLite equivalent — indexes still work, so drop them.
    return `CREATE ${unique}INDEX ${Quote.identifier(statement_.name)} ON ${Quote.objectName(statement_.table)} (${columns})${where}`
  }

/** Rendered statement with the variables it binds. */
export type Rendered = {
  readonly sql: string,
  readonly variables: readonly string[]
}

/**
 * @returns SQLite SQL of a directly renderable statement — SELECT, INSERT,
 * UPDATE, DELETE, TRUNCATE, DDL. Control flow, DECLARE/SET, transactions and
 * EXEC are interpreted by the engine instead.
 */
export const statement =
  (statement_: Ast.Statement): Rendered => {
    const ctx = Context.of()
    const sql = (() => {
      switch (statement_.kind) {
        case 'select':
          return select(ctx, statement_)
        case 'insert':
          return insert(ctx, statement_)
        case 'update':
          return update(ctx, statement_)
        case 'delete':
          return delete_(ctx, statement_)
        case 'truncate':
          return `DELETE FROM ${Quote.objectName(statement_.table)}`
        case 'createTable':
          return createTable(ctx, statement_)
        case 'createIndex':
          return createIndex(ctx, statement_)
        case 'createView': {
          const columns = statement_.columns === undefined ?
            '' :
            ` (${statement_.columns.map(Quote.identifier).join(', ')})`
          return `CREATE VIEW ${Quote.objectName(statement_.name)}${columns} AS ${select(ctx, statement_.select)}`
        }
        case 'dropTable':
          return statement_.names
            .map(name => `DROP TABLE ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.objectName(name)}`)
            .join('; ')
        case 'dropView':
          return statement_.names
            .map(name => `DROP VIEW ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.objectName(name)}`)
            .join('; ')
        case 'dropIndex':
          return `DROP INDEX ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.identifier(statement_.name)}`
        case 'alterTable': {
          const table = Quote.objectName(statement_.name)
          switch (statement_.action.kind) {
            case 'addColumns':
              return statement_.action.columns
                .map(column => `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(ctx, column, [])}`)
                .join('; ')
            case 'dropColumns':
              return statement_.action.columns
                .map(column => `ALTER TABLE ${table} DROP COLUMN ${Quote.identifier(column)}`)
                .join('; ')
            default:
              return unsupported('ALTER TABLE constraints are not supported by SQLite.')
          }
        }
        default:
          return unsupported(`Statement ${statement_.kind} has no direct SQLite rendering.`)
      }
    })()
    return { sql, variables: ctx.variables }
  }

/** @returns rendered scalar expression with its variables. */
export const scalar =
  (expression_: Ast.Expression): Rendered => {
    const ctx = Context.of()
    const sql = expression(ctx, expression_)
    return { sql, variables: ctx.variables }
  }

export default statement
