# DatabaseSync

> Source: [Node.js SQLite docs — Class `DatabaseSync`](https://nodejs.org/api/sqlite.html#class-databasesync)

`DatabaseSync` represents a single synchronous connection to a SQLite database file (or `:memory:`). It cannot be shared across worker threads.

## Constructor

```javascript
new DatabaseSync(path[, options])
```

| Argument | Type | Notes |
|----------|------|-------|
| `path` | `string` \| `Buffer` \| `URL` | Filesystem path, `Buffer`/`URL` representing one, or the literal `':memory:'` for an in-memory database |
| `options` | `Object` | See option table below |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `open` | boolean | `true` | If `false`, the database is not opened by the constructor — call `db.open()` later. Use when you want to mutate `limits` first. |
| `readOnly` | boolean | `false` | Open the database in read-only mode. Writes throw. |
| `enableForeignKeyConstraints` | boolean | `true` | Enables `PRAGMA foreign_keys = ON`. |
| `enableDoubleQuotedStringLiterals` | boolean | `false` | If `true`, double-quoted strings are treated as string literals (legacy SQLite quirk). Leave `false` for portable SQL — `"x"` is an identifier. |
| `allowExtension` | boolean | `false` | Enables `sqlite3_enable_load_extension()`. Required before `db.loadExtension()` will work. |
| `timeout` | number | `0` | Busy timeout in milliseconds — how long to retry when the database is locked by another connection. |
| `readBigInts` | boolean | `false` | When `true`, INTEGER columns are returned as `BigInt`. See [types.md](types.md). |
| `returnArrays` | boolean | `false` | When `true`, rows are returned as arrays of values rather than objects keyed by column name. |
| `allowBareNamedParameters` | boolean | `true` | When `true`, named parameters can be passed without their `:`/`@`/`$` prefix in the JS object. |
| `allowUnknownNamedParameters` | boolean | `false` | When `true`, properties in the bind object that don't match any SQL parameter are silently ignored. |
| `defensive` | boolean | `true` | Enables the SQLite defensive flag — disallows certain dangerous schema mutations from SQL. |
| `limits` | `Object` | — | Per-connection runtime limits (see below). |

### `limits` sub-options

All numeric; sets the corresponding `sqlite3_limit()` value.

| Field | Limit |
|-------|-------|
| `length` | Max length of strings and BLOBs |
| `sqlLength` | Max length of a single SQL statement |
| `column` | Max columns in a table / index / SELECT |
| `exprDepth` | Max expression tree depth |
| `compoundSelect` | Max terms in a compound SELECT |
| `vdbeOp` | Max VDBE instructions in a program |
| `functionArg` | Max arguments on a function |
| `attach` | Max attached databases |
| `likePatternLength` | Max length of a LIKE / GLOB pattern |
| `variableNumber` | Max number of `?NNN` parameters |
| `triggerDepth` | Max trigger recursion depth |

To use `limits`, set `open: false`, mutate `db.limits`, then call `db.open()`.

## Methods

### `db.exec(sql)`

Executes one or more SQL statements without returning rows. Use for DDL, batched setup, and fire-and-forget DML. Equivalent to `sqlite3_exec()`.

```javascript
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE INDEX idx_users_name ON users(name);
`);
```

### `db.prepare(sql[, options])` → `StatementSync`

Compiles SQL into a prepared statement. See [statements.md](statements.md).

### `db.open()`

Opens the database. Only meaningful after constructing with `open: false`. Throws if already open.

### `db.close()`

Closes the connection. Pending `iterate()` cursors must be exhausted (or garbage collected) before close.

### `db.isOpen` (getter)

`true` if open, `false` otherwise.

### `db.isTransaction` (getter)

`true` if an explicit transaction is currently active on this connection (i.e. `BEGIN` has been issued and not yet `COMMIT`/`ROLLBACK`).

### `db.location([dbName])` → string \| null

Returns the filesystem path of the named database (defaults to `'main'`). Returns `null` for `:memory:` and temp databases.

### `db.function(name[, options], fn)`

Registers a scalar user-defined function. See [functions-and-auth.md](functions-and-auth.md).

### `db.aggregate(name, options)`

Registers an aggregate (and optionally a window) function. See [functions-and-auth.md](functions-and-auth.md).

### `db.setAuthorizer(callback)`

Installs an authorizer callback invoked while statements are compiled. See [functions-and-auth.md](functions-and-auth.md).

### `db.loadExtension(path)`

Loads a SQLite extension (`.so` / `.dylib` / `.dll`). Requires `allowExtension: true` in the constructor **and** `db.enableLoadExtension(true)` to be in effect.

### `db.enableLoadExtension(allow)`

Toggles extension loading at runtime. Throws if `allowExtension` was not set in the constructor.

### `db.enableDefensive(active)`

Toggles the defensive flag at runtime.

### `db.serialize([dbName])` → `Uint8Array`

Snapshots the database into a byte array. See [backup-serialize.md](backup-serialize.md).

### `db.deserialize(buffer[, options])`

Replaces this connection's database contents with `buffer`. See [backup-serialize.md](backup-serialize.md).

### `db.createTagStore([maxSize])` → `SQLTagStore`

Creates a prepared-statement LRU cache. See [tag-store.md](tag-store.md). Default `maxSize` is implementation-defined; pass an explicit number to cap it.

### `db.createSession([options])` → `Session`

Begins tracking changes. See [sessions-and-changesets.md](sessions-and-changesets.md).

### `db.applyChangeset(changeset[, options])` → boolean

Applies a previously captured changeset. Returns `false` if aborted by a conflict callback. See [sessions-and-changesets.md](sessions-and-changesets.md).

### `db.limits` (getter / setter)

Reads or writes the connection's `limits` object. Most useful before `open()` when the database was created with `open: false`.

### `db[Symbol.dispose]()`

Equivalent to `close()`. Lets you use `using` (TC39 explicit resource management) for automatic cleanup:

```javascript
using db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t(x)');
// db is closed at end of scope
```

## Connection lifecycle examples

### Default open

```javascript
const db = new DatabaseSync('app.db', {
  enableForeignKeyConstraints: true,
  timeout: 5000,
});
```

### Deferred open with custom limits

```javascript
const db = new DatabaseSync('app.db', { open: false });
db.limits = { ...db.limits, sqlLength: 200_000, variableNumber: 5000 };
db.open();
```

### Read-only attach

```javascript
const db = new DatabaseSync('report.db', { readOnly: true });
db.prepare('INSERT INTO t VALUES (1)').run();   // throws — read-only
```

### Manual transaction

`DatabaseSync` does **not** offer a `transaction()` wrapper (unlike `better-sqlite3`). Use `exec` directly:

```javascript
db.exec('BEGIN');
try {
  insertUser.run({ name: 'Alice' });
  insertUser.run({ name: 'Bob' });
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
```

Check `db.isTransaction` to detect whether you are inside one.
