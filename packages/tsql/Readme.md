# @mssqlite/tsql

T-SQL lexer and parser producing a typed AST. Token-level parser combinators
in the style of [`@prelude/parser`](https://www.npmjs.com/package/@prelude/parser)
— immutable `Reader`, `Result.ok`/`Result.fail` values, no exceptions inside
the grammar.

Reference: the [`t-sql` skill](../../.agents/skills/t-sql/SKILL.md).

## API

```ts
import { parse, parseStatement, parseExpression } from '@mssqlite/tsql'

const statements = parse(`
  DECLARE @x INT = 1;
  SELECT TOP 10 u.id, u.name
  FROM dbo.users u
  WHERE u.age >= @x
  ORDER BY u.name DESC;
`)
```

- `lex(sql)` — tokens (`word`, `quoted`, `string`, `number`, `binary`,
  `variable`, `punct`), whitespace/comments skipped, `N'...'` flagged,
  offsets preserved for error messages. Throws `LexError`.
- `parse(sql)` — statement list of a batch. Throws `ParseError` with offset.
- `parseStatement(sql)` / `parseExpression(sql)` — single-production entry
  points, mostly for tests and tooling.
- `Ast` — the AST type definitions, all `readonly` discriminated unions.
- `Combinators` / `Reader` / `Result` / `Parser` — the token combinator core
  (`map`, `chain`, `seq`, `first`, `maybe`, `many0/1`, `sepBy1`, `lazy`,
  `keyword(s)`, `punct`, `identifier`, `qualifiedName`, `parens`, …) for
  extending the grammar.

## Supported surface

- **Queries** — SELECT with DISTINCT, TOP (expr) [PERCENT], select-list
  aliases (`AS x`, `x = expr`), variable assignment items (`@x = expr`),
  INTO, FROM with aliases and parsed-but-ignored table hints, INNER/LEFT/
  RIGHT/FULL/CROSS JOIN and comma cross joins, derived tables, WHERE,
  GROUP BY, HAVING, ORDER BY ASC/DESC, OFFSET/FETCH, UNION [ALL], EXCEPT,
  INTERSECT, CTEs (`WITH a AS (...)`), and table-valued functions in FROM
  with aliases/positional column aliases and `OPENJSON ... WITH (...)`;
  CROSS/OUTER APPLY preserve lateral source order in the AST, and PIVOT /
  UNPIVOT are postfix table-source transforms with required aliases.
- **Expressions** — full T-SQL operator precedence, unary `- + ~ NOT`,
  arithmetic, concat `+`, bitwise `& ^ |`, comparisons (incl. `!=`, `!<`,
  `!>`), `IS [NOT] NULL`, `[NOT] LIKE ... ESCAPE`, `[NOT] IN (list|subquery)`,
  `[NOT] BETWEEN`, `EXISTS`, scalar subqueries, simple and searched CASE,
  CAST/TRY_CAST, CONVERT/TRY_CONVERT with style, function calls (incl.
  reserved-word functions like `LEFT(...)`), `COUNT(*)`, `COUNT(DISTINCT x)`,
  window `OVER (PARTITION BY ... ORDER BY ...)`, parenless
  `CURRENT_TIMESTAMP`, variables `@x` and globals `@@ROWCOUNT`.
- **DML** — INSERT (column list, multi-row VALUES, SELECT, DEFAULT VALUES),
  UPDATE (compound assignment, FROM, WHERE), DELETE, TRUNCATE TABLE, and
  the OUTPUT clause on all three (`inserted.` / `deleted.` items with
  aliases, `OUTPUT ... INTO table (columns)`). MERGE with WHEN MATCHED /
  NOT MATCHED [BY TARGET] / NOT MATCHED BY SOURCE arms and AND conditions;
  USING accepts a table, `(SELECT …) AS s (cols)` or `(VALUES …) AS s
  (cols)` — column lists desugar into select-item aliases at parse time.
  `$action` lexes as a plain word (a leading `$` may start a word), so
  MERGE OUTPUT items carry it as an ordinary column reference.
- **DDL** — CREATE TABLE (column constraints in any order: NULL/NOT NULL,
  IDENTITY(s,i), PRIMARY KEY, UNIQUE, DEFAULT, CHECK, REFERENCES with
  ON DELETE/UPDATE actions, COLLATE, named constraints; table constraints:
  PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK), DROP TABLE/VIEW [IF EXISTS],
  CREATE [UNIQUE] INDEX with INCLUDE and filtered WHERE, DROP INDEX,
  CREATE [OR ALTER] VIEW, ALTER TABLE ADD/DROP COLUMN/CONSTRAINT.
- **Procedural** — scalar DECLARE with initializers and
  `DECLARE @t TABLE (...)` with column/table constraints, SET @x
  (compound operators),
  SET session options (NOCOUNT, ANSI_NULLS lists, TRANSACTION ISOLATION
  LEVEL, IDENTITY_INSERT), IF/ELSE, WHILE, BEGIN...END blocks, BREAK,
  CONTINUE, RETURN, THROW, PRINT, EXEC[UTE] with named/positional/OUTPUT
  arguments, USE, BEGIN/COMMIT/ROLLBACK/SAVE TRAN[SACTION].

Statements separate on semicolons or juxtaposition (as in real batches).

## Notes

- Reserved words are rejected as bare identifiers but allowed as function
  names when directly followed by `(` — so `LEFT(x, 1)` parses while
  `SELECT FROM` fails.
- The AST keeps numeric literals as raw text (`{ kind: 'number', value: '1.50' }`)
  so downstream layers control exactness.
- `GO` is a client-side batch separator, never sent over TDS — deliberately
  not part of the grammar.
