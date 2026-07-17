import datePart from './date-part.ts'
import { string } from './quote.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'

type Call = Ast.Expression & { kind: 'call' }

/** Renders a sub-expression. */
export type Render =
  (expression: Ast.Expression) => string

type Handler =
  (call: Call, render: Render) => string

/** Local datetime now — MSSQL servers report local time. */
const now = 'strftime(\'%Y-%m-%d %H:%M:%f\', \'now\', \'localtime\')'
const utcNow = 'strftime(\'%Y-%m-%d %H:%M:%f\', \'now\')'

const args =
  (call: Call, render: Render): string[] =>
    call.args.map(render)

const arg =
  (call: Call, render: Render, index: number): string => {
    const rendered = args(call, render)[index]
    if (rendered === undefined) {
      return unsupported(`Missing argument ${index + 1} of ${call.name.join('.')}.`)
    }
    return rendered
  }

const fixed =
  (name: string): Handler =>
    (call, render) =>
      call.star === true ?
        `${name}(*)` :
        `${name}(${args(call, render).join(', ')})`

const sum =
  (call: Call, render: Render): string => {
    const value = call.args[0]
    const name = value?.kind === 'cast' || value?.kind === 'convert' ?
      value.type.name === 'bigint' ? 'mssqlite_sum_bigint' :
        value.type.name === 'decimal' || value.type.name === 'numeric' ? 'sum' :
          'mssqlite_sum' :
      'mssqlite_sum'
    return fixed(name)(call, render)
  }

const literalDatePart =
  (call: Call): string => {
    const part = call.args[0] === undefined ? undefined : datePart(call.args[0])
    return part === undefined ?
      unsupported(`Unknown datepart in ${call.name.join('.')}.`) :
      string(part)
  }

const convertStyles: Record<number, string> = {
  23: '%Y-%m-%d',
  101: '%m/%d/%Y',
  102: '%Y.%m.%d',
  103: '%d/%m/%Y',
  105: '%d-%m-%Y',
  108: '%H:%M:%S',
  110: '%m-%d-%Y',
  111: '%Y/%m/%d',
  112: '%Y%m%d',
  114: '%H:%M:%f',
  120: '%Y-%m-%d %H:%M:%S',
  121: '%Y-%m-%d %H:%M:%f',
  126: '%Y-%m-%dT%H:%M:%f'
} as const

/** @returns strftime format string of a CONVERT datetime style, `undefined` if unmapped. */
export const convertStyle =
  (style: number): string | undefined =>
    convertStyles[style]

const handlers: Record<string, Handler> = {
  // Date and time.
  getdate: () => now,
  sysdatetime: () => now,
  current_timestamp: () => now,
  getutcdate: () => utcNow,
  sysutcdatetime: () => utcNow,
  dateadd: (call, render) =>
    `mssqlite_dateadd(${literalDatePart(call)}, ${arg(call, render, 1)}, ${arg(call, render, 2)})`,
  datediff: (call, render) =>
    `mssqlite_datediff(${literalDatePart(call)}, ${arg(call, render, 1)}, ${arg(call, render, 2)})`,
  datepart: (call, render) =>
    `mssqlite_datepart(${literalDatePart(call)}, ${arg(call, render, 1)})`,
  datename: (call, render) =>
    `mssqlite_datename(${literalDatePart(call)}, ${arg(call, render, 1)})`,
  year: (call, render) =>
    `CAST(strftime('%Y', ${arg(call, render, 0)}) AS INTEGER)`,
  month: (call, render) =>
    `CAST(strftime('%m', ${arg(call, render, 0)}) AS INTEGER)`,
  day: (call, render) =>
    `CAST(strftime('%d', ${arg(call, render, 0)}) AS INTEGER)`,
  eomonth: (call, render) =>
    call.args.length === 1 ?
      `date(${arg(call, render, 0)}, 'start of month', '+1 month', '-1 day')` :
      `mssqlite_eomonth(${arg(call, render, 0)}, ${arg(call, render, 1)})`,
  datefromparts: (call, render) =>
    `mssqlite_datefromparts(${args(call, render).join(', ')})`,
  datetimefromparts: fixed('mssqlite_datetimefromparts'),
  isdate: fixed('mssqlite_isdate'),
  // Strings.
  len: fixed('mssqlite_len'),
  datalength: fixed('mssqlite_datalength'),
  substring: fixed('mssqlite_substring'),
  charindex: (call, render) =>
    call.args.length <= 2 ?
      `instr(${arg(call, render, 1)}, ${arg(call, render, 0)})` :
      `mssqlite_charindex(${args(call, render).join(', ')})`,
  patindex: fixed('mssqlite_patindex'),
  left: fixed('mssqlite_left'),
  right: fixed('mssqlite_right'),
  ltrim: fixed('ltrim'),
  rtrim: fixed('rtrim'),
  trim: fixed('trim'),
  upper: fixed('upper'),
  lower: fixed('lower'),
  replace: fixed('replace'),
  translate: fixed('mssqlite_translate'),
  concat: fixed('concat'),
  concat_ws: fixed('concat_ws'),
  replicate: fixed('mssqlite_replicate'),
  space: (call, render) =>
    `mssqlite_replicate(' ', ${arg(call, render, 0)})`,
  reverse: fixed('mssqlite_reverse'),
  stuff: fixed('mssqlite_stuff'),
  char: fixed('mssqlite_char'),
  nchar: fixed('mssqlite_nchar'),
  ascii: fixed('mssqlite_ascii'),
  unicode: fixed('mssqlite_unicode'),
  quotename: fixed('mssqlite_quotename'),
  isnumeric: fixed('mssqlite_isnumeric'),
  // Math.
  abs: fixed('abs'),
  ceiling: fixed('ceiling'),
  floor: fixed('floor'),
  round: fixed('mssqlite_round'),
  power: fixed('power'),
  sqrt: fixed('sqrt'),
  square: (call, render) =>
    `power(${arg(call, render, 0)}, 2)`,
  sign: fixed('sign'),
  exp: fixed('exp'),
  log: (call, render) =>
    call.args.length === 1 ?
      `ln(${arg(call, render, 0)})` :
      `log(${arg(call, render, 1)}, ${arg(call, render, 0)})`,
  log10: fixed('log10'),
  pi: fixed('pi'),
  rand: () => 'mssqlite_rand()',
  degrees: fixed('degrees'),
  radians: fixed('radians'),
  sin: fixed('sin'),
  cos: fixed('cos'),
  tan: fixed('tan'),
  asin: fixed('asin'),
  acos: fixed('acos'),
  atan: fixed('atan'),
  atn2: fixed('atan2'),
  // Logical.
  isnull: fixed('ifnull'),
  coalesce: fixed('coalesce'),
  nullif: fixed('nullif'),
  iif: fixed('iif'),
  choose: (call, render) => {
    const [ index, ...values ] = args(call, render)
    if (index === undefined || values.length === 0) {
      return unsupported('CHOOSE needs an index and at least one value.')
    }
    const whens = values.map((value, at) => `WHEN ${at + 1} THEN ${value}`)
    return `(CASE ${index} ${whens.join(' ')} END)`
  },
  // Aggregates and windows — native names.
  count: fixed('count'),
  count_big: fixed('count'),
  sum,
  avg: fixed('avg'),
  min: fixed('min'),
  max: fixed('max'),
  string_agg: fixed('group_concat'),
  row_number: fixed('row_number'),
  rank: fixed('rank'),
  dense_rank: fixed('dense_rank'),
  ntile: fixed('ntile'),
  lag: fixed('lag'),
  lead: fixed('lead'),
  first_value: fixed('first_value'),
  last_value: fixed('last_value'),
  // JSON.
  isjson: fixed('mssqlite_isjson'),
  json_value: fixed('mssqlite_json_value'),
  json_query: (call, render) => {
    if (call.args.length < 1 || call.args.length > 2) {
      return unsupported('JSON_QUERY expects one or two arguments.')
    }
    return `mssqlite_json_query(${arg(call, render, 0)}, ` +
      `${call.args.length === 1 ? string('$') : arg(call, render, 1)})`
  },
  // System.
  newid: fixed('mssqlite_newid'),
  scope_identity: fixed('mssqlite_scope_identity'),
  ident_current: fixed('mssqlite_ident_current'),
  db_name: (call, render) =>
    call.args.length === 0 ?
      'mssqlite_db_name()' :
      `(SELECT name FROM "sys.databases" WHERE database_id = ${arg(call, render, 0)})`,
  db_id: (call, render) =>
    call.args.length === 0 ?
      'mssqlite_db_id()' :
      `(SELECT database_id FROM "sys.databases" WHERE name = ${arg(call, render, 0)} COLLATE NOCASE)`,
  object_id: (call, render) =>
    `(SELECT object_id FROM "sys.objects" WHERE name = mssqlite_name(${arg(call, render, 0)}) COLLATE NOCASE LIMIT 1)`,
  object_name: (call, render) =>
    `(SELECT name FROM "sys.objects" WHERE object_id = ${arg(call, render, 0)})`,
  object_definition: (call, render) =>
    `(SELECT definition FROM "sys.sql_modules" WHERE object_id = ${arg(call, render, 0)})`,
  schema_id: (call, render) =>
    call.args.length === 0 ?
      '1' :
      `(SELECT schema_id FROM "sys.schemas" WHERE name = ${arg(call, render, 0)} COLLATE NOCASE)`,
  schema_name: (call, render) =>
    call.args.length === 0 ?
      '\'dbo\'' :
      `(SELECT name FROM "sys.schemas" WHERE schema_id = ${arg(call, render, 0)})`,
  type_id: (call, render) =>
    `(SELECT user_type_id FROM "sys.types" WHERE name = mssqlite_name(${arg(call, render, 0)}) COLLATE NOCASE LIMIT 1)`,
  type_name: (call, render) =>
    `(SELECT name FROM "sys.types" WHERE user_type_id = ${arg(call, render, 0)})`,
  serverproperty: fixed('mssqlite_serverproperty'),
  suser_sname: fixed('mssqlite_suser_sname'),
  system_user: fixed('mssqlite_suser_sname'),
  session_user: fixed('mssqlite_user_name'),
  current_user: fixed('mssqlite_user_name'),
  user: fixed('mssqlite_user_name'),
  user_name: fixed('mssqlite_user_name'),
  host_name: fixed('mssqlite_host_name'),
  app_name: fixed('mssqlite_app_name'),
  // Error handling — CATCH-scoped session state via engine UDFs.
  error_number: fixed('mssqlite_error_number'),
  error_message: fixed('mssqlite_error_message'),
  error_severity: fixed('mssqlite_error_severity'),
  error_state: fixed('mssqlite_error_state'),
  error_line: fixed('mssqlite_error_line'),
  error_procedure: fixed('mssqlite_error_procedure'),
  xact_state: fixed('mssqlite_xact_state')
} as const

/**
 * @returns SQLite rendering of a T-SQL function call, mapping built-ins to
 * native SQLite functions or engine-registered `mssqlite_*` UDFs.
 * Unknown single-part names pass through lowercased (user/engine functions).
 */
export const call =
  (expression: Call, render: Render): string => {
    const name = (expression.name[expression.name.length - 1] ?? '').toLowerCase()
    const handler = expression.name.length === 1 ? handlers[name] : undefined
    if (handler !== undefined) {
      return handler(expression, render)
    }
    if (expression.star === true) {
      return `${name}(*)`
    }
    return `${name}(${args(expression, render).join(', ')})`
  }

export default call
