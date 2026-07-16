import * as C from './combinators.ts'
import * as Reader from './reader.ts'
import * as Result from './result.ts'
import typeName from './type-name.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

/** Select parser is injected by the grammar entry point to break the module cycle. */
let selectParser: Parser.t<Ast.Select> | undefined

/** Wires the SELECT parser used for subqueries and EXISTS. */
export const useSelectParser =
  (parser: Parser.t<Ast.Select>): void => {
    selectParser = parser
  }

const select: Parser.t<Ast.Select> =
  reader =>
    selectParser === undefined ?
      Result.fail(reader, 'Select parser not wired.') :
      selectParser(reader)

const parenlessFunctions = new Set([
  'current_timestamp', 'current_user', 'session_user', 'system_user', 'user'
])

const literal: Parser.t<Ast.Expression> =
  reader => {
    const token = Reader.peek(reader)
    if (token === undefined) {
      return Result.fail(reader, 'Expected expression.')
    }
    switch (token.kind) {
      case 'number':
        return Result.ok(reader, { kind: 'number', value: token.value }, 1)
      case 'string':
        return Result.ok(reader, {
          kind: 'string',
          value: token.value,
          national: token.national === true
        }, 1)
      case 'binary':
        return Result.ok(reader, { kind: 'binary', value: token.value }, 1)
      case 'variable':
        return Result.ok(reader, { kind: 'variable', name: token.value }, 1)
      default:
        return Result.fail(reader, 'Expected literal.')
    }
  }

const caseExpression: Parser.t<Ast.Expression> =
  C.map(
    C.seq(
      C.keyword('case'),
      C.maybe(reader => operand(reader)),
      C.many1(C.map(
        C.seq(C.keyword('when'), reader => expression(reader), C.keyword('then'), reader => expression(reader)),
        ([ , when, , then ]) => ({ when, then })
      )),
      C.maybe(C.map(
        C.seq(C.keyword('else'), reader => expression(reader)),
        ([ , value ]) => value
      )),
      C.keyword('end')
    ),
    ([ , operand_, whens, else_ ]) =>
      else_ === undefined ?
        { kind: 'case' as const, ...operand_ !== undefined ? { operand: operand_ } : {}, whens } :
        { kind: 'case' as const, ...operand_ !== undefined ? { operand: operand_ } : {}, whens, else_ }
  )

const castExpression: Parser.t<Ast.Expression> =
  C.chain(
    C.first(C.keyword('cast'), C.keyword('try_cast')),
    name =>
      C.map(
        C.parens(C.seq(reader => expression(reader), C.keyword('as'), typeName)),
        ([ expression_, , type ]) => ({
          kind: 'cast' as const,
          expression: expression_,
          type,
          try_: name === 'try_cast'
        })
      )
  )

const convertExpression: Parser.t<Ast.Expression> =
  C.chain(
    C.first(C.keyword('convert'), C.keyword('try_convert')),
    name =>
      C.map(
        C.parens(C.seq(
          typeName,
          C.punct(','),
          reader => expression(reader),
          C.maybe(C.map(C.seq(C.punct(','), reader => expression(reader)), ([ , style ]) => style))
        )),
        ([ type, , expression_, style ]) => ({
          kind: 'convert' as const,
          type,
          expression: expression_,
          ...style !== undefined ? { style } : {},
          try_: name === 'try_convert'
        })
      )
  )

const existsExpression: Parser.t<Ast.Expression> =
  C.map(
    C.seq(C.keyword('exists'), C.parens(select)),
    ([ , select_ ]) => ({ kind: 'exists' as const, select: select_ })
  )

const nextValueExpression: Parser.t<Ast.Expression> =
  C.map(
    C.seq(C.keyword('next'), C.keyword('value'), C.keyword('for'), C.qualifiedName),
    ([ , , , sequence ]) => ({ kind: 'nextValue' as const, sequence })
  )

const overClause: Parser.t<Ast.Over> =
  C.map(
    C.seq(
      C.keyword('over'),
      C.parens(C.seq(
        C.maybe(C.map(
          C.seq(C.keywords('partition', 'by'), C.sepBy1(reader => expression(reader), C.punct(','))),
          ([ , expressions ]) => expressions
        )),
        C.maybe(C.map(
          C.seq(C.keywords('order', 'by'), C.sepBy1(reader => orderByItem(reader), C.punct(','))),
          ([ , items ]) => items
        ))
      ))
    ),
    ([ , [ partitionBy, orderBy ] ]) => ({
      partitionBy: partitionBy ?? [],
      orderBy: orderBy ?? []
    })
  )

/** ORDER BY item parser — shared with SELECT. */
export const orderByItem: Parser.t<Ast.OrderBy> =
  C.map(
    C.seq(
      reader => expression(reader),
      C.maybe(C.first(C.keyword('asc'), C.keyword('desc')))
    ),
    ([ expression_, direction ]) => ({
      expression: expression_,
      descending: direction === 'desc'
    })
  )

const callArguments: Parser.t<Pick<Ast.Expression & { kind: 'call' }, 'args' | 'star' | 'distinct'>> =
  reader => {
    const star = C.parens(C.punct('*'))(reader)
    if (!Result.failed(star)) {
      return Result.ok(star.reader, { args: [], star: true })
    }
    const empty = C.seq(C.punct('('), C.punct(')'))(reader)
    if (!Result.failed(empty)) {
      return Result.ok(empty.reader, { args: [] })
    }
    return C.map(
      C.parens(C.seq(
        C.maybe(C.keyword('distinct')),
        C.sepBy1(reader_ => expression(reader_), C.punct(','))
      )),
      ([ distinct, args ]) => ({
        args,
        ...distinct === undefined ? {} : { distinct: true }
      })
    )(reader)
  }

const columnOrCall: Parser.t<Ast.Expression> =
  reader => {
    let name = C.qualifiedName(reader)
    if (Result.failed(name)) {
      // Reserved words like LEFT and RIGHT are valid function names when
      // directly followed by an argument list.
      const token = Reader.peek(reader)
      const next = Reader.peek(reader, 1)
      if (token?.kind === 'word' && next?.kind === 'punct' && next.value === '(') {
        name = Result.ok(Reader.advanced(reader), [ token.value ])
      } else {
        return name
      }
    }
    const next = Reader.peek(name.reader)
    if (next?.kind === 'punct' && next.value === '(') {
      const args = callArguments(name.reader)
      if (Result.failed(args)) {
        return args
      }
      const over = C.maybe(overClause)(args.reader)
      if (Result.failed(over)) {
        return over
      }
      return Result.ok(over.reader, {
        kind: 'call',
        name: name.value,
        ...args.value,
        ...over.value === undefined ? {} : { over: over.value }
      })
    }
    if (name.value.length === 1 && parenlessFunctions.has((name.value[0] ?? '').toLowerCase())) {
      return Result.ok(name.reader, { kind: 'call', name: name.value, args: [] })
    }
    return Result.ok(name.reader, { kind: 'column', name: name.value })
  }

const parenthesized: Parser.t<Ast.Expression> =
  reader => {
    const open = C.punct('(')(reader)
    if (Result.failed(open)) {
      return open
    }
    const subquery = select(open.reader)
    if (!Result.failed(subquery)) {
      const close = C.punct(')')(subquery.reader)
      if (Result.failed(close)) {
        return close
      }
      return Result.ok(close.reader, { kind: 'subquery', select: subquery.value })
    }
    const inner = expression(open.reader)
    if (Result.failed(inner)) {
      return inner
    }
    const close = C.punct(')')(inner.reader)
    if (Result.failed(close)) {
      return close
    }
    return Result.ok(close.reader, inner.value)
  }

const primary: Parser.t<Ast.Expression> =
  C.first(
    C.map(C.keyword('null'), () => ({ kind: 'null' as const })),
    C.map(C.keyword('default'), () => ({ kind: 'default' as const })),
    literal,
    caseExpression,
    castExpression,
    convertExpression,
    existsExpression,
    nextValueExpression,
    parenthesized,
    columnOrCall
  )

const unary: Parser.t<Ast.Expression> =
  reader => {
    const token = Reader.peek(reader)
    if (token?.kind === 'punct' && (token.value === '-' || token.value === '+' || token.value === '~')) {
      const operand_ = unary(Reader.advanced(reader))
      if (Result.failed(operand_)) {
        return operand_
      }
      return Result.ok(operand_.reader, {
        kind: 'unary',
        operator: token.value,
        operand: operand_.value
      })
    }
    return primary(reader)
  }

const binaryLevel =
  (operators: readonly string[], next: Parser.t<Ast.Expression>): Parser.t<Ast.Expression> =>
    reader => {
      const head = next(reader)
      if (Result.failed(head)) {
        return head
      }
      let left = head.value
      let current = head.reader
      for (;;) {
        const token = Reader.peek(current)
        if (token?.kind !== 'punct' || !operators.includes(token.value)) {
          break
        }
        const right = next(Reader.advanced(current))
        if (Result.failed(right)) {
          // Rewind the operator — `TOP 10 *` reads `*` as the select star.
          break
        }
        left = { kind: 'binaryOp', operator: token.value, left, right: right.value }
        current = right.reader
      }
      return Result.ok(current, left)
    }

const multiplicative = binaryLevel([ '*', '/', '%' ], unary)
// T-SQL puts + - & ^ | on one precedence level, left-to-right.
const additive = binaryLevel([ '+', '-', '&', '^', '|' ], multiplicative)
const bitwise = additive

/** Scalar (non-boolean) operand — used where AND belongs to an enclosing construct. */
export const operand: Parser.t<Ast.Expression> =
  bitwise

const comparisonOperators = [ '=', '<>', '!=', '>', '<', '>=', '<=', '!>', '!<' ] as const

const comparison: Parser.t<Ast.Expression> =
  reader => {
    const head = bitwise(reader)
    if (Result.failed(head)) {
      return head
    }
    let left = head.value
    let current = head.reader
    for (;;) {
      const token = Reader.peek(current)
      // Symbolic comparison.
      if (token?.kind === 'punct' && (comparisonOperators as readonly string[]).includes(token.value)) {
        const right = bitwise(Reader.advanced(current))
        if (Result.failed(right)) {
          return right
        }
        left = {
          kind: 'binaryOp',
          operator: token.value === '!=' ? '<>' : token.value,
          left,
          right: right.value
        }
        current = right.reader
        continue
      }
      // Word-based predicates, with optional NOT.
      const negation = C.keyword('not')(current)
      const negated = !Result.failed(negation)
      const at = negated ? negation.reader : current
      const word = Reader.peek(at)
      if (word?.kind !== 'word') {
        if (negated) {
          break
        }
        break
      }
      switch (word.value.toLowerCase()) {
        case 'is': {
          if (negated) {
            return Result.fail(current, 'Unexpected NOT before IS.')
          }
          const not = C.maybe(C.keyword('not'))(Reader.advanced(at))
          if (Result.failed(not)) {
            return not
          }
          const null_ = C.keyword('null')(not.reader)
          if (Result.failed(null_)) {
            return null_
          }
          left = { kind: 'isNull', expression: left, negated: not.value !== undefined }
          current = null_.reader
          continue
        }
        case 'like': {
          const pattern = bitwise(Reader.advanced(at))
          if (Result.failed(pattern)) {
            return pattern
          }
          const escape = C.maybe(C.map(
            C.seq(C.keyword('escape'), bitwise),
            ([ , value ]) => value
          ))(pattern.reader)
          if (Result.failed(escape)) {
            return escape
          }
          left = {
            kind: 'like',
            expression: left,
            pattern: pattern.value,
            ...escape.value === undefined ? {} : { escape: escape.value },
            negated
          }
          current = escape.reader
          continue
        }
        case 'in': {
          const open = C.punct('(')(Reader.advanced(at))
          if (Result.failed(open)) {
            return open
          }
          const subquery = select(open.reader)
          if (!Result.failed(subquery)) {
            const close = C.punct(')')(subquery.reader)
            if (Result.failed(close)) {
              return close
            }
            left = { kind: 'in', expression: left, values: subquery.value, negated }
            current = close.reader
            continue
          }
          const values = C.seq(
            C.sepBy1(reader_ => expression(reader_), C.punct(',')),
            C.punct(')')
          )(open.reader)
          if (Result.failed(values)) {
            return values
          }
          left = { kind: 'in', expression: left, values: values.value[0], negated }
          current = values.reader
          continue
        }
        case 'between': {
          const low = bitwise(Reader.advanced(at))
          if (Result.failed(low)) {
            return low
          }
          const and = C.keyword('and')(low.reader)
          if (Result.failed(and)) {
            return and
          }
          const high = bitwise(and.reader)
          if (Result.failed(high)) {
            return high
          }
          left = { kind: 'between', expression: left, low: low.value, high: high.value, negated }
          current = high.reader
          continue
        }
        default:
          break
      }
      break
    }
    return Result.ok(current, left)
  }

const notExpression: Parser.t<Ast.Expression> =
  reader => {
    const not = C.keyword('not')(reader)
    if (!Result.failed(not)) {
      const operand_ = notExpression(not.reader)
      if (Result.failed(operand_)) {
        return operand_
      }
      return Result.ok(operand_.reader, {
        kind: 'unary',
        operator: 'not',
        operand: operand_.value
      })
    }
    return comparison(reader)
  }

const andKeyword =
  (word: string, next: Parser.t<Ast.Expression>): Parser.t<Ast.Expression> =>
    reader => {
      const head = next(reader)
      if (Result.failed(head)) {
        return head
      }
      let left = head.value
      let current = head.reader
      for (;;) {
        const operator = C.keyword(word)(current)
        if (Result.failed(operator)) {
          break
        }
        const right = next(operator.reader)
        if (Result.failed(right)) {
          return right
        }
        left = { kind: 'binaryOp', operator: word, left, right: right.value }
        current = right.reader
      }
      return Result.ok(current, left)
    }

const andExpression = andKeyword('and', notExpression)

/** Full expression parser including boolean operators. */
export const expression: Parser.t<Ast.Expression> =
  andKeyword('or', andExpression)

export default expression
