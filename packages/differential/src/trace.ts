import type { CommunicationStream } from './types.ts'

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const token = /^([A-Za-z]+Token) \{/

export type Trace = {
  readonly mark: () => number,
  readonly record: (message: string) => void,
  readonly since: (mark: number) => CommunicationStream
}

const normalize =
  (message: string, maximumLength: number): string => {
    const value = message.replace(ansi, '').replaceAll('\r\n', '\n')
    if (value.length <= maximumLength) {
      return value
    }
    return value.slice(0, maximumLength) +
      `\n... ${value.length - maximumLength} trace characters omitted`
  }

/** Captures bounded tedious packet and token diagnostics between explicit marks. */
export const trace =
  (maximumEntryLength = 8192): Trace => {
    const entries: string[] = []
    return {
      mark: () => entries.length,
      record: message => {
        if (message !== '') {
          entries.push(normalize(message, maximumEntryLength))
        }
      },
      since: mark => {
        const diagnostics = entries.slice(mark)
        return {
          diagnostics,
          tokens: diagnostics.flatMap(message => message.match(token)?.[1] ?? [])
        }
      }
    }
  }

export default trace
