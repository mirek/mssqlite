# Backup and Serialization

> Source: [Node.js SQLite docs — `backup()`, `database.serialize()`, `database.deserialize()`](https://nodejs.org/api/sqlite.html)

Two distinct mechanisms for moving database state around.

| | `backup()` | `serialize()` / `deserialize()` |
|--|-----------|----------------------------------|
| Sync/async | **Async** (returns Promise) | Sync |
| Destination | File on disk | In-memory `Uint8Array` |
| Source can be in use | Yes — copies pages while writes happen | Yes — takes a consistent snapshot |
| Progress callback | Yes | No |
| Use case | Online backup of a live database | Round-trip an in-memory DB, ship a snapshot in-process |

## `backup(sourceDb, destPath[, options])`

Top-level export. Returns a Promise resolving to the total number of pages copied.

```javascript
const { DatabaseSync, backup } = require('node:sqlite');

const db = new DatabaseSync('live.db');
const total = await backup(db, 'live-backup.db', {
  rate: 100,
  progress: ({ totalPages, remainingPages }) => {
    console.log(`copied ${totalPages - remainingPages} of ${totalPages}`);
  },
});
```

### Options

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `source` | string | `'main'` | Source database name (relevant if you've `ATTACH`ed others) |
| `target` | string | `'main'` | Target database name inside the destination file |
| `rate` | number | `100` | Pages copied per iteration — larger values finish faster but hold the source lock longer |
| `progress` | `({ totalPages, remainingPages }) => void` | — | Called after each iteration |

Backup is incremental: the source database can be read and written during the copy, and SQLite will retry pages that change.

## `db.serialize([dbName])` → `Uint8Array`

Returns the full database content as a byte array. Default schema is `'main'`.

```javascript
const bytes = db.serialize();
fs.writeFileSync('snapshot.db', bytes);
```

The output is a valid SQLite database file — you can open it directly with the CLI.

## `db.deserialize(buffer[, options])`

Replaces the named database in this connection with the contents of `buffer`. The connection must be open; the existing database in that schema is closed first.

```javascript
const bytes = fs.readFileSync('snapshot.db');
const db = new DatabaseSync(':memory:');
db.deserialize(bytes);
db.prepare('SELECT count(*) AS n FROM users').get();
```

### Options

(Available on recent Node.js versions.)

| Option | Type | Effect |
|--------|------|--------|
| `readOnly` | boolean | Mount the deserialized database read-only |
| `freeOnClose` | boolean | Free the underlying buffer when the database closes |
| `resizable` | boolean | Allow the in-memory database to grow past the buffer's initial size |

## Common patterns

### Clone an in-memory database

```javascript
const original = new DatabaseSync(':memory:');
// ... populate ...
const bytes = original.serialize();

const clone = new DatabaseSync(':memory:');
clone.deserialize(bytes);
```

### Atomic-ish snapshot to disk

```javascript
const bytes = db.serialize();
await fs.promises.writeFile(`backup-${Date.now()}.db`, bytes);
```

Note: `serialize()` allocates a buffer the size of the database. For multi-GB databases, prefer `backup()` — it streams pages rather than holding the entire database in memory.

### Hot backup with progress

```javascript
await backup(db, '/var/backups/app.db', {
  rate: 500,
  progress: ({ totalPages, remainingPages }) => {
    const pct = ((totalPages - remainingPages) / totalPages * 100).toFixed(1);
    process.stderr.write(`\rbackup ${pct}%`);
  },
});
process.stderr.write('\n');
```
