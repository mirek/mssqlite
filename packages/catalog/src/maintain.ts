import { columnType } from './type-row.ts'
import type { Ast } from '@mssqlite/tsql'
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
  readonly is_identity: number
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
         precision, scale, collation_name, is_nullable, is_rowguidcol, is_identity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      objectId, column.name, columnId,
      type.systemTypeId, type.userTypeId, type.maxLength,
      type.precision, type.scale, type.collationName,
      column.nullable === false || column.primaryKey === true || column.identity !== undefined ? 0 : 1,
      column.rowguidcol === true ? 1 : 0,
      column.identity === undefined ? 0 : 1
    )
    if (column.identity !== undefined) {
      db.prepare(
        `INSERT INTO "sys.identity_columns_extra" (object_id, column_id, seed_value, increment_value)
          VALUES (?, ?, ?, ?)`
      ).run(objectId, columnId, String(column.identity.seed), String(column.identity.increment))
    }
  }

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
  (db: DatabaseSync, statement: Ast.Statement & { kind: 'createTable' }): number => {
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
          `INSERT INTO "sys.check_constraints" (object_id, parent_column_id, is_system_named)
            VALUES (?, ?, 1)`
        ).run(checkId, columnIds.get(column.name.toLowerCase()) ?? 0)
      }
      if (column.default_ !== undefined) {
        const defaultId = allocateId(db)
        insertObject(db, {
          objectId: defaultId,
          name: `DF__${at.name}__${defaultId}`,
          schemaId,
          parentObjectId: objectId,
          type: 'D',
          typeDesc: 'DEFAULT_CONSTRAINT'
        })
        db.prepare(
          `INSERT INTO "sys.default_constraints" (object_id, parent_column_id, is_system_named)
            VALUES (?, ?, 1)`
        ).run(defaultId, columnIds.get(column.name.toLowerCase()) ?? 0)
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
            `INSERT INTO "sys.check_constraints" (object_id, is_system_named)
              VALUES (?, ?)`
          ).run(checkId, constraint.name === undefined ? 1 : 0)
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
      db.prepare('DELETE FROM "sys.index_columns" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.indexes" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.columns" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.foreign_key_columns" WHERE constraint_object_id = ? OR parent_object_id = ?').run(id, id)
      db.prepare('DELETE FROM "sys.foreign_keys" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.key_constraints" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.check_constraints" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.default_constraints" WHERE object_id = ?').run(id)
      db.prepare('DELETE FROM "sys.identity_columns_extra" WHERE object_id = ?').run(id)
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
  (db: DatabaseSync, name: Ast.QualifiedName): number => {
    const at = objectNameOf(name)
    const objectId = allocateId(db)
    insertObject(db, {
      objectId,
      name: at.name,
      schemaId: schemaIdOf(db, at.schema),
      type: 'V',
      typeDesc: 'VIEW'
    })
    return objectId
  }

/** Removes a dropped view. */
export const dropView =
  (db: DatabaseSync, name: Ast.QualifiedName): void => {
    const objectId = objectIdOf(db, name)
    if (objectId !== undefined) {
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
      db.prepare('DELETE FROM "sys.sql_modules" WHERE object_id = ?').run(objectId)
      db.prepare('DELETE FROM "sys.objects" WHERE object_id = ?').run(objectId)
    }
  }

/** Removes a dropped procedure and its module row. */
export const dropProcedure =
  dropModule

/** Registers a scalar or inline table-valued function definition. */
export const createFunction =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    definition: string,
    tableValued: boolean
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
    db.prepare('INSERT INTO "sys.sql_modules" (object_id, definition) VALUES (?, ?)')
      .run(objectId, definition)
    return objectId
  }

/** Removes a dropped function and its module row. */
export const dropFunction =
  dropModule

/** Registers columns added by ALTER TABLE ADD. */
export const addColumns =
  (db: DatabaseSync, name: Ast.QualifiedName, columns: readonly Ast.ColumnDefinition[]): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    const max = db.prepare('SELECT MAX(column_id) AS max_id FROM "sys.columns" WHERE object_id = ?')
      .get(objectId) as { max_id: number | null }
    let columnId = (max.max_id ?? 0) + 1
    for (const column of columns) {
      insertColumn(db, objectId, columnId++, column)
    }
  }

/** Removes columns dropped by ALTER TABLE DROP COLUMN. */
export const dropColumns =
  (db: DatabaseSync, name: Ast.QualifiedName, columns: readonly string[]): void => {
    const objectId = objectIdOf(db, name)
    if (objectId === undefined) {
      return
    }
    for (const column of columns) {
      db.prepare('DELETE FROM "sys.columns" WHERE object_id = ? AND name = ?').run(objectId, column)
    }
  }
