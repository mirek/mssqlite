# Sessions and Changesets

> Source: [Node.js SQLite docs — `database.createSession()`, `Session`, `database.applyChangeset()`](https://nodejs.org/api/sqlite.html)

The session API wraps the SQLite [session extension](https://www.sqlite.org/sessionintro.html). It captures changes made through a connection into an opaque binary blob (a changeset or patchset), which can later be applied to another database with the same schema.

## Creating a session — `db.createSession([options])`

```javascript
const session = db.createSession();
```

### Options

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `table` | string | — | If set, only changes to this table are recorded. |
| `db` | string | `'main'` | The attached database (schema) to track. |

A session begins recording immediately. Tables must have a PRIMARY KEY for their changes to be captured (rowid tables without an explicit PK are silently skipped).

## Session methods

| Method | Returns | Description |
|--------|---------|-------------|
| `session.changeset()` | `Uint8Array` | Snapshot of changes since the session started. Can be called multiple times — each call returns the *cumulative* changeset. |
| `session.patchset()` | `Uint8Array` | Smaller, lossy alternative: only records new values for UPDATEs, not original values. Cannot be used to revert changes or detect conflicts based on old data. |
| `session.close()` | void | Stops recording and frees resources. |
| `session[Symbol.dispose]()` | void | Equivalent to `close()`. |

## Applying a changeset — `db.applyChangeset(changeset[, options])`

Returns `true` on success, `false` if an `onConflict` callback returned `SQLITE_CHANGESET_ABORT`.

```javascript
const ok = target.applyChangeset(changeset);
```

### Options

| Option | Type | Effect |
|--------|------|--------|
| `filter` | `(tableName) => boolean` | Return `true` to **skip** changes for that table (note: `true` means "filter out"). |
| `onConflict` | `(conflictType) => resolution` | Decide what to do when a change can't be applied cleanly. See below. |

### Conflict types (from `sqlite.constants`)

| Constant | When it fires |
|----------|---------------|
| `SQLITE_CHANGESET_DATA` | UPDATE/DELETE found a row but its current values don't match the changeset's "before" image |
| `SQLITE_CHANGESET_NOTFOUND` | UPDATE/DELETE found no row matching the primary key |
| `SQLITE_CHANGESET_CONFLICT` | INSERT collided with an existing primary key |
| `SQLITE_CHANGESET_CONSTRAINT` | A NOT NULL / CHECK / UNIQUE / etc. constraint blocked the change |
| `SQLITE_CHANGESET_FOREIGN_KEY` | One or more foreign-key violations resulted from this changeset |

### Resolution values

| Constant | Effect |
|----------|--------|
| `SQLITE_CHANGESET_OMIT` | Skip this change; continue applying the rest |
| `SQLITE_CHANGESET_REPLACE` | Force the change through, overwriting the conflicting row (only meaningful for `DATA` and `CONFLICT`) |
| `SQLITE_CHANGESET_ABORT` | Stop applying; any changes already applied are rolled back |

```javascript
const { constants } = require('node:sqlite');

target.applyChangeset(changeset, {
  filter: (table) => table === 'audit_log',   // skip audit_log
  onConflict: (conflictType) => {
    switch (conflictType) {
      case constants.SQLITE_CHANGESET_NOTFOUND:
        return constants.SQLITE_CHANGESET_OMIT;
      case constants.SQLITE_CHANGESET_CONFLICT:
        return constants.SQLITE_CHANGESET_REPLACE;
      default:
        return constants.SQLITE_CHANGESET_ABORT;
    }
  },
});
```

## Replication pattern

```javascript
const { DatabaseSync } = require('node:sqlite');

const source = new DatabaseSync('primary.db');
const replica = new DatabaseSync('replica.db');   // same schema

// Begin tracking on source
const session = source.createSession();

// Mutations on source
source.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Alice');
source.prepare('UPDATE users SET name = ? WHERE id = ?').run('Alicia', 1);

// Capture and ship the changeset
const blob = session.changeset();
session.close();

// Network / file / queue ...

// Apply on replica
replica.applyChangeset(blob);
```

## changeset() vs patchset()

| | changeset | patchset |
|--|-----------|----------|
| Size | Larger | Smaller |
| UPDATEs include old values? | Yes | No |
| Can detect `SQLITE_CHANGESET_DATA` conflicts | Yes | No |
| Reversible (via `sqlite3changeset_invert`) | Yes | No |

Choose `changeset()` for replication where conflict detection matters; `patchset()` only when bandwidth dominates and you accept last-writer-wins semantics.

## Caveats

- Schemas must match between source and target. A column added on one side will fail to apply on the other.
- Tables without a PRIMARY KEY (other than `INTEGER PRIMARY KEY`) are not tracked. Use `WITHOUT ROWID` or a real PK.
- Sessions don't capture changes made by other connections — only by the database handle on which they were created.
- The session extension must be enabled in the SQLite build Node.js ships; it is on by default in upstream Node.js releases.
