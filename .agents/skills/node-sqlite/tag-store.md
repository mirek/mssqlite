# SQLTagStore

> Source: [Node.js SQLite docs — Class `SQLTagStore`](https://nodejs.org/api/sqlite.html#class-sqltagstore)

`SQLTagStore` is an LRU cache of prepared statements driven by **tagged template literals**. Each unique SQL string compiles once; subsequent calls with the same template reuse the cached `StatementSync`.

```javascript
const sql = db.createTagStore(1000);   // up to 1000 cached statements
```

## Construction

```javascript
db.createTagStore([maxSize])
```

`maxSize` caps the cache. When full, least-recently-used statements are evicted.

## Tagged template methods

Each method is invoked as a template tag — the SQL is the template, and interpolated values are bound as parameters (never substituted as text):

| Method | Returns | Mirrors |
|--------|---------|---------|
| `sql.run\`...\`` | `{ changes, lastInsertRowid }` | `StatementSync.run` |
| `sql.get\`...\`` | first row or `undefined` | `StatementSync.get` |
| `sql.all\`...\`` | row array | `StatementSync.all` |
| `sql.iterate\`...\`` | row iterator | `StatementSync.iterate` |

```javascript
const id = 1;
const name = 'Alice';

sql.run`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
//  → prepared as: "INSERT INTO users (id, name) VALUES (?, ?)"
//  → bound with: [1, 'Alice']

const user = sql.get`SELECT * FROM users WHERE id = ${id}`;
const adults = sql.all`SELECT * FROM users WHERE age >= ${18}`;

for (const row of sql.iterate`SELECT * FROM users ORDER BY id`) {
  // ...
}
```

The cache key is the **template's static parts**, not the interpolated values. The two calls below share one prepared statement:

```javascript
sql.get`SELECT * FROM users WHERE id = ${1}`;
sql.get`SELECT * FROM users WHERE id = ${2}`;
```

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `sql.size` | number | Statements currently cached |
| `sql.capacity` | number | Max cache size (the value passed to `createTagStore`) |
| `sql.db` | `DatabaseSync` | The owning database |

## Methods (non-template)

| Method | Effect |
|--------|--------|
| `sql.clear()` | Drops every cached statement; future calls recompile |

## Pitfalls

- **Identifiers can't be interpolated.** Table/column names must be part of the static template — interpolation always produces a parameter binding. Build separate `sql` calls per table.
- **Don't string-concatenate SQL.** Two callsites with the same SQL but built via `+ '...'` have different template identities; each occupies a cache slot.
- **Conditional SQL** (e.g. optional `WHERE` clauses) defeats the cache. Either prepare both variants ahead of time or fall back to `db.prepare()` directly.
- **Memory.** Cached statements pin their compiled VDBE programs; pick a `maxSize` that matches your working set, not "as big as possible."

## When to use

- App code that issues many ad-hoc queries with a small-ish set of distinct SQL shapes.
- Hot paths where the alternative is recompiling on every call.

When the same statement is reused at a single callsite, holding a `db.prepare()` handle in a local variable is simpler and avoids the cache layer entirely.
