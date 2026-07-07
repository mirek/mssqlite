import { MssqlError } from './error.ts'
import type { Session, Value } from './session.ts'

/** @returns value coerced to what node:sqlite accepts as a bound parameter. */
export const bindable =
  (value: Value): null | number | bigint | string | Uint8Array =>
    typeof value === 'boolean' ?
      (value ? 1 : 0) :
      value

/** @returns value of a global variable like `@@rowcount`. */
export const globalOf =
  (session: Session, name: string): Value => {
    switch (name) {
      case '@@rowcount':
        return session.rowCount
      case '@@identity':
        return session.lastIdentity
      case '@@trancount':
        return session.transactionCount
      case '@@error':
        return session.lastError
      case '@@spid':
        return session.spid
      case '@@version':
        return session.server.version
      case '@@servername':
        return session.server.serverName
      case '@@language':
        return 'us_english'
      case '@@lock_timeout':
        return -1
      case '@@max_precision':
        return 38
      case '@@nestlevel':
        return session.nestLevel
      case '@@fetch_status':
        return -1
      case '@@datefirst':
        return 7
      default:
        throw new MssqlError(`Unrecognized global variable ${name}.`, 137, 15)
    }
  }

/** @returns bound parameter object for the variables a rendered statement uses. */
export const bindings =
  (session: Session, variables: readonly string[]): Record<string, null | number | bigint | string | Uint8Array> => {
    const bound: Record<string, null | number | bigint | string | Uint8Array> = {}
    for (const name of variables) {
      if (name.startsWith('@@')) {
        bound[`__${name.slice(2)}`] = bindable(globalOf(session, name))
      } else {
        const variable = session.variables.get(name)
        if (variable === undefined) {
          throw new MssqlError(`Must declare the scalar variable "${name}".`, 137, 15)
        }
        bound[name.slice(1)] = bindable(variable.value)
      }
    }
    return bound
  }
