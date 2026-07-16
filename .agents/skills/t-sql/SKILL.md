---
name: t-sql
description: "Comprehensive T-SQL language reference for implementing a T-SQL engine. Covers data types, type conversion, operators, expressions, control flow, queries (SELECT, JOIN, CTE, window functions), DML statements (INSERT, UPDATE, DELETE, MERGE), DDL statements (CREATE/ALTER/DROP TABLE, INDEX, VIEW, PROCEDURE, FUNCTION, TRIGGER), built-in functions (aggregate, string, math, date/time, conversion, JSON), transactions, error handling, and session settings. Use when implementing T-SQL parsing, evaluation, query processing, or SQL Server compatibility."
---

# T-SQL Language Reference

Complete reference for the Transact-SQL language used by Microsoft SQL Server.

Source https://learn.microsoft.com/en-us/sql/t-sql/language-reference?view=sql-server-ver17

## Reference Files

- [data-types.md](data-types.md) — All data types (exact/approximate numeric, date/time, character, binary, special), storage sizes, ranges, precision/scale rules, type precedence, type synonyms
- [type-conversion.md](type-conversion.md) — CAST/CONVERT with style codes, TRY_CAST/TRY_CONVERT, implicit/explicit conversion matrix, decimal arithmetic precision rules, truncation vs rounding behavior
- [language-elements.md](language-elements.md) — Operators (arithmetic, comparison, logical, bitwise, string, compound, unary), operator precedence, expressions, CASE, LIKE wildcards, BETWEEN/IN/EXISTS/ALL/ANY, variables (DECLARE/SET/SELECT), control flow (IF/ELSE, WHILE, BEGIN/END, GOTO, RETURN, WAITFOR), cursors, reserved keywords, NULL and three-valued logic
- [queries.md](queries.md) — Logical processing order, SELECT clause, FROM/JOIN types and semantics (INNER/LEFT/RIGHT/FULL/CROSS, APPLY, PIVOT), WHERE/search conditions, GROUP BY (ROLLUP/CUBE/GROUPING SETS), HAVING, ORDER BY with OFFSET/FETCH, TOP, OVER clause / window frames (ROWS vs RANGE), CTEs (recursive and non-recursive), set operations (UNION/EXCEPT/INTERSECT), subqueries, OUTPUT clause, SELECT INTO, table value constructor, hints, AT TIME ZONE
- [functions.md](functions.md) — Aggregate functions (COUNT, SUM, AVG, MIN, MAX, STRING_AGG, STDEV, VAR), ranking/window functions (ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE, PERCENT_RANK, CUME_DIST, PERCENTILE_CONT/DISC), string functions (SUBSTRING, LEN, REPLACE, CONCAT, UPPER, LOWER, TRIM, LEFT, RIGHT, CHARINDEX, PATINDEX, REVERSE, REPLICATE, STUFF, SPACE, CHAR, NCHAR, ASCII, UNICODE), math functions (ABS, CEILING, FLOOR, ROUND, POWER, SQRT, SIGN), date/time functions (GETDATE, DATEADD, DATEDIFF, DATEPART, DATENAME, DATEFROMPARTS, FORMAT), logical functions (IIF, CHOOSE, ISNULL, COALESCE, NULLIF), system functions (NEWID, DB_NAME, OBJECT_ID, @@ERROR, @@ROWCOUNT, SCOPE_IDENTITY, @@TRANCOUNT), JSON functions (JSON_VALUE, JSON_QUERY, JSON_MODIFY, ISJSON, OPENJSON), error functions (ERROR_MESSAGE/NUMBER/SEVERITY/STATE/LINE/PROCEDURE), ISNUMERIC, ISDATE, DATALENGTH
- [statements-ddl.md](statements-ddl.md) — CREATE/ALTER/DROP TABLE (column definitions, constraints, IDENTITY, computed columns, foreign key actions), CREATE INDEX (clustered/nonclustered, UNIQUE, filtered, INCLUDE, options), CREATE VIEW (SCHEMABINDING, CHECK OPTION, updatable views), CREATE PROCEDURE (parameters, OUTPUT, RECOMPILE), CREATE FUNCTION (scalar, inline TVF, multi-statement TVF), CREATE TRIGGER (AFTER/INSTEAD OF, DML/DDL, inserted/deleted tables), CREATE DATABASE, CREATE SCHEMA, GRANT/DENY/REVOKE permissions
- [statements-dml.md](statements-dml.md) — INSERT (VALUES, SELECT, EXEC, DEFAULT VALUES, OUTPUT), UPDATE (SET, compound operators, FROM clause for multi-table, .WRITE for LOB), DELETE (FROM...FROM pattern, join-based), MERGE (MATCHED/NOT MATCHED, $action), TRUNCATE TABLE (vs DELETE, IDENTITY reset, restrictions), BULK INSERT (format options, constraints, triggers)
- [transactions-and-error-handling.md](transactions-and-error-handling.md) — Transaction modes (autocommit/explicit/implicit), BEGIN/COMMIT/ROLLBACK TRANSACTION, SAVE TRANSACTION/savepoints, @@TRANCOUNT semantics, XACT_STATE(), TRY...CATCH (severity rules, error functions, uncommittable transactions), THROW vs RAISERROR, SET statements (ANSI_NULLS, QUOTED_IDENTIFIER, NOCOUNT, XACT_ABORT, IDENTITY_INSERT, TRANSACTION ISOLATION LEVEL, ARITHABORT, CONCAT_NULL_YIELDS_NULL, and more), isolation levels

## Implementation — @mssqlite/tsql + transpile + engine

The language pipeline lives in three packages:

- [`packages/tsql`](../../../packages/tsql) — lexer + parser to a typed
  AST. Its Readme lists the exact supported surface (queries with joins/
  CTEs/set ops/window OVER, full expression precedence and predicates,
  DML, DDL with constraints, DECLARE/SET, control flow, transactions,
  EXEC, THROW).
- [`packages/transpile`](../../../packages/transpile) — AST → SQLite SQL
  with function mapping and CONVERT style support.
- [`packages/engine`](../../../packages/engine) — interprets what SQLite
  cannot: variables, IF/WHILE, @@TRANCOUNT nesting, sp_executesql,
  SELECT INTO, error-number mapping.

### Parsing notes discovered implementing

- Reserved words must be rejected as bare identifiers (else
  `SELECT FROM` "succeeds" selecting a column named FROM) but allowed as
  function names directly before `(` — `LEFT(x, 1)`, `RIGHT(...)`.
- `TOP 10 *` is ambiguous with multiplication: binary-operator parsing
  must rewind when the right operand fails so `*` can be the select star.
  Bare `TOP n` only takes a constant; expressions require `TOP (expr)`.
- `CASE x WHEN …` vs `CASE WHEN …`: the optional operand parser must not
  swallow the `WHEN` keyword as a column reference.
- `GO` is a client-side batch separator — it never arrives over TDS and
  is deliberately not in the grammar.
- Statements separate on semicolons *or* juxtaposition; both appear in
  real client traffic.
- `@@ERROR` reads as the previous statement's error number — it resets
  *after* the statement referencing it, and it persists across batches.

### Implementation notes — later additions

- TRY/CATCH parses in `beginBlockOrTransaction` (BEGIN TRAN → BEGIN TRY →
  block, in that order); bodies terminate on the two-word `END TRY` /
  `END CATCH`, so nested plain `BEGIN … END` blocks parse through
  `statementRef` and never confuse the terminator scan.
- RAISERROR takes a parenthesized argument list plus optional
  `WITH option[, …]` (options parsed, lowercased, NOWAIT/LOG ignored).
- CREATE [OR ALTER] PROC[EDURE] owns the rest of the batch as its body
  (MSSQL requires it to be alone in a batch); `parse()` patches the
  statement's `definition` with the trimmed batch source for
  sys.sql_modules. Parameters accept optional parens, defaults,
  OUT/OUTPUT and READONLY.
- TOP parses `PERCENT` and `WITH TIES` (`top.withTies`); UPDATE/DELETE
  accept `TOP (expr)` only, per MSSQL.
- OUTPUT clause (`Ast.Output`) sits between the column list / SET list /
  target and the source / FROM / WHERE. Items reuse the select-item shape
  minus variable assignment; `OUTPUT` being a reserved word is what stops
  the preceding expression (last SET value, INSERT column list) from
  swallowing it. INSERT/DELETE (and inserted-only UPDATE) transpile to
  SQLite `RETURNING` with the pseudo-table qualifier stripped; UPDATE
  reading `deleted.` values is engine-interpreted via a temp-table
  snapshot joined to the post-update rows. Divergences: an unaliased
  `deleted.x, inserted.x` pair collapses to one result key (duplicate
  column names — known engine-wide limitation, alias them), and
  `UPDATE … FROM` combined with `OUTPUT deleted.` is rejected.
- MERGE parses in `parse/dml.ts`: USING accepts a table, `(SELECT …)` or
  `(VALUES …)` — both need an alias, and a column list desugars into
  select-item aliases at parse time (VALUES becomes a UNION ALL chain),
  so downstream layers only ever see a derived table. `USING` had to
  join the reserved-word set or it parses as the target's alias. The
  engine decomposes MERGE via a snapshot temp table (see the
  architecture skill). Divergences from SQL Server: the terminating
  semicolon is not enforced; two WHEN MATCHED arms whose first has no
  AND condition are accepted (the second is just dead); the same table
  can be target and source (the snapshot makes it safe); arm-count and
  duplicate-action violations raise 10714, multi-source matches for one
  target row raise 8672. MERGE OUTPUT supports `$action` (lexed as a
  plain word — a leading `$` may start a word token), `inserted.` /
  `deleted.` items and stars, and `OUTPUT … INTO`; unlike SQL Server,
  source columns in MERGE OUTPUT are rejected (the row images are
  assembled after the arms apply, when source pairing is gone).
- `DECLARE @t TABLE (...)` reuses CREATE TABLE column/constraint members but
  requires the table variable to be the only declaration in that DECLARE.
  Object-position variables parse only in SELECT/INSERT/UPDATE/DELETE. The
  engine gives each declaration a unique SQLite temp backing table and
  scopes it to the declaring batch or procedure; nested procedures and
  `sp_executesql` cannot see a caller's table variables. Backing tables are
  dropped on normal or exceptional scope exit.

### Not yet implemented (raise clean errors)

CREATE FUNCTION/TRIGGER, PIVOT/UNPIVOT, APPLY, cursors, WAITFOR,
GOTO, source columns in MERGE OUTPUT,
table-valued functions in FROM (STRING_SPLIT, OPENJSON), FOR JSON/XML,
GROUP BY ROLLUP/CUBE/GROUPING SETS, COLLATE as expression operator,
AT TIME ZONE, ALTER TABLE ALTER COLUMN.
