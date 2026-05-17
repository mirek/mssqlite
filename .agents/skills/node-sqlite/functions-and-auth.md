# User-Defined Functions, Aggregates, and Authorization

> Source: [Node.js SQLite docs — `database.function()`, `database.aggregate()`, `database.setAuthorizer()`](https://nodejs.org/api/sqlite.html)

## Scalar functions — `db.function(name[, options], fn)`

Registers a JS function callable from SQL. Argument and return types follow the standard [JS↔SQLite mapping](types.md).

```javascript
db.function('double', (x) => x * 2);
db.prepare("SELECT double(21)").get();
// { 'double(21)': 42 }
```

### Options

| Option | Type | Effect |
|--------|------|--------|
| `deterministic` | boolean | Marks the function pure — SQLite can use it in indexes, hoist it out of loops, and call it from `CHECK` constraints. Same inputs **must** yield the same outputs. |
| `directOnly` | boolean | Function can only appear in top-level SQL (not in views, triggers, or schema expressions). A hardening measure for functions that can side-effect outside the database. |
| `useBigIntArguments` | boolean | INTEGER arguments arrive as `BigInt`. Required if you may receive values outside the JS safe integer range. |
| `varargs` | boolean | Accept any arity. Otherwise SQLite enforces `fn.length`. |

```javascript
db.function('add', {
  deterministic: true,
  useBigIntArguments: true,
  varargs: true,
}, (...args) => args.reduce((a, b) => a + b, 0n));
```

### Return types

- `number` / `bigint` → INTEGER or REAL
- `string` → TEXT
- `Uint8Array` / `DataView` / `Buffer` → BLOB
- `null` / `undefined` → NULL
- Anything else throws.

### Errors

Throwing from `fn` propagates as a SQLite error to the calling statement. The error message preserves the JS `Error.message`.

## Aggregate functions — `db.aggregate(name, options)`

Registers an aggregate or window function.

```javascript
db.aggregate('sumint', {
  start: 0,
  step:    (acc, value) => acc + value,
  result:  (acc) => acc,
});

db.prepare('SELECT sumint(x) AS total FROM t').get();
```

### Options

| Option | Type | Required | Effect |
|--------|------|----------|--------|
| `start` | any \| `() => any` | yes | Initial accumulator. If a function, it is called once per aggregation to produce a fresh value (use this for mutable accumulators like arrays / Maps). |
| `step` | `(acc, ...args) => any` | yes | Folds a row into the accumulator. May return a new accumulator or mutate in place. |
| `result` | `(acc) => any` | no | Maps the final accumulator into the returned value. Defaults to identity. |
| `inverse` | `(acc, ...args) => any` | only for window functions | Reverses a `step` — required to use the function with an `OVER (...)` window. |
| `deterministic` | boolean | no | Same effect as for scalar functions. |
| `directOnly` | boolean | no | Same effect as for scalar functions. |
| `useBigIntArguments` | boolean | no | Same effect as for scalar functions. |
| `varargs` | boolean | no | Same effect as for scalar functions. |

### Mutable accumulator pattern

`start` as a factory avoids leaking state between concurrent aggregations:

```javascript
db.aggregate('collect', {
  start:  () => [],
  step:   (acc, v) => { acc.push(v); return acc; },
  result: (acc) => JSON.stringify(acc),
});
```

### Window function

```javascript
db.aggregate('rolling_sum', {
  start: 0,
  step:    (acc, v) => acc + v,
  inverse: (acc, v) => acc - v,
  result:  (acc) => acc,
});

db.prepare(`
  SELECT t, rolling_sum(v) OVER (
    ORDER BY t ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
  ) AS r
  FROM series
`).all();
```

## Authorization — `db.setAuthorizer(callback)`

Installs a compile-time hook called once per "action" while SQLite parses a statement. Returning `SQLITE_DENY` causes compilation to fail; `SQLITE_IGNORE` substitutes a no-op (e.g., a column read returns NULL).

```javascript
const { constants } = require('node:sqlite');

db.setAuthorizer((actionCode, arg1, arg2, dbName, triggerOrView) => {
  if (actionCode === constants.SQLITE_DELETE && arg1 === 'audit_log') {
    return constants.SQLITE_DENY;
  }
  return constants.SQLITE_OK;
});
```

### Callback signature

```javascript
(actionCode, arg1, arg2, dbName, triggerOrView) => SQLITE_OK | SQLITE_DENY | SQLITE_IGNORE
```

| Argument | Meaning |
|----------|---------|
| `actionCode` | One of the `SQLITE_*` action constants — see [constants.md](constants.md) |
| `arg1`, `arg2` | Action-specific (often table name and column name) |
| `dbName` | Source schema (`'main'`, `'temp'`, attached DB name), or `null` |
| `triggerOrView` | The trigger or view causing the action, or `null` if top-level |

### Return values

- `constants.SQLITE_OK` — allow
- `constants.SQLITE_DENY` — abort statement compilation with an error
- `constants.SQLITE_IGNORE` — silently skip (semantics depend on the action; for `SQLITE_READ`, returns NULL for the column)

### Notes

- The authorizer fires during `prepare()` / `exec()`, **not** during row execution — it's a static gate, not a row-level filter.
- Only one authorizer per database. Subsequent `setAuthorizer()` replaces it; pass `null` to remove.
- Use it for sandboxing untrusted SQL (e.g., user-supplied queries against a read-only view), not for permission models that depend on row data.
