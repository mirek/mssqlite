import { isDeepStrictEqual } from 'node:util'
import type {
  Comparison, Difference, ExpectedDifference, Snapshot
} from './types.ts'

const comparable =
  (snapshot: Snapshot): unknown => ({
    ...snapshot,
    execution: {
      ...snapshot.execution,
      ...snapshot.execution.error === undefined ? {} : {
        error: {
          number: snapshot.execution.error.number,
          state: snapshot.execution.error.state,
          class: snapshot.execution.error.class,
          lineNumber: snapshot.execution.error.lineNumber
        }
      }
    }
  })

const escape =
  (part: string): string => part.replaceAll('~', '~0').replaceAll('/', '~1')

const present =
  (value: unknown): unknown => value === undefined ? { kind: 'missing' } : value

const differences =
  (left: unknown, right: unknown, path = ''): readonly Difference[] => {
    if (isDeepStrictEqual(left, right)) {
      return []
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const result: Difference[] = []
      const length = Math.max(left.length, right.length)
      for (let index = 0; index < length; index += 1) {
        result.push(...differences(left[index], right[index], `${path}/${index}`))
      }
      return result
    }
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
      const left_ = left as Readonly<Record<string, unknown>>
      const right_ = right as Readonly<Record<string, unknown>>
      const result: Difference[] = []
      for (const key of new Set([ ...Object.keys(left_), ...Object.keys(right_) ])) {
        result.push(...differences(left_[key], right_[key], `${path}/${escape(key)}`))
      }
      return result
    }
    return [ {
      path: path === '' ? '/' : path,
      mssqlite: present(left),
      sqlServer: present(right)
    } ]
  }

const expected =
  (difference: Difference, expectation: ExpectedDifference): boolean =>
    difference.path === expectation.path &&
    isDeepStrictEqual(difference.mssqlite, expectation.mssqlite) &&
    isDeepStrictEqual(difference.sqlServer, expectation.sqlServer)

/** Exact structural comparison, except for declared path-and-value differences. */
export const snapshots =
  (
    mssqlite: Snapshot,
    sqlServer: Snapshot,
    expectations: readonly ExpectedDifference[] = []
  ): Comparison => {
    const found = differences(comparable(mssqlite), comparable(sqlServer))
    return {
      unexpected: found.filter(difference =>
        !expectations.some(expectation => expected(difference, expectation))),
      unusedExpectations: expectations.filter(expectation =>
        !found.some(difference => expected(difference, expectation)))
    }
  }
