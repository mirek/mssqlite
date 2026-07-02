/** Raised for T-SQL constructs that cannot be represented in SQLite. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedError'
  }
}

/** @throws UnsupportedError */
export const unsupported =
  (message: string): never => {
    throw new UnsupportedError(message)
  }
