import { Request, type Connection } from 'tedious'
import { scalar } from './normalize.ts'
import type {
  Column, Done, ErrorSnapshot, Execution, ResultSet
} from './types.ts'

type Metadata = {
  readonly colName: string,
  readonly type: { readonly name: string },
  readonly dataLength?: number,
  readonly precision?: number,
  readonly scale?: number,
  readonly flags: number
}

type ReturnedColumn = {
  readonly value: unknown
}

type RequestError = Error & {
  readonly number?: number,
  readonly state?: number,
  readonly class?: number,
  readonly lineNumber?: number
}

const numberOrNull =
  (value: number | undefined): number | null => value ?? null

const errorSnapshot =
  (error: Error): ErrorSnapshot => {
    const request = error as RequestError
    return {
      number: request.number ?? null,
      state: request.state ?? null,
      class: request.class ?? null,
      lineNumber: request.lineNumber ?? null,
      message: request.message
    }
  }

const metadata =
  (values: readonly Metadata[]): readonly Column[] =>
    values.map(value => ({
      name: value.colName,
      type: value.type.name,
      length: value.dataLength ?? null,
      precision: value.precision ?? null,
      scale: value.scale ?? null,
      nullable: (value.flags & 1) !== 0
    }))

/** Captures every result boundary, row, DONE token, count, and request error. */
export const execute =
  (connection: Connection, sql: string): Promise<Execution> =>
    new Promise(resolve => {
      const results: { columns: readonly Column[], rows: ReturnType<typeof scalar>[][] }[] = []
      const done: Done[] = []
      const request = new Request(sql, (error, rowCount) => {
        resolve({
          results,
          done,
          rowCount: rowCount ?? 0,
          ...error === undefined || error === null ? {} : { error: errorSnapshot(error) }
        })
      })
      request.on('columnMetadata', values => {
        results.push({
          columns: metadata(Object.values(values) as readonly Metadata[]),
          rows: []
        })
      })
      request.on('row', values => {
        const result = results[results.length - 1]
        if (result !== undefined) {
          result.rows.push((Object.values(values) as readonly ReturnedColumn[])
            .map(column => scalar(column.value)))
        }
      })
      request.on('done', (rowCount, more) =>
        done.push({ kind: 'done', rowCount: numberOrNull(rowCount), more }))
      request.on('doneInProc', (rowCount, more) =>
        done.push({ kind: 'doneInProc', rowCount: numberOrNull(rowCount), more }))
      request.on('doneProc', (rowCount, more) =>
        done.push({ kind: 'doneProc', rowCount: numberOrNull(rowCount), more }))
      connection.execSql(request)
    })

export const successful =
  (execution: Execution, context: string): void => {
    if (execution.error !== undefined) {
      throw new Error(`${context}: ${execution.error.message}`)
    }
  }

export const firstRow =
  (execution: Execution): ResultSet['rows'][number] | undefined =>
    execution.results[0]?.rows[0]
