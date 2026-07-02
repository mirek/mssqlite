export * as Schema from './schema.ts'
export * as TypeRow from './type-row.ts'
export { bootstrap } from './bootstrap.ts'
export {
  addColumns,
  allocateId,
  createIndex,
  createTable,
  createView,
  dropColumns,
  dropIndex,
  dropTable,
  dropView,
  objectIdOf,
  objectNameOf,
  schemaIdOf,
  tableColumns,
  type ColumnRow,
  type ObjectName
} from './maintain.ts'
