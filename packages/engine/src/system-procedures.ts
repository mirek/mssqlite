import * as Catalog from '@mssqlite/catalog'
import { Collation, DataType, TypeInfo } from '@mssqlite/tds'
import { MssqlError } from './error.ts'
import { sequenceKey } from './sequence.ts'
import { procedureKey, triggerKey, type Session, type Value } from './session.ts'
import type { Item, Rows } from './execute.ts'
import type { Column } from './metadata.ts'

export type Argument = {
  readonly name?: string,
  readonly value: Value | undefined
}

type Parameter = {
  readonly name: string,
  readonly defaultValue?: Value,
  readonly required?: boolean
}

const parameters =
  (procedure: string, args: readonly Argument[], definitions: readonly Parameter[]): Value[] => {
    const supplied = new Map<number, Value | undefined>()
    args.forEach((argument, index) => {
      const at = argument.name === undefined ? index : definitions.findIndex(parameter =>
        parameter.name.toLowerCase() === argument.name?.replace(/^@/, '').toLowerCase())
      if (at < 0 || definitions[at] === undefined) {
        throw new MssqlError(`${argument.name} is not a parameter for procedure ${procedure}.`, 8145, 16)
      }
      if (supplied.has(at)) {
        throw new MssqlError(`The parameter '${definitions[at]?.name}' was specified multiple times.`, 8145, 16)
      }
      supplied.set(at, argument.value)
    })
    if (args.length > definitions.length) {
      throw new MssqlError(`Procedure or function ${procedure} has too many arguments specified.`, 8144, 16)
    }
    return definitions.map((parameter, index) => {
      const value = supplied.get(index)
      if (value !== undefined) {
        return value
      }
      if (parameter.required === true && parameter.defaultValue === undefined) {
        throw new MssqlError(
          `Procedure or function '${procedure}' expects parameter '@${parameter.name}', which was not supplied.`,
          201,
          16
        )
      }
      return parameter.defaultValue ?? null
    })
  }

const column =
  (name: string, typeInfo: TypeInfo.t, nullable = true): Column =>
    ({ name, typeInfo, nullable })

const nvarchar =
  (name: string, length = 128, nullable = true): Column =>
    column(name, TypeInfo.nvarchar(length), nullable)

const varchar =
  (name: string, length: number, nullable = true): Column =>
    column(name, TypeInfo.varchar(length), nullable)

const integer =
  (name: string, length: 1 | 2 | 4 | 8 = 4, nullable = true): Column =>
    column(name, TypeInfo.intN(length), nullable)

const nchar =
  (name: string, length: number, nullable = true): Column =>
    column(name, {
      type: DataType.DataType.nchar,
      maxLength: length * 2,
      collation: Collation.default_
    }, nullable)

const char =
  (name: string, length: number, nullable = true): Column =>
    column(name, {
      type: DataType.DataType.bigChar,
      maxLength: length,
      collation: Collation.default_
    }, nullable)

const rows =
  (columns: readonly Column[], values: readonly (readonly Value[])[]): Rows =>
    ({ kind: 'rows', columns, rows: values, rowCount: values.length })

const stringOf =
  (value: Value): string | null =>
    value === null ? null : String(value)

const objectType =
  (type: string): string => ({
    U: 'user table',
    V: 'view',
    P: 'stored procedure',
    FN: 'SQL scalar function',
    IF: 'SQL inline table-valued function',
    TR: 'SQL trigger',
    SO: 'sequence object'
  }[type] ?? type)

type ObjectRow = {
  readonly object_id: number,
  readonly name: string,
  readonly schema_name: string,
  readonly type: string,
  readonly type_desc: string,
  readonly create_date: string
}

const resolveObject =
  (session: Session, name: string): ObjectRow | undefined => {
    const parts = Catalog.nameParts(name)
    const at = Catalog.objectNameOf(parts)
    return session.db.prepare(
      `SELECT o.object_id, o.name, s.name AS schema_name, o.type, o.type_desc, o.create_date
        FROM "sys.objects" o JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        WHERE o.name = ? AND s.name = ?`
    ).get(at.name, at.schema) as ObjectRow | undefined
  }

const like =
  (value: string, pattern: string | null, usePattern = true): boolean => {
    if (pattern === null) {
      return true
    }
    if (!usePattern) {
      return value.toLowerCase() === pattern.toLowerCase()
    }
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('%', '.*')
      .replaceAll('_', '.')
    return new RegExp(`^${source}$`, 'i').test(value)
  }

const helpSummary =
  (session: Session): Rows => {
    const result = session.db.prepare(
      `SELECT o.name, s.name AS owner, o.type
        FROM "sys.objects" o JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        ORDER BY o.name`
    ).all() as unknown as { name: string, owner: string, type: string }[]
    return rows([
      nvarchar('Name', 128, false),
      nvarchar('Owner', 128, false),
      nvarchar('Object_type', 31, false)
    ], result.map(row => [ row.name, row.owner, objectType(row.type) ]))
  }

const helpType =
  (session: Session, name: string): Rows | undefined => {
    const type = session.db.prepare(
      `SELECT t.name, base.name AS storage_name, t.max_length, t.precision, t.scale,
        t.is_nullable, t.collation_name
        FROM "sys.types" t
        LEFT JOIN "sys.types" base
          ON base.user_type_id = t.system_type_id AND base.user_type_id = base.system_type_id
        WHERE t.name = ? COLLATE NOCASE LIMIT 1`
    ).get(name) as {
      name: string,
      storage_name: string | null,
      max_length: number,
      precision: number,
      scale: number,
      is_nullable: number,
      collation_name: string | null
    } | undefined
    if (type === undefined) {
      return undefined
    }
    return rows([
      nvarchar('Type_name', 128, false), nvarchar('Storage_type', 128, false),
      integer('Length', 2, false), integer('Prec', 4, false), integer('Scale', 4, false),
      varchar('Nullable', 35, false), nvarchar('Default_name'), nvarchar('Rule_name'),
      nvarchar('Collation')
    ], [ [
      type.name, type.storage_name ?? type.name, type.max_length, type.precision, type.scale,
      type.is_nullable === 1 ? 'Yes' : 'No', null, null, type.collation_name
    ] ])
  }

const helpObject =
  (session: Session, object: ObjectRow): Item[] => {
    const items: Item[] = [ rows([
      nvarchar('Name', 128, false), nvarchar('Owner', 128, false),
      nvarchar('Type', 31, false), column('Created_datetime', TypeInfo.datetimeN(8), false)
    ], [ [ object.name, object.schema_name, objectType(object.type), object.create_date ] ]) ]
    if (![ 'U', 'V' ].includes(object.type)) {
      return items
    }
    const columns = session.db.prepare(
      `SELECT c.*, t.name AS type_name
        FROM "sys.columns" c JOIN "sys.types" t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = ? ORDER BY c.column_id`
    ).all(object.object_id) as unknown as {
      name: string,
      type_name: string,
      is_computed: number,
      max_length: number,
      precision: number,
      scale: number,
      is_nullable: number,
      is_ansi_padded: number,
      collation_name: string | null,
      is_identity: number,
      column_id: number
    }[]
    items.push(rows([
      nvarchar('Column_name', 128, false), nvarchar('Type', 128, false),
      varchar('Computed', 35, false), integer('Length', 4, false),
      char('Prec', 5, false), char('Scale', 5, false), varchar('Nullable', 35, false),
      varchar('TrimTrailingBlanks', 35, false), varchar('FixedLenNullInSource', 35, false),
      nvarchar('Collation')
    ], columns.map(entry => [
      entry.name, entry.type_name, entry.is_computed === 1 ? 'Yes' : 'No', entry.max_length,
      String(entry.precision), String(entry.scale), entry.is_nullable === 1 ? 'Yes' : 'No',
      entry.is_ansi_padded === 1 ? 'No' : 'Yes', 'No', entry.collation_name
    ])))
    const identities = session.db.prepare(
      `SELECT c.name, i.seed_value, i.increment_value, i.is_not_for_replication
        FROM "sys.identity_columns_extra" i
        JOIN "sys.columns" c ON c.object_id = i.object_id AND c.column_id = i.column_id
        WHERE i.object_id = ?`
    ).all(object.object_id) as unknown as {
      name: string,
      seed_value: string,
      increment_value: string,
      is_not_for_replication: number
    }[]
    if (identities.length > 0) {
      items.push(rows([
        nvarchar('Identity', 128, false), column('Seed', TypeInfo.decimalN(38, 0), false),
        column('Increment', TypeInfo.decimalN(38, 0), false),
        integer('Not For Replication', 4, false)
      ], identities.map(identity => [
        identity.name, identity.seed_value, identity.increment_value,
        identity.is_not_for_replication
      ])))
    }
    const indexes = session.db.prepare(
      `SELECT name, index_id, type_desc, is_unique, is_primary_key
        FROM "sys.indexes" WHERE object_id = ? AND name IS NOT NULL ORDER BY index_id`
    ).all(object.object_id) as unknown as {
      name: string,
      index_id: number,
      type_desc: string,
      is_unique: number,
      is_primary_key: number
    }[]
    if (indexes.length > 0) {
      const indexRows = indexes.map(index => {
        const keys = session.db.prepare(
          `SELECT c.name, ic.is_descending_key
            FROM "sys.index_columns" ic
            JOIN "sys.columns" c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE ic.object_id = ? AND ic.index_id = ? ORDER BY ic.index_column_id`
        ).all(object.object_id, index.index_id) as unknown as {
          name: string,
          is_descending_key: number
        }[]
        const description = [
          index.is_primary_key === 1 ? 'primary key' : '',
          index.is_unique === 1 ? 'unique' : '',
          index.type_desc.toLowerCase()
        ].filter(Boolean).join(', ')
        return [
          index.name,
          description,
          keys.map(key => `${key.name}${key.is_descending_key === 1 ? '(-)' : ''}`).join(', ')
        ]
      })
      items.push(rows([
        nvarchar('index_name', 128, false), varchar('Index_description', 210, false),
        nvarchar('index_keys', 2078)
      ], indexRows))
    }
    const constraints = session.db.prepare(
      `SELECT name, type_desc FROM "sys.objects"
        WHERE parent_object_id = ? AND type IN ('C', 'D', 'F', 'PK', 'UQ') ORDER BY name`
    ).all(object.object_id) as unknown as { name: string, type_desc: string }[]
    if (constraints.length > 0) {
      items.push(rows([
        nvarchar('constraint_type', 146, false), nvarchar('constraint_name', 128, false),
        nvarchar('delete_action', 9), nvarchar('update_action', 9),
        varchar('status_enabled', 8, false), varchar('status_for_replication', 19, false),
        nvarchar('constraint_keys', 2078)
      ], constraints.map(constraint => [
        constraint.type_desc.replaceAll('_', ' '), constraint.name,
        'N/A', 'N/A', 'Enabled', 'Is_For_Replication', null
      ])))
    }
    return items
  }

const spHelp =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ value ] = parameters('sp_help', args, [ { name: 'objname', defaultValue: null } ])
    const name = stringOf(value ?? null)
    if (name === null) {
      return [ helpSummary(session) ]
    }
    const object = resolveObject(session, name)
    if (object !== undefined) {
      return helpObject(session, object)
    }
    const type = helpType(session, name)
    if (type !== undefined) {
      return [ type ]
    }
    throw new MssqlError(
      `The object '${name}' does not exist in database '${session.database}' or is invalid for this operation.`,
      15009,
      16
    )
  }

const spHelptext =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ objectValue, columnValue ] = parameters('sp_helptext', args, [
      { name: 'objname', required: true },
      { name: 'columnname', defaultValue: null }
    ])
    const name = String(objectValue ?? '')
    const object = resolveObject(session, name)
    let definition: string | null = null
    const columnName = stringOf(columnValue ?? null)
    if (object !== undefined && columnName !== null) {
      const row = session.db.prepare(
        `SELECT cc.definition FROM "sys.computed_columns_extra" cc
          JOIN "sys.columns" c ON c.object_id = cc.object_id AND c.column_id = cc.column_id
          WHERE cc.object_id = ? AND c.name = ?`
      ).get(object.object_id, columnName) as { definition: string | null } | undefined
      definition = row?.definition ?? null
    } else if (object !== undefined) {
      const row = session.db.prepare(
        'SELECT definition FROM "sys.sql_modules" WHERE object_id = ?'
      ).get(object.object_id) as { definition: string | null } | undefined
      definition = row?.definition ?? null
    }
    if (definition === null) {
      throw new MssqlError(
        `The object '${name}' does not exist in database '${session.database}' or is invalid for this operation.`,
        15009,
        16
      )
    }
    const chunks = definition.match(/[\s\S]{1,255}/g) ?? [ '' ]
    return [ rows([ nvarchar('Text', 255, false) ], chunks.map(chunk => [ chunk ])) ]
  }

const odbcType =
  (systemType: number): number | null => ({
    34: -4, 35: -1, 36: -11, 40: 91, 41: 92, 42: 93, 43: -155,
    48: -6, 52: 5, 56: 4, 58: 93, 59: 7, 60: 3, 61: 93, 62: 6,
    98: -150, 99: -10, 104: -7, 106: 3, 108: 2, 122: 3, 127: -5,
    165: -3, 167: 12, 173: -2, 175: 1, 189: -2, 231: -9, 239: -8,
    240: -151, 241: -152
  }[systemType] ?? null)

type ColumnCatalogRow = {
  readonly database_name: string,
  readonly schema_name: string,
  readonly table_name: string,
  readonly column_name: string,
  readonly system_type_id: number,
  readonly type_name: string,
  readonly max_length: number,
  readonly precision: number,
  readonly scale: number,
  readonly is_nullable: number,
  readonly column_id: number,
  readonly definition: string | null
}

const catalogColumns =
  (session: Session): ColumnCatalogRow[] =>
    (session.db.prepare(
      `SELECT s.name AS schema_name, o.name AS table_name,
        c.name AS column_name, c.system_type_id, t.name AS type_name,
        c.max_length, c.precision, c.scale, c.is_nullable, c.column_id,
        dc.definition
        FROM "sys.columns" c
        JOIN "sys.objects" o ON o.object_id = c.object_id
        JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        JOIN "sys.types" t ON t.user_type_id = c.user_type_id
        LEFT JOIN "sys.default_constraints" dc
          ON dc.object_id = c.default_object_id
        WHERE o.type IN ('U', 'V')
        ORDER BY s.name, o.name, c.column_id`
    ).all() as unknown as Omit<ColumnCatalogRow, 'database_name'>[])
      .map(entry => ({ ...entry, database_name: session.database }))

const spColumns =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ tableValue, ownerValue, qualifierValue, columnValue, versionValue ] = parameters(
      'sp_columns',
      args,
      [
        { name: 'table_name', required: true },
        { name: 'table_owner', defaultValue: null },
        { name: 'table_qualifier', defaultValue: null },
        { name: 'column_name', defaultValue: null },
        { name: 'ODBCVer', defaultValue: 2 }
      ]
    )
    const version = Number(versionValue)
    if (![ 2, 3 ].includes(version)) {
      throw new MssqlError('The ODBC version must be 2 or 3.', 15249, 16)
    }
    const tablePattern = String(tableValue ?? '')
    const ownerPattern = stringOf(ownerValue ?? null)
    const qualifierPattern = stringOf(qualifierValue ?? null)
    const columnPattern = stringOf(columnValue ?? null)
    const entries = catalogColumns(session).filter(entry =>
      like(entry.table_name, tablePattern) &&
      like(entry.schema_name, ownerPattern) &&
      like(entry.database_name, qualifierPattern) &&
      like(entry.column_name, columnPattern))
    return [ rows([
      nvarchar('TABLE_QUALIFIER', 128), nvarchar('TABLE_OWNER', 128, false),
      nvarchar('TABLE_NAME', 128, false), nvarchar('COLUMN_NAME', 128, false),
      integer('DATA_TYPE', 2), nvarchar('TYPE_NAME', 128, false),
      integer('PRECISION', 4), integer('LENGTH', 4), integer('SCALE', 2),
      integer('RADIX', 2), integer('NULLABLE', 2, false), varchar('REMARKS', 254),
      nvarchar('COLUMN_DEF', 4000), integer('SQL_DATA_TYPE', 2, false),
      integer('SQL_DATETIME_SUB', 2), integer('CHAR_OCTET_LENGTH', 4),
      integer('ORDINAL_POSITION', 4, false), varchar('IS_NULLABLE', 254, false),
      integer('SS_DATA_TYPE', 1, false)
    ], entries.map(entry => {
      const dataType = odbcType(entry.system_type_id)
      const character = [ 34, 35, 99, 165, 167, 173, 175, 189, 231, 239 ].includes(entry.system_type_id)
      const numeric = [ 48, 52, 56, 59, 60, 62, 106, 108, 122, 127 ].includes(entry.system_type_id)
      const precision = entry.precision > 0 ? entry.precision :
        entry.max_length < 0 ? 0 :
          [ 231, 239, 99 ].includes(entry.system_type_id) ? entry.max_length / 2 : entry.max_length
      return [
        entry.database_name, entry.schema_name, entry.table_name, entry.column_name,
        dataType, entry.type_name, precision, entry.max_length, entry.scale,
        numeric ? 10 : null, entry.is_nullable, null, entry.definition,
        dataType, null, character ? entry.max_length : null, entry.column_id,
        entry.is_nullable === 1 ? 'YES' : 'NO', entry.system_type_id
      ]
    })) ]
  }

const tableTypeFilter =
  (value: string | null): Set<string> | undefined => {
    if (value === null) {
      return undefined
    }
    const values = value.toUpperCase().match(/[A-Z]+(?:\s+[A-Z]+)*/g) ?? []
    return new Set(values.map(entry => entry.trim()))
  }

const spTables =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ tableValue, ownerValue, qualifierValue, typeValue, patternValue ] = parameters(
      'sp_tables',
      args,
      [
        { name: 'table_name', defaultValue: null },
        { name: 'table_owner', defaultValue: null },
        { name: 'table_qualifier', defaultValue: null },
        { name: 'table_type', defaultValue: null },
        { name: 'fUsePattern', defaultValue: 1 }
      ]
    )
    const tablePattern = stringOf(tableValue ?? null)
    const ownerPattern = stringOf(ownerValue ?? null)
    const qualifierPattern = stringOf(qualifierValue ?? null)
    const types = tableTypeFilter(stringOf(typeValue ?? null))
    const usePattern = Number(patternValue) !== 0
    const entries = session.db.prepare(
      `SELECT s.name AS owner, o.name,
        CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS table_type
        FROM "sys.objects" o
        JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V')`
    ).all() as unknown as {
      owner: string,
      name: string,
      table_type: string
    }[]
    const qualified = entries.map(entry => ({ ...entry, qualifier: session.database }))
    const selected = qualified.filter(entry =>
      like(entry.name, tablePattern, usePattern) &&
      like(entry.owner, ownerPattern, usePattern) &&
      like(entry.qualifier, qualifierPattern, usePattern) &&
      (types === undefined || types.has(entry.table_type)))
      .sort((left, right) => [
        left.table_type.localeCompare(right.table_type),
        left.qualifier.localeCompare(right.qualifier),
        left.owner.localeCompare(right.owner),
        left.name.localeCompare(right.name)
      ].find(comparison => comparison !== 0) ?? 0)
    return [ rows([
      nvarchar('TABLE_QUALIFIER', 128), nvarchar('TABLE_OWNER', 128, false),
      nvarchar('TABLE_NAME', 128, false), varchar('TABLE_TYPE', 32, false),
      varchar('REMARKS', 254)
    ], selected.map(entry => [
      entry.qualifier, entry.owner, entry.name, entry.table_type, null
    ])) ]
  }

const spWho =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ filterValue ] = parameters('sp_who', args, [
      { name: 'loginame', defaultValue: null }
    ])
    const filter = stringOf(filterValue ?? null)?.toLowerCase() ?? null
    const activity = session.db.prepare(
      `SELECT s.session_id, s.status, s.login_name, s.host_name,
        r.command, r.request_id
      FROM "sys.dm_exec_sessions" s
      LEFT JOIN "sys.dm_exec_requests" r ON r.session_id = s.session_id
      ORDER BY s.session_id`
    ).all() as unknown as {
      session_id: number,
      status: string,
      login_name: string,
      host_name: string | null,
      command: string | null,
      request_id: number | null
    }[]
    const selected = activity.filter(row => filter === null ||
      (filter === 'active' ? row.request_id !== null :
        filter === row.login_name.toLowerCase() || filter === String(row.session_id)))
    return [ rows([
      integer('spid', 2, false), integer('ecid', 2, false), nchar('status', 30, false),
      nchar('loginame', 128, false), nchar('hostname', 128, false),
      char('blk', 5, false), nchar('dbname', 128, false), nchar('cmd', 26, false),
      integer('request_id', 4, false)
    ], selected.map(row => [
      row.session_id, 0, row.status, row.login_name, row.host_name ?? '',
      '0', session.database, row.command ?? 'AWAITING COMMAND', row.request_id ?? 0
    ])) ]
  }

const databaseBytes =
  (session: Session): number => {
    const pages = session.db.prepare('PRAGMA page_count').get() as { page_count: number }
    const size = session.db.prepare('PRAGMA page_size').get() as { page_size: number }
    return pages.page_count * size.page_size
  }

const megabytes =
  (bytes: number): string =>
    `${(bytes / 1024 / 1024).toFixed(2)} MB`

const kilobytes =
  (bytes: number): string =>
    `${Math.ceil(bytes / 1024)} KB`

const spHelpdb =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ databaseValue ] = parameters('sp_helpdb', args, [
      { name: 'dbname', defaultValue: null }
    ])
    const requested = stringOf(databaseValue ?? null)
    const databases = session.db.prepare(
      `SELECT name, database_id, create_date, compatibility_level, collation_name,
        user_access_desc, state_desc, recovery_model_desc, is_read_only
        FROM "sys.databases" ORDER BY name`
    ).all() as unknown as {
      name: string,
      database_id: number,
      create_date: string,
      compatibility_level: number,
      collation_name: string,
      user_access_desc: string,
      state_desc: string,
      recovery_model_desc: string,
      is_read_only: number
    }[]
    const selected = requested === null ? databases : databases.filter(database =>
      database.name.toLowerCase() === requested.toLowerCase())
    if (selected.length === 0) {
      throw new MssqlError(`Database '${requested}' does not exist.`, 15010, 16)
    }
    const size = databaseBytes(session)
    const items: Item[] = [ rows([
      nvarchar('name', 128, false), nvarchar('db_size', 13, false),
      nvarchar('owner', 128, false), integer('dbid', 2, false),
      nvarchar('created', 11, false), nvarchar('status', 600, false),
      integer('compatibility_level', 1, false)
    ], selected.map(database => [
      database.name,
      database.name.toLowerCase() === session.server.databaseName.toLowerCase() ? megabytes(size) : '0.00 MB',
      'sa', database.database_id, database.create_date.slice(0, 10),
      `Status=${database.state_desc}, Updateability=${database.is_read_only === 1 ? 'READ_ONLY' : 'READ_WRITE'}, ` +
        `UserAccess=${database.user_access_desc}, Recovery=${database.recovery_model_desc}, ` +
        `Collation=${database.collation_name}`,
      database.compatibility_level
    ])) ]
    if (requested !== null) {
      const file = session.db.prepare('PRAGMA database_list').all() as unknown as {
        seq: number,
        name: string,
        file: string
      }[]
      const main = file.find(entry => entry.name === 'main')
      items.push(rows([
        nchar('name', 128, false), integer('fileid', 2, false), nchar('filename', 260, false),
        nvarchar('filegroup', 128), nvarchar('size', 18, false),
        nvarchar('maxsize', 18, false), nvarchar('growth', 18, false),
        varchar('usage', 9, false)
      ], [ [
        `${requested}_data`, 1, main?.file === '' || main?.file === undefined ? ':memory:' : main.file,
        'PRIMARY', megabytes(size), 'UNLIMITED', '1024 KB', 'data only'
      ] ]))
    }
    return items
  }

const dbstatBytes =
  (session: Session, names: readonly string[]): number => {
    if (names.length === 0) {
      return 0
    }
    try {
      const placeholders = names.map(() => '?').join(', ')
      const row = session.db.prepare(
        `SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name IN (${placeholders})`
      ).get(...names) as { bytes: number }
      return row.bytes
    } catch {
      return 0
    }
  }

const spSpaceused =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ objectValue, updateValue, modeValue, oneValue ] = parameters(
      'sp_spaceused',
      args,
      [
        { name: 'objname', defaultValue: null },
        { name: 'updateusage', defaultValue: 'false' },
        { name: 'mode', defaultValue: 'ALL' },
        { name: 'oneresultset', defaultValue: 0 },
        { name: 'include_total_xtp_storage', defaultValue: 0 }
      ]
    )
    const update = String(updateValue ?? '').toLowerCase()
    if (![ 'true', 'false' ].includes(update)) {
      throw new MssqlError('@updateusage must be \'true\' or \'false\'.', 15600, 16)
    }
    const mode = String(modeValue ?? '').toUpperCase()
    if (!([ 'ALL', 'LOCAL_ONLY' ].includes(mode))) {
      throw new MssqlError('REMOTE_ONLY is unavailable because Stretch storage is not configured.', 15600, 16)
    }
    const objectName = stringOf(objectValue ?? null)
    if (objectName !== null) {
      const object = resolveObject(session, objectName)
      if (object === undefined || object.type !== 'U') {
        throw new MssqlError(`Invalid object name '${objectName}'.`, 15009, 16)
      }
      const physical = object.schema_name.toLowerCase() === 'dbo' ?
        object.name : `${object.schema_name}.${object.name}`
      const row = session.db.prepare(`SELECT COUNT(*) AS count FROM "${physical.replaceAll('"', '""')}"`)
        .get() as { count: number }
      const indexes = session.db.prepare(
        'SELECT name FROM "sys.indexes" WHERE object_id = ? AND name IS NOT NULL'
      ).all(object.object_id) as unknown as { name: string }[]
      const data = dbstatBytes(session, [ physical ])
      const index = dbstatBytes(session, indexes.map(entry => entry.name))
      return [ rows([
        nvarchar('name', 128, false), char('rows', 20, false),
        varchar('reserved', 18, false), varchar('data', 18, false),
        varchar('index_size', 18, false), varchar('unused', 18, false)
      ], [ [
        object.name, String(row.count), kilobytes(data + index), kilobytes(data),
        kilobytes(index), '0 KB'
      ] ]) ]
    }
    const size = databaseBytes(session)
    const firstColumns = [
      nvarchar('database_name', 128, false), varchar('database_size', 18, false),
      varchar('unallocated space', 18, false)
    ]
    const secondColumns = [
      varchar('reserved', 18, false), varchar('data', 18, false),
      varchar('index_size', 18, false), varchar('unused', 18, false)
    ]
    const first: readonly Value[] = [ session.database, megabytes(size), '0 KB' ]
    const second: readonly Value[] = [ kilobytes(size), kilobytes(size), '0 KB', '0 KB' ]
    return Number(oneValue) === 1 ?
      [ rows([ ...firstColumns, ...secondColumns ], [ [ ...first, ...second ] ]) ] :
      [ rows(firstColumns, [ first ]), rows(secondColumns, [ second ]) ]
  }

const inferRenameKind =
  (session: Session, name: string): Catalog.RenameKind => {
    if (resolveObject(session, name) !== undefined) {
      return 'object'
    }
    const parts = Catalog.nameParts(name)
    const leaf = parts[parts.length - 1] ?? ''
    const object = resolveObject(session, parts.slice(0, -1).join('.'))
    if (object !== undefined) {
      const columnExists = session.db.prepare(
        'SELECT 1 FROM "sys.columns" WHERE object_id = ? AND name = ?'
      ).get(object.object_id, leaf)
      if (columnExists !== undefined) {
        return 'column'
      }
      const index = session.db.prepare(
        'SELECT 1 FROM "sys.indexes" WHERE object_id = ? AND name = ?'
      ).get(object.object_id, leaf)
      if (index !== undefined) {
        return 'index'
      }
    }
    return 'object'
  }

const updateRenamedRegistry =
  (session: Session, result: Catalog.RenameResult): void => {
    if (result.kind !== 'object') {
      return
    }
    if (result.objectType === 'P') {
      const oldKey = procedureKey(result.oldName)
      const procedure = session.server.procedures.get(oldKey)
      if (procedure !== undefined) {
        session.server.procedures.delete(oldKey)
        session.server.procedures.set(procedureKey(result.newName), {
          ...procedure,
          name: result.newName[result.newName.length - 1] ?? procedure.name
        })
      }
    }
    if (result.objectType === 'TR') {
      const oldKey = triggerKey(result.oldName)
      const trigger = session.server.triggers.get(oldKey)
      if (trigger !== undefined) {
        session.server.triggers.delete(oldKey)
        session.server.triggers.set(triggerKey(result.newName), {
          ...trigger,
          name: result.newName
        })
      }
    }
    if (result.objectType === 'SO') {
      const oldKey = sequenceKey(result.oldName)
      const sequence = session.server.sequences.get(oldKey)
      if (sequence !== undefined) {
        session.server.sequences.delete(oldKey)
        session.server.sequences.set(sequenceKey(result.newName), {
          ...sequence,
          name: result.newName
        })
      }
    }
  }

const requestedRenameKind =
  (session: Session, oldName: string, requested: string | null): Catalog.RenameKind => {
    switch (requested) {
      case null:
        return inferRenameKind(session, oldName)
      case 'COLUMN':
        return 'column'
      case 'INDEX':
        return 'index'
      case 'OBJECT':
        return 'object'
      default:
        throw new MssqlError(`The @objtype parameter '${requested}' is not supported.`, 15248, 16)
    }
  }

const spRename =
  (session: Session, args: readonly Argument[]): Item[] => {
    const [ objectValue, newValue, typeValue ] = parameters('sp_rename', args, [
      { name: 'objname', required: true },
      { name: 'newname', required: true },
      { name: 'objtype', defaultValue: null }
    ])
    const oldName = String(objectValue ?? '')
    const newName = String(newValue ?? '')
    const requested = stringOf(typeValue ?? null)?.toUpperCase() ?? null
    const kind = requestedRenameKind(session, oldName, requested)
    const object = kind === 'object' ? resolveObject(session, oldName) : undefined
    if (object !== undefined && [ 'FN', 'IF' ].includes(object.type)) {
      throw new MssqlError(
        'Renaming functions is unavailable; drop and recreate the function with its new name.',
        15248,
        16
      )
    }
    try {
      const result = Catalog.rename(session.db, oldName, newName, kind)
      updateRenamedRegistry(session, result)
    } catch (error) {
      throw new MssqlError(error instanceof Error ? error.message : String(error), 15248, 16)
    }
    return [ {
      kind: 'message',
      text: 'Caution: renaming an object can break dependent scripts and modules.'
    } ]
  }

/** Built-in names handled before the user procedure registry. */
export const names = new Set([
  'sp_help', 'sp_helptext', 'sp_columns', 'sp_tables',
  'sp_who', 'sp_helpdb', 'sp_rename', 'sp_spaceused'
])

/** Executes a supported system stored procedure, or returns undefined. */
export const execute =
  (session: Session, name: string, args: readonly Argument[]): Item[] | undefined => {
    switch (name.toLowerCase()) {
      case 'sp_help':
        return spHelp(session, args)
      case 'sp_helptext':
        return spHelptext(session, args)
      case 'sp_columns':
        return spColumns(session, args)
      case 'sp_tables':
        return spTables(session, args)
      case 'sp_who':
        return spWho(session, args)
      case 'sp_helpdb':
        return spHelpdb(session, args)
      case 'sp_rename':
        return spRename(session, args)
      case 'sp_spaceused':
        return spSpaceused(session, args)
      default:
        return undefined
    }
  }
