import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { bindings } from './bind.ts'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Item } from './execute.ts'
import type { Session } from './session.ts'

type Merge =
  Ast.Statement & { kind: 'merge' }

/** Snapshot of match results and pre-evaluated arm values. */
const SNAPSHOT = 'temp."__mssqlite_merge"'

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
 * MERGE semantics require. Rows that match no arm carry a NULL action.
 */
const snapshotSelect =
  (statement: Merge, exposedTarget: string, hasBySource: boolean): Ast.Select => {
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
  (session: Session, statement: Merge, when: Ast.MergeWhen, index: number, exposedTarget: string): number => {
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
        if (when.action.values === undefined) {
          // INSERT DEFAULT VALUES — one insert per unmatched source row.
          const counted = session.db.prepare(
            `SELECT COUNT(*) AS n FROM ${SNAPSHOT} WHERE "__mssqlite_action" = ${tag}`
          ).get() as { n: number }
          const insert = session.db.prepare(`INSERT INTO ${table} DEFAULT VALUES`)
          for (let row = 0; row < counted.n; row++) {
            insert.run()
          }
          return counted.n
        }
        const columns = when.action.columns === undefined ?
          '' :
          ` (${when.action.columns.map(Transpile.Quote.identifier).join(', ')})`
        const values = when.action.values
          .map((_value, position) => `"__mssqlite_v${index}_${position}"`)
          .join(', ')
        const result = session.db.prepare(
          `INSERT INTO ${table}${columns} SELECT ${values} FROM ${SNAPSHOT} WHERE "__mssqlite_action" = ${tag}`
        ).run()
        return Number(result.changes)
      }
    }
  }

/**
 * Executes MERGE by decomposition: one snapshot of match results and arm
 * values taken against the pre-merge state, then per-arm DELETE / UPDATE /
 * INSERT statements reading only the snapshot — atomic via an implicit
 * transaction when none is open.
 */
export const executeMerge =
  (session: Session, statement: Merge, items: Item[]): void => {
    if (statement.output !== undefined) {
      throw new MssqlError('MERGE with an OUTPUT clause is not yet supported.', 40000, 16)
    }
    validateArms(statement.whens)
    for (const when of statement.whens) {
      if (when.action.kind === 'insert') {
        insertColumnCount(session, statement, when.action)
      }
    }
    const exposedTarget = statement.alias ?? last(statement.target)
    const hasBySource = statement.whens.some(when => when.match === 'notMatchedBySource')
    const snapshot = Transpile.statement(snapshotSelect(statement, exposedTarget, hasBySource))
    const implicit = session.transactionCount === 0
    session.db.exec(`DROP TABLE IF EXISTS ${SNAPSHOT}`)
    if (implicit) {
      session.db.exec('BEGIN')
    }
    try {
      session.db.prepare(`CREATE TEMP TABLE "__mssqlite_merge" AS ${snapshot.sql}`)
        .run(bindings(session, snapshot.variables))
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
        const changes = applyArm(session, statement, when, index, exposedTarget)
        total += changes
        if (when.action.kind === 'insert') {
          inserted += changes
        }
      }
      if (inserted > 0 && hasIdentity(session, statement.target)) {
        const lastRow = session.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }
        session.lastIdentity = Number(lastRow.id)
      }
      if (implicit) {
        session.db.exec('COMMIT')
      }
      session.rowCount = total
      items.push({ kind: 'count', rowCount: total })
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
    }
  }
