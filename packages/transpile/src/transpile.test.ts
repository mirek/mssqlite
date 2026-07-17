import { expect, test } from 'vitest'
import { parseExpression, parseStatement } from '@mssqlite/tsql'
import { Computed, scalar, statement, UnsupportedError } from './index.ts'

const sqlOf =
  (tsql: string): string =>
    statement(parseStatement(tsql)).sql

const scalarOf =
  (tsql: string): string =>
    scalar(parseExpression(tsql)).sql

test('select basics', () => {
  expect(sqlOf('SELECT 1 AS x')).toBe('SELECT 1 AS "x"')
  expect(sqlOf('SELECT * FROM dbo.users')).toBe('SELECT * FROM "users"')
  expect(sqlOf('SELECT u.name FROM users u WHERE u.age >= 18'))
    .toBe('SELECT "u"."name" FROM "users" AS "u" WHERE ("u"."age" >= 18)')
})

test('sys and schema-qualified names', () => {
  // Flattened names get a bare-table alias so qualified column refs still resolve.
  expect(sqlOf('SELECT * FROM sys.tables')).toBe('SELECT * FROM "sys.tables" AS "tables"')
  expect(sqlOf('SELECT * FROM master.sys.Tables'))
    .toBe('SELECT * FROM "mssqlite_6d6173746572"."sys.tables" AS "Tables"')
  expect(sqlOf('SELECT * FROM app.users')).toBe('SELECT * FROM "app.users" AS "users"')
  expect(sqlOf('SELECT * FROM #tmp')).toBe('SELECT * FROM temp."#tmp" AS "#tmp"')
  expect(sqlOf('SELECT * FROM dbo.users')).toBe('SELECT * FROM "users"')
})

test('schema-qualified table keeps qualified column refs working', () => {
  // Regression: unaliased non-dbo table must expose its bare name for `orders.id`.
  expect(sqlOf('SELECT orders.id FROM sales.orders'))
    .toBe('SELECT "orders"."id" FROM "sales.orders" AS "orders"')
  expect(sqlOf('SELECT sales.orders.id FROM sales.orders'))
    .toBe('SELECT "orders"."id" FROM "sales.orders" AS "orders"')
})

test('db..table shorthand resolves to the same table as db.dbo.table', () => {
  const expected = 'SELECT * FROM "mssqlite_6d796462"."orders" AS "orders"'
  expect(sqlOf('SELECT * FROM mydb..orders')).toBe(expected)
  expect(sqlOf('SELECT * FROM mydb.dbo.orders')).toBe(expected)
})

test('top and offset become limit', () => {
  expect(sqlOf('SELECT TOP 5 * FROM t')).toBe('SELECT * FROM "t" LIMIT 5')
  expect(sqlOf('SELECT * FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY'))
    .toBe('SELECT * FROM "t" ORDER BY "id" LIMIT 5 OFFSET 10')
  expect(sqlOf('SELECT * FROM t ORDER BY id OFFSET 10 ROWS'))
    .toBe('SELECT * FROM "t" ORDER BY "id" LIMIT -1 OFFSET 10')
})

test('joins', () => {
  expect(sqlOf('SELECT * FROM a JOIN b ON a.id = b.a_id'))
    .toBe('SELECT * FROM "a" INNER JOIN "b" ON ("a"."id" = "b"."a_id")')
  expect(sqlOf('SELECT * FROM a, b'))
    .toBe('SELECT * FROM "a" CROSS JOIN "b"')
})

test('table-valued functions render with declared result metadata', () => {
  const split = statement(parseStatement(
    'SELECT * FROM STRING_SPLIT(N\'a,b\', \',\', 1) AS s'))
  expect(split.sql).toContain('json_each(mssqlite_string_split')
  expect(split.columns).toEqual([
    { name: 'value', type: { name: 'nvarchar', args: [ 3 ] }, nullable: false },
    { name: 'ordinal', type: { name: 'bigint', args: [] }, nullable: false }
  ])

  const json = statement(parseStatement(
    'SELECT id, label FROM OPENJSON(@j) WITH (id INT, label NVARCHAR(20)) AS j'))
  expect(json.sql).toContain('FROM json_each(')
  expect(json.columns).toEqual([
    { name: 'id', type: { name: 'int', args: [] }, nullable: true },
    { name: 'label', type: { name: 'nvarchar', args: [ 20 ] }, nullable: true }
  ])

  expect(sqlOf('SELECT value FROM GENERATE_SERIES(1, 3)')).toContain('WITH RECURSIVE')
  expect(() => sqlOf('SELECT * FROM STRING_SPLIT(\'a,b\', \',\', @ordinal)'))
    .toThrow(UnsupportedError)
  expect(() => sqlOf('SELECT * FROM GENERATE_SERIES(1, 3, 0)'))
    .toThrow(UnsupportedError)
  expect(() => sqlOf('SELECT * FROM unknown_tvf(1)')).toThrow(UnsupportedError)
})

test('apply maps supported correlated string split sources to lateral virtual tables', () => {
  expect(sqlOf(`
    SELECT t.id, s.value FROM tags t
    CROSS APPLY STRING_SPLIT(t.csv, ',') s
  `)).toContain('"tags" AS "t" CROSS JOIN json_each(mssqlite_string_split("t"."csv", \',\')) AS "s"')
  expect(sqlOf(`
    SELECT t.id, s.value FROM tags t
    OUTER APPLY STRING_SPLIT(t.csv, ',') s
  `)).toContain('LEFT JOIN json_each(mssqlite_string_split("t"."csv", \',\')) AS "s" ON TRUE')
  expect(() => sqlOf(`
    SELECT * FROM tags t CROSS APPLY GENERATE_SERIES(1, t.id) s
  `)).toThrow(UnsupportedError)
  const topOne = sqlOf(`
    SELECT t.id, latest.note FROM tags t OUTER APPLY (
      SELECT TOP (1) n.note FROM notes n
      WHERE n.tag_id = t.id ORDER BY n.created DESC
    ) latest
  `)
  expect(topOne).toContain('row_number() OVER (PARTITION BY "n"."tag_id" ORDER BY "n"."created" DESC)')
  expect(topOne).toContain('LEFT JOIN')
  expect(topOne).toContain('"latest"."__mssqlite_apply_rank" = 1')
})

test('pivot and unpivot render one source evaluation and reject ambiguous output', () => {
  const pivot = sqlOf(`
    SELECT * FROM (SELECT region, quarter, amount FROM sales) source
    PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2])) result
  `)
  expect(pivot).toContain('sum(CASE WHEN "quarter" = \'Q1\' THEN "amount" END) AS "Q1"')
  expect(pivot.match(/FROM "sales"/g)).toHaveLength(1)

  const unpivot = sqlOf(`
    SELECT * FROM (SELECT id, [Q1], [Q2] FROM quarterly) source
    UNPIVOT (amount FOR quarter IN ([Q1], [Q2])) result
  `)
  expect(unpivot).toContain('AS MATERIALIZED')
  expect(unpivot.match(/FROM "quarterly"/g)).toHaveLength(1)
  expect(unpivot).toContain('WHERE "Q1" IS NOT NULL UNION ALL')

  expect(() => sqlOf(`
    SELECT * FROM (SELECT region, quarter, amount FROM sales) source
    PIVOT (SUM(amount) FOR quarter IN ([region])) result
  `)).toThrow(UnsupportedError)
  expect(() => sqlOf(`
    SELECT * FROM (SELECT id, [Q1], [Q2] FROM quarterly) source
    UNPIVOT (id FOR quarter IN ([Q1], [Q2])) result
  `)).toThrow(UnsupportedError)
})

test('advanced grouping expands ordered branches and validates grouping arguments', () => {
  const rollup = sqlOf(`
    SELECT a, b, SUM(v) AS total, GROUPING(a) AS ga, GROUPING(b) AS gb
    FROM t GROUP BY ROLLUP(a, b)
  `)
  expect(rollup).toContain('AS MATERIALIZED')
  expect(rollup.match(/UNION ALL/g)).toHaveLength(2)
  const detail = rollup.indexOf('GROUP BY "a", "b"')
  expect(detail).toBeGreaterThan(0)
  expect(rollup.indexOf('GROUP BY "a"', detail + 1)).toBeGreaterThan(detail)
  expect(rollup).toContain('NULL AS "a", NULL AS "b"')

  const combined = sqlOf(`
    SELECT a, b, SUM(v) FROM t
    GROUP BY a, GROUPING SETS ((b), ())
  `)
  expect(combined.match(/UNION ALL/g)).toHaveLength(1)
  expect(() => sqlOf(`
    SELECT GROUPING(c) FROM t GROUP BY ROLLUP(a, b)
  `)).toThrow(UnsupportedError)
  expect(() => sqlOf(`
    SELECT a, SUM(v) FROM t GROUP BY CUBE(a, b) OFFSET 1 ROWS
  `)).toThrow(UnsupportedError)
})

test('for json renders one nvarchar max result and validates projected names', () => {
  const rendered = statement(parseStatement(`
    SELECT id, name AS [info.name] FROM users ORDER BY id
    FOR JSON PATH, ROOT('users')
  `))
  expect(rendered.sql).toContain('json_group_array')
  expect(rendered.sql).toContain('json_object(\'info\'')
  expect(rendered.sql).toContain('AS "JSON_F52E2B61-18A1-11d1-B105-00805F49916B"')
  expect(rendered.columns).toEqual([ {
    name: 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B',
    type: { name: 'nvarchar', args: [ 'max' ] },
    nullable: false
  } ])
  expect(() => sqlOf('SELECT 1 FOR JSON PATH')).toThrow(UnsupportedError)
  expect(() => sqlOf('SELECT 1 AS a, 2 AS a FOR JSON PATH')).toThrow(UnsupportedError)
  expect(() => sqlOf('SELECT 1 AS a, 2 AS [a.b] FOR JSON PATH')).toThrow(UnsupportedError)
  expect(() => sqlOf('SELECT 1 AS a FOR JSON AUTO')).toThrow(UnsupportedError)
})

test('union and ctes', () => {
  expect(sqlOf('SELECT 1 AS n UNION ALL SELECT 2 ORDER BY n'))
    .toBe('SELECT 1 AS "n" UNION ALL SELECT 2 ORDER BY "n"')
  expect(sqlOf('WITH a AS (SELECT 1 AS x) SELECT * FROM a'))
    .toBe('WITH "a" AS (SELECT 1 AS "x") SELECT * FROM "a"')
})

test('variables become parameters', () => {
  const rendered = statement(parseStatement('SELECT * FROM t WHERE id = @Id AND n < @@ROWCOUNT'))
  expect(rendered.sql).toBe('SELECT * FROM "t" WHERE (("id" = @id) AND ("n" < @__rowcount))')
  expect(rendered.variables).toEqual([ '@id', '@@rowcount' ])
})

test('plus resolves to add, concat or dynamic dispatch', () => {
  expect(scalarOf('1 + 2')).toBe('mssqlite_arithmetic(\'+\', 1, 2, 32)')
  expect(scalarOf('\'a\' + \'b\'')).toBe('(\'a\' || \'b\')')
  // A column of unknown type + a string is dynamic — MSSQL concatenates two
  // strings but numerically adds a string/number mix, which mssqlite_add does.
  expect(scalarOf('name + \'x\'')).toBe('mssqlite_add("name", \'x\')')
  // A literal number + literal string is numeric addition in T-SQL, not concat.
  expect(scalarOf('3 + \'5\'')).toBe(
    'mssqlite_arithmetic(\'+\', 3, mssqlite_cast_integer(\'5\', \'int\', 0), 32)')
  expect(scalarOf('a + b')).toBe('mssqlite_add("a", "b")')
  expect(scalarOf('LEN(a) + 1')).toBe(
    'mssqlite_arithmetic(\'+\', length(rtrim("a")), 1, 32)')
})

test('compound update operators reuse add/concat/xor rendering', () => {
  expect(sqlOf('UPDATE t SET name += \'!\' WHERE id = 1'))
    .toBe('UPDATE "t" SET "name" = mssqlite_add("name", \'!\') WHERE ("id" = 1)')
  expect(sqlOf('UPDATE t SET flags ^= 4'))
    .toBe('UPDATE "t" SET "flags" = (("flags" | 4) - ("flags" & 4))')
  expect(sqlOf('UPDATE t SET n -= 2')).toBe(
    'UPDATE "t" SET "n" = mssqlite_arithmetic(\'-\', "n", 2, 32)')
})

test('!> and !< comparison operators', () => {
  expect(scalarOf('a !> 5')).toBe('("a" <= 5)')
  expect(scalarOf('a !< 5')).toBe('("a" >= 5)')
})

test('odd-length binary literal pads to even', () => {
  expect(scalarOf('0x1')).toBe('x\'01\'')
  expect(scalarOf('0xABC')).toBe('x\'0ABC\'')
})

test('TOP inside a set operation is branch-scoped', () => {
  expect(sqlOf('SELECT TOP 1 x FROM t2 UNION ALL SELECT y FROM u'))
    .toBe('SELECT * FROM (SELECT "x" FROM "t2" LIMIT 1) UNION ALL SELECT "y" FROM "u"')
  expect(sqlOf('SELECT x FROM t2 UNION ALL SELECT TOP 1 y FROM u'))
    .toBe('SELECT "x" FROM "t2" UNION ALL SELECT * FROM (SELECT "y" FROM "u" LIMIT 1)')
})

test('string literals escape', () => {
  expect(scalarOf('\'it\'\'s\'')).toBe('\'it\'\'s\'')
  expect(scalarOf('N\'ü\'')).toBe('\'ü\'')
})

test('function mappings', () => {
  expect(scalarOf('GETDATE()')).toContain('strftime(\'%Y-%m-%d %H:%M:%f\', \'now\', \'localtime\')')
  expect(scalarOf('GETUTCDATE()')).toBe('strftime(\'%Y-%m-%d %H:%M:%f\', \'now\')')
  expect(scalarOf('ISNULL(a, 0)')).toBe('ifnull("a", 0)')
  expect(scalarOf('LEN(x)')).toBe('length(rtrim("x"))')
  expect(scalarOf('SUBSTRING(x, 2, 3)')).toBe('mssqlite_substring("x", 2, 3)')
  expect(scalarOf('CHARINDEX(\'a\', x)')).toBe('instr("x", \'a\')')
  expect(scalarOf('LEFT(x, 3)')).toBe('mssqlite_left("x", 3)')
  expect(scalarOf('RIGHT(x, 3)')).toBe('mssqlite_right("x", 3)')
  expect(scalarOf('QUOTENAME(x, \'"\')')).toBe('mssqlite_quotename("x", \'"\')')
  expect(scalarOf('ASCII(x)')).toBe('unicode("x")')
  expect(scalarOf('NEWID()')).toBe('mssqlite_newid()')
  expect(scalarOf('SCOPE_IDENTITY()')).toBe('mssqlite_scope_identity()')
  expect(scalarOf('DATEADD(month, 1, d)')).toBe('mssqlite_dateadd(\'month\', 1, "d")')
  expect(scalarOf('DATEDIFF(dd, a, b)')).toBe('mssqlite_datediff(\'day\', "a", "b")')
  expect(scalarOf('YEAR(d)')).toBe('CAST(strftime(\'%Y\', "d") AS INTEGER)')
  expect(scalarOf('EOMONTH(d)')).toBe('date("d", \'start of month\', \'+1 month\', \'-1 day\')')
  expect(scalarOf('STRING_AGG(x, \',\')')).toBe('group_concat("x", \',\')')
  expect(scalarOf('CEILING(x)')).toBe('ceiling("x")')
  expect(scalarOf('SQUARE(x)')).toBe('power("x", 2)')
  expect(scalarOf('LOG(x)')).toBe('ln("x")')
  expect(scalarOf('LOG(x, 2)')).toBe('log(2, "x")')
  expect(scalarOf('CHOOSE(n, \'a\', \'b\')')).toBe('(CASE "n" WHEN 1 THEN \'a\' WHEN 2 THEN \'b\' END)')
  expect(scalarOf('COUNT(DISTINCT x)')).toBe('count(DISTINCT "x")')
  expect(scalarOf('COUNT(*)')).toBe('count(*)')
})

test('window functions', () => {
  expect(scalarOf('ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC)'))
    .toBe('row_number() OVER (PARTITION BY "a" ORDER BY "b" DESC)')
})

test('catalog function rewrites', () => {
  expect(scalarOf('OBJECT_ID(\'users\')'))
    .toBe('(SELECT object_id FROM "sys.objects" WHERE name = mssqlite_name(\'users\') COLLATE NOCASE LIMIT 1)')
  expect(scalarOf('SCHEMA_NAME(1)')).toBe('(SELECT name FROM "sys.schemas" WHERE schema_id = 1)')
  expect(scalarOf('DB_NAME()')).toBe('mssqlite_db_name()')
})

test('cast and convert', () => {
  expect(scalarOf('CAST(x AS int)')).toBe('mssqlite_cast_integer("x", \'int\', 0)')
  expect(scalarOf('CAST(x AS nvarchar(50))'))
    .toBe('mssqlite_cast_character("x", \'nvarchar\', 50, 0)')
  expect(scalarOf('CAST(x AS varchar)'))
    .toBe('mssqlite_cast_character("x", \'varchar\', 30, 0)')
  expect(scalarOf('CAST(x AS date)')).toBe('date("x")')
  expect(scalarOf('CAST(x AS bit)')).toBe('(CAST("x" AS NUMERIC) <> 0)')
  expect(scalarOf('CONVERT(varchar(10), d, 120)'))
    .toBe('mssqlite_cast_character(strftime(\'%Y-%m-%d %H:%M:%S\', "d"), \'varchar\', 10, 0)')
  expect(scalarOf('CONVERT(int, x)')).toBe('mssqlite_cast_integer("x", \'int\', 0)')
  expect(scalarOf('DATALENGTH(CAST(x AS varchar(3)))'))
    .toBe('mssqlite_datalength(mssqlite_cast_character("x", \'varchar\', 3, 0), \'varchar\')')
  expect(scalarOf('ISNULL(CAST(NULL AS varchar(3)), \'abcdef\')'))
    .toBe('mssqlite_cast_character(ifnull(mssqlite_cast_character(NULL, \'varchar\', 3, 0), \'abcdef\'), \'varchar\', 3, 0)')
})

test('case, in, like, between, exists', () => {
  expect(scalarOf('CASE WHEN x = 1 THEN \'a\' ELSE \'b\' END'))
    .toBe('(CASE WHEN ("x" = 1) THEN \'a\' ELSE \'b\' END)')
  expect(scalarOf('x IN (1, 2)')).toBe('("x" IN (1, 2))')
  expect(scalarOf('x NOT IN (SELECT id FROM t)')).toBe('("x" NOT IN (SELECT "id" FROM "t"))')
  expect(scalarOf('x LIKE \'a%\'')).toBe('("x" LIKE \'a%\')')
  expect(scalarOf('x BETWEEN 1 AND 2')).toBe('("x" BETWEEN 1 AND 2)')
  expect(scalarOf('EXISTS (SELECT 1 FROM t)')).toBe('EXISTS (SELECT 1 FROM "t")')
  expect(scalarOf('x IS NOT NULL')).toBe('("x" IS NOT NULL)')
})

test('insert, update, delete, truncate', () => {
  expect(sqlOf('INSERT INTO t (a, b) VALUES (1, \'x\'), (2, \'y\')'))
    .toBe('INSERT INTO "t" ("a", "b") VALUES (1, \'x\'), (2, \'y\')')
  expect(sqlOf('INSERT INTO t DEFAULT VALUES')).toBe('INSERT INTO "t" DEFAULT VALUES')
  expect(sqlOf('INSERT INTO t SELECT * FROM s')).toBe('INSERT INTO "t" SELECT * FROM "s"')
  expect(sqlOf('UPDATE t SET a = 1, b += 2 WHERE id = @id'))
    .toBe('UPDATE "t" SET "a" = 1, "b" = mssqlite_add("b", 2) WHERE ("id" = @id)')
  expect(sqlOf('DELETE FROM t WHERE id = 1')).toBe('DELETE FROM "t" WHERE ("id" = 1)')
  expect(sqlOf('TRUNCATE TABLE t')).toBe('DELETE FROM "t"')
})

test('top percent and with ties become computed limits', () => {
  expect(sqlOf('SELECT TOP 10 PERCENT * FROM t'))
    .toBe('SELECT * FROM "t" LIMIT ' +
      '(SELECT CAST(ceiling(COUNT(*) * (10) / 100.0) AS INTEGER) FROM (SELECT 1 FROM "t"))')
  expect(sqlOf('SELECT TOP 2 WITH TIES a FROM t ORDER BY a'))
    .toBe('SELECT "a" FROM "t" ORDER BY "a" LIMIT ' +
      '(SELECT COUNT(*) FROM (SELECT rank() OVER (ORDER BY "a") AS "__mssqlite_rank" FROM "t") ' +
      'WHERE "__mssqlite_rank" <= 2)')
  expect(() => sqlOf('SELECT TOP 2 WITH TIES a FROM t')).toThrow(UnsupportedError)
})

test('update and delete top pick rows by rowid', () => {
  expect(sqlOf('UPDATE TOP (2) t SET a = 1 WHERE b = 0'))
    .toBe('UPDATE "t" SET "a" = 1 WHERE rowid IN (SELECT rowid FROM "t" WHERE ("b" = 0) LIMIT 2)')
  expect(sqlOf('DELETE TOP (2) FROM t WHERE b = 0'))
    .toBe('DELETE FROM "t" WHERE rowid IN (SELECT rowid FROM "t" WHERE ("b" = 0) LIMIT 2)')
})

test('delete with a second from clause resolves the alias to its table', () => {
  expect(sqlOf('DELETE a FROM t AS a JOIN s ON a.id = s.a_id WHERE s.done = 1'))
    .toBe('DELETE FROM "t" WHERE rowid IN ' +
      '(SELECT "a".rowid FROM "t" AS "a" INNER JOIN "s" ON ("a"."id" = "s"."a_id") ' +
      'WHERE ("s"."done" = 1))')
  expect(sqlOf('DELETE FROM t FROM t JOIN s ON t.id = s.a_id'))
    .toBe('DELETE FROM "t" WHERE rowid IN ' +
      '(SELECT "t".rowid FROM "t" INNER JOIN "s" ON ("t"."id" = "s"."a_id"))')
  expect(() => sqlOf('DELETE x FROM t JOIN s ON t.id = s.a_id')).toThrow(UnsupportedError)
})

test('create table', () => {
  expect(sqlOf(`
    CREATE TABLE dbo.users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(100) NOT NULL,
      age INT NULL DEFAULT 0,
      email VARCHAR(255) UNIQUE,
      team_id INT REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT uq_name UNIQUE (name)
    )
  `)).toBe(
    'CREATE TABLE "users" (' +
    '"id" INTEGER PRIMARY KEY NOT NULL, ' +
    '"name" TEXT COLLATE NOCASE NOT NULL, ' +
    '"age" INTEGER DEFAULT (0), ' +
    '"email" TEXT COLLATE NOCASE UNIQUE, ' +
    '"team_id" INTEGER REFERENCES "teams" ("id") ON DELETE CASCADE, ' +
    'CONSTRAINT "uq_name" UNIQUE ("name"))'
  )
})

test('computed columns render inferred virtual and stored generated columns', () => {
  const parsed = parseStatement(`
    CREATE TABLE totals (
      quantity INT,
      price DECIMAL(10,2),
      total AS quantity * price PERSISTED,
      doubled AS quantity * 2
    )
  `)
  if (parsed.kind !== 'createTable') {
    throw new Error('Expected CREATE TABLE.')
  }
  const resolved = { ...parsed, columns: Computed.columns(parsed.columns) }
  expect(statement(resolved).sql).toBe(
    'CREATE TABLE "totals" (' +
    '"quantity" INTEGER, "price" TEXT, ' +
    '"total" TEXT GENERATED ALWAYS AS (' +
    'mssqlite_decimal_generated_arithmetic(\'*\', "quantity", "price", 0, 2, 21, 2)) STORED, ' +
    '"doubled" INTEGER GENERATED ALWAYS AS (mssqlite_generated_arithmetic(\'*\', "quantity", 2, 32)) VIRTUAL)'
  )
})

test('collations render normalized predicates, ordering and uniqueness', () => {
  expect(scalarOf('value COLLATE Latin1_General_100_CI_AI = N\'café\'')).toBe(
    '(mssqlite_collation_key(("value" COLLATE NOCASE), \'latin1_general_100_ci_ai\') = ' +
    'mssqlite_collation_key(\'café\', \'latin1_general_100_ci_ai\'))'
  )
  expect(sqlOf(`
    CREATE TABLE names (
      value NVARCHAR(20) COLLATE Latin1_General_100_CI_AI UNIQUE,
      exact NVARCHAR(20) COLLATE Latin1_General_100_CS_AS
    )
  `)).toBe(
    'CREATE TABLE "names" (' +
    '"value" TEXT COLLATE NOCASE UNIQUE, "exact" TEXT COLLATE BINARY); ' +
    'CREATE UNIQUE INDEX "__mssqlite_names_collation_0" ON "names" (' +
    'mssqlite_collation_key("value", \'latin1_general_100_ci_ai\'))'
  )
  expect(() => sqlOf('CREATE TABLE bad (value NVARCHAR(10) COLLATE Unknown_Collation)'))
    .toThrow(UnsupportedError)
})

test('identity via table-level primary key', () => {
  expect(sqlOf('CREATE TABLE t (id INT IDENTITY(1,1), name TEXT, PRIMARY KEY (id))'))
    .toBe('CREATE TABLE "t" ("id" INTEGER NOT NULL, "name" TEXT COLLATE NOCASE, PRIMARY KEY ("id"))')
})

test('indexes and views', () => {
  expect(sqlOf('CREATE UNIQUE INDEX ix ON t (a, b DESC) WHERE a > 0'))
    .toBe('CREATE UNIQUE INDEX "ix" ON "t" ("a", "b" DESC) WHERE ("a" > 0)')
  expect(sqlOf('DROP INDEX ix ON t')).toBe('DROP INDEX "ix"')
  expect(sqlOf('CREATE VIEW v AS SELECT 1 AS x')).toBe('CREATE VIEW "v" AS SELECT 1 AS "x"')
  expect(sqlOf('DROP TABLE IF EXISTS a, b')).toBe('DROP TABLE IF EXISTS "a"; DROP TABLE IF EXISTS "b"')
})

test('alter table', () => {
  expect(sqlOf('ALTER TABLE t ADD c INT NULL'))
    .toBe('ALTER TABLE "t" ADD COLUMN "c" INTEGER')
  expect(sqlOf('ALTER TABLE t DROP COLUMN c'))
    .toBe('ALTER TABLE "t" DROP COLUMN "c"')
})

test('binary literals', () => {
  expect(scalarOf('0xDEADBEEF')).toBe('x\'DEADBEEF\'')
})
