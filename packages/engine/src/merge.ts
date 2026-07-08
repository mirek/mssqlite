import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { bindings } from './bind.ts'
import { emitOutput, expandOutputStars, query } from './output.ts'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Item } from './execute.ts'
import type { Session } from './session.ts'

type Merge =
  Ast.Statement & { kind: 'merge' }

/** Snapshot of match results and pre-evaluated arm values. */
const SNAPSHOT = 'temp."__mssqlite_merge"'

/** Rowids captured from OUTPUT-observed insert arms. */
const INSERTED = 'temp."__mssqlite_merge_inserted"'

const last =
  (name: Ast.QualifiedName): string =>
    name[name.length - 1] ?? ''

const isNull =
  (expression: Ast.Expression, negated = false): Ast.Expression =>
    ({ kind: 'isNull', expression, negated })

const and =
  (left: Ast.Expression, right: Ast.Expression): Ast.Expression =>
    ({ kind: 'binaryOp', operator: 'and', left, right })

const clauseLabel = {
  matched: 'WHEN MATCHED',
  notMatchedByTarget: 'WHEN NOT MATCHED [BY TARGET]',
  notMatchedBySource: 'WHEN NOT MATCHED BY SOURCE'
} as const

// Grammar already restricts action kinds per clause, so rejecting duplicate
// (clause, action) pairs enforces every T-SQL cap: two MATCHED arms must be
// one UPDATE and one DELETE, one NOT MATCHED insert, two BY SOURCE arms.
const validateArms =
  (whens: readonly Ast.MergeWhen[]): void => {
    const seen = new Set<string>()
    for (const when of whens) {
      const key = `${when.match}:${when.action.kind}`
      if (seen.has(key)) {
        throw new MssqlError(
          `An action of type '${when.action.kind.toUpperCase()}' cannot appear more than once in a '${clauseLabel[when.match]}' clause of a MERGE statement.`,
          10714, 16)
      }
      seen.add(key)
    }
  }

/** @returns SET assignment normalized to a plain target column and its value expression. */
const assignmentOf =
  (assignment: Ast.Assignment, exposedTarget: string): { column: string, value: Ast.Expression } => {
    if (assignment.target.kind === 'variable') {
      throw new MssqlError('Variable assignment in a MERGE statement is not supported.', 40000, 16)
    }
    const name = assignment.target.name
    const qualifier = name.length > 1 ? name[name.length - 2] ?? '' : undefined
    if (qualifier !== undefined && qualifier.toLowerCase() !== exposedTarget.toLowerCase()) {
      throw new MssqlError(`The multi-part identifier "${name.join('.')}" could not be bound.`, 4104, 16)
    }
    const column = last(name)
    if (assignment.operator === '=') {
      return { column, value: assignment.value }
    }
    // Compound operators reuse binaryOp rendering — += concatenates text, etc.
    return {
      column,
      value: {
        kind: 'binaryOp',
        operator: assignment.operator.slice(0, -1),
        left: { kind: 'column', name: [ exposedTarget, column ] },
        right: assignment.value
      }
    }
  }

const insertColumnCount =
  (session: Session, statement: Merge, action: Ast.MergeAction & { kind: 'insert' }): void => {
    if (action.values === undefined) {
      return
    }
    if (action.columns !== undefined) {
      if (action.columns.length > action.values.length) {
        throw new MssqlError(
          'There are more columns in the INSERT statement than values specified in the VALUES clause.', 109, 15)
      }
      if (action.columns.length < action.values.length) {
        throw new MssqlError(
          'There are fewer columns in the INSERT statement than values specified in the VALUES clause.', 110, 15)
      }
      return
    }
    const columns = session.db
      .prepare(`PRAGMA table_info(${Transpile.Quote.objectName(statement.target)})`)
      .all() as { name: string }[]
    if (columns.length > 0 && columns.length !== action.values.length) {
      throw new MssqlError('Column name or number of supplied values does not match table definition.', 213, 16)
    }
  }

const hasIdentity =
  (session: Session, table: Ast.QualifiedName): boolean => {
    const objectId = Catalog.objectIdOf(session.db, table)
    return objectId !== undefined &&
      Catalog.tableColumns(session.db, objectId).some(column => column.is_identity === 1)
  }

/**
 * Snapshot SELECT computing, per source/target row pair, the chosen arm tag
 * and every arm's SET / INSERT values — all against the pre-merge state, as
 * MERGE semantics require. Rows that match no arm carry a NULL action. An
 * OUTPUT clause additionally captures the pre-merge target image
 * (`captureColumns`) as the DELETED pseudo-table's rows.
 */
const snapshotSelect =
  (statement: Merge, exposedTarget: string, hasBySource: boolean, captureColumns: readonly string[]): Ast.Select => {
    const exposedSource = statement.source.kind === 'table' ?
      statement.source.alias ?? last(statement.source.name) :
      statement.source.kind === 'derived' ? statement.source.alias : ''
    // A FULL JOIN row with a missing source side is only detectable through a
    // never-null marker column, so wrap the source when BY SOURCE arms exist.
    const marker: Ast.Expression = { kind: 'column', name: [ exposedSource, '__mssqlite_source' ] }
    const sourceSide: Ast.TableSource = hasBySource ?
      {
        kind: 'derived',
        alias: exposedSource,
        select: {
          kind: 'select',
          distinct: false,
          items: [
            { kind: 'expression', expression: { kind: 'number', value: '1' }, alias: '__mssqlite_source' },
            { kind: 'star', qualifier: [ exposedSource ] }
          ],
          from: statement.source
        }
      } :
      statement.source
    const targetRow: Ast.Expression = { kind: 'column', name: [ exposedTarget, 'rowid' ] }
    const groupTest = (match: Ast.MergeWhen['match']): Ast.Expression => {
      switch (match) {
        case 'matched':
          return hasBySource ?
            and(isNull(marker, true), isNull(targetRow, true)) :
            isNull(targetRow, true)
        case 'notMatchedByTarget':
          return isNull(targetRow)
        default:
          return isNull(marker)
      }
    }
    const actionCase: Ast.Expression = {
      kind: 'case',
      whens: statement.whens.map((when, index) => ({
        when: when.condition === undefined ?
          groupTest(when.match) :
          and(groupTest(when.match), when.condition),
        then: { kind: 'string', value: `a${index}`, national: false }
      }))
    }
    const items: Ast.SelectItem[] = [
      { kind: 'expression', expression: targetRow, alias: '__mssqlite_tgt' },
      { kind: 'expression', expression: actionCase, alias: '__mssqlite_action' }
    ]
    statement.whens.forEach((when, index) => {
      const values = when.action.kind === 'update' ?
        when.action.set.map(assignment => assignmentOf(assignment, exposedTarget).value) :
        when.action.kind === 'insert' ?
          when.action.values ?? [] :
          []
      values.forEach((value, position) => {
        if (value.kind === 'default') {
          throw new MssqlError('DEFAULT in MERGE INSERT values is not supported.', 40000, 16)
        }
        items.push({ kind: 'expression', expression: value, alias: `__mssqlite_v${index}_${position}` })
      })
    })
    captureColumns.forEach((column, position) => {
      items.push({
        kind: 'expression',
        expression: { kind: 'column', name: [ exposedTarget, column ] },
        alias: `__mssqlite_d${position}`
      })
    })
    return {
      kind: 'select',
      distinct: false,
      items,
      from: {
        kind: 'join',
        join: hasBySource ? 'full' : 'left',
        left: sourceSide,
        right: {
          kind: 'table',
          name: statement.target,
          ...statement.alias === undefined ? {} : { alias: statement.alias }
        },
        on: statement.on
      }
    }
  }

// A target row updated or deleted through more than one matched source row is
// nondeterministic — SQL Server rejects it.
const checkCardinality =
  (session: Session, whens: readonly Ast.MergeWhen[]): void => {
    const tags = whens
      .map((when, index) => (when.match === 'matched' ? `'a${index}'` : undefined))
      .filter((tag): tag is string => tag !== undefined)
    if (tags.length === 0) {
      return
    }
    const duplicate = session.db.prepare(
      `SELECT 1 AS one FROM ${SNAPSHOT} WHERE "__mssqlite_action" IN (${tags.join(', ')})
        GROUP BY "__mssqlite_tgt" HAVING COUNT(*) > 1 LIMIT 1`
    ).get()
    if (duplicate !== undefined) {
      throw new MssqlError(
        'The MERGE statement attempted to UPDATE or DELETE the same row more than once. ' +
        'This happens when a target row matches more than one source row. ' +
        'Refine the ON clause to ensure a target row matches at most one source row.',
        8672, 16)
    }
  }

/** @returns rows affected by one arm, applied from the snapshot. */
const applyArm =
  (session: Session, statement: Merge, when: Ast.MergeWhen, index: number, exposedTarget: string, capture: boolean): number => {
    const table = Transpile.Quote.objectName(statement.target)
    // Qualified references to the DML target use the bare table name — the
    // temp schema prefix is not part of the exposed name.
    const targetRef = table.startsWith('temp.') ? table.slice('temp.'.length) : table
    const tag = `'a${index}'`
    switch (when.action.kind) {
      case 'delete':
        return Number(session.db.prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT "__mssqlite_tgt" FROM ${SNAPSHOT} WHERE "__mssqlite_action" = ${tag})`
        ).run().changes)
      case 'update': {
        const sets = when.action.set
          .map((assignment, position) =>
            `${Transpile.Quote.identifier(assignmentOf(assignment, exposedTarget).column)} = m."__mssqlite_v${index}_${position}"`)
          .join(', ')
        return Number(session.db.prepare(
          `UPDATE ${table} SET ${sets} FROM ${SNAPSHOT} AS m WHERE m."__mssqlite_action" = ${tag} AND m."__mssqlite_tgt" = ${targetRef}.rowid`
        ).run().changes)
      }
      default: {
        const record = capture ? session.db.prepare(`INSERT INTO ${INSERTED} VALUES (?)`) : undefined
        if (when.action.values === undefined) {
          // INSERT DEFAULT VALUES — one insert per unmatched source row.
          const counted = session.db.prepare(
            `SELECT COUNT(*) AS n FROM ${SNAPSHOT} WHERE "__mssqlite_action" = ${tag}`
          ).get() as { n: number }
          const insert = session.db.prepare(`INSERT INTO ${table} DEFAULT VALUES`)
          for (let row = 0; row < counted.n; row++) {
            const result = insert.run()
            record?.run(result.lastInsertRowid)
          }
          return counted.n
        }
        const columns = when.action.columns === undefined ?
          '' :
          ` (${when.action.columns.map(Transpile.Quote.identifier).join(', ')})`
        const values = when.action.values
          .map((_value, position) => `"__mssqlite_v${index}_${position}"`)
          .join(', ')
        const insert = `INSERT INTO ${table}${columns} SELECT ${values} FROM ${SNAPSHOT} WHERE "__mssqlite_action" = ${tag}`
        if (record === undefined) {
          return Number(session.db.prepare(insert).run().changes)
        }
        // RETURNING identifies the inserted rows for the OUTPUT images — a
        // pre/post rowid watermark would misattribute reused rowids.
        const rows = session.db.prepare(`${insert} RETURNING rowid AS r`).all() as { r: number | bigint }[]
        for (const row of rows) {
          record.run(row.r)
        }
        return rows.length
      }
    }
  }

const actionWord = {
  update: 'UPDATE',
  delete: 'DELETE',
  insert: 'INSERT'
} as const

const isAction =
  (expression: Ast.Expression): boolean =>
    expression.kind === 'column' &&
    expression.name.length === 1 &&
    (expression.name[0] ?? '').toLowerCase() === '$action'

/**
 * @returns OUTPUT expression with `$action` replaced by the arm's action word
 * — the per-arm SELECTs expose real `inserted` / `deleted` aliases, so column
 * references pass through once validated.
 */
const armExpression =
  (expression: Ast.Expression, word: string): Ast.Expression => {
    const inner = (nested: Ast.Expression): Ast.Expression => armExpression(nested, word)
    switch (expression.kind) {
      case 'column': {
        if (isAction(expression)) {
          return { kind: 'string', value: word, national: true }
        }
        const qualifier = expression.name.length === 2 ? (expression.name[0] ?? '').toLowerCase() : ''
        if (qualifier !== 'inserted' && qualifier !== 'deleted') {
          throw new MssqlError(
            `MERGE OUTPUT column ${expression.name.join('.')} must be qualified with the INSERTED or DELETED pseudo-table, or be $action.`,
            40000, 16)
        }
        return expression
      }
      case 'unary':
        return { ...expression, operand: inner(expression.operand) }
      case 'binaryOp':
        return { ...expression, left: inner(expression.left), right: inner(expression.right) }
      case 'call':
        return { ...expression, args: expression.args.map(inner) }
      case 'cast':
      case 'convert':
        return { ...expression, expression: inner(expression.expression) }
      case 'case':
        return {
          ...expression,
          ...expression.operand === undefined ? {} : { operand: inner(expression.operand) },
          whens: expression.whens.map(({ when, then }) => ({ when: inner(when), then: inner(then) })),
          ...expression.else_ === undefined ? {} : { else_: inner(expression.else_) }
        }
      case 'in':
        if (!Array.isArray(expression.values)) {
          throw new MssqlError('Subqueries are not allowed in an OUTPUT clause.', 40000, 16)
        }
        return { ...expression, expression: inner(expression.expression), values: expression.values.map(inner) }
      case 'like':
        return {
          ...expression,
          expression: inner(expression.expression),
          pattern: inner(expression.pattern),
          ...expression.escape === undefined ? {} : { escape: inner(expression.escape) }
        }
      case 'between':
        return {
          ...expression,
          expression: inner(expression.expression),
          low: inner(expression.low),
          high: inner(expression.high)
        }
      case 'isNull':
        return { ...expression, expression: inner(expression.expression) }
      case 'exists':
      case 'subquery':
        throw new MssqlError('Subqueries are not allowed in an OUTPUT clause.', 40000, 16)
      default:
        return expression
    }
  }

/** Derived table exposing the snapshot's pre-merge target image for one arm. */
const deletedSource =
  (tag: string, columns: readonly string[]): Ast.TableSource => ({
    kind: 'derived',
    alias: 'deleted',
    select: {
      kind: 'select',
      distinct: false,
      items: [
        { kind: 'expression', expression: { kind: 'column', name: [ '__mssqlite_tgt' ] } },
        ...columns.map((column, position): Ast.SelectItem => ({
          kind: 'expression',
          expression: { kind: 'column', name: [ `__mssqlite_d${position}` ] },
          alias: column
        }))
      ],
      from: { kind: 'table', name: [ '__mssqlite_merge' ] },
      where: {
        kind: 'binaryOp',
        operator: '=',
        left: { kind: 'column', name: [ '__mssqlite_action' ] },
        right: { kind: 'string', value: tag, national: false }
      }
    }
  })

/** One-row derived table of NULLs standing in for a pseudo-table with no image. */
const nullSource =
  (alias: string, columns: readonly string[]): Ast.TableSource => ({
    kind: 'derived',
    alias,
    select: {
      kind: 'select',
      distinct: false,
      items: columns.map((column): Ast.SelectItem => ({
        kind: 'expression',
        expression: { kind: 'null' },
        alias: column
      }))
    }
  })

/** @returns FROM tree binding `inserted` / `deleted` to one arm's row images. */
const armFrom =
  (statement: Merge, when: Ast.MergeWhen, index: number, columns: readonly string[]): Ast.TableSource => {
    const tag = `a${index}`
    switch (when.action.kind) {
      case 'update':
        // Old image from the snapshot, new image from the updated table row.
        return {
          kind: 'join',
          join: 'inner',
          left: { kind: 'table', name: statement.target, alias: 'inserted' },
          right: deletedSource(tag, columns),
          on: {
            kind: 'binaryOp',
            operator: '=',
            left: { kind: 'column', name: [ 'inserted', 'rowid' ] },
            right: { kind: 'column', name: [ 'deleted', '__mssqlite_tgt' ] }
          }
        }
      case 'delete':
        return {
          kind: 'join',
          join: 'cross',
          left: deletedSource(tag, columns),
          right: nullSource('inserted', columns)
        }
      default:
        return {
          kind: 'join',
          join: 'cross',
          left: {
            kind: 'join',
            join: 'inner',
            left: { kind: 'table', name: statement.target, alias: 'inserted' },
            right: { kind: 'table', name: [ '__mssqlite_merge_inserted' ] },
            on: {
              kind: 'binaryOp',
              operator: '=',
              left: { kind: 'column', name: [ 'inserted', 'rowid' ] },
              right: { kind: 'column', name: [ '__mssqlite_merge_inserted', 'r' ] }
            }
          },
          right: nullSource('deleted', columns)
        }
    }
  }

/**
 * @returns SELECT assembling the OUTPUT result — a UNION ALL of one SELECT per
 * arm, each exposing the arm's `inserted` / `deleted` images under those
 * aliases with `$action` folded to the arm's literal action word.
 */
const outputSelect =
  (session: Session, statement: Merge, output: Ast.Output, columns: readonly string[]): Ast.Select => {
    const expanded = expandOutputStars(session, statement.target, output.items)
    const selects = statement.whens.map((when, index): Ast.Select => ({
      kind: 'select',
      distinct: false,
      items: expanded.map((item): Ast.SelectItem => {
        if (item.kind !== 'expression') {
          throw new MssqlError('Variable assignment is not allowed in an OUTPUT clause.', 40000, 16)
        }
        const alias = item.alias ?? (isAction(item.expression) ? '$action' : undefined)
        return {
          kind: 'expression',
          expression: armExpression(item.expression, actionWord[when.action.kind]),
          ...alias === undefined ? {} : { alias }
        }
      }),
      from: armFrom(statement, when, index, columns)
    }))
    let chained = selects[selects.length - 1] as Ast.Select
    for (let index = selects.length - 2; index >= 0; index--) {
      chained = { ...selects[index] as Ast.Select, union: { kind: 'unionAll', select: chained } }
    }
    return chained
  }

/**
 * Executes MERGE by decomposition: one snapshot of match results and arm
 * values taken against the pre-merge state, then per-arm DELETE / UPDATE /
 * INSERT statements reading only the snapshot — atomic via an implicit
 * transaction when none is open.
 */
export const executeMerge =
  (session: Session, statement: Merge, items: Item[]): void => {
    validateArms(statement.whens)
    for (const when of statement.whens) {
      if (when.action.kind === 'insert') {
        insertColumnCount(session, statement, when.action)
      }
    }
    const output = statement.output
    const exposedTarget = statement.alias ?? last(statement.target)
    const hasBySource = statement.whens.some(when => when.match === 'notMatchedBySource')
    const targetColumns = output === undefined ?
      [] :
      (session.db
        .prepare(`PRAGMA table_info(${Transpile.Quote.objectName(statement.target)})`)
        .all() as { name: string }[])
        .map(column => column.name)
    const capture = output !== undefined && statement.whens.some(when => when.action.kind === 'insert')
    // Rendered up front so invalid OUTPUT items fail before any arm applies.
    const outputRendered = output === undefined ?
      undefined :
      Transpile.statement(outputSelect(session, statement, output, targetColumns))
    const snapshot = Transpile.statement(snapshotSelect(statement, exposedTarget, hasBySource, targetColumns))
    const implicit = session.transactionCount === 0
    session.db.exec(`DROP TABLE IF EXISTS ${SNAPSHOT}`)
    session.db.exec(`DROP TABLE IF EXISTS ${INSERTED}`)
    if (implicit) {
      session.db.exec('BEGIN')
    }
    try {
      session.db.prepare(`CREATE TEMP TABLE "__mssqlite_merge" AS ${snapshot.sql}`)
        .run(bindings(session, snapshot.variables))
      if (capture) {
        session.db.exec('CREATE TEMP TABLE "__mssqlite_merge_inserted" ("r" INTEGER)')
      }
      checkCardinality(session, statement.whens)
      // Deletes free unique keys for inserts; arm row sets are disjoint, so
      // ordering between arms never changes which rows each one touches.
      const rank = { delete: 0, update: 1, insert: 2 } as const
      const arms = statement.whens
        .map((when, index) => ({ when, index }))
        .sort((a, b) => rank[a.when.action.kind] - rank[b.when.action.kind])
      let total = 0
      let inserted = 0
      for (const { when, index } of arms) {
        const changes = applyArm(session, statement, when, index, exposedTarget, capture)
        total += changes
        if (when.action.kind === 'insert') {
          inserted += changes
        }
      }
      if (inserted > 0 && hasIdentity(session, statement.target)) {
        // Capture-table writes clobber last_insert_rowid — the last captured
        // rowid is the same value.
        const lastRow = capture ?
          session.db.prepare(`SELECT "r" AS id FROM ${INSERTED} ORDER BY rowid DESC LIMIT 1`).get() as { id: number | bigint } :
          session.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }
        session.lastIdentity = Number(lastRow.id)
      }
      if (output !== undefined && outputRendered !== undefined) {
        // Assembled inside the transaction — OUTPUT INTO writes must roll
        // back with the merge if they fail.
        emitOutput(session, output, query(session, outputRendered.sql, outputRendered.variables), items)
      }
      if (implicit) {
        session.db.exec('COMMIT')
      }
      session.rowCount = total
      if (output === undefined) {
        items.push({ kind: 'count', rowCount: total })
      }
    } catch (error) {
      if (implicit) {
        try {
          session.db.exec('ROLLBACK')
        } catch {
          // The failed statement already rolled the transaction back.
        }
      }
      throw error
    } finally {
      session.db.exec(`DROP TABLE IF EXISTS ${SNAPSHOT}`)
      session.db.exec(`DROP TABLE IF EXISTS ${INSERTED}`)
    }
  }
