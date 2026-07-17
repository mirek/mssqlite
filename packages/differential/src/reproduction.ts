import type { Case } from './types.ts'

/** Standalone T-SQL printed for a failed corpus case. */
export const reproduction =
  (value: Case): string =>
    [
      `-- mssqlite differential case: ${value.name}`,
      `-- source: todo/${value.sourceTodo}.md`,
      value.setup === undefined ? undefined : `-- setup\n${value.setup.trim()}`,
      `-- query\n${value.query.trim()}`,
      value.cleanup === undefined ? undefined : `-- cleanup\n${value.cleanup.trim()}`
    ].filter(part => part !== undefined).join('\n\n') + '\n'
