import * as C from './combinators.ts'
import * as Reader from './reader.ts'
import * as Result from './result.ts'
import * as TypeName from '../type-name.ts'
import type * as Parser from './parser.ts'

const typeArgument: Parser.t<number | 'max'> =
  reader => {
    const token = Reader.peek(reader)
    if (token?.kind === 'number') {
      return Result.ok(reader, Number(token.value), 1)
    }
    if (token?.kind === 'word' && token.value.toLowerCase() === 'max') {
      return Result.ok(reader, 'max', 1)
    }
    return Result.fail(reader, 'Expected type length or MAX.')
  }

/**
 * Type name parser — `int`, `nvarchar(50)`, `varchar(max)`, `decimal(10, 2)`,
 * `[dbo].[MyType]`, two-word names like `double precision`.
 */
export const typeName: Parser.t<TypeName.t> =
  reader => {
    const name = C.qualifiedName(reader)
    if (Result.failed(name)) {
      return name
    }
    let base = (name.value[name.value.length - 1] ?? '').toLowerCase()
    let current = name.reader
    // Two-word types: double precision, national character (varying), character varying.
    const follow = Reader.peek(current)
    if (follow?.kind === 'word') {
      const second = follow.value.toLowerCase()
      if ((base === 'double' && second === 'precision') ||
        ((base === 'character' || base === 'char' || base === 'national') && second === 'varying') ||
        (base === 'national' && (second === 'character' || second === 'char' || second === 'text'))) {
        base = `${base} ${second}`
        current = Reader.advanced(current)
        const third = Reader.peek(current)
        if (third?.kind === 'word' && third.value.toLowerCase() === 'varying') {
          base = `${base} varying`
          current = Reader.advanced(current)
        }
      }
    }
    const args = C.maybe(C.parens(C.sepBy1(typeArgument, C.punct(','))))(current)
    if (Result.failed(args)) {
      return args
    }
    return Result.ok(args.reader, TypeName.of(base, args.value ?? []))
  }

export default typeName
