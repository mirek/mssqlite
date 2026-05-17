# StatementSync

> Source: [Node.js SQLite docs — Class `StatementSync`](https://nodejs.org/api/sqlite.html#class-statementsync)

A `StatementSync` is a compiled SQL statement. Instances are produced by `db.prepare(sql)` — the constructor is **not** public.

```javascript
const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
```

Prepared statements can be executed repeatedly with different parameter values. Compilation cost is paid once.

## Execution methods

| Method | Returns | When to use |
|--------|---------|-------------|
| `stmt.all(...params)` | `Object[]` (or `Array[]` if `returnArrays`) | Read queries returning many rows |
| `stmt.get(...params)` | first row or `undefined` | Read queries expected to return zero or one row |
| `stmt.iterate(...params)` | iterable yielding rows | Stream rows lazily |
| `stmt.run(...params)` | `{ changes, lastInsertRowid }` | INSERT / UPDATE / DELETE / DDL |

`run()` return shape:

```javascript
{
  changes: number | bigint,         // rows modified by the statement
  lastInsertRowid: number | bigint  // rowid of last INSERT
}
```

Both fields become `bigint` if the value exceeds the JS safe integer range.

## Parameter binding

### Anonymous (positional) — `?`

Passed as separate arguments in order:

```javascript
const stmt = db.prepare('SELECT * FROM users WHERE name = ? AND age > ?');
stmt.all('Alice', 30);
```

### Named — `:name`, `@name`, `$name`

Passed as a single object argument. Any of the three SQLite prefixes work in SQL; the JS key must match the SQL form unless `allowBareNamedParameters` is enabled (see below).

```javascript
const stmt = db.prepare('SELECT * FROM users WHERE name = :name AND age > :age');
stmt.all({ ':name': 'Alice', ':age': 30 });
```

### Bare named parameters

When the database (or statement) has `allowBareNamedParameters: true` (the **default**), you can omit the prefix in the JS object:

```javascript
stmt.all({ name: 'Alice', age: 30 });   // implicit prefix
```

If two SQL parameters would collide after stripping prefixes (`:x` and `@x`), bare binding throws — pass them prefixed.

### Unknown parameters

By default, an unknown key in the bind object throws. With `allowUnknownNamedParameters: true`, extra keys are silently ignored — useful when you pass the same context object to multiple statements.

### Mixing positional and named

Allowed by SQLite, but avoid it: use one style per statement for readability.

## Configuration setters

Apply to this statement only and override the database-level defaults.

| Method | Effect |
|--------|--------|
| `stmt.setReadBigInts(enabled)` | Read INTEGER columns as `BigInt` |
| `stmt.setReturnArrays(enabled)` | Rows as arrays instead of objects |
| `stmt.setAllowBareNamedParameters(enabled)` | Toggle bare-name binding |
| `stmt.setAllowUnknownNamedParameters(enabled)` | Ignore unknown keys |

```javascript
const stmt = db.prepare('SELECT id, total FROM ledger');
stmt.setReadBigInts(true);            // money column → BigInt
for (const row of stmt.iterate()) { /* row.total is bigint */ }
```

## Introspection

### `stmt.sourceSQL` (getter)

The original SQL string passed to `prepare()`.

### `stmt.expandedSQL` (getter)

The SQL with the most recently bound parameter values inlined as literals. Useful for logging — **do not** feed this back into `exec`/`prepare` as a substitute for parameter binding.

### `stmt.columns()` → `Object[]`

Per-column metadata for the result set. Each entry:

```javascript
{
  name:     'id',         // alias if AS was used, else the underlying column
  database: 'main',       // schema name
  table:    'users',      // table name, '' for expressions
  column:   'id',         // underlying column, '' for expressions
  type:     'INTEGER'     // declared column type, '' for expressions
}
```

Order matches the result row order. For a `returnArrays` statement this is how you discover column names.

## Result shape examples

```javascript
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
db.prepare('INSERT INTO t (name) VALUES (?)').run('Alice');
db.prepare('INSERT INTO t (name) VALUES (?)').run('Bob');

// Default: array of objects
db.prepare('SELECT * FROM t').all();
// [ { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' } ]

// returnArrays: array of arrays
const stmt = db.prepare('SELECT * FROM t');
stmt.setReturnArrays(true);
stmt.all();
// [ [ 1, 'Alice' ], [ 2, 'Bob' ] ]
stmt.columns().map(c => c.name);  // [ 'id', 'name' ]

// get(): single row or undefined
db.prepare('SELECT * FROM t WHERE id = ?').get(99);   // undefined

// iterate(): lazy
for (const row of db.prepare('SELECT * FROM t').iterate()) {
  if (row.name === 'Bob') break;   // safe — closes underlying cursor
}
```

## Lifecycle notes

- A `StatementSync` keeps a reference to the underlying SQLite statement until garbage collected. Long-lived statements are cheap; recompiling on every call is wasteful.
- Closing the database while a statement is alive is safe — subsequent calls on the statement throw.
- Active `iterate()` cursors hold a row lock; finish or break out of the loop before issuing other writes that would conflict.
