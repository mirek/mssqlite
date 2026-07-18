import type { Case } from './types.ts'

/** Standalone T-SQL printed for a failed corpus case. */
export const reproduction =
  (value: Case): string =>
    [
      `-- mssqlite differential case: ${value.name}`,
      `-- audit area: ${value.sourceTodo}`,
      value.todo === undefined ? undefined : `-- open issue: todo/${value.todo}.md`,
      value.setup === undefined ? undefined : `-- setup\n${value.setup.trim()}`,
      `-- query\n${value.query.trim()}`,
      value.cleanup === undefined ? undefined : `-- cleanup\n${value.cleanup.trim()}`
    ].filter(part => part !== undefined).join('\n\n') + '\n'
