# Constants

> Source: [Node.js SQLite docs — `sqlite.constants`](https://nodejs.org/api/sqlite.html#sqliteconstants)

Access through the module export:

```javascript
const { constants } = require('node:sqlite');
// or
import { constants } from 'node:sqlite';
```

The constants object holds numeric values matching the SQLite C API. Two groups:

1. **Authorizer codes** — for `db.setAuthorizer()` callbacks ([functions-and-auth.md](functions-and-auth.md))
2. **Changeset codes** — for `db.applyChangeset()` conflict handlers ([sessions-and-changesets.md](sessions-and-changesets.md))

## Authorizer return values

Returned from the authorizer callback to decide what happens with the requested action.

| Constant | Meaning |
|----------|---------|
| `SQLITE_OK` | Allow the action |
| `SQLITE_DENY` | Reject the statement; compilation fails with an error |
| `SQLITE_IGNORE` | Substitute a no-op (e.g., reading a column returns NULL) |

## Authorizer action codes

Passed as the first argument to the authorizer callback. The meaning of `arg1` / `arg2` differs per action — see the [SQLite authorizer reference](https://www.sqlite.org/c3ref/c_alter_table.html) for the full matrix.

| Constant | Fires when |
|----------|------------|
| `SQLITE_CREATE_INDEX` | `CREATE INDEX` |
| `SQLITE_CREATE_TABLE` | `CREATE TABLE` |
| `SQLITE_CREATE_TEMP_INDEX` | `CREATE TEMP INDEX` |
| `SQLITE_CREATE_TEMP_TABLE` | `CREATE TEMP TABLE` |
| `SQLITE_CREATE_TEMP_TRIGGER` | `CREATE TEMP TRIGGER` |
| `SQLITE_CREATE_TEMP_VIEW` | `CREATE TEMP VIEW` |
| `SQLITE_CREATE_TRIGGER` | `CREATE TRIGGER` |
| `SQLITE_CREATE_VIEW` | `CREATE VIEW` |
| `SQLITE_DELETE` | `DELETE FROM table` |
| `SQLITE_DROP_INDEX` | `DROP INDEX` |
| `SQLITE_DROP_TABLE` | `DROP TABLE` |
| `SQLITE_DROP_TEMP_INDEX` | `DROP TEMP INDEX` |
| `SQLITE_DROP_TEMP_TABLE` | `DROP TEMP TABLE` |
| `SQLITE_DROP_TEMP_TRIGGER` | `DROP TEMP TRIGGER` |
| `SQLITE_DROP_TEMP_VIEW` | `DROP TEMP VIEW` |
| `SQLITE_DROP_TRIGGER` | `DROP TRIGGER` |
| `SQLITE_DROP_VIEW` | `DROP VIEW` |
| `SQLITE_INSERT` | `INSERT INTO table` |
| `SQLITE_PRAGMA` | `PRAGMA` statement |
| `SQLITE_READ` | A column is read |
| `SQLITE_SELECT` | A `SELECT` is compiled (once per statement) |
| `SQLITE_TRANSACTION` | `BEGIN` / `COMMIT` / `ROLLBACK` |
| `SQLITE_UPDATE` | `UPDATE table SET column = ...` |
| `SQLITE_ATTACH` | `ATTACH DATABASE` |
| `SQLITE_DETACH` | `DETACH DATABASE` |
| `SQLITE_ALTER_TABLE` | `ALTER TABLE` |
| `SQLITE_REINDEX` | `REINDEX` |
| `SQLITE_ANALYZE` | `ANALYZE` |
| `SQLITE_CREATE_VTABLE` | `CREATE VIRTUAL TABLE` |
| `SQLITE_DROP_VTABLE` | `DROP` of a virtual table |
| `SQLITE_FUNCTION` | A function is invoked |
| `SQLITE_SAVEPOINT` | `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` |
| `SQLITE_COPY` | (no-op in modern SQLite) |
| `SQLITE_RECURSIVE` | Recursive CTE step |

## Changeset conflict types

Passed to the `onConflict` callback of `db.applyChangeset()`.

| Constant | Meaning |
|----------|---------|
| `SQLITE_CHANGESET_DATA` | UPDATE/DELETE: target row exists but its current values diverge from the changeset's "before" image |
| `SQLITE_CHANGESET_NOTFOUND` | UPDATE/DELETE: no row matches the primary key |
| `SQLITE_CHANGESET_CONFLICT` | INSERT: primary key already exists |
| `SQLITE_CHANGESET_CONSTRAINT` | A constraint (NOT NULL, CHECK, UNIQUE, …) blocks the change |
| `SQLITE_CHANGESET_FOREIGN_KEY` | One or more FK violations would result |

## Changeset conflict resolutions

Returned by the `onConflict` callback.

| Constant | Effect |
|----------|--------|
| `SQLITE_CHANGESET_OMIT` | Skip this change, keep applying the rest |
| `SQLITE_CHANGESET_REPLACE` | Force the change; overwrite the existing row (only meaningful for `DATA` and `CONFLICT`) |
| `SQLITE_CHANGESET_ABORT` | Stop and roll back everything applied so far; `applyChangeset()` returns `false` |
