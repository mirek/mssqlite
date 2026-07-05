import { expect, test } from 'vitest'
import { parse, parseExpression, parseStatement, ParseError } from './parse.ts'

test('select literal with alias', () => {
  expect(parseStatement('SELECT \'foo\' AS bar')).toEqual({
    kind: 'select',
    distinct: false,
    items: [ {
      kind: 'expression',
      expression: { kind: 'string', value: 'foo', national: false },
      alias: 'bar'
    } ]
  })
})

test('select with from, where, order by', () => {
  const statement = parseStatement(`
    SELECT TOP 10 u.id, u.name AS n, COUNT(*)
    FROM dbo.users u WITH (NOLOCK)
    WHERE u.age >= 18 AND u.name LIKE N'a%'
    GROUP BY u.id, u.name
    HAVING COUNT(*) > 1
    ORDER BY u.name DESC
  `)
  expect(statement).toMatchObject({
    kind: 'select',
    top: { count: { kind: 'number', value: '10' }, percent: false },
    items: [
      { kind: 'expression', expression: { kind: 'column', name: [ 'u', 'id' ] } },
      { kind: 'expression', alias: 'n' },
      { kind: 'expression', expression: { kind: 'call', name: [ 'COUNT' ], star: true } }
    ],
    from: { kind: 'table', name: [ 'dbo', 'users' ], alias: 'u', hints: [ 'NOLOCK' ] },
    where: { kind: 'binaryOp', operator: 'and' },
    groupBy: [ {}, {} ],
    having: { kind: 'binaryOp', operator: '>' },
    orderBy: [ { descending: true } ]
  })
})

test('top percent and with ties parse', () => {
  expect(parseStatement('SELECT TOP 10 PERCENT * FROM t')).toMatchObject({
    kind: 'select',
    top: { count: { kind: 'number', value: '10' }, percent: true }
  })
  expect(parseStatement('SELECT TOP (10) PERCENT WITH TIES * FROM t ORDER BY x')).toMatchObject({
    kind: 'select',
    top: { count: { kind: 'number', value: '10' }, percent: true, withTies: true }
  })
  expect(parseStatement('UPDATE TOP (2) t SET a = 1')).toMatchObject({
    kind: 'update',
    top: { kind: 'number', value: '2' }
  })
  expect(parseStatement('DELETE TOP (2) FROM t')).toMatchObject({
    kind: 'delete',
    top: { kind: 'number', value: '2' }
  })
})

test('joins are left-associative', () => {
  const statement = parseStatement(
    'SELECT * FROM a JOIN b ON a.id = b.a_id LEFT OUTER JOIN c ON b.id = c.b_id'
  )
  expect(statement).toMatchObject({
    from: {
      kind: 'join',
      join: 'left',
      left: { kind: 'join', join: 'inner', left: { kind: 'table', name: [ 'a' ] } },
      right: { kind: 'table', name: [ 'c' ] }
    }
  })
})

test('derived tables and subqueries', () => {
  expect(parseStatement('SELECT x.n FROM (SELECT 1 AS n) x')).toMatchObject({
    from: { kind: 'derived', alias: 'x', select: { kind: 'select' } }
  })
  expect(parseExpression('(SELECT MAX(id) FROM t)')).toMatchObject({
    kind: 'subquery'
  })
  expect(parseExpression('EXISTS (SELECT 1 FROM t)')).toMatchObject({ kind: 'exists' })
})

test('union all with order by applies to whole', () => {
  const statement = parseStatement('SELECT 1 AS n UNION ALL SELECT 2 ORDER BY n')
  expect(statement).toMatchObject({
    kind: 'select',
    union: { kind: 'unionAll', select: { kind: 'select' } },
    orderBy: [ {} ]
  })
})

test('offset fetch', () => {
  expect(parseStatement('SELECT * FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY')).toMatchObject({
    offset: { kind: 'number', value: '10' },
    fetch: { kind: 'number', value: '5' }
  })
})

test('ctes', () => {
  expect(parseStatement('WITH a AS (SELECT 1 AS x), b (y) AS (SELECT 2) SELECT * FROM a, b')).toMatchObject({
    ctes: [ { name: 'a' }, { name: 'b', columns: [ 'y' ] } ]
  })
})

test('comma-separated from is a cross join', () => {
  // T-SQL `FROM a, b` — parsed via first table source only; comma joins handled here.
  const statement = parseStatement('SELECT * FROM a, b WHERE a.id = b.id')
  expect(statement).toMatchObject({
    from: { kind: 'join', join: 'cross' }
  })
})

test('operator precedence', () => {
  expect(parseExpression('1 + 2 * 3')).toMatchObject({
    kind: 'binaryOp',
    operator: '+',
    right: { kind: 'binaryOp', operator: '*' }
  })
  expect(parseExpression('NOT a = 1 AND b = 2 OR c = 3')).toMatchObject({
    kind: 'binaryOp',
    operator: 'or',
    left: {
      kind: 'binaryOp',
      operator: 'and',
      left: { kind: 'unary', operator: 'not' }
    }
  })
})

test('predicates', () => {
  expect(parseExpression('x IS NOT NULL')).toMatchObject({ kind: 'isNull', negated: true })
  expect(parseExpression('name NOT LIKE \'a%\' ESCAPE \'\\\'')).toMatchObject({
    kind: 'like',
    negated: true,
    escape: { kind: 'string' }
  })
  expect(parseExpression('x IN (1, 2, 3)')).toMatchObject({
    kind: 'in',
    values: [ {}, {}, {} ]
  })
  expect(parseExpression('x NOT IN (SELECT id FROM t)')).toMatchObject({
    kind: 'in',
    negated: true,
    values: { kind: 'select' }
  })
  expect(parseExpression('x BETWEEN 1 AND 10 AND y = 2')).toMatchObject({
    kind: 'binaryOp',
    operator: 'and',
    left: { kind: 'between' }
  })
})

test('case expressions', () => {
  expect(parseExpression('CASE WHEN x = 1 THEN \'one\' ELSE \'many\' END')).toMatchObject({
    kind: 'case',
    whens: [ { when: { kind: 'binaryOp' } } ],
    else_: { kind: 'string' }
  })
  expect(parseExpression('CASE x WHEN 1 THEN \'one\' END')).toMatchObject({
    kind: 'case',
    operand: { kind: 'column' }
  })
})

test('cast and convert', () => {
  expect(parseExpression('CAST(x AS nvarchar(50))')).toMatchObject({
    kind: 'cast',
    type: { name: 'nvarchar', args: [ 50 ] },
    try_: false
  })
  expect(parseExpression('TRY_CAST(x AS int)')).toMatchObject({ kind: 'cast', try_: true })
  expect(parseExpression('CONVERT(varchar(10), GETDATE(), 120)')).toMatchObject({
    kind: 'convert',
    type: { name: 'varchar', args: [ 10 ] },
    style: { kind: 'number', value: '120' }
  })
  expect(parseExpression('CAST(x AS varchar(max))')).toMatchObject({
    type: { name: 'varchar', args: [ 'max' ] }
  })
})

test('functions', () => {
  expect(parseExpression('COUNT(DISTINCT name)')).toMatchObject({
    kind: 'call',
    distinct: true
  })
  expect(parseExpression('GETDATE()')).toMatchObject({ kind: 'call', args: [] })
  expect(parseExpression('CURRENT_TIMESTAMP')).toMatchObject({ kind: 'call', name: [ 'CURRENT_TIMESTAMP' ] })
  expect(parseExpression('ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC)')).toMatchObject({
    kind: 'call',
    over: {
      partitionBy: [ {} ],
      orderBy: [ { descending: true } ]
    }
  })
})

test('variables and globals', () => {
  expect(parseExpression('@x + @@ROWCOUNT')).toMatchObject({
    kind: 'binaryOp',
    left: { kind: 'variable', name: '@x' },
    right: { kind: 'variable', name: '@@ROWCOUNT' }
  })
})

test('insert forms', () => {
  expect(parseStatement('INSERT INTO t (a, b) VALUES (1, \'x\'), (2, \'y\')')).toMatchObject({
    kind: 'insert',
    table: [ 't' ],
    columns: [ 'a', 'b' ],
    source: { kind: 'values', rows: [ [ {}, {} ], [ {}, {} ] ] }
  })
  expect(parseStatement('INSERT t DEFAULT VALUES')).toMatchObject({
    source: { kind: 'defaultValues' }
  })
  expect(parseStatement('INSERT INTO t SELECT * FROM s')).toMatchObject({
    source: { kind: 'select' }
  })
})

test('update and delete', () => {
  expect(parseStatement('UPDATE t SET a = 1, b += 2 WHERE id = 3')).toMatchObject({
    kind: 'update',
    target: [ 't' ],
    set: [
      { target: { kind: 'column' }, operator: '=' },
      { target: { kind: 'column' }, operator: '+=' }
    ],
    where: {}
  })
  expect(parseStatement('DELETE FROM t WHERE id = 1')).toMatchObject({
    kind: 'delete',
    target: [ 't' ]
  })
  expect(parseStatement('TRUNCATE TABLE t')).toMatchObject({ kind: 'truncate' })
})

test('create table with constraints', () => {
  const statement = parseStatement(`
    CREATE TABLE dbo.users (
      id INT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
      name NVARCHAR(100) NOT NULL,
      email NVARCHAR(255) NULL UNIQUE,
      age INT CHECK (age >= 0),
      team_id INT REFERENCES teams (id) ON DELETE CASCADE,
      created DATETIME2 DEFAULT SYSDATETIME(),
      CONSTRAINT uq_users_name UNIQUE (name),
      FOREIGN KEY (team_id) REFERENCES teams (id)
    )
  `)
  expect(statement).toMatchObject({
    kind: 'createTable',
    name: [ 'dbo', 'users' ],
    columns: [
      {
        name: 'id',
        type: { name: 'int' },
        identity: { seed: 1, increment: 1 },
        nullable: false,
        primaryKey: true
      },
      { name: 'name', nullable: false },
      { name: 'email', nullable: true, unique: true },
      { name: 'age', check: {} },
      { name: 'team_id', references: { table: [ 'teams' ], columns: [ 'id' ], onDelete: 'cascade' } },
      { name: 'created', default_: { kind: 'call' } }
    ],
    constraints: [
      { kind: 'unique', name: 'uq_users_name' },
      { kind: 'foreignKey', columns: [ 'team_id' ] }
    ]
  })
})

test('composite primary key constraint', () => {
  expect(parseStatement('CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b DESC))')).toMatchObject({
    constraints: [ {
      kind: 'primaryKey',
      columns: [ { name: 'a', descending: false }, { name: 'b', descending: true } ]
    } ]
  })
})

test('drop / create index / views / alter table', () => {
  expect(parseStatement('DROP TABLE IF EXISTS a, dbo.b')).toMatchObject({
    kind: 'dropTable',
    ifExists: true,
    names: [ [ 'a' ], [ 'dbo', 'b' ] ]
  })
  expect(parseStatement('CREATE UNIQUE INDEX ix ON t (a, b DESC) WHERE a > 0')).toMatchObject({
    kind: 'createIndex',
    unique: true,
    columns: [ { name: 'a' }, { name: 'b', descending: true } ],
    where: {}
  })
  expect(parseStatement('DROP INDEX ix ON t')).toMatchObject({ kind: 'dropIndex', name: 'ix', table: [ 't' ] })
  expect(parseStatement('CREATE VIEW v (a) AS SELECT 1')).toMatchObject({
    kind: 'createView',
    columns: [ 'a' ]
  })
  expect(parseStatement('ALTER TABLE t ADD c INT NULL')).toMatchObject({
    kind: 'alterTable',
    action: { kind: 'addColumns', columns: [ { name: 'c' } ] }
  })
  expect(parseStatement('ALTER TABLE t DROP COLUMN c, d')).toMatchObject({
    action: { kind: 'dropColumns', columns: [ 'c', 'd' ] }
  })
})

test('declare and set', () => {
  expect(parseStatement('DECLARE @x INT = 1, @s NVARCHAR(50)')).toMatchObject({
    kind: 'declare',
    declarations: [
      { name: '@x', type: { name: 'int' }, initial: {} },
      { name: '@s', type: { name: 'nvarchar', args: [ 50 ] } }
    ]
  })
  expect(parseStatement('SET @x = @x + 1')).toMatchObject({
    kind: 'setVariable',
    name: '@x',
    operator: '='
  })
  expect(parseStatement('SET NOCOUNT ON')).toMatchObject({
    kind: 'setOption',
    options: [ 'nocount' ],
    value: 'on'
  })
  expect(parseStatement('SET ANSI_NULLS, ANSI_WARNINGS ON')).toMatchObject({
    options: [ 'ansi_nulls', 'ansi_warnings' ]
  })
  expect(parseStatement('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toMatchObject({
    options: [ 'transaction isolation level' ],
    value: 'read committed'
  })
})

test('control flow', () => {
  expect(parseStatement('IF @x > 0 SELECT \'pos\' ELSE SELECT \'neg\'')).toMatchObject({
    kind: 'if',
    then: { kind: 'select' },
    else_: { kind: 'select' }
  })
  expect(parseStatement('WHILE @i < 10 BEGIN SET @i = @i + 1; END')).toMatchObject({
    kind: 'while',
    body: { kind: 'block', statements: [ { kind: 'setVariable' } ] }
  })
})

test('transactions', () => {
  expect(parseStatement('BEGIN TRANSACTION')).toMatchObject({ kind: 'beginTransaction' })
  expect(parseStatement('BEGIN TRAN t1')).toMatchObject({ kind: 'beginTransaction', name: 't1' })
  expect(parseStatement('COMMIT')).toMatchObject({ kind: 'commitTransaction' })
  expect(parseStatement('ROLLBACK TRAN')).toMatchObject({ kind: 'rollbackTransaction' })
  expect(parseStatement('SAVE TRAN sp1')).toMatchObject({ kind: 'saveTransaction', name: 'sp1' })
})

test('exec, use, print, return, throw', () => {
  expect(parseStatement('EXEC sp_executesql N\'SELECT 1\', N\'@p int\', @p = 5')).toMatchObject({
    kind: 'execute',
    procedure: [ 'sp_executesql' ],
    args: [
      { value: { kind: 'string' }, output: false },
      { value: { kind: 'string' }, output: false },
      { name: '@p', value: { kind: 'number' }, output: false }
    ]
  })
  expect(parseStatement('USE master')).toMatchObject({ kind: 'use', database: 'master' })
  expect(parseStatement('PRINT \'hello\'')).toMatchObject({ kind: 'print' })
  expect(parseStatement('RETURN 0')).toMatchObject({ kind: 'return', expression: {} })
  expect(parseStatement('THROW 50000, \'err\', 1')).toMatchObject({ kind: 'throw' })
})

test('variable assignment in select', () => {
  expect(parseStatement('SELECT @x = MAX(id) FROM t')).toMatchObject({
    items: [ { kind: 'assign', variable: '@x', operator: '=' } ]
  })
})

test('batches split on semicolons', () => {
  const statements = parse(`
    SET NOCOUNT ON;
    DECLARE @x INT = 1;
    SELECT @x;
  `)
  expect(statements.map(statement => statement.kind)).toEqual([
    'setOption', 'declare', 'select'
  ])
})

test('multiple statements without semicolons', () => {
  const statements = parse('DECLARE @x INT SET @x = 1 SELECT @x AS x')
  expect(statements.map(statement => statement.kind)).toEqual([
    'declare', 'setVariable', 'select'
  ])
})

test('sys catalog queries parse', () => {
  expect(parseStatement(`
    SELECT t.name, s.name AS schema_name, c.name AS column_name
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.columns c ON c.object_id = t.object_id
    WHERE t.is_ms_shipped = 0
    ORDER BY t.name, c.column_id
  `)).toMatchObject({ kind: 'select' })
})

test('parse errors carry offsets', () => {
  expect(() => parse('SELECT FROM')).toThrow(ParseError)
  expect(() => parse('CREATE TABLE t (')).toThrow(ParseError)
  expect(() => parse('%%%')).toThrow()
})
