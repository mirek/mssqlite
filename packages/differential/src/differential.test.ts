import { expect, test } from 'vitest'
import { snapshots } from './compare.ts'
import { corpus } from './corpus.ts'
import { reproduction } from './reproduction.ts'
import { trace } from './trace.ts'
import type { Snapshot } from './types.ts'

const snapshot =
  (value: number): Snapshot => ({
    execution: {
      results: [ {
        columns: [ {
          name: 'value', type: 'Int', length: 4, precision: null, scale: null, nullable: false
        } ],
        rows: [ [ value ] ]
      } ],
      done: [ { kind: 'doneProc', rowCount: 1, more: false } ],
      rowCount: 1
    },
    session: { transactionCount: 0, transactionState: 0, reusable: true }
  })

test('snapshot differences require exact path, values and a used expectation', () => {
  const left = snapshot(1)
  const right = snapshot(2)
  expect(snapshots(left, right)).toEqual({
    unexpected: [ {
      path: '/execution/results/0/rows/0/0', mssqlite: 1, sqlServer: 2
    } ],
    unusedExpectations: []
  })
  expect(snapshots(left, right, [ {
    path: '/execution/results/0/rows/0/0',
    mssqlite: 1,
    sqlServer: 2,
    reason: 'test-only intentional difference'
  } ])).toEqual({ unexpected: [], unusedExpectations: [] })
})

test('corpus has stable unique cases and standalone reproductions', () => {
  expect(new Set(corpus.map(value => value.name)).size).toBe(corpus.length)
  expect(new Set(corpus.map(value => value.sourceTodo))).toEqual(new Set([
    'alter-table-alter-column',
    'apply-derived-tables',
    'character-width-enforcement',
    'for-xml',
    'identity-semantics',
    'implicit-type-conversions',
    'merge-validation',
    'openjson-strict-paths',
    'scalar-result-metadata',
    'select-into-type-preservation',
    'string-comparison-padding',
    'table-value-constructors-in-from',
    'tds-order-token',
    'unique-null-semantics'
  ]))
  for (const value of corpus) {
    expect(reproduction(value)).toContain(value.query.trim())
    expect(reproduction(value)).toContain(`-- audit area: ${value.sourceTodo}`)
    if (value.todo !== undefined) {
      expect(reproduction(value)).toContain(`todo/${value.todo}.md`)
    }
  }
  expect(new Set(corpus.flatMap(value => value.todo ?? []))).toEqual(new Set([
    'catalog-result-metadata',
    'character-cast-width-metadata',
    'fixed-integer-result-metadata',
    'order-token-fidelity',
    'rpc-completion-token-fidelity',
    'runtime-error-stream-fidelity'
  ]))
})

test('communication trace marks ranges, strips color and bounds entries', () => {
  const captured = trace(12)
  captured.record('before')
  const mark = captured.mark()
  captured.record(`${String.fromCharCode(27)}[31mReceived${String.fromCharCode(27)}[0m`)
  captured.record('a long packet header')
  captured.record('DoneToken {\n  name: \'DONE\'\n}')
  expect(captured.since(mark)).toEqual({
    diagnostics: [
      'Received',
      'a long packe\n... 8 trace characters omitted',
      'DoneToken {\n\n... 16 trace characters omitted'
    ],
    tokens: [ 'DoneToken' ]
  })
})
