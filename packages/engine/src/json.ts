import { MssqlError } from './error.ts'
import type { Value } from './session.ts'

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

type Node = {
  readonly kind: Kind,
  readonly start: number,
  readonly end: number,
  readonly value?: string,
  readonly members?: readonly { readonly key: string, readonly value: Node }[],
  readonly elements?: readonly Node[]
}

type Path = {
  readonly strict: boolean,
  readonly steps: readonly ({ readonly kind: 'key', readonly value: string } |
    { readonly kind: 'index', readonly value: number })[]
}

type ParsedNode = { readonly node: Node, readonly end: number }
type PathStep = Path['steps'][number]

const malformed =
  (source: string, at: number): MssqlError => {
    const found = source[at] ?? 'end of input'
    return new MssqlError(
      `JSON text is not properly formatted. Unexpected character '${found}' is found at position ${at}.`,
      13609, 16, 1, { statementTerminating: true })
  }

const malformedPath =
  (source: string, at: number): MssqlError =>
    new MssqlError(
      `JSON path is not properly formatted. Unexpected character '${source[at] ?? 'end of input'}' ` +
      `is found at position ${at}.`,
      13607, 16, 1, { statementTerminating: true })

const escapedEnd =
  (source: string, at: number): number => {
    if (source[at] === 'u') {
      if (!/^[0-9a-f]{4}$/i.test(source.slice(at + 1, at + 5))) {
        throw malformed(source, at)
      }
      return at + 5
    }
    if (![ '"', '\\', '/', 'b', 'f', 'n', 'r', 't' ].includes(source[at] ?? '')) {
      throw malformed(source, at)
    }
    return at + 1
  }

const quoted =
  (source: string, start: number): { readonly value: string, readonly end: number } => {
    let at = start + 1
    while (at < source.length) {
      const char = source[at]
      if (char === '"') {
        const end = at + 1
        try {
          return { value: JSON.parse(source.slice(start, end)) as string, end }
        } catch {
          throw malformed(source, start)
        }
      }
      if (char === '\\') {
        at = escapedEnd(source, at + 1)
        continue
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw malformed(source, at)
      }
      at++
    }
    throw malformed(source, at)
  }

const whitespaceEnd =
  (source: string, start: number): number => {
    let at = start
    while ([ ' ', '\t', '\r', '\n' ].includes(source[at] ?? '')) {
      at++
    }
    return at
  }

const literalNode =
  (source: string, start: number): ParsedNode | undefined => {
    for (const [ literal, kind ] of [
      [ 'true', 'boolean' ], [ 'false', 'boolean' ], [ 'null', 'null' ]
    ] as const) {
      if (source.startsWith(literal, start)) {
        const end = start + literal.length
        return { node: { kind, start, end }, end }
      }
    }
    return undefined
  }

const numberNode =
  (source: string, start: number): ParsedNode => {
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(source.slice(start))?.[0]
    if (number === undefined) {
      throw malformed(source, start)
    }
    const end = start + number.length
    return { node: { kind: 'number', start, end }, end }
  }

const nodeAt =
  (source: string, start_: number): ParsedNode => {
    const start = whitespaceEnd(source, start_)
    if (source[start] === '"') {
      const result = quoted(source, start)
      return { node: { kind: 'string', start, end: result.end, value: result.value }, end: result.end }
    }
    if (source[start] === '{') {
      return objectNode(source, start)
    }
    if (source[start] === '[') {
      return arrayNode(source, start)
    }
    return literalNode(source, start) ?? numberNode(source, start)
  }

const objectMember =
  (source: string, start_: number): {
    readonly member: { readonly key: string, readonly value: Node },
    readonly end: number
  } => {
    const start = whitespaceEnd(source, start_)
    if (source[start] !== '"') {
      throw malformed(source, start)
    }
    const key = quoted(source, start)
    const colon = whitespaceEnd(source, key.end)
    if (source[colon] !== ':') {
      throw malformed(source, colon)
    }
    const parsed = nodeAt(source, colon + 1)
    return { member: { key: key.value, value: parsed.node }, end: parsed.end }
  }

const objectNode =
  (source: string, start: number): ParsedNode => {
    let at = whitespaceEnd(source, start + 1)
    const members: { readonly key: string, readonly value: Node }[] = []
    while (source[at] !== '}') {
      const parsed = objectMember(source, at)
      members.push(parsed.member)
      at = whitespaceEnd(source, parsed.end)
      if (source[at] !== ',') {
        break
      }
      at = whitespaceEnd(source, at + 1)
      if (source[at] === '}') {
        throw malformed(source, at)
      }
    }
    if (source[at] !== '}') {
      throw malformed(source, at)
    }
    const end = at + 1
    return { node: { kind: 'object', start, end, members }, end }
  }

const arrayNode =
  (source: string, start: number): ParsedNode => {
    let at = whitespaceEnd(source, start + 1)
    const elements: Node[] = []
    while (source[at] !== ']') {
      const parsed = nodeAt(source, at)
      elements.push(parsed.node)
      at = whitespaceEnd(source, parsed.end)
      if (source[at] !== ',') {
        break
      }
      at = whitespaceEnd(source, at + 1)
      if (source[at] === ']') {
        throw malformed(source, at)
      }
    }
    if (source[at] !== ']') {
      throw malformed(source, at)
    }
    const end = at + 1
    return { node: { kind: 'array', start, end, elements }, end }
  }

const parse =
  (source: string): Node => {
    const result = nodeAt(source, 0)
    const end = whitespaceEnd(source, result.end)
    if (end !== source.length) {
      throw malformed(source, end)
    }
    return result.node
  }

const quotedPathStep =
  (source: string, start: number): { readonly step: PathStep, readonly end: number } => {
    try {
      const key = quoted(source, start)
      return { step: { kind: 'key', value: key.value }, end: key.end }
    } catch {
      throw malformedPath(source, start)
    }
  }

const pathStep =
  (source: string, start: number): { readonly step: PathStep, readonly end: number } => {
    if (source[start] === '[') {
      const match = /^\[(\d+)\]/.exec(source.slice(start))
      if (match === null) {
        throw malformedPath(source, start)
      }
      return { step: { kind: 'index', value: Number(match[1]) }, end: start + match[0].length }
    }
    if (source[start] !== '.') {
      throw malformedPath(source, start)
    }
    const keyStart = start + 1
    if (source[keyStart] === '"') {
      return quotedPathStep(source, keyStart)
    }
    let end = keyStart
    while (end < source.length && source[end] !== '.' && source[end] !== '[') {
      end++
    }
    if (end === keyStart) {
      throw malformedPath(source, end)
    }
    return { step: { kind: 'key', value: source.slice(keyStart, end) }, end }
  }

const path =
  (source_: string): Path => {
    const source = source_.trim()
    const mode = /^(strict|lax)\s+/i.exec(source)
    const strict = mode?.[1]?.toLowerCase() === 'strict'
    let at = mode?.[0].length ?? 0
    if (source[at] !== '$') {
      throw malformedPath(source, at)
    }
    at++
    const steps: ({ readonly kind: 'key', readonly value: string } |
      { readonly kind: 'index', readonly value: number })[] = []
    while (at < source.length) {
      const parsed = pathStep(source, at)
      steps.push(parsed.step)
      at = parsed.end
    }
    return { strict, steps }
  }

const selected =
  (root: Node, path_: Path): Node | undefined => {
    let current: Node | undefined = root
    for (const step of path_.steps) {
      current = step.kind === 'key' ?
        current?.kind === 'object' ?
          current.members?.find(member => member.key === step.value)?.value : undefined :
        current?.kind === 'array' ? current.elements?.[step.value] : undefined
      if (current === undefined) {
        return undefined
      }
    }
    return current
  }

const missing =
  (): MssqlError =>
    new MssqlError('Property cannot be found on the specified JSON path.',
      13608, 16, 1, { statementTerminating: true })

/** @returns SQL Server's default object-or-array ISJSON result. */
export const isJson =
  (value: Value): Value => {
    if (value === null) {
      return null
    }
    try {
      const kind = parse(String(value)).kind
      return kind === 'object' || kind === 'array' ? 1 : 0
    } catch {
      return 0
    }
  }

/** @returns decoded scalar text selected by JSON_VALUE. */
export const jsonValue =
  (value: Value, path_: Value): Value => {
    if (value === null || path_ === null) {
      return null
    }
    const source = String(value)
    const parsedPath = path(String(path_))
    const node = selected(parse(source), parsedPath)
    if (node === undefined) {
      if (parsedPath.strict) {
        throw missing()
      }
      return null
    }
    if (node.kind === 'object' || node.kind === 'array') {
      if (parsedPath.strict) {
        throw new MssqlError('Scalar value cannot be found in the specified JSON path.',
          13623, 16, 2, { statementTerminating: true })
      }
      return null
    }
    if (node.kind === 'null') {
      return null
    }
    const result = node.kind === 'string' ? node.value ?? '' : source.slice(node.start, node.end)
    if (result.length > 4000) {
      if (parsedPath.strict) {
        throw new MssqlError('String value in the specified JSON path would be truncated.',
          13625, 16, 1, { statementTerminating: true })
      }
      return null
    }
    return result
  }

/** @returns the original object/array slice selected by JSON_QUERY. */
export const jsonQuery =
  (value: Value, path_: Value): Value => {
    if (value === null || path_ === null) {
      return null
    }
    const source = String(value)
    const parsedPath = path(String(path_))
    const node = selected(parse(source), parsedPath)
    if (node === undefined) {
      if (parsedPath.strict) {
        throw missing()
      }
      return null
    }
    if (node.kind !== 'object' && node.kind !== 'array') {
      if (parsedPath.strict) {
        throw new MssqlError('Object or array cannot be found in the specified JSON path.',
          13624, 16, 2, { statementTerminating: true })
      }
      return null
    }
    return source.slice(node.start, node.end)
  }
