export * as Schema from './schema.ts'
export * as TypeRow from './type-row.ts'
export { bootstrap } from './bootstrap.ts'
export {
  addColumns,
  allocateId,
  createIndex,
  createFunction,
  createProcedure,
  createTable,
  createTrigger,
  createView,
  dropColumns,
  dropIndex,
  dropFunction,
  dropProcedure,
  dropTable,
  dropTrigger,
  dropView,
  objectIdOf,
  objectNameOf,
  schemaIdOf,
  tableColumns,
  type ColumnRow,
  type ObjectName
} from './maintain.ts'
