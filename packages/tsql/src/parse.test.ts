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
    groupBy: [
      { kind: 'expressions', expressions: [ {} ] },
      { kind: 'expressions', expressions: [ {} ] }
    ],
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

test('output clause parses on insert, update and delete', () => {
  expect(parseStatement('INSERT INTO t (a) OUTPUT inserted.id, inserted.a AS added VALUES (1)')).toMatchObject({
    kind: 'insert',
    output: {
      items: [
        { kind: 'expression', expression: { kind: 'column', name: [ 'inserted', 'id' ] } },
        { kind: 'expression', expression: { kind: 'column', name: [ 'inserted', 'a' ] }, alias: 'added' }
      ]
    },
    source: { kind: 'values' }
  })
  expect(parseStatement('DELETE FROM t OUTPUT deleted.* WHERE id = 1')).toMatchObject({
    kind: 'delete',
    output: { items: [ { kind: 'star', qualifier: [ 'deleted' ] } ] },
    where: { kind: 'binaryOp', operator: '=' }
  })
  expect(parseStatement(
    'UPDATE t SET a = 1 OUTPUT deleted.a, inserted.a INTO log (old_a, new_a) WHERE id = 1'
  )).toMatchObject({
    kind: 'update',
    output: {
      items: [
        { kind: 'expression', expression: { kind: 'column', name: [ 'deleted', 'a' ] } },
        { kind: 'expression', expression: { kind: 'column', name: [ 'inserted', 'a' ] } }
      ],
      into: { table: [ 'log' ], columns: [ 'old_a', 'new_a' ] }
    }
  })
})

test('try/catch and raiserror parse', () => {
  expect(parseStatement(`
    BEGIN TRY
      INSERT INTO t VALUES (1);
      SELECT 1
    END TRY
    BEGIN CATCH
      SELECT ERROR_NUMBER() AS n
    END CATCH
  `)).toMatchObject({
    kind: 'tryCatch',
    try_: [ { kind: 'insert' }, { kind: 'select' } ],
    catch_: [ { kind: 'select' } ]
  })
  expect(parseStatement('RAISERROR (\'oops %s\', 16, 1, \'x\') WITH NOWAIT')).toMatchObject({
    kind: 'raiserror',
    args: [ { kind: 'string', value: 'oops %s' }, {}, {}, {} ],
    options: [ 'nowait' ]
  })
  expect(parseStatement('THROW')).toMatchObject({ kind: 'throw' })
})

test('create, alter and drop procedure parse', () => {
  expect(parseStatement(`
    CREATE PROCEDURE dbo.p @a INT, @b NVARCHAR(50) = N'x', @c INT OUTPUT AS
    BEGIN
      SET @c = @a
    END
  `)).toMatchObject({
    kind: 'createProcedure',
    name: [ 'dbo', 'p' ],
    action: 'create',
    parameters: [
      { name: '@a', output: false },
      { name: '@b', default_: { kind: 'string', value: 'x' }, output: false },
      { name: '@c', output: true }
    ],
    body: [ { kind: 'block' } ],
    definition: expect.stringContaining('CREATE PROCEDURE') as unknown
  })
  expect(parseStatement('CREATE OR ALTER PROC p AS SELECT 1')).toMatchObject({
    kind: 'createProcedure',
    action: 'createOrAlter'
  })
  expect(parseStatement('ALTER PROCEDURE p AS SELECT 2')).toMatchObject({
    kind: 'createProcedure',
    action: 'alter'
  })
  expect(parseStatement('DROP PROCEDURE IF EXISTS p, q')).toMatchObject({
    kind: 'dropProcedure',
    ifExists: true,
    names: [ [ 'p' ], [ 'q' ] ]
  })
})

test('scalar and inline table functions parse', () => {
  expect(parseStatement(`
    CREATE FUNCTION dbo.add_tax(@amount DECIMAL(10,2), @rate INT = 20)
    RETURNS DECIMAL(10,2) AS
    BEGIN
      DECLARE @result DECIMAL(10,2) = @amount + @amount * @rate / 100
      RETURN @result
    END
  `)).toMatchObject({
    kind: 'createFunction',
    action: 'create',
    name: [ 'dbo', 'add_tax' ],
    parameters: [
      { name: '@amount', type: { name: 'decimal', args: [ 10, 2 ] } },
      { name: '@rate', default_: { kind: 'number', value: '20' } }
    ],
    returns: {
      kind: 'scalar',
      type: { name: 'decimal', args: [ 10, 2 ] },
      body: [ { kind: 'declare' }, { kind: 'return' } ]
    }
  })
  expect(parseStatement(`
    CREATE OR ALTER FUNCTION dbo.orders_for(@customer INT)
    RETURNS TABLE AS RETURN (
      SELECT id, amount FROM orders WHERE customer_id = @customer
    )
  `)).toMatchObject({
    kind: 'createFunction',
    action: 'createOrAlter',
    parameters: [ { name: '@customer', type: { name: 'int' } } ],
    returns: { kind: 'table', select: { kind: 'select' } }
  })
  expect(parseStatement('DROP FUNCTION IF EXISTS dbo.add_tax')).toMatchObject({
    kind: 'dropFunction',
    ifExists: true,
    names: [ [ 'dbo', 'add_tax' ] ]
  })
  expect(() => parseStatement(
    'CREATE FUNCTION f() RETURNS INT AS RETURN 1')).toThrow()
})

test('create, alter and drop DML triggers parse', () => {
  expect(parseStatement(`
    CREATE OR ALTER TRIGGER dbo.audit_orders ON dbo.orders
    WITH EXECUTE AS OWNER
    AFTER INSERT, UPDATE WITH APPEND NOT FOR REPLICATION AS
    BEGIN
      INSERT INTO audit (id) SELECT id FROM inserted
    END
  `)).toMatchObject({
    kind: 'createTrigger',
    action: 'createOrAlter',
    name: [ 'dbo', 'audit_orders' ],
    target: [ 'dbo', 'orders' ],
    timing: 'after',
    events: [ 'insert', 'update' ],
    options: [ 'execute as owner', 'append', 'not for replication' ],
    body: [ { kind: 'block' } ],
    definition: expect.stringContaining('CREATE OR ALTER TRIGGER') as unknown
  })
  expect(parseStatement('ALTER TRIGGER t ON dbo.orders INSTEAD OF DELETE AS SELECT * FROM deleted'))
    .toMatchObject({ kind: 'createTrigger', action: 'alter', timing: 'insteadOf', events: [ 'delete' ] })
  expect(parseStatement('DROP TRIGGER IF EXISTS dbo.t, dbo.u')).toMatchObject({
    kind: 'dropTrigger',
    ifExists: true,
    names: [ [ 'dbo', 't' ], [ 'dbo', 'u' ] ]
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

test('computed columns retain expression, persistence and nullability', () => {
  expect(parseStatement(`
    CREATE TABLE totals (
      quantity INT,
      price DECIMAL(10,2),
      total AS quantity * price PERSISTED NOT NULL,
      doubled AS (quantity * 2)
    )
  `)).toMatchObject({
    kind: 'createTable',
    columns: [
      { name: 'quantity' },
      { name: 'price' },
      {
        name: 'total', nullable: false,
        computed: { expression: { kind: 'binaryOp', operator: '*' }, persisted: true }
      },
      { name: 'doubled', computed: { persisted: false } }
    ]
  })
})

test('column and expression collations are retained', () => {
  expect(parseStatement(`
    CREATE TABLE names (value NVARCHAR(20) COLLATE Latin1_General_100_CS_AI)
  `)).toMatchObject({
    kind: 'createTable',
    columns: [ { name: 'value', collate: 'Latin1_General_100_CS_AI' } ]
  })
  expect(parseExpression('value COLLATE Latin1_General_100_CI_AI = N\'cafe\'')).toMatchObject({
    kind: 'binaryOp',
    left: { kind: 'collate', collation: 'Latin1_General_100_CI_AI' }
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

test('database lifecycle DDL', () => {
  expect(parseStatement('CREATE DATABASE sales')).toEqual({
    kind: 'createDatabase', name: 'sales'
  })
  expect(parseStatement('ALTER DATABASE sales MODIFY NAME = archive')).toEqual({
    kind: 'alterDatabase', name: 'sales', action: { kind: 'rename', name: 'archive' }
  })
  expect(parseStatement('ALTER DATABASE archive SET READ_ONLY')).toEqual({
    kind: 'alterDatabase', name: 'archive', action: { kind: 'setAccess', readOnly: true }
  })
  expect(parseStatement('ALTER DATABASE archive SET READ_WRITE')).toEqual({
    kind: 'alterDatabase', name: 'archive', action: { kind: 'setAccess', readOnly: false }
  })
  expect(parseStatement('DROP DATABASE IF EXISTS archive')).toEqual({
    kind: 'dropDatabase', name: 'archive', ifExists: true
  })
})

test('sequence DDL and NEXT VALUE FOR parse', () => {
  expect(parseStatement(`
    CREATE SEQUENCE dbo.order_ids AS INT
      START WITH 10 INCREMENT BY 5 MINVALUE 10 MAXVALUE 100
      CYCLE CACHE 8
  `)).toMatchObject({
    kind: 'createSequence',
    name: [ 'dbo', 'order_ids' ],
    dataType: { name: 'int' },
    options: [
      { kind: 'start', value: '10' },
      { kind: 'increment', value: '5' },
      { kind: 'min', value: '10' },
      { kind: 'max', value: '100' },
      { kind: 'cycle', enabled: true },
      { kind: 'cache', enabled: true, size: '8' }
    ]
  })
  expect(parseStatement(`
    ALTER SEQUENCE order_ids RESTART WITH -5 INCREMENT BY -2
      NO MINVALUE NO MAXVALUE NO CYCLE NO CACHE
  `)).toMatchObject({
    kind: 'alterSequence',
    options: [
      { kind: 'restart', value: '-5' },
      { kind: 'increment', value: '-2' },
      { kind: 'min' }, { kind: 'max' },
      { kind: 'cycle', enabled: false },
      { kind: 'cache', enabled: false }
    ]
  })
  expect(parseStatement('DROP SEQUENCE IF EXISTS dbo.order_ids, other')).toMatchObject({
    kind: 'dropSequence', ifExists: true
  })
  expect(parseExpression('NEXT VALUE FOR dbo.order_ids')).toEqual({
    kind: 'nextValue', sequence: [ 'dbo', 'order_ids' ]
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

test('cursor lifecycle and fetch orientations parse', () => {
  expect(parseStatement(`
    DECLARE items LOCAL SCROLL CURSOR STATIC READ_ONLY FOR
      SELECT id, name FROM products ORDER BY id
      FOR UPDATE OF name
  `)).toMatchObject({
    kind: 'declareCursor',
    name: 'items',
    scope: 'local',
    options: [ 'scroll', 'static', 'read_only' ],
    select: { kind: 'select' },
    updateColumns: [ 'name' ]
  })
  expect(parseStatement('OPEN CURSOR GLOBAL items')).toEqual({ kind: 'openCursor', name: 'items' })
  expect(parseStatement('FETCH FROM items')).toMatchObject({
    kind: 'fetchCursor',
    orientation: { kind: 'next' },
    into: []
  })
  expect(parseStatement('FETCH ABSOLUTE -2 FROM items INTO @id, @name')).toMatchObject({
    kind: 'fetchCursor',
    orientation: { kind: 'absolute', offset: { kind: 'unary', operator: '-' } },
    into: [ '@id', '@name' ]
  })
  expect(parseStatement('FETCH RELATIVE 3 FROM items')).toMatchObject({
    orientation: { kind: 'relative' }
  })
  expect(parseStatement('FETCH NEXT FROM GLOBAL items')).toMatchObject({ name: 'items' })
  expect(parseStatement('CLOSE items')).toEqual({ kind: 'closeCursor', name: 'items' })
  expect(parseStatement('DEALLOCATE CURSOR items')).toEqual({ kind: 'deallocateCursor', name: 'items' })
})

test('table variable declarations and DML references', () => {
  expect(parseStatement(`
    DECLARE @items TABLE (
      id INT IDENTITY(1,1) PRIMARY KEY,
      name NVARCHAR(50) NOT NULL,
      qty INT DEFAULT 1,
      UNIQUE (name),
      CHECK (qty >= 0)
    )
  `)).toMatchObject({
    kind: 'declare',
    declarations: [ {
      kind: 'table',
      name: '@items',
      columns: [
        { name: 'id', identity: { seed: 1, increment: 1 }, primaryKey: true },
        { name: 'name', type: { name: 'nvarchar', args: [ 50 ] }, nullable: false },
        { name: 'qty', default_: { kind: 'number', value: '1' } }
      ],
      constraints: [ { kind: 'unique' }, { kind: 'check' } ]
    } ]
  })
  const statements = parse(`
    INSERT INTO @items (name) VALUES (N'a')
    UPDATE @items SET qty = 2 WHERE name = N'a'
    DELETE FROM @items WHERE qty = 0
    SELECT * FROM @items AS i
  `)
  expect(statements).toMatchObject([
    { kind: 'insert', table: [ '@items' ] },
    { kind: 'update', target: [ '@items' ] },
    { kind: 'delete', target: [ '@items' ] },
    { kind: 'select', from: { kind: 'table', name: [ '@items' ], alias: 'i' } }
  ])
  expect(() => parseStatement('DECLARE @t TABLE (id INT), @x INT')).toThrow()
})

test('table-valued functions parse as aliased table sources', () => {
  expect(parseStatement(`
    SELECT s.token, s.position
    FROM STRING_SPLIT('a,b', ',', 1) AS s (token, position)
  `)).toMatchObject({
    kind: 'select',
    from: {
      kind: 'function',
      name: [ 'STRING_SPLIT' ],
      args: [ { kind: 'string' }, { kind: 'string' }, { kind: 'number' } ],
      alias: 's',
      columns: [ 'token', 'position' ]
    }
  })
  expect(parseStatement(`
    SELECT j.id, j.details
    FROM OPENJSON(@json, '$.items') WITH (
      id INT '$.itemId',
      details NVARCHAR(MAX) '$.details' AS JSON
    ) j
  `)).toMatchObject({
    from: {
      kind: 'function',
      name: [ 'OPENJSON' ],
      with: [
        { name: 'id', type: { name: 'int' }, path: '$.itemId', asJson: false },
        { name: 'details', type: { name: 'nvarchar', args: [ 'max' ] }, asJson: true }
      ],
      alias: 'j'
    }
  })
  expect(parseStatement('SELECT value FROM GENERATE_SERIES(1, 5, 2)')).toMatchObject({
    from: { kind: 'function', name: [ 'GENERATE_SERIES' ], args: [ {}, {}, {} ] }
  })
  expect(() => parseStatement('SELECT * FROM STRING_SPLIT()')).toThrow()
  expect(() => parseStatement('SELECT * FROM OPENJSON(@j) WITH (id INT id)')).toThrow()
})

test('cross and outer apply preserve lateral join order', () => {
  expect(parseStatement(`
    SELECT t.id, s.value
    FROM tags t
    CROSS APPLY STRING_SPLIT(t.csv, ',', 1) s
    OUTER APPLY (
      SELECT TOP (1) note FROM notes n
      WHERE n.tag_id = t.id ORDER BY n.created_at DESC
    ) latest
  `)).toMatchObject({
    from: {
      kind: 'join',
      join: 'outerApply',
      left: {
        kind: 'join',
        join: 'crossApply',
        left: { kind: 'table', name: [ 'tags' ], alias: 't' },
        right: { kind: 'function', name: [ 'STRING_SPLIT' ], alias: 's' }
      },
      right: {
        kind: 'derived',
        alias: 'latest',
        select: { kind: 'select', top: {}, orderBy: [ {} ] }
      }
    }
  })
  expect(() => parseStatement('SELECT * FROM t CROSS APPLY')).toThrow()
  expect(() => parseStatement('SELECT * FROM t OUTER APPLY f(1) ON 1 = 1')).toThrow()
})

test('pivot and unpivot parse as postfix table transforms', () => {
  expect(parseStatement(`
    SELECT region, [Q1], [Q2]
    FROM (SELECT region, quarter, amount FROM sales) src
    PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2])) [p]
  `)).toMatchObject({
    from: {
      kind: 'pivot',
      alias: 'p',
      source: { kind: 'derived', alias: 'src' },
      aggregate: {
        name: [ 'SUM' ],
        expression: { kind: 'column', name: [ 'amount' ] }
      },
      pivotColumn: [ 'quarter' ],
      values: [ 'Q1', 'Q2' ]
    }
  })
  expect(parseStatement(`
    SELECT id, quarter, amount
    FROM quarterly
    UNPIVOT (amount FOR quarter IN ([Q1], [Q2], [Q3])) u
  `)).toMatchObject({
    from: {
      kind: 'unpivot',
      alias: 'u',
      source: { kind: 'table', name: [ 'quarterly' ] },
      valueColumn: 'amount',
      pivotColumn: 'quarter',
      columns: [ 'Q1', 'Q2', 'Q3' ]
    }
  })
  expect(() => parseStatement('SELECT * FROM t PIVOT (SUM(v) FOR k IN ()) p')).toThrow()
  expect(() => parseStatement('SELECT * FROM t UNPIVOT (v FOR k IN (a))')).toThrow()
})

test('rollup cube and grouping sets preserve grouping units', () => {
  expect(parseStatement(`
    SELECT a, b, SUM(v) FROM t
    GROUP BY a, ROLLUP((b, c), d), GROUPING SETS ((e, f), CUBE(g, h), ())
  `)).toMatchObject({
    groupBy: [
      { kind: 'expressions', expressions: [ { kind: 'column', name: [ 'a' ] } ] },
      {
        kind: 'rollup',
        units: [
          [ { kind: 'column', name: [ 'b' ] }, { kind: 'column', name: [ 'c' ] } ],
          [ { kind: 'column', name: [ 'd' ] } ]
        ]
      },
      {
        kind: 'sets',
        sets: [
          { kind: 'expressions', expressions: [ { kind: 'column' }, { kind: 'column' } ] },
          { kind: 'cube', units: [ [ { kind: 'column' } ], [ { kind: 'column' } ] ] },
          { kind: 'expressions', expressions: [] }
        ]
      }
    ]
  })
  expect(parseStatement('SELECT COUNT(*) FROM t GROUP BY ()')).toMatchObject({
    groupBy: [ { kind: 'expressions', expressions: [] } ]
  })
  expect(() => parseStatement('SELECT a FROM t GROUP BY ROLLUP()')).toThrow()
  expect(() => parseStatement(
    'SELECT a FROM t GROUP BY GROUPING SETS (GROUPING SETS ((a)))')).toThrow()
})

test('for json modes and options parse at the select tail', () => {
  expect(parseStatement(`
    SELECT id, name AS [info.name] FROM users ORDER BY id
    FOR JSON PATH, ROOT('users'), INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
  `)).toMatchObject({
    forJson: {
      mode: 'path',
      root: 'users',
      includeNullValues: true,
      withoutArrayWrapper: true
    }
  })
  expect(parseStatement('SELECT t.id FROM t FOR JSON AUTO')).toMatchObject({
    forJson: {
      mode: 'auto',
      includeNullValues: false,
      withoutArrayWrapper: false
    }
  })
  expect(() => parseStatement('SELECT 1 FOR JSON XML')).toThrow()
  expect(() => parseStatement('SELECT 1 FOR JSON PATH, ROOT(1)')).toThrow()
  expect(() => parseStatement(
    'SELECT 1 FOR JSON PATH, INCLUDE_NULL_VALUES, INCLUDE_NULL_VALUES')).toThrow()
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

test('merge with matched and not matched arms', () => {
  expect(parseStatement(`
    MERGE INTO dbo.target AS t
    USING dbo.source AS s
    ON t.id = s.id
    WHEN MATCHED AND s.qty = 0 THEN DELETE
    WHEN MATCHED THEN UPDATE SET t.qty = s.qty, name = s.name
    WHEN NOT MATCHED BY TARGET THEN INSERT (id, qty) VALUES (s.id, s.qty)
    WHEN NOT MATCHED BY SOURCE THEN DELETE
  `)).toMatchObject({
    kind: 'merge',
    target: [ 'dbo', 'target' ],
    alias: 't',
    source: { kind: 'table', name: [ 'dbo', 'source' ], alias: 's' },
    on: { kind: 'binaryOp', operator: '=' },
    whens: [
      { match: 'matched', condition: { kind: 'binaryOp' }, action: { kind: 'delete' } },
      { match: 'matched', action: { kind: 'update', set: [ {}, {} ] } },
      { match: 'notMatchedByTarget', action: { kind: 'insert', columns: [ 'id', 'qty' ], values: [ {}, {} ] } },
      { match: 'notMatchedBySource', action: { kind: 'delete' } }
    ]
  })
})

test('merge using values desugars to an aliased union chain', () => {
  const statement = parseStatement(`
    MERGE t WITH (HOLDLOCK)
    USING (VALUES (1, N'a'), (2, N'b')) AS s (id, name)
    ON t.id = s.id
    WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name)
  `)
  expect(statement).toMatchObject({
    kind: 'merge',
    target: [ 't' ],
    source: {
      kind: 'derived',
      alias: 's',
      select: {
        kind: 'select',
        items: [
          { kind: 'expression', expression: { kind: 'number', value: '1' }, alias: 'id' },
          { kind: 'expression', expression: { kind: 'string', value: 'a' }, alias: 'name' }
        ],
        union: { kind: 'unionAll', select: { items: [ {}, {} ] } }
      }
    },
    whens: [ { match: 'notMatchedByTarget', action: { kind: 'insert' } } ]
  })
  expect(statement).not.toHaveProperty('alias')
})

test('merge using derived select renames columns positionally', () => {
  expect(parseStatement(`
    MERGE target AS t
    USING (SELECT id, total FROM staging) AS s (sid, amount)
    ON t.id = s.sid
    WHEN MATCHED THEN UPDATE SET amount = s.amount
    WHEN NOT MATCHED THEN INSERT DEFAULT VALUES
  `)).toMatchObject({
    kind: 'merge',
    source: {
      kind: 'derived',
      alias: 's',
      select: {
        items: [
          { expression: { kind: 'column', name: [ 'id' ] }, alias: 'sid' },
          { expression: { kind: 'column', name: [ 'total' ] }, alias: 'amount' }
        ]
      }
    },
    whens: [
      { match: 'matched' },
      { match: 'notMatchedByTarget', action: { kind: 'insert' } }
    ]
  })
})

test('merge with output clause parses', () => {
  expect(parseStatement(`
    MERGE t USING s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET v = s.v
    OUTPUT inserted.id
  `)).toMatchObject({
    kind: 'merge',
    output: { items: [ { kind: 'expression' } ] }
  })
})

test('merge output with $action and INTO parses', () => {
  expect(parseStatement(`
    MERGE t USING s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET v = s.v
    OUTPUT $action, inserted.id, deleted.v AS old INTO log (act, id, old)
  `)).toMatchObject({
    kind: 'merge',
    output: {
      items: [
        { kind: 'expression', expression: { kind: 'column', name: [ '$action' ] } },
        { kind: 'expression', expression: { kind: 'column', name: [ 'inserted', 'id' ] } },
        { kind: 'expression', expression: { kind: 'column', name: [ 'deleted', 'v' ] }, alias: 'old' }
      ],
      into: { table: [ 'log' ], columns: [ 'act', 'id', 'old' ] }
    }
  })
})

test('merge rejects malformed arms', () => {
  expect(() => parseStatement('MERGE t USING s ON t.id = s.id')).toThrow(ParseError)
  expect(() => parseStatement(
    'MERGE t USING (VALUES (1, 2)) AS s (a) ON t.a = s.a WHEN MATCHED THEN DELETE'
  )).toThrow(ParseError)
  expect(() => parseStatement(
    'MERGE t USING s ON t.id = s.id WHEN NOT MATCHED THEN DELETE'
  )).toThrow(ParseError)
})
