import * as C from './combinators.ts'
import * as Result from './result.ts'
import typeName from './type-name.ts'
import { expression } from './expression.ts'
import { select } from './select.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const referentialAction: Parser.t<Ast.ReferentialAction> =
  C.first(
    C.map(C.keywords('no', 'action'), () => 'noAction' as const),
    C.map(C.keyword('cascade'), () => 'cascade' as const),
    C.map(C.keywords('set', 'null'), () => 'setNull' as const),
    C.map(C.keywords('set', 'default'), () => 'setDefault' as const)
  )

const references: Parser.t<NonNullable<Ast.ColumnDefinition['references']>> =
  reader => {
    const head = C.seq(
      C.keyword('references'),
      C.qualifiedName,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))))
    )(reader)
    if (Result.failed(head)) {
      return head
    }
    const [ , table, columns ] = head.value
    let onDelete: Ast.ReferentialAction | undefined
    let onUpdate: Ast.ReferentialAction | undefined
    let current = head.reader
    for (;;) {
      const delete_ = C.map(C.seq(C.keyword('on'), C.keyword('delete'), referentialAction), ([ , , action ]) => action)(current)
      if (!Result.failed(delete_)) {
        onDelete = delete_.value
        current = delete_.reader
        continue
      }
      const update = C.map(C.seq(C.keyword('on'), C.keyword('update'), referentialAction), ([ , , action ]) => action)(current)
      if (!Result.failed(update)) {
        onUpdate = update.value
        current = update.reader
        continue
      }
      break
    }
    return Result.ok(current, {
      table,
      ...columns === undefined ? {} : { columns },
      ...onDelete === undefined ? {} : { onDelete },
      ...onUpdate === undefined ? {} : { onUpdate }
    })
  }

const indexColumns: Parser.t<{ name: string, descending: boolean }[]> =
  C.parens(C.sepBy1(
    C.map(
      C.seq(C.anyIdentifier, C.maybe(C.first(C.keyword('asc'), C.keyword('desc')))),
      ([ name, direction ]) => ({ name, descending: direction === 'desc' })
    ),
    C.punct(',')
  ))

/** Column definition parser — type plus constraints in any order. */
export const columnDefinition: Parser.t<Ast.ColumnDefinition> =
  reader => {
    const head = C.seq(C.anyIdentifier, typeName)(reader)
    if (Result.failed(head)) {
      return head
    }
    const [ name, type ] = head.value
    const column: {
      -readonly [K in keyof Ast.ColumnDefinition]: Ast.ColumnDefinition[K]
    } = { name, type }
    let current = head.reader
    for (;;) {
      const constraintName = C.map(
        C.seq(C.keyword('constraint'), C.anyIdentifier),
        ([ , value ]) => value
      )(current)
      if (!Result.failed(constraintName)) {
        column.constraintName = constraintName.value
        current = constraintName.reader
        continue
      }
      const notNull = C.seq(C.keyword('not'), C.keyword('null'))(current)
      if (!Result.failed(notNull)) {
        column.nullable = false
        current = notNull.reader
        continue
      }
      const null_ = C.keyword('null')(current)
      if (!Result.failed(null_)) {
        column.nullable = true
        current = null_.reader
        continue
      }
      const identity = C.seq(
        C.keyword('identity'),
        C.maybe(C.parens(C.map(
          C.seq(expression, C.punct(','), expression),
          ([ seed, , increment ]) => [ seed, increment ] as const
        )))
      )(current)
      if (!Result.failed(identity)) {
        const args = identity.value[1]
        const numberOf = (value: Ast.Expression): number => {
          if (value.kind === 'number') {
            return Number(value.value)
          }
          if (value.kind === 'unary' && value.operator === '-' && value.operand.kind === 'number') {
            return -Number(value.operand.value)
          }
          return 1
        }
        column.identity = args === undefined ?
          { seed: 1, increment: 1 } :
          { seed: numberOf(args[0]), increment: numberOf(args[1]) }
        current = identity.reader
        continue
      }
      const primaryKey = C.seq(C.keyword('primary'), C.keyword('key'), C.maybe(C.first(C.keyword('clustered'), C.keyword('nonclustered'))))(current)
      if (!Result.failed(primaryKey)) {
        column.primaryKey = true
        current = primaryKey.reader
        continue
      }
      const unique = C.keyword('unique')(current)
      if (!Result.failed(unique)) {
        column.unique = true
        current = unique.reader
        continue
      }
      const default_ = C.map(C.seq(C.keyword('default'), expression), ([ , value ]) => value)(current)
      if (!Result.failed(default_)) {
        column.default_ = default_.value
        current = default_.reader
        continue
      }
      const check = C.map(C.seq(C.keyword('check'), C.parens(expression)), ([ , value ]) => value)(current)
      if (!Result.failed(check)) {
        column.check = check.value
        current = check.reader
        continue
      }
      const references_ = references(current)
      if (!Result.failed(references_)) {
        column.references = references_.value
        current = references_.reader
        continue
      }
      const collate = C.map(C.seq(C.keyword('collate'), C.anyIdentifier), ([ , value ]) => value)(current)
      if (!Result.failed(collate)) {
        column.collate = collate.value
        current = collate.reader
        continue
      }
      const rowguidcol = C.keyword('rowguidcol')(current)
      if (!Result.failed(rowguidcol)) {
        column.rowguidcol = true
        current = rowguidcol.reader
        continue
      }
      break
    }
    return Result.ok(current, column)
  }

/** Table-level constraint parser. */
export const tableConstraint: Parser.t<Ast.TableConstraint> =
  reader => {
    const name = C.maybe(C.map(
      C.seq(C.keyword('constraint'), C.anyIdentifier),
      ([ , value ]) => value
    ))(reader)
    if (Result.failed(name)) {
      return name
    }
    const withName = name.value === undefined ? {} : { name: name.value }
    const primaryKey = C.map(
      C.seq(
        C.keyword('primary'), C.keyword('key'),
        C.maybe(C.first(C.keyword('clustered'), C.keyword('nonclustered'))),
        indexColumns
      ),
      ([ , , clustered, columns ]): Ast.TableConstraint => ({
        kind: 'primaryKey' as const,
        ...withName,
        clustered: clustered !== 'nonclustered',
        columns
      })
    )(name.reader)
    if (!Result.failed(primaryKey)) {
      return primaryKey
    }
    const unique = C.map(
      C.seq(
        C.keyword('unique'),
        C.maybe(C.first(C.keyword('clustered'), C.keyword('nonclustered'))),
        indexColumns
      ),
      ([ , clustered, columns ]): Ast.TableConstraint => ({
        kind: 'unique' as const,
        ...withName,
        clustered: clustered === 'clustered',
        columns
      })
    )(name.reader)
    if (!Result.failed(unique)) {
      return unique
    }
    const foreignKey = C.map(
      C.seq(
        C.keyword('foreign'), C.keyword('key'),
        C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))),
        references
      ),
      ([ , , columns, references_ ]): Ast.TableConstraint => ({
        kind: 'foreignKey' as const,
        ...withName,
        columns,
        references: references_
      })
    )(name.reader)
    if (!Result.failed(foreignKey)) {
      return foreignKey
    }
    const check = C.map(
      C.seq(C.keyword('check'), C.parens(expression)),
      ([ , expression_ ]): Ast.TableConstraint => ({
        kind: 'check' as const,
        ...withName,
        expression: expression_
      })
    )(name.reader)
    if (!Result.failed(check)) {
      return check
    }
    return Result.fail(reader, 'Expected table constraint.')
  }

/** CREATE TABLE statement parser. */
export const createTable: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('create'), C.keyword('table'), C.qualifiedName,
      C.parens(C.sepBy1(
        C.first<(Parser.t<Ast.TableConstraint | Ast.ColumnDefinition>)[]>(
          tableConstraint,
        columnDefinition
        ),
        C.punct(',')
      )),
      C.maybe(C.punct(';'))
    ),
    ([ , , name, members ]) => ({
      kind: 'createTable' as const,
      name,
      columns: members.filter((member): member is Ast.ColumnDefinition => !('kind' in member)),
      constraints: members.filter((member): member is Ast.TableConstraint => 'kind' in member)
    })
  )

const ifExists: Parser.t<boolean> =
  C.map(
    C.maybe(C.seq(C.keyword('if'), C.keyword('exists'))),
    value => value !== undefined
  )

/** DROP schema-scoped object parser. */
export const drop: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('drop'),
      C.first(
        C.keyword('table'), C.keyword('view'), C.keyword('procedure'),
        C.keyword('proc'), C.keyword('function'), C.keyword('trigger'), C.keyword('sequence')
      ),
      ifExists,
      C.sepBy1(C.qualifiedName, C.punct(','))
    ),
    ([ , what, ifExists_, names ]) =>
      what === 'table' ?
        { kind: 'dropTable' as const, names, ifExists: ifExists_ } :
        what === 'view' ?
          { kind: 'dropView' as const, names, ifExists: ifExists_ } :
          what === 'function' ?
            { kind: 'dropFunction' as const, names, ifExists: ifExists_ } :
            what === 'trigger' ?
              { kind: 'dropTrigger' as const, names, ifExists: ifExists_ } :
              what === 'sequence' ?
                { kind: 'dropSequence' as const, names, ifExists: ifExists_ } :
                { kind: 'dropProcedure' as const, names, ifExists: ifExists_ }
  )

/** CREATE INDEX statement parser. */
export const createIndex: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('create'),
      C.maybe(C.keyword('unique')),
      C.maybe(C.first(C.keyword('clustered'), C.keyword('nonclustered'))),
      C.keyword('index'),
      C.anyIdentifier,
      C.keyword('on'),
      C.qualifiedName,
      indexColumns,
      C.maybe(C.map(
        C.seq(C.keyword('include'), C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
        ([ , columns ]) => columns
      )),
      C.maybe(C.map(C.seq(C.keyword('where'), expression), ([ , value ]) => value))
    ),
    ([ , unique, clustered, , name, , table, columns, include, where ]) => ({
      kind: 'createIndex' as const,
      unique: unique !== undefined,
      clustered: clustered === 'clustered',
      name,
      table,
      columns,
      ...include === undefined ? {} : { include },
      ...where === undefined ? {} : { where }
    })
  )

/** DROP INDEX statement parser — `name ON table` and legacy `table.name` forms. */
export const dropIndex: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('drop'), C.keyword('index'), ifExists,
      C.first(
        C.map(
          C.seq(C.anyIdentifier, C.keyword('on'), C.qualifiedName),
          ([ name, , table ]) => ({ name, table })
        ),
        C.map(C.qualifiedName, name => ({
          name: name[name.length - 1] ?? '',
          table: name.slice(0, -1)
        }))
      )
    ),
    ([ , , ifExists_, at ]) => ({
      kind: 'dropIndex' as const,
      name: at.name,
      ...at.table.length === 0 ? {} : { table: at.table },
      ifExists: ifExists_
    })
  )

/** CREATE [OR ALTER] VIEW statement parser. */
export const createView: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('create'),
      C.maybe(C.seq(C.keyword('or'), C.keyword('alter'))),
      C.keyword('view'),
      C.qualifiedName,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
      C.keyword('as'),
      select
    ),
    ([ , orReplace, , name, columns, , select_ ]) => ({
      kind: 'createView' as const,
      name,
      ...columns === undefined ? {} : { columns },
      select: select_,
      ...orReplace === undefined ? {} : { orReplace: true }
    })
  )

/** ALTER TABLE statement parser. */
export const alterTable: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('alter'), C.keyword('table'), C.qualifiedName,
      C.first<Parser.t<(Ast.Statement & { kind: 'alterTable' })['action']>[]>(
        C.map(
          C.seq(C.keyword('add'), C.sepBy1(
            C.first<(Parser.t<Ast.TableConstraint | Ast.ColumnDefinition>)[]>(
              tableConstraint,
            columnDefinition
            ),
            C.punct(',')
          )),
          ([ , members ]) => {
            const constraints = members.filter((member): member is Ast.TableConstraint => 'kind' in member)
            return constraints.length > 0 ?
              { kind: 'addConstraints' as const, constraints } :
              {
                kind: 'addColumns' as const,
                columns: members.filter((member): member is Ast.ColumnDefinition => !('kind' in member))
              }
          }
        ),
      C.map(
        C.seq(C.keyword('drop'), C.keyword('column'), C.sepBy1(C.anyIdentifier, C.punct(','))),
        ([ , , columns ]) => ({ kind: 'dropColumns' as const, columns })
      ),
      C.map(
        C.seq(C.keyword('drop'), C.keyword('constraint'), C.sepBy1(C.anyIdentifier, C.punct(','))),
        ([ , , names ]) => ({ kind: 'dropConstraints' as const, names })
      )
      )
    ),
    ([ , , name, action ]) => ({ kind: 'alterTable' as const, name, action })
  )
