import { columnType } from './type-row.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { DatabaseSync } from 'node:sqlite'

/** Resolved object name — schema defaults to dbo, database qualifiers drop. */
export type ObjectName = {
  readonly schema: string,
  readonly name: string
}

/** @returns schema/name of a T-SQL qualified name. */
export const objectNameOf =
  (name: Ast.QualifiedName): ObjectName => {
    const parts = name.length > 2 ? name.slice(-2) : [ ...name ]
    return parts.length === 2 ?
      { schema: parts[0] ?? 'dbo', name: parts[1] ?? '' } :
      { schema: 'dbo', name: parts[0] ?? '' }
  }

/** @returns next object id, advancing the allocator. */
export const allocateId =
  (db: DatabaseSync): number => {
    const row = db.prepare('SELECT next_id FROM "sys._next_id"').get() as { next_id: number }
    db.prepare('UPDATE "sys._next_id" SET next_id = next_id + 1').run()
    return row.next_id
  }

/** @returns the last database-wide rowversion value allocated. */
export const rowversionValue =
  (db: DatabaseSync): string => {
    const row = db.prepare(
      'SELECT current_value FROM "sys.rowversion_state" WHERE singleton = 1'
    ).get() as { current_value: string }
    return row.current_value
  }

/** Persists the last database-wide rowversion value allocated. */
export const updateRowversionValue =
  (db: DatabaseSync, value: string): void => {
    db.prepare(
      'UPDATE "sys.rowversion_state" SET current_value = ? WHERE singleton = 1'
    ).run(value)
  }

/** @returns schema id, creating the schema row on first use. */
export const schemaIdOf =
  (db: DatabaseSync, schema: string): number => {
    const row = db.prepare('SELECT schema_id FROM "sys.schemas" WHERE name = ?').get(schema) as
      { schema_id: number } | undefined
    if (row !== undefined) {
      return row.schema_id
    }
    const max = db.prepare('SELECT MAX(schema_id) AS max_id FROM "sys.schemas"').get() as { max_id: number }
    const id = Math.max(5, max.max_id + 1)
    db.prepare('INSERT INTO "sys.schemas" (schema_id, name) VALUES (?, ?)').run(id, schema)
    return id
  }

/** @returns object id of a schema-scoped object, `undefined` when absent. */
export const objectIdOf =
  (db: DatabaseSync, name: Ast.QualifiedName): number | undefined => {
    const at = objectNameOf(name)
    const row = db.prepare(
      `SELECT o.object_id FROM "sys.objects" o
        JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        WHERE o.name = ? AND s.name = ?`
    ).get(at.name, at.schema) as { object_id: number } | undefined
    return row?.object_id
  }

/** Catalog row of a table column, as stored in sys.columns. */
export type ColumnRow = {
  readonly object_id: number,
  readonly name: string,
  readonly column_id: number,
  readonly system_type_id: number,
  readonly user_type_id: number,
  readonly max_length: number,
  readonly precision: number,
  readonly scale: number,
  readonly collation_name: string | null,
  readonly is_nullable: number,
  readonly is_rowguidcol?: number,
  readonly is_identity: number
  readonly is_computed: number
  readonly default_object_id?: number
}

/** @returns sys.columns rows of an object ordered by column id. */
export const tableColumns =
  (db: DatabaseSync, objectId: number): ColumnRow[] =>
    db.prepare('SELECT * FROM "sys.columns" WHERE object_id = ? ORDER BY column_id')
      .all(objectId) as unknown as ColumnRow[]

const insertObject =
  (db: DatabaseSync, fields: {
    objectId: number,
    name: string,
    schemaId: number,
    parentObjectId?: number,
    type: string,
    typeDesc: string
  }): void => {
    db.prepare(
      `INSERT INTO "sys.objects" (object_id, name, schema_id, parent_object_id, type, type_desc)
        VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      fields.objectId, fields.name, fields.schemaId,
      fields.parentObjectId ?? 0, fields.type, fields.typeDesc
    )
  }

const insertIndexColumns =
  (db: DatabaseSync, objectId: number, indexId: number, columns: readonly { name: string, descending?: boolean }[], columnIds: Map<string, number>): void => {
    const insert = db.prepare(
      `INSERT INTO "sys.index_columns"
        (object_id, index_id, index_column_id, column_id, key_ordinal, is_descending_key)
        VALUES (?, ?, ?, ?, ?, ?)`
    )
    columns.forEach((column, at) => {
      insert.run(
        objectId, indexId, at + 1,
        columnIds.get(column.name.toLowerCase()) ?? 0,
        at + 1,
        column.descending === true ? 1 : 0
      )
    })
  }

const referentialActionCode: Record<string, [ number, string ]> = {
  noAction: [ 0, 'NO_ACTION' ],
  cascade: [ 1, 'CASCADE' ],
  setNull: [ 2, 'SET_NULL' ],
  setDefault: [ 3, 'SET_DEFAULT' ]
} as const

const insertForeignKey =
  (db: DatabaseSync, fields: {
    name: string | undefined,
    tableObjectId: number,
    schemaId: number,
    tableName: string,
    columns: readonly string[],
    references: NonNullable<Ast.ColumnDefinition['references']>,
    columnIds: Map<string, number>
  }): void => {
    const objectId = allocateId(db)
    const referencedId = objectIdOf(db, fields.references.table)
    if (referencedId === undefined) {
      return
    }
    insertObject(db, {
      objectId,
      name: fields.name ?? `FK__${fields.tableName}__${objectId}`,
      schemaId: fields.schemaId,
      parentObjectId: fields.tableObjectId,
      type: 'F',
      typeDesc: 'FOREIGN_KEY_CONSTRAINT'
    })
    const [ deleteCode, deleteDesc ] = referentialActionCode[fields.references.onDelete ?? 'noAction'] ?? [ 0, 'NO_ACTION' ]
    const [ updateCode, updateDesc ] = referentialActionCode[fields.references.onUpdate ?? 'noAction'] ?? [ 0, 'NO_ACTION' ]
    db.prepare(
      `INSERT INTO "sys.foreign_keys"
        (object_id, referenced_object_id, key_index_id,
         delete_referential_action, delete_referential_action_desc,
         update_referential_action, update_referential_action_desc, is_system_named)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      objectId, referencedId,
      deleteCode, deleteDesc, updateCode, updateDesc,
      fields.name === undefined ? 1 : 0
    )
    const referencedColumns = tableColumns(db, referencedId)
    const referencedByName = new Map(referencedColumns.map(column => [ column.name.toLowerCase(), column.column_id ]))
    const insert = db.prepare(
      `INSERT INTO "sys.foreign_key_columns"
        (constraint_object_id, constraint_column_id, parent_object_id, parent_column_id,
         referenced_object_id, referenced_column_id)
        VALUES (?, ?, ?, ?, ?, ?)`
    )
    fields.columns.forEach((column, at) => {
      const referencedColumn = fields.references.columns?.[at]
      insert.run(
        objectId, at + 1,
        fields.tableObjectId, fields.columnIds.get(column.toLowerCase()) ?? 0,
        referencedId,
        referencedColumn === undefined ?
          referencedColumns[at]?.column_id ?? 0 :
          referencedByName.get(referencedColumn.toLowerCase()) ?? 0
      )
    })
  }

const insertColumn =
  (db: DatabaseSync, objectId: number, columnId: number, column: Ast.ColumnDefinition): void => {
    const type = columnType(column.type) ?? {
      systemTypeId: 231,
      userTypeId: 231,
      maxLength: -1,
      precision: 0,
      scale: 0,
      collationName: 'SQL_Latin1_General_CP1_CI_AS'
    }
    db.prepare(
      `INSERT INTO "sys.columns"
        (object_id, name, column_id, system_type_id, user_type_id, max_length,
         precision, scale, collation_name, is_nullable, is_rowguidcol, is_identity, is_computed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      objectId, column.name, columnId,
      type.systemTypeId, type.userTypeId, type.maxLength,
      type.precision, type.scale, column.collate ?? type.collationName,
      column.nullable === false || column.primaryKey === true || column.identity !== undefined ||
        ([ 'rowversion', 'timestamp' ].includes(column.type.name) && column.nullable !== true) ? 0 : 1,
      column.rowguidcol === true ? 1 : 0,
      column.identity === undefined ? 0 : 1,
      column.computed === undefined ? 0 : 1
    )
    if (column.identity !== undefined) {
      db.prepare(
        `INSERT INTO "sys.identity_columns_extra" (object_id, column_id, seed_value, increment_value)
          VALUES (?, ?, ?, ?)`
      ).run(objectId, columnId, column.identity.seed, column.identity.increment)
    }
    if (column.computed !== undefined) {
      db.prepare(
        `INSERT INTO "sys.computed_columns_extra"
          (object_id, column_id, definition, uses_database_collation, is_persisted)
          VALUES (?, ?, ?, 0, ?)`
      ).run(
        objectId, columnId, column.computed.definition,
        column.computed.persisted ? 1 : 0
      )
    }
  }

type ExpressionRenderer = (expression: Ast.Expression) => string

const expressionDefinition =
  (render: ExpressionRenderer | undefined, expression: Ast.Expression): string | null =>
    render === undefined ? null : `(${render(expression)})`

const insertKeyConstraint =
  (db: DatabaseSync, fields: {
    kind: 'primaryKey' | 'unique',
    name: string | undefined,
    tableObjectId: number,
    tableName: string,
    schemaId: number,
    indexId: number,
    columns: readonly { name: string, descending?: boolean }[],
    columnIds: Map<string, number>
  }): number => {
    const objectId = allocateId(db)
    const primary = fields.kind === 'primaryKey'
    insertObject(db, {
      objectId,
      name: fields.name ?? `${primary ? 'PK' : 'UQ'}__${fields.tableName}__${objectId}`,
      schemaId: fields.schemaId,
      parentObjectId: fields.tableObjectId,
      type: primary ? 'PK' : 'UQ',
      typeDesc: primary ? 'PRIMARY_KEY_CONSTRAINT' : 'UNIQUE_CONSTRAINT'
    })
    db.prepare(
      'INSERT INTO "sys.key_constraints" (object_id, unique_index_id, is_system_named) VALUES (?, ?, ?)'
    ).run(objectId, fields.indexId, fields.name === undefined ? 1 : 0)
    db.prepare(
      `INSERT INTO "sys.indexes"
        (object_id, name, index_id, type, type_desc, is_unique, is_primary_key, is_unique_constraint)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      fields.tableObjectId,
      fields.name ?? `${primary ? 'PK' : 'UQ'}__${fields.tableName}__${objectId}`,
      fields.indexId,
      primary ? 1 : 2,
      primary ? 'CLUSTERED' : 'NONCLUSTERED',
      primary ? 1 : 0,
      primary ? 0 : 1
    )
    insertIndexColumns(db, fields.tableObjectId, fields.indexId, fields.columns, fields.columnIds)
    return fields.indexId
  }

/** Registers a created table — objects, columns, constraints, indexes. */
export const createTable =
  (
    db: DatabaseSync,
    statement: Ast.Statement & { kind: 'createTable' },
    renderExpression?: ExpressionRenderer
  ): number => {
    const at = objectNameOf(statement.name)
    const schemaId = schemaIdOf(db, at.schema)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId,
      type: 'U',
      typeDesc: 'USER_TABLE'
    })
    const columnIds = new Map<string, number>()
    statement.columns.forEach((column, index) => {
      columnIds.set(column.name.toLowerCase(), index + 1)
      insertColumn(db, objectId, index + 1, column)
    })
    let nextIndexId = 2
    let hasPrimaryKey = false
    // Column-level constraints.
    statement.columns.forEach(column => {
      const columns = [ { name: column.name } ]
      if (column.primaryKey === true || (column.identity !== undefined && !hasPrimaryKey &&
        !statement.constraints.some(constraint => constraint.kind === 'primaryKey'))) {
        insertKeyConstraint(db, {
          kind: 'primaryKey',
          name: column.constraintName,
          tableObjectId: objectId,
          tableName: at.name,
          schemaId,
          indexId: 1,
          columns,
          columnIds
        })
        hasPrimaryKey = true
      } else if (column.unique === true) {
        insertKeyConstraint(db, {
          kind: 'unique',
          name: undefined,
          tableObjectId: objectId,
          tableName: at.name,
          schemaId,
          indexId: nextIndexId++,
          columns,
          columnIds
        })
      }
      if (column.references !== undefined) {
        insertForeignKey(db, {
          name: undefined,
          tableObjectId: objectId,
          schemaId,
          tableName: at.name,
          columns: [ column.name ],
          references: column.references,
          columnIds
        })
      }
      if (column.check !== undefined) {
        const checkId = allocateId(db)
        insertObject(db, {
          objectId: checkId,
          name: `CK__${at.name}__${checkId}`,
          schemaId,
          parentObjectId: objectId,
          type: 'C',
          typeDesc: 'CHECK_CONSTRAINT'
        })
        db.prepare(
          `INSERT INTO "sys.check_constraints"
            (object_id, parent_column_id, definition, is_system_named)
            VALUES (?, ?, ?, 1)`
        ).run(
          checkId, columnIds.get(column.name.toLowerCase()) ?? 0,
          expressionDefinition(renderExpression, column.check)
        )
      }
      if (column.default_ !== undefined) {
        const defaultId = allocateId(db)
        insertObject(db, {
          objectId: defaultId,
          name: column.constraintName ?? `DF__${at.name}__${defaultId}`,
          schemaId,
          parentObjectId: objectId,
          type: 'D',
          typeDesc: 'DEFAULT_CONSTRAINT'
        })
        db.prepare(
          `INSERT INTO "sys.default_constraints_extra"
            (object_id, parent_column_id, definition, is_system_named)
            VALUES (?, ?, ?, ?)`
        ).run(
          defaultId, columnIds.get(column.name.toLowerCase()) ?? 0,
          expressionDefinition(renderExpression, column.default_),
          column.constraintName === undefined ? 1 : 0
        )
        db.prepare(
          `UPDATE "sys.columns" SET default_object_id = ?
            WHERE object_id = ? AND column_id = ?`
        ).run(defaultId, objectId, columnIds.get(column.name.toLowerCase()) ?? 0)
      }
    })
    // Table-level constraints.
    for (const constraint of statement.constraints) {
      switch (constraint.kind) {
        case 'primaryKey':
          if (!hasPrimaryKey) {
            insertKeyConstraint(db, {
              kind: 'primaryKey',
              name: constraint.name,
              tableObjectId: objectId,
              tableName: at.name,
              schemaId,
              indexId: 1,
              columns: constraint.columns,
              columnIds
            })
            hasPrimaryKey = true
          }
          break
        case 'unique':
          insertKeyConstraint(db, {
            kind: 'unique',
            name: constraint.name,
            tableObjectId: objectId,
            tableName: at.name,
            schemaId,
            indexId: nextIndexId++,
            columns: constraint.columns,
            columnIds
          })
          break
        case 'foreignKey':
          insertForeignKey(db, {
            name: constraint.name,
            tableObjectId: objectId,
            schemaId,
            tableName: at.name,
            columns: constraint.columns,
            references: constraint.references,
            columnIds
          })
          break
        case 'check': {
          const checkId = allocateId(db)
          insertObject(db, {
            objectId: checkId,
            name: constraint.name ?? `CK__${at.name}__${checkId}`,
            schemaId,
            parentObjectId: objectId,
            type: 'C',
            typeDesc: 'CHECK_CONSTRAINT'
          })
          db.prepare(
            `INSERT INTO "sys.check_constraints" (object_id, definition, is_system_named)
              VALUES (?, ?, ?)`
          ).run(
            checkId, expressionDefinition(renderExpression, constraint.expression),
            constraint.name === undefined ? 1 : 0
          )
          break
        }
        default:
          break
      }
    }
    if (!hasPrimaryKey) {
      db.prepare(
        `INSERT INTO "sys.indexes" (object_id, name, index_id, type, type_desc)
          VALUES (?, NULL, 0, 0, 'HEAP')`
      ).run(objectId)
    }
    return objectId
  }

/** Removes a dropped table and its dependent catalog rows. */
export const dropTable =
  (db: DatabaseSync, name: Ast.QualifiedName): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    const children = db.prepare('SELECT object_id FROM "sys.objects" WHERE parent_object_id = ?')
      .all(objectId) as { object_id: number }[]
    const ids = [ objectId, ...children.map(row => row.object_id) ]
    for (const id of ids) {
      db.prepare('DELETE FROM "sys.sql_modules" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.index_columns" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.indexes" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.columns" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.foreign_key_columns" WHERE constraint_object_id = ? OR parent_object_id = ?').run(id, id)
      db.prepare('DELETE FROM "sys.foreign_keys" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.key_constraints" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.check_constraints" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.default_constraints_extra" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.identity_columns_extra" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.computed_columns_extra" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(id)
    }
  }

/** Registers a created index. */
export const createIndex =
  (db: DatabaseSync, statement: Ast.Statement & { kind: 'createIndex' }): void => {
    const objectId = objectIdOf(db, statement.table)
    if (objectId === undefined) {
      return
    }
    const max = db.prepare('SELECT MAX(index_id) AS max_id FROM "sys.indexes" WHERE object_id = ?')
      .get(objectId) as { max_id: number | null }
    const indexId = Math.max(2, (max.max_id ?? 0) + 1)
    db.prepare(
      `INSERT INTO "sys.indexes"
        (object_id, name, index_id, type, type_desc, is_unique, has_filter)
        VALUES (?, ?, ?, 2, 'NONCLUSTERED', ?, ?)`
    ).run(objectId, statement.name, indexId, statement.unique ? 1 : 0, statement.where === undefined ? 0 : 1)
    const columns = tableColumns(db, objectId)
    const columnIds = new Map(columns.map(column => [ column.name.toLowerCase(), column.column_id ]))
    insertIndexColumns(db, objectId, indexId, statement.columns, columnIds)
  }

/** Removes a dropped index. */
export const dropIndex =
  (db: DatabaseSync, name: string): void => {
    const row = db.prepare('SELECT object_id, index_id FROM "sys.indexes" WHERE name = ?').get(name) as
      { object_id: number, index_id: number } | undefined
    if (row === undefined) {
      return
    }
    db.prepare('DELETE FROM "sys.index_columns" WHERE object_id = ? AND index_id = ?')
      .run(row.object_id, row.index_id)
    db.prepare('DELETE FROM "sys.indexes" WHERE object_id = ? AND index_id = ?')
      .run(row.object_id, row.index_id)
  }

/** Registers a created view. */
export const createView =
  (db: DatabaseSync, name: Ast.QualifiedName, definition = ''): number => {
    const existing = objectIdOf(db, name)
    if (existing !== undefined) {
      db.prepare(
        `UPDATE "sys.objects" SET modify_date = strftime('%Y-%m-%d %H:%M:%S', 'now')
          WHERE object_id = ?`
      ).run(existing)
      db.prepare(
        `INSERT INTO "sys.sql_modules" (object_id, definition) VALUES (?, ?)
          ON CONFLICT(object_id) DO UPDATE SET definition = excluded.definition`
      ).run(existing, definition)
      return existing
    }
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      type: 'V',
      typeDesc: 'VIEW'
    })
    db.prepare('INSERT INTO "sys.sql_modules" (object_id, definition) VALUES (?, ?)')
      .run(objectId, definition)
    return objectId
  }

/** Removes a dropped view. */
export const dropView =
  (db: DatabaseSync, name: Ast.QualifiedName): void => {
    const objectId = objectIdOf(db, name)
    if (objectId !== undefined) {
      db.prepare('DELETE FROM "sys.sql_modules" WHERE object_id = ?').run(objectId)
      db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(objectId)
    }
  }

/** Registers a created procedure with its module definition. */
export const createProcedure =
  (db: DatabaseSync, name: Ast.QualifiedName, definition: string): number => {
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      type: 'P',
      typeDesc: 'SQL_STORED_PROCEDURE'
    })
    db.prepare('INSERT INTO "sys.sql_modules" (object_id, definition) VALUES (?, ?)')
      .run(objectId, definition)
    return objectId
  }

const dropModule =
  (db: DatabaseSync, name: Ast.QualifiedName): void => {
    const objectId = objectIdOf(db, name)
    if (objectId !== undefined) {
      db.prepare('DELETE FROM "sys.routine_metadata" WHERE object_id = ?').run(objectId)
      db.prepare('DELETE FROM "sys.sql_modules" WHERE object_id = ?').run(objectId)
      db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(objectId)
    }
  }

/** Removes a dropped procedure and its module row. */
export const dropProcedure =
  dropModule

const characterTypes =
  new Set([ 'char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname' ])
const unicodeTypes =
  new Set([ 'nchar', 'nvarchar', 'ntext', 'sysname' ])
const numericTypes =
  new Set([ 'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric',
    'money', 'smallmoney', 'real', 'float' ])
const datetimeTypes =
  new Set([ 'time', 'datetime2', 'datetimeoffset' ])

type RoutineMetadata = readonly (string | number | null)[]

const when =
  <T extends string | number>(condition: boolean, value: T | null | undefined): T | null =>
    condition ? value ?? null : null

const maximumCharacters =
  (maxLength: number | undefined, unicode: boolean): number | null => {
    if (maxLength === undefined || maxLength === -1) {
      return maxLength ?? null
    }
    return unicode ? maxLength / 2 : maxLength
  }

const numericRadix =
  (numeric: boolean, name: string): number | null => {
    if (!numeric) {
      return null
    }
    return [ 'real', 'float' ].includes(name) ? 2 : 10
  }

const routineMetadata =
  (tableValued: boolean, returnType: TypeName.t | undefined): RoutineMetadata => {
    if (tableValued) {
      return [ 'table', null, null, null, null, null, null, null, null ]
    }
    if (returnType === undefined) {
      return [ null, null, null, null, null, null, null, null, null ]
    }
    const type = columnType(returnType)
    const character = characterTypes.has(returnType.name)
    const unicode = unicodeTypes.has(returnType.name)
    const numeric = numericTypes.has(returnType.name)
    const datetime = datetimeTypes.has(returnType.name)
    return [
      returnType.name,
      when(character, maximumCharacters(type?.maxLength, unicode)),
      when(character, type?.maxLength),
      when(character, type?.collationName),
      when(character, unicode ? 'UNICODE' : 'iso_1'),
      when(numeric, type?.precision),
      numericRadix(numeric, returnType.name),
      when(numeric, type?.scale),
      when(datetime, type?.scale)
    ]
  }

/** Registers a scalar or inline table-valued function definition. */
export const createFunction =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    definition: string,
    tableValued: boolean,
    returnType?: TypeName.t
  ): number => {
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      type: tableValued ? 'IF' : 'FN',
      typeDesc: tableValued ? 'SQL_INLINE_TABLE_VALUED_FUNCTION' : 'SQL_SCALAR_FUNCTION'
    })
    db.prepare(
      `INSERT INTO "sys.sql_modules" (object_id, definition, is_inlineable, inline_type)
        VALUES (?, ?, ?, ?)`
    ).run(objectId, definition, tableValued ? 1 : 0, tableValued ? 1 : 0)
    db.prepare(
      `INSERT INTO "sys.routine_metadata" (
        object_id, data_type, character_maximum_length, character_octet_length,
        collation_name, character_set_name, numeric_precision, numeric_precision_radix,
        numeric_scale, datetime_precision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(objectId, ...routineMetadata(tableValued, returnType))
    return objectId
  }

/** Removes a dropped function and its module row. */
export const dropFunction =
  dropModule

/** Registers a table DML trigger with its module definition. */
export const createTrigger =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    target: Ast.QualifiedName,
    definition: string
  ): number => {
    const parentObjectId = objectIdOf(db, target)
    if (parentObjectId === undefined) {
      throw new Error(`Trigger target ${target.join('.')} does not exist.`)
    }
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      parentObjectId,
      type: 'TR',
      typeDesc: 'SQL_TRIGGER'
    })
    db.prepare('INSERT INTO "sys.sql_modules" (object_id, definition) VALUES (?, ?)')
      .run(objectId, definition)
    return objectId
  }

/** Removes a trigger and its module row. */
export const dropTrigger =
  dropModule

export type SequenceState = {
  readonly dataType: TypeName.t,
  readonly start: string,
  readonly increment: string,
  readonly minimum: string,
  readonly maximum: string,
  readonly cycling: boolean,
  readonly cached: boolean,
  readonly cacheSize: number | null,
  readonly current: string,
  readonly exhausted: boolean,
  readonly lastUsed: string | null
}

/** Persisted sequence row joined to its schema-scoped name. */
export type SequenceRow = {
  readonly object_id: number,
  readonly schema_name: string,
  readonly name: string,
  readonly type_name: string,
  readonly precision: number,
  readonly scale: number,
  readonly start_value: string,
  readonly increment_value: string,
  readonly minimum_value: string,
  readonly maximum_value: string,
  readonly is_cycling: number,
  readonly is_cached: number,
  readonly cache_size: number | null,
  readonly current_value: string,
  readonly is_exhausted: number,
  readonly last_used_value: string | null
}

const insertSequenceState =
  (db: DatabaseSync, objectId: number, state: SequenceState): void => {
    const type = columnType(state.dataType)
    if (type === undefined) {
      throw new Error(`Unknown sequence type ${state.dataType.name}.`)
    }
    db.prepare(
      `INSERT INTO "sys.sequence_state" (
        object_id, system_type_id, user_type_id, precision, scale,
        start_value, increment_value, minimum_value, maximum_value,
        is_cycling, is_cached, cache_size, current_value, is_exhausted, last_used_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      objectId, type.systemTypeId, type.userTypeId, type.precision, type.scale,
      state.start, state.increment, state.minimum, state.maximum,
      state.cycling ? 1 : 0, state.cached ? 1 : 0, state.cacheSize,
      state.current, state.exhausted ? 1 : 0, state.lastUsed
    )
  }

/** Registers a schema-scoped sequence and its persistent counter state. */
export const createSequence =
  (db: DatabaseSync, name: Ast.QualifiedName, state: SequenceState): number => {
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      type: 'SO',
      typeDesc: 'SEQUENCE_OBJECT'
    })
    insertSequenceState(db, objectId, state)
    return objectId
  }

/** Replaces a sequence's persisted definition and counter state. */
export const alterSequence =
  (db: DatabaseSync, name: Ast.QualifiedName, state: SequenceState): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    db.prepare('DELETE FROM "sys.sequence_state" WHERE object_id = ?').run(objectId)
    insertSequenceState(db, objectId, state)
    db.prepare(
      `UPDATE "sys.objects" SET modify_date = strftime('%Y-%m-%d %H:%M:%S', 'now')
        WHERE object_id = ?`
    ).run(objectId)
  }

/** Removes a sequence object and its persistent state. */
export const dropSequence =
  (db: DatabaseSync, name: Ast.QualifiedName): void => {
    const objectId = objectIdOf(db, name)
    if (objectId !== undefined) {
      db.prepare('DELETE FROM "sys.sequence_state" WHERE object_id = ?').run(objectId)
      db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(objectId)
    }
  }

/** Returns all persisted sequences for server-registry hydration. */
export const sequenceRows =
  (db: DatabaseSync): SequenceRow[] =>
    db.prepare(
      `SELECT q.*, o.name, s.name AS schema_name, t.name AS type_name
        FROM "sys.sequence_state" q
        JOIN "sys.objects" o ON o.object_id = q.object_id
        JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        JOIN "sys.types" t ON t.user_type_id = q.user_type_id
        WHERE o.type = 'SO'`
    ).all() as unknown as SequenceRow[]

/** Flushes the allocation fields of one sequence. */
export const updateSequenceValue =
  (
    db: DatabaseSync,
    objectId: number,
    current: string,
    exhausted: boolean,
    lastUsed: string | null
  ): void => {
    db.prepare(
      `UPDATE "sys.sequence_state"
        SET current_value = ?, is_exhausted = ?, last_used_value = ?
        WHERE object_id = ?`
    ).run(current, exhausted ? 1 : 0, lastUsed, objectId)
  }

/** Persisted identity column joined to its table, schema and declared type. */
export type IdentityRow = {
  readonly object_id: number,
  readonly column_id: number,
  readonly schema_name: string,
  readonly table_name: string,
  readonly column_name: string,
  readonly type_name: string,
  readonly precision: number,
  readonly scale: number,
  readonly seed_value: string,
  readonly increment_value: string,
  readonly last_value: string | null
}

/** Returns every persisted identity definition for runtime hydration. */
export const identityRows =
  (db: DatabaseSync): IdentityRow[] =>
    db.prepare(
      `SELECT i.object_id, i.column_id, s.name AS schema_name,
        o.name AS table_name, c.name AS column_name, t.name AS type_name,
        c.precision, c.scale, i.seed_value, i.increment_value, i.last_value
      FROM "sys.identity_columns_extra" i
      JOIN "sys.objects" o ON o.object_id = i.object_id
      JOIN "sys.schemas" s ON s.schema_id = o.schema_id
      JOIN "sys.columns" c
        ON c.object_id = i.object_id AND c.column_id = i.column_id
      JOIN "sys.types" t ON t.user_type_id = c.user_type_id
      WHERE o.type = 'U'`
    ).all() as unknown as IdentityRow[]

/** Persists one identity column's last generated or accepted explicit value. */
export const updateIdentityValue =
  (db: DatabaseSync, objectId: number, columnId: number, last: string | null): void => {
    db.prepare(
      `UPDATE "sys.identity_columns_extra" SET last_value = ?
        WHERE object_id = ? AND column_id = ?`
    ).run(last, objectId, columnId)
  }

/** Registers columns added by ALTER TABLE ADD. */
export const addColumns =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    columns: readonly Ast.ColumnDefinition[],
    renderExpression?: ExpressionRenderer
  ): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    const object = db.prepare(
      'SELECT name, schema_id FROM "sys.objects" WHERE object_id = ?'
    ).get(objectId) as { name: string, schema_id: number }
    const max = db.prepare('SELECT MAX(column_id) AS max_id FROM "sys.columns" WHERE object_id = ?')
      .get(objectId) as { max_id: number | null }
    let columnId = (max.max_id ?? 0) + 1
    for (const column of columns) {
      const at = columnId++
      insertColumn(db, objectId, at, column)
      if (column.default_ !== undefined) {
        const defaultId = allocateId(db)
        insertObject(db, {
          objectId: defaultId,
          name: column.constraintName ?? `DF__${object.name}__${defaultId}`,
          schemaId: object.schema_id,
          parentObjectId: objectId,
          type: 'D',
          typeDesc: 'DEFAULT_CONSTRAINT'
        })
        db.prepare(
          `INSERT INTO "sys.default_constraints_extra"
            (object_id, parent_column_id, definition, is_system_named)
            VALUES (?, ?, ?, ?)`
        ).run(
          defaultId, at, expressionDefinition(renderExpression, column.default_),
          column.constraintName === undefined ? 1 : 0
        )
        db.prepare(
          `UPDATE "sys.columns" SET default_object_id = ?
            WHERE object_id = ? AND column_id = ?`
        ).run(defaultId, objectId, at)
      }
    }
  }

/** Updates one column's declared type/collation/nullability without changing its identity. */
export const alterColumn =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    column: string,
    type: TypeName.t,
    collation: string | undefined,
    nullable: boolean
  ): void => {
    const objectId = objectIdOf(db, name)
    const fields = columnType(type)
    if (objectId === undefined || fields === undefined) {
      return
    }
    db.prepare(
      `UPDATE "sys.columns" SET
        system_type_id = ?, user_type_id = ?, max_length = ?, precision = ?, scale = ?,
        collation_name = ?, is_nullable = ?
        WHERE object_id = ? AND lower(name) = lower(?)`
    ).run(
      fields.systemTypeId, fields.userTypeId, fields.maxLength, fields.precision, fields.scale,
      collation ?? fields.collationName, nullable ? 1 : 0, objectId, column
    )
    db.prepare(
      `UPDATE "sys.objects" SET modify_date = strftime('%Y-%m-%d %H:%M:%S', 'now')
        WHERE object_id = ?`
    ).run(objectId)
  }

/** Removes columns dropped by ALTER TABLE DROP COLUMN. */
export const dropColumns =
  (db: DatabaseSync, name: Ast.QualifiedName, columns: readonly string[]): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    for (const column of columns) {
      const row = db.prepare(
        'SELECT column_id FROM "sys.columns" WHERE object_id = ? AND name = ?'
      ).get(objectId, column) as { column_id: number } | undefined
      if (row !== undefined) {
        const constraints = db.prepare(
          `SELECT o.object_id, o.type FROM "sys.objects" o
            LEFT JOIN "sys.default_constraints_extra" d ON d.object_id = o.object_id
            LEFT JOIN "sys.check_constraints" c ON c.object_id = o.object_id
            WHERE o.parent_object_id = ?
              AND (d.parent_column_id = ? OR c.parent_column_id = ?)`
        ).all(objectId, row.column_id, row.column_id) as { object_id: number, type: string }[]
        for (const constraint of constraints) {
          if (constraint.type === 'D') {
            db.prepare('DELETE FROM "sys.default_constraints_extra" WHERE object_id = ?')
              .run(constraint.object_id)
          } else if (constraint.type === 'C') {
            db.prepare('DELETE FROM "sys.check_constraints" WHERE object_id = ?')
              .run(constraint.object_id)
          }
          db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(constraint.object_id)
        }
        db.prepare(
          'DELETE FROM "sys.computed_columns_extra" WHERE object_id = ? AND column_id = ?'
        ).run(objectId, row.column_id)
      }
      db.prepare('DELETE FROM "sys.columns" WHERE object_id = ? AND name = ?').run(objectId, column)
    }
  }
