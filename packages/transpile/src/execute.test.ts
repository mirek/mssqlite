import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parse, parseStatement } from '@mssqlite/tsql'
import { statement } from './index.ts'

/** Executes transpiled T-SQL against a real SQLite database. */
const database =
  (): DatabaseSync => {
    const db = new DatabaseSync(':memory:')
    db.function('mssqlite_arithmetic', (operator, left, right, _width) => {
      if (left === null || right === null) {
        return null
      }
      const a = Number(left)
      const b = Number(right)
      return operator === '+' ? a + b : operator === '-' ? a - b : operator === '*' ? a * b :
        operator === '/' ? a / b : a % b
    })
    db.aggregate<number>('mssqlite_sum', {
      start: 0,
      step: (sum, value) => sum + Number(value ?? 0)
    })
    db.aggregate<number>('mssqlite_sum_bigint', {
      start: 0,
      step: (sum, value) => sum + Number(value ?? 0)
    })
    return db
  }

const tableFunctionDatabase =
  (): DatabaseSync => {
    const db = database()
    db.function('mssqlite_string_split', (value, separator) =>
      value === null || separator === null || value === '' ?
        '[]' :
        JSON.stringify(String(value).split(String(separator))))
    db.function('mssqlite_series_step', (start, stop, step) =>
      start === null || stop === null ?
        null :
        Number(step ?? (Number(start) <= Number(stop) ? 1 : -1)))
    return db
  }

const run =
  (db: DatabaseSync, tsql: string): void => {
    for (const parsed of parse(tsql)) {
      for (const sql of statement(parsed).sql.split('; ')) {
        db.exec(sql)
      }
    }
  }

const all =
  (db: DatabaseSync, tsql: string): unknown[] => {
    const { sql } = statement(parseStatement(tsql))
    return db.prepare(sql).all()
  }

test('create, insert, select round trip', () => {
  const db = database()
  run(db, `
    CREATE TABLE dbo.users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(100) NOT NULL,
      age INT NULL
    );
    INSERT INTO users (name, age) VALUES (N'Alice', 30), (N'Bob', NULL);
  `)
  expect(all(db, 'SELECT * FROM users ORDER BY id')).toEqual([
    { id: 1, name: 'Alice', age: 30 },
    { id: 2, name: 'Bob', age: null }
  ])
  expect(all(db, 'SELECT COUNT(*) AS n FROM users WHERE age IS NULL')).toEqual([ { n: 1 } ])
})

test('case-insensitive text comparison via NOCASE', () => {
  const db = database()
  run(db, `
    CREATE TABLE t (name NVARCHAR(50));
    INSERT INTO t VALUES (N'Alice');
  `)
  expect(all(db, 'SELECT COUNT(*) AS n FROM t WHERE name = \'ALICE\'')).toEqual([ { n: 1 } ])
})

test('identity autoincrements and unique constraints enforce', () => {
  const db = database()
  run(db, `
    CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, email VARCHAR(50) UNIQUE);
    INSERT INTO t (email) VALUES ('a@x.io');
    INSERT INTO t (email) VALUES ('b@x.io');
  `)
  expect(all(db, 'SELECT MAX(id) AS m FROM t')).toEqual([ { m: 2 } ])
  expect(() => run(db, 'INSERT INTO t (email) VALUES (\'a@x.io\')')).toThrow()
})

test('top, group by, having, order by', () => {
  const db = database()
  run(db, `
    CREATE TABLE sales (region NVARCHAR(20), amount INT);
    INSERT INTO sales VALUES ('east', 10), ('east', 20), ('west', 5);
  `)
  expect(all(db, `
    SELECT TOP 1 region, SUM(amount) AS total
    FROM sales GROUP BY region HAVING SUM(amount) > 1 ORDER BY total DESC
  `)).toEqual([ { region: 'east', total: 30 } ])
})

test('joins, subqueries and ctes execute', () => {
  const db = database()
  run(db, `
    CREATE TABLE teams (id INT PRIMARY KEY, name NVARCHAR(50));
    CREATE TABLE users (id INT PRIMARY KEY, team_id INT, name NVARCHAR(50));
    INSERT INTO teams VALUES (1, 'red'), (2, 'blue');
    INSERT INTO users VALUES (1, 1, 'a'), (2, 1, 'b'), (3, 2, 'c');
  `)
  expect(all(db, `
    SELECT t.name, COUNT(*) AS members
    FROM users u JOIN teams t ON u.team_id = t.id
    GROUP BY t.name ORDER BY members DESC
  `)).toEqual([
    { name: 'red', members: 2 },
    { name: 'blue', members: 1 }
  ])
  expect(all(db, `
    WITH big AS (SELECT team_id FROM users GROUP BY team_id HAVING COUNT(*) > 1)
    SELECT name FROM teams WHERE id IN (SELECT team_id FROM big)
  `)).toEqual([ { name: 'red' } ])
})

test('table-valued functions execute against real SQLite', () => {
  const db = tableFunctionDatabase()
  expect(all(db, `
    SELECT token, position
    FROM STRING_SPLIT('a,,b', ',', 1) AS s (token, position)
    ORDER BY position
  `)).toEqual([
    { token: 'a', position: 1 },
    { token: '', position: 2 },
    { token: 'b', position: 3 }
  ])
  expect(all(db, 'SELECT * FROM STRING_SPLIT(NULL, \',\')')).toEqual([])
  expect(all(db, 'SELECT * FROM STRING_SPLIT(\'\', \',\')')).toEqual([])

  expect(all(db, `
    SELECT [key], value, type
    FROM OPENJSON('{"name":"Ada","active":true,"items":[1]}')
    ORDER BY [key]
  `)).toEqual([
    { key: 'active', value: 'true', type: 3 },
    { key: 'items', value: '[1]', type: 4 },
    { key: 'name', value: 'Ada', type: 1 }
  ])
  expect(all(db, `
    SELECT id, name, details
    FROM OPENJSON('{"id":7,"name":"Ada","details":{"active":true}}')
    WITH (id INT, name NVARCHAR(20), details NVARCHAR(MAX) AS JSON)
  `)).toEqual([ { id: 7, name: 'Ada', details: '{"active":true}' } ])
  expect(all(db, `
    SELECT id FROM OPENJSON('{"items":[{"id":1},{"id":2}]}', '$.items')
    WITH (id INT) ORDER BY id
  `)).toEqual([ { id: 1 }, { id: 2 } ])
  expect(all(db, 'SELECT * FROM OPENJSON(NULL)')).toEqual([])
  expect(all(db, 'SELECT * FROM OPENJSON(\'[]\')')).toEqual([])

  expect(all(db, 'SELECT value FROM GENERATE_SERIES(1, 5, 2)')).toEqual([
    { value: 1 }, { value: 3 }, { value: 5 }
  ])
  expect(all(db, 'SELECT value FROM GENERATE_SERIES(3, 1)')).toEqual([
    { value: 3 }, { value: 2 }, { value: 1 }
  ])
  expect(all(db, 'SELECT value FROM GENERATE_SERIES(1, 3, -1)')).toEqual([])
  expect(all(db, 'SELECT value FROM GENERATE_SERIES(NULL, 3)')).toEqual([])
})

test('cross and outer apply evaluate string split per left row', () => {
  const db = tableFunctionDatabase()
  run(db, `
    CREATE TABLE tags (id INT, csv NVARCHAR(20));
    INSERT INTO tags VALUES (1, 'a,b'), (2, NULL), (3, 'c');
    CREATE TABLE notes (tag_id INT, note NVARCHAR(20), created INT);
    INSERT INTO notes VALUES (1, 'old', 1), (1, 'new', 2), (3, 'only', 1);
  `)
  expect(all(db, `
    SELECT t.id, s.value
    FROM tags t CROSS APPLY STRING_SPLIT(t.csv, ',') s
    ORDER BY t.id, s.value
  `)).toEqual([
    { id: 1, value: 'a' }, { id: 1, value: 'b' }, { id: 3, value: 'c' }
  ])
  expect(all(db, `
    SELECT t.id, s.value
    FROM tags t OUTER APPLY STRING_SPLIT(t.csv, ',') s
    ORDER BY t.id, s.value
  `)).toEqual([
    { id: 1, value: 'a' }, { id: 1, value: 'b' },
    { id: 2, value: null }, { id: 3, value: 'c' }
  ])
  expect(all(db, `
    SELECT t.id, latest.note
    FROM tags t OUTER APPLY (
      SELECT TOP (1) n.note FROM notes n
      WHERE n.tag_id = t.id ORDER BY n.created DESC
    ) latest
    ORDER BY t.id
  `)).toEqual([
    { id: 1, note: 'new' }, { id: 2, note: null }, { id: 3, note: 'only' }
  ])
  expect(all(db, `
    SELECT t.id, latest.note
    FROM tags t CROSS APPLY (
      SELECT TOP (1) n.note FROM notes n
      WHERE n.tag_id = t.id ORDER BY n.created DESC
    ) latest
    ORDER BY t.id
  `)).toEqual([
    { id: 1, note: 'new' }, { id: 3, note: 'only' }
  ])
})

test('pivot groups and aggregates while preserving missing values', () => {
  const db = database()
  run(db, `
    CREATE TABLE sales (region NVARCHAR(20), quarter NVARCHAR(2), amount INT);
    INSERT INTO sales VALUES
      ('east', 'Q1', 10), ('east', 'Q1', 5), ('east', 'Q2', NULL),
      ('west', 'Q2', 7);
  `)
  expect(all(db, `
    SELECT region, [Q1], [Q2], [Q3]
    FROM (SELECT region, quarter, amount FROM sales) source
    PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY region
  `)).toEqual([
    { region: 'east', Q1: 15, Q2: null, Q3: null },
    { region: 'west', Q1: null, Q2: 7, Q3: null }
  ])
  expect(all(db, `
    SELECT [Q1], [Q2], [Q3]
    FROM (SELECT quarter, amount FROM sales) source
    PIVOT (COUNT(amount) FOR quarter IN ([Q1], [Q2], [Q3])) result
  `)).toEqual([ { Q1: 2, Q2: 1, Q3: 0 } ])
})

test('unpivot omits nulls and preserves compatible mixed numeric affinities', () => {
  const db = database()
  run(db, `
    CREATE TABLE quarterly (id INT, [Q1] INT, [Q2] REAL, [Q3] INT);
    INSERT INTO quarterly VALUES (1, 10, 2.5, NULL), (2, NULL, 4.0, 30);
  `)
  expect(all(db, `
    SELECT id, quarter, amount
    FROM (SELECT id, [Q1], [Q2], [Q3] FROM quarterly) source
    UNPIVOT (amount FOR quarter IN ([Q1], [Q2], [Q3])) result
    ORDER BY id, quarter
  `)).toEqual([
    { id: 1, quarter: 'Q1', amount: 10 },
    { id: 1, quarter: 'Q2', amount: 2.5 },
    { id: 2, quarter: 'Q2', amount: 4 },
    { id: 2, quarter: 'Q3', amount: 30 }
  ])
})

test('rollup distinguishes ordinary nulls from subtotal nulls', () => {
  const db = database()
  run(db, `
    CREATE TABLE grouped_sales (region NVARCHAR(10), product NVARCHAR(10), amount INT);
    INSERT INTO grouped_sales VALUES
      ('east', 'a', 10), ('east', 'b', 20), ('west', 'a', 5), (NULL, 'a', 7);
  `)
  expect(all(db, `
    SELECT region, product, SUM(amount) AS total,
      GROUPING(region) AS gr, GROUPING(product) AS gp
    FROM grouped_sales
    GROUP BY ROLLUP(region, product)
    ORDER BY gr, gp, region, product
  `)).toEqual([
    { region: null, product: 'a', total: 7, gr: 0, gp: 0 },
    { region: 'east', product: 'a', total: 10, gr: 0, gp: 0 },
    { region: 'east', product: 'b', total: 20, gr: 0, gp: 0 },
    { region: 'west', product: 'a', total: 5, gr: 0, gp: 0 },
    { region: null, product: null, total: 7, gr: 0, gp: 1 },
    { region: 'east', product: null, total: 30, gr: 0, gp: 1 },
    { region: 'west', product: null, total: 5, gr: 0, gp: 1 },
    { region: null, product: null, total: 42, gr: 1, gp: 1 }
  ])
})

test('cube and grouping sets preserve branch and duplicate-set order', () => {
  const db = database()
  run(db, `
    CREATE TABLE dimensions (a NVARCHAR(2), b NVARCHAR(2), v INT);
    INSERT INTO dimensions VALUES ('x', 'p', 1), ('x', 'q', 2), ('y', 'p', 4);
  `)
  expect(all(db, `
    SELECT GROUPING(a) AS ga, GROUPING(b) AS gb, SUM(v) AS total
    FROM dimensions GROUP BY CUBE(a, b)
    ORDER BY ga, gb, total
  `)).toEqual([
    { ga: 0, gb: 0, total: 1 }, { ga: 0, gb: 0, total: 2 },
    { ga: 0, gb: 0, total: 4 }, { ga: 0, gb: 1, total: 3 },
    { ga: 0, gb: 1, total: 4 }, { ga: 1, gb: 0, total: 2 },
    { ga: 1, gb: 0, total: 5 }, { ga: 1, gb: 1, total: 7 }
  ])
  expect(all(db, `
    SELECT GROUPING(a) AS ga, SUM(v) AS total
    FROM dimensions GROUP BY GROUPING SETS ((a), (), ())
  `)).toEqual([
    { ga: 0, total: 3 }, { ga: 0, total: 4 },
    { ga: 1, total: 7 }, { ga: 1, total: 7 }
  ])
  expect(all(db, `
    SELECT a, GROUPING(a) AS ga, SUM(v) AS total
    FROM dimensions GROUP BY GROUPING SETS ((), (a))
    ORDER BY ga DESC, a
  `)).toEqual([
    { a: null, ga: 1, total: 7 },
    { a: 'x', ga: 0, total: 3 }, { a: 'y', ga: 0, total: 4 }
  ])
  expect(all(db, `
    SELECT a, GROUPING(a) AS ga, SUM(v) AS total
    FROM dimensions GROUP BY a HAVING GROUPING(a) = 0 ORDER BY a
  `)).toEqual([
    { a: 'x', ga: 0, total: 3 }, { a: 'y', ga: 0, total: 4 }
  ])

  run(db, 'CREATE TABLE empty_dimensions (a INT)')
  expect(all(db, 'SELECT COUNT(*) AS n FROM empty_dimensions GROUP BY ()'))
    .toEqual([ { n: 0 } ])
})

test('advanced grouping materializes a simple volatile source once', () => {
  const db = database()
  let calls = 0
  db.function('mssqlite_tick', value => {
    calls++
    return value
  })
  run(db, 'CREATE TABLE ticks (id INT); INSERT INTO ticks VALUES (1), (2), (3)')
  expect(all(db, `
    SELECT k, COUNT(*) AS n, GROUPING(k) AS g
    FROM (SELECT mssqlite_tick(id) AS k FROM ticks) source
    GROUP BY ROLLUP(k)
    ORDER BY g, k
  `)).toEqual([
    { k: 1, n: 1, g: 0 }, { k: 2, n: 1, g: 0 },
    { k: 3, n: 1, g: 0 }, { k: null, n: 3, g: 1 }
  ])
  expect(calls).toBe(3)
})

test('for json path nests aliases, omits nulls and preserves JSON fragments', () => {
  const db = database()
  const jsonColumn = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'
  run(db, `
    CREATE TABLE json_people (id INT, name NVARCHAR(20), nick NVARCHAR(20), note NVARCHAR(40));
    INSERT INTO json_people VALUES
      (1, 'Ada', NULL, 'quote " slash \\'), (2, 'Bob', 'b', NULL);
  `)
  const path = all(db, `
    SELECT id, name AS [info.name], nick AS [info.nick], note
    FROM json_people ORDER BY id FOR JSON PATH
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(path[0]?.[jsonColumn]))).toEqual([
    { id: 1, info: { name: 'Ada' }, note: 'quote " slash \\' },
    { id: 2, info: { name: 'Bob', nick: 'b' } }
  ])

  const included = all(db, `
    SELECT id, name AS [info.name], nick AS [info.nick], note
    FROM json_people WHERE id = 1
    FOR JSON PATH, INCLUDE_NULL_VALUES, ROOT('people')
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(included[0]?.[jsonColumn]))).toEqual({
    people: [ { id: 1, info: { name: 'Ada', nick: null }, note: 'quote " slash \\' } ]
  })

  const unwrapped = all(db, `
    SELECT id, JSON_QUERY('{"nested":[1,2]}') AS payload,
      '{"escaped":true}' AS text
    FROM json_people WHERE id = 1 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(unwrapped[0]?.[jsonColumn]))).toEqual({
    id: 1,
    payload: { nested: [ 1, 2 ] },
    text: '{"escaped":true}'
  })

  const empty = all(db, 'SELECT id FROM json_people WHERE id < 0 FOR JSON PATH') as
    Record<string, unknown>[]
  expect(empty[0]?.[jsonColumn]).toBe('[]')

})

test('for json auto keeps dotted keys and nests one joined child alias', () => {
  const db = database()
  const jsonColumn = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'
  run(db, `
    CREATE TABLE json_parents (id INT, name NVARCHAR(20));
    CREATE TABLE json_children (parent_id INT, value NVARCHAR(20));
    INSERT INTO json_parents VALUES (1, 'one'), (2, 'two');
    INSERT INTO json_children VALUES (1, 'a'), (1, 'b');
  `)
  const single = all(db, `
    SELECT p.id, p.name AS [info.name]
    FROM json_parents p ORDER BY p.id FOR JSON AUTO
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(single[0]?.[jsonColumn]))).toEqual([
    { id: 1, 'info.name': 'one' }, { id: 2, 'info.name': 'two' }
  ])

  const joined = all(db, `
    SELECT p.id, p.name, c.value
    FROM json_parents p LEFT JOIN json_children c ON c.parent_id = p.id
    ORDER BY p.id, c.value FOR JSON AUTO
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(joined[0]?.[jsonColumn]))).toEqual([
    { id: 1, name: 'one', c: [ { value: 'a' }, { value: 'b' } ] },
    { id: 2, name: 'two' }
  ])

  const nested = all(db, `
    SELECT p.id,
      (SELECT c.value FROM json_children c WHERE c.parent_id = p.id
       ORDER BY c.value FOR JSON PATH) AS children
    FROM json_parents p ORDER BY p.id FOR JSON PATH
  `) as Record<string, unknown>[]
  expect(JSON.parse(String(nested[0]?.[jsonColumn]))).toEqual([
    { id: 1, children: [ { value: 'a' }, { value: 'b' } ] },
    { id: 2, children: [] }
  ])
})

test('window functions execute', () => {
  const db = database()
  run(db, `
    CREATE TABLE t (grp NVARCHAR(5), v INT);
    INSERT INTO t VALUES ('a', 1), ('a', 2), ('b', 3);
  `)
  expect(all(db, 'SELECT grp, v, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY v DESC) AS rn FROM t ORDER BY grp, rn')).toEqual([
    { grp: 'a', v: 2, rn: 1 },
    { grp: 'a', v: 1, rn: 2 },
    { grp: 'b', v: 3, rn: 1 }
  ])
})

test('date functions execute', () => {
  const db = database()
  expect(all(db, 'SELECT YEAR(\'2026-07-01\') AS y, MONTH(\'2026-07-01\') AS m, DAY(\'2026-07-01\') AS d')).toEqual([
    { y: 2026, m: 7, d: 1 }
  ])
  expect(all(db, 'SELECT EOMONTH(\'2026-02-10\') AS e')).toEqual([ { e: '2026-02-28' } ])
  expect(all(db, 'SELECT DATEFROMPARTS(2026, 7, 1) AS d')).toEqual([ { d: '2026-07-01' } ])
})

test('string functions execute', () => {
  const db = database()
  expect(all(db, 'SELECT LEN(\'abc \') AS l, UPPER(\'a\') AS u, SUBSTRING(\'hello\', 2, 3) AS s')).toEqual([
    { l: 3, u: 'A', s: 'ell' }
  ])
  expect(all(db, 'SELECT CHARINDEX(\'l\', \'hello\') AS i, LEFT(\'hello\', 2) AS lf')).toEqual([
    { i: 3, lf: 'he' }
  ])
  expect(all(db, 'SELECT ISNULL(NULL, \'x\') AS a, COALESCE(NULL, 1) AS b, IIF(1 > 0, \'y\', \'n\') AS c')).toEqual([
    { a: 'x', b: 1, c: 'y' }
  ])
  expect(all(db, 'SELECT \'a\' + \'b\' AS ab, 1 + 2 AS n')).toEqual([ { ab: 'ab', n: 3 } ])
})

test('update from and offset fetch execute', () => {
  const db = database()
  run(db, `
    CREATE TABLE t (id INT PRIMARY KEY, v INT);
    INSERT INTO t VALUES (1, 10), (2, 20), (3, 30);
    UPDATE t SET v = v * 2 WHERE id > 1;
  `)
  expect(all(db, 'SELECT v FROM t ORDER BY id OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY')).toEqual([
    { v: 40 }, { v: 60 }
  ])
})

test('top percent and with ties execute', () => {
  const db = database()
  run(db, `
    CREATE TABLE scores (name NVARCHAR(10), score INT);
    INSERT INTO scores VALUES ('a', 90), ('b', 80), ('c', 80), ('d', 70), ('e', 60),
      ('f', 50), ('g', 40), ('h', 30), ('i', 20), ('j', 10);
  `)
  // 25 percent of 10 rows rounds up to 3.
  expect(all(db, 'SELECT TOP 25 PERCENT name FROM scores ORDER BY score DESC')).toEqual([
    { name: 'a' }, { name: 'b' }, { name: 'c' }
  ])
  // TOP 2 WITH TIES includes the second 80.
  expect(all(db, 'SELECT TOP 2 WITH TIES name, score FROM scores ORDER BY score DESC')).toEqual([
    { name: 'a', score: 90 }, { name: 'b', score: 80 }, { name: 'c', score: 80 }
  ])
  // Ties over an aliased order key.
  expect(all(db, 'SELECT TOP 2 WITH TIES score AS s FROM scores ORDER BY s DESC')).toEqual([
    { s: 90 }, { s: 80 }, { s: 80 }
  ])
})

test('update top and delete top execute', () => {
  const db = database()
  run(db, `
    CREATE TABLE t (id INT PRIMARY KEY, done INT);
    INSERT INTO t VALUES (1, 0), (2, 0), (3, 0), (4, 1);
  `)
  run(db, 'UPDATE TOP (2) t SET done = 1 WHERE done = 0')
  expect(all(db, 'SELECT COUNT(*) AS n FROM t WHERE done = 1')).toEqual([ { n: 3 } ])
  run(db, 'DELETE TOP (2) FROM t WHERE done = 1')
  expect(all(db, 'SELECT COUNT(*) AS n FROM t WHERE done = 1')).toEqual([ { n: 1 } ])
})

test('delete with a join executes against the aliased target', () => {
  const db = database()
  run(db, `
    CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT);
    CREATE TABLE customers (id INT PRIMARY KEY, closed INT);
    INSERT INTO customers VALUES (1, 1), (2, 0);
    INSERT INTO orders VALUES (10, 1), (11, 1), (12, 2);
  `)
  run(db, 'DELETE o FROM orders AS o JOIN customers c ON o.customer_id = c.id WHERE c.closed = 1')
  expect(all(db, 'SELECT id FROM orders ORDER BY id')).toEqual([ { id: 12 } ])
})

test('output renders as returning and executes', () => {
  const db = database()
  run(db, 'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50))')
  expect(all(db, 'INSERT INTO t (name) OUTPUT inserted.id, inserted.name VALUES (\'a\'), (\'b\')')).toEqual([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' }
  ])
  expect(all(db, 'INSERT INTO t (name) OUTPUT inserted.* SELECT name FROM t WHERE id = 1')).toEqual([
    { id: 3, name: 'a' }
  ])
  expect(all(db, 'UPDATE t SET name = \'z\' OUTPUT inserted.name AS renamed WHERE id = 2')).toEqual([
    { renamed: 'z' }
  ])
  expect(all(db, 'DELETE FROM t OUTPUT deleted.* WHERE id = 1')).toEqual([
    { id: 1, name: 'a' }
  ])
  expect(all(db, 'DELETE TOP (2) FROM t OUTPUT deleted.id')).toEqual([
    { id: 2 }, { id: 3 }
  ])
})

test('output validates pseudo-table references', () => {
  expect(() => statement(parseStatement('INSERT INTO t (a) OUTPUT deleted.a VALUES (1)')))
    .toThrow(/DELETED pseudo-table cannot be referenced .* INSERT/)
  expect(() => statement(parseStatement('DELETE FROM t OUTPUT inserted.a')))
    .toThrow(/INSERTED pseudo-table cannot be referenced .* DELETE/)
  expect(() => statement(parseStatement('INSERT INTO t (a) OUTPUT a VALUES (1)')))
    .toThrow(/must be qualified/)
  expect(() => statement(parseStatement('INSERT INTO t (a) OUTPUT deleted.* VALUES (1)')))
    .toThrow(/DELETED pseudo-table cannot be referenced .* INSERT/)
  // Pre-update values need the engine's snapshot — no direct rendering.
  expect(() => statement(parseStatement('UPDATE t SET a = 1 OUTPUT deleted.a')))
    .toThrow(/no direct SQLite rendering/)
})
