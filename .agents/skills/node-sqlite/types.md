# Type Conversion

> Source: [Node.js SQLite docs — Type conversion between JavaScript and SQLite](https://nodejs.org/api/sqlite.html#type-conversion-between-javascript-and-sqlite)

SQLite has five storage classes: `NULL`, `INTEGER`, `REAL`, `TEXT`, `BLOB`. JS values are converted on the way in; column values are converted on the way out.

## Mapping table

| SQLite | JS → SQLite (bind) | SQLite → JS (read) |
|--------|-------------------|---------------------|
| `NULL` | `null`, `undefined` | `null` |
| `INTEGER` | `number` (integer), `bigint`, `boolean` (→ 0/1) | `number` if safe, else throws — unless `readBigInts` |
| `REAL` | `number` (non-integer), `bigint` (large) | `number` |
| `TEXT` | `string` | `string` |
| `BLOB` | `Uint8Array`, `DataView`, `Buffer` | `Uint8Array` |

Anything else (`Date`, plain objects, arrays, functions, `Symbol`) **throws** at bind time. There is no implicit serialization.

## INTEGER and BigInt

SQLite INTEGERs are 64-bit signed. JS numbers are IEEE-754 doubles with a 53-bit safe integer range.

- Values within `[-(2^53 - 1), (2^53 - 1)]` round-trip as `number`.
- Values outside that range throw when read **unless** BigInt mode is on.

Enable BigInt reads either globally or per statement:

```javascript
// Global
const db = new DatabaseSync(':memory:', { readBigInts: true });

// Per statement
const stmt = db.prepare('SELECT id FROM big');
stmt.setReadBigInts(true);
```

When `readBigInts` is `true`, **all** INTEGER columns return `bigint` — including small ones. Mixed-mode is not supported.

Writing a BigInt is always safe:

```javascript
db.prepare('INSERT INTO t (id) VALUES (?)').run(9007199254740993n);   // OK
```

### `lastInsertRowid` and `changes`

Both fields of `run()`'s return value are `number` when small and `bigint` when they exceed safe range, independent of `readBigInts`.

## BLOB

Reads always produce `Uint8Array`. Writes accept anything backed by an `ArrayBuffer`:

```javascript
db.prepare('INSERT INTO blobs VALUES (?)').run(new Uint8Array([1,2,3]));
db.prepare('INSERT INTO blobs VALUES (?)').run(Buffer.from('hello'));
db.prepare('INSERT INTO blobs VALUES (?)').run(new DataView(new ArrayBuffer(8)));

const row = db.prepare('SELECT v FROM blobs').get();
row.v instanceof Uint8Array;   // true
```

To bind an `ArrayBuffer` directly, wrap it: `new Uint8Array(buf)`.

## Boolean

There is no boolean storage class. `true` / `false` bind as INTEGER `1` / `0`. On read you get back numbers (or BigInts) — convert explicitly with `Boolean(value)`.

## Date

Not handled — bind manually. Common conventions:

- ISO 8601 string: `date.toISOString()` ↔ `new Date(row.created_at)`
- Unix milliseconds: `date.getTime()` ↔ `new Date(row.created_at)`
- Julian days (SQLite native): use `julianday('now')` and `datetime()` in SQL

## `null` vs `undefined`

Both bind as SQL `NULL`. Reads always return `null` — `undefined` never appears in row data.

## STRICT tables

Declaring a table `STRICT` makes SQLite enforce declared column types instead of its default flexible typing:

```sql
CREATE TABLE t (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age  INTEGER
) STRICT;
```

With STRICT, binding the wrong JS type throws at run time (e.g., a string into an `INTEGER` column). Recommended for new schemas — it surfaces type bugs early.

## Common pitfalls

- **Implicit BigInt mixing.** Adding a JS `number` to a `bigint` throws `TypeError`. If your schema can hold large integers, decide upfront whether you want `readBigInts` on or off for that database.
- **`Date` objects.** Easy to forget; binding throws with a not-very-loud message. Convert before bind.
- **`NaN` / `Infinity`.** Bind as REAL (SQLite supports them in storage but most arithmetic functions don't). Prefer rejecting them at the application boundary.
- **Buffer return type changes.** Reads come back as `Uint8Array`, not `Buffer`. If you need `Buffer` semantics, do `Buffer.from(row.v.buffer, row.v.byteOffset, row.v.byteLength)`.
