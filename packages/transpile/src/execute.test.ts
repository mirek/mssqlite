import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parse, parseStatement } from '@mssqlite/tsql'
import { statement } from './index.ts'

/** Executes transpiled T-SQL against a real SQLite database. */
const database =
  (): DatabaseSync =>
    new DatabaseSync(':memory:')

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
