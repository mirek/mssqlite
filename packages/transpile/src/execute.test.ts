import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parse, parseStatement } from '@mssqlite/tsql'
import { statement } from './index.ts'

/** Executes transpiled T-SQL against a real SQLite database. */
const database =
  (): DatabaseSync =>
    new DatabaseSync(':memory:')

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
