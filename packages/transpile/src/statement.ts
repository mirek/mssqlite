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
        const object = Quote.objectName(source.name)
        const tablePart = source.name[source.name.length - 1] ?? ''
        // When flattening changes the exposed name (schema-qualified or temp
        // tables), alias back to the bare table name so `orders.id` and
        // `sales.orders.id` still resolve.
        const alias = source.alias !== undefined ?
          ` AS ${Quote.identifier(source.alias)}` :
          object === Quote.identifier(tablePart) ?
            '' :
            ` AS ${Quote.identifier(tablePart)}`
        return `${object}${alias}`
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

// ORDER BY keys with select-list aliases substituted by their expressions, so
// the keys stay valid inside a derived subquery that replaces the select list.
const orderKeys =
  (select_: Ast.Select): readonly Ast.OrderBy[] =>
    (select_.orderBy ?? []).map(item => {
      if (item.expression.kind === 'column' && item.expression.name.length === 1) {
        const name = (item.expression.name[0] ?? '').toLowerCase()
        const aliased = select_.items.find(candidate =>
          candidate.kind === 'expression' && candidate.alias?.toLowerCase() === name)
        if (aliased !== undefined && aliased.kind === 'expression') {
          return { ...item, expression: aliased.expression }
        }
      }
      return item
    })

// TOP row budget as a LIMIT expression. PERCENT counts the underlying rows at
// run time via a scalar subquery; WITH TIES widens the budget to every row
// whose RANK() over the ORDER BY keys fits within it.
const topLimit =
  (ctx: Context.t, select_: Ast.Select): string => {
    const top = select_.top
    if (top === undefined) {
      return unsupported('TOP is missing.')
    }
    const { top: _top, orderBy: _orderBy, union: _union, ctes: _ctes, ...bare } = select_
    let budget = expression(ctx, top.count)
    if (top.percent) {
      // DISTINCT needs the real select list to count distinct rows; otherwise
      // a constant keeps the count subquery free of duplicate-name issues.
      const counted = selectCore(ctx, select_.distinct ?
        bare :
        { ...bare, items: [ { kind: 'expression', expression: { kind: 'number', value: '1' } } ] })
      budget = `(SELECT CAST(ceiling(COUNT(*) * (${budget}) / 100.0) AS INTEGER) FROM (${counted}))`
    }
    if (top.withTies !== true) {
      return budget
    }
    if (select_.orderBy === undefined) {
      return unsupported('TOP ... WITH TIES requires ORDER BY.')
    }
    if (select_.distinct) {
      return unsupported('SELECT DISTINCT TOP ... WITH TIES is not supported.')
    }
    const rank: Ast.Expression = {
      kind: 'call',
      name: [ 'rank' ],
      args: [],
      over: { partitionBy: [], orderBy: orderKeys(select_) }
    }
    const ranked = selectCore(ctx, {
      ...bare,
      items: [ { kind: 'expression', expression: rank, alias: '__mssqlite_rank' } ]
    })
    return `(SELECT COUNT(*) FROM (${ranked}) WHERE "__mssqlite_rank" <= ${budget})`
  }

// A TOP inside a set operation is branch-scoped, so wrap that branch's core
// in a LIMIT subquery; SQLite otherwise cannot LIMIT a single compound term.
const setTerm =
  (ctx: Context.t, term: Ast.Select): string => {
    const core = selectCore(ctx, term)
    return term.top === undefined ?
      core :
      `SELECT * FROM (${core} LIMIT ${topLimit(ctx, term)})`
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
    const inSet = select_.union !== undefined
    parts.push(inSet ? setTerm(ctx, select_) : selectCore(ctx, select_))
    for (let union = select_.union; union !== undefined; union = union.select.union) {
      const keyword = {
        union: 'UNION',
        unionAll: 'UNION ALL',
        except: 'EXCEPT',
        intersect: 'INTERSECT'
      }[union.kind]
      parts.push(keyword, setTerm(ctx, union.select))
    }
    if (select_.orderBy !== undefined) {
      parts.push(orderBy(ctx, select_.orderBy))
    }
    if (select_.offset !== undefined) {
      const fetch = select_.fetch === undefined ? '-1' : expression(ctx, select_.fetch)
      parts.push(`LIMIT ${fetch} OFFSET ${expression(ctx, select_.offset)}`)
    } else if (select_.top !== undefined && !inSet) {
      parts.push(`LIMIT ${topLimit(ctx, select_)}`)
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
    if (statement_.top !== undefined && statement_.from !== undefined) {
      return unsupported('UPDATE TOP with a FROM clause is not supported.')
    }
    const assignments = statement_.set
      .map(({ target, operator, value }) => {
        if (target.kind === 'variable') {
          return unsupported('Variable assignment in UPDATE is not supported.')
        }
        const column = Quote.identifier(target.name[target.name.length - 1] ?? '')
        if (operator === '=') {
          return `${column} = ${expression(ctx, value)}`
        }
        // Compound operators reuse binaryOp rendering so += concatenates text,
        // ^= rewrites to xor, etc. — never raw SQLite operators.
        const compound: Ast.Expression = {
          kind: 'binaryOp',
          operator: operator.slice(0, -1),
          left: { kind: 'column', name: target.name },
          right: value
        }
        return `${column} = ${expression(ctx, compound)}`
      })
      .join(', ')
    const target = Quote.objectName(statement_.target)
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    if (statement_.top !== undefined) {
      // MSSQL updates an arbitrary n rows — pick them by rowid.
      return `UPDATE ${target} SET ${assignments} WHERE rowid IN ` +
        `(SELECT rowid FROM ${target}${where} LIMIT ${expression(ctx, statement_.top)})`
    }
    const from = statement_.from === undefined ?
      '' :
      ` FROM ${tableSource(ctx, statement_.from)}`
    return `UPDATE ${target} SET ${assignments}${from}${where}`
  }

/** @returns the plain-table leaves of a join tree. */
const tableLeaves =
  (source: Ast.TableSource): readonly (Ast.TableSource & { kind: 'table' })[] =>
    source.kind === 'table' ?
      [ source ] :
      source.kind === 'join' ?
        [ ...tableLeaves(source.left), ...tableLeaves(source.right) ] :
        []

const delete_ =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'delete' }): string => {
    if (statement_.top !== undefined && statement_.from !== undefined) {
      return unsupported('DELETE TOP with a second FROM clause is not supported.')
    }
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    if (statement_.from !== undefined) {
      // DELETE alias FROM t AS alias JOIN ... — the target names a table or
      // alias inside the FROM join tree; delete its rows by rowid membership.
      const targetName = (statement_.target[statement_.target.length - 1] ?? '').toLowerCase()
      const match = tableLeaves(statement_.from).find(leaf =>
        (leaf.alias ?? leaf.name[leaf.name.length - 1] ?? '').toLowerCase() === targetName)
      if (match === undefined) {
        return unsupported(`DELETE target ${targetName} is not in the FROM clause.`)
      }
      const qualifier = Quote.identifier(match.alias ?? (match.name[match.name.length - 1] ?? ''))
      return `DELETE FROM ${Quote.objectName(match.name)} WHERE rowid IN ` +
        `(SELECT ${qualifier}.rowid FROM ${tableSource(ctx, statement_.from)}${where})`
    }
    const target = Quote.objectName(statement_.target)
    if (statement_.top !== undefined) {
      // MSSQL deletes an arbitrary n rows — pick them by rowid.
      return `DELETE FROM ${target} WHERE rowid IN ` +
        `(SELECT rowid FROM ${target}${where} LIMIT ${expression(ctx, statement_.top)})`
    }
    return `DELETE FROM ${target}${where}`
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
