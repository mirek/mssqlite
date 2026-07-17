/**
 * Removes a leading current-database component from qualified AST names.
 * Cross-database names remain intact for attachment rendering.
 */
export const localize =
  <T>(value: T, database: string): T => {
    if (Array.isArray(value)) {
      if (value.length >= 3 && value.every(part => typeof part === 'string') &&
        String(value[0]).toLowerCase() === database.toLowerCase()) {
        return value.slice(1) as T
      }
      return value.map(part => localize(part, database)) as T
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .map(([ key, part ]) => [ key, localize(part, database) ])) as T
    }
    return value
  }

export default localize
