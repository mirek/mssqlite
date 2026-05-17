# Examples

End-to-end patterns. All snippets target the built-in `node:sqlite` module — no external dependencies.

## 1. Bootstrap + CRUD with named parameters

```javascript
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('app.db', {
  enableForeignKeyConstraints: true,
  timeout: 5000,
});

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    email      TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
`);

const insertUser = db.prepare(`
  INSERT INTO users (name, email) VALUES (:name, :email)
`);
const findUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
const allUsers = db.prepare(`SELECT id, name, email FROM users ORDER BY id`);

const { lastInsertRowid } = insertUser.run({ name: 'Alice', email: 'a@x.com' });
console.log(findUser.get(lastInsertRowid));
console.log(allUsers.all());
```

## 2. Manual transaction with rollback

```javascript
function transfer(db, fromId, toId, amount) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const debit  = db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?');
    const credit = db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');
    const check  = db.prepare('SELECT balance FROM accounts WHERE id = ?');

    if (check.get(fromId).balance < amount) {
      throw new Error('insufficient funds');
    }
    debit.run(amount, fromId);
    credit.run(amount, toId);

    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
```

`BEGIN IMMEDIATE` acquires a reserved lock up front, avoiding the surprise of a write-conflict in the middle of a read-modify-write sequence.

## 3. Streaming a large result set

```javascript
const stmt = db.prepare('SELECT id, payload FROM events WHERE day = ?');
for (const row of stmt.iterate('2026-05-17')) {
  await processEvent(row);   // back-pressure under control
}
```

Iteration holds a row cursor — break out (or finish) before issuing conflicting writes on the same connection.

## 4. Custom scalar function

```javascript
const crypto = require('node:crypto');

db.function('sha256', { deterministic: true }, (input) => {
  if (input == null) return null;
  return crypto.createHash('sha256').update(String(input)).digest();
  // returns Uint8Array-like Buffer → stored as BLOB
});

db.prepare('SELECT sha256(?) AS h').get('hello').h;   // <Buffer …>
```

## 5. Window aggregate

```javascript
db.aggregate('moving_avg', {
  start:   () => ({ sum: 0, n: 0 }),
  step:    (acc, v) => { acc.sum += v; acc.n += 1; return acc; },
  inverse: (acc, v) => { acc.sum -= v; acc.n -= 1; return acc; },
  result:  (acc) => acc.n === 0 ? null : acc.sum / acc.n,
});

const rows = db.prepare(`
  SELECT t,
         v,
         moving_avg(v) OVER (ORDER BY t ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma
  FROM samples
  ORDER BY t
`).all();
```

## 6. SQLTagStore for many ad-hoc queries

```javascript
const sql = db.createTagStore(200);

function findUsersOlderThan(age) {
  return sql.all`SELECT * FROM users WHERE age > ${age}`;
}

function logEvent(userId, kind) {
  sql.run`INSERT INTO events (user_id, kind, at) VALUES (${userId}, ${kind}, CURRENT_TIMESTAMP)`;
}
```

Two distinct templates → two cached statements. Each subsequent call binds new parameters without re-preparing.

## 7. Change replication via sessions

```javascript
const source = new DatabaseSync('primary.db');
const replica = new DatabaseSync('replica.db');

const session = source.createSession();

source.prepare('INSERT INTO orders (id, total) VALUES (?, ?)').run(1, 99);
source.prepare('UPDATE orders SET total = ? WHERE id = ?').run(120, 1);

const blob = session.changeset();
session.close();

// ... ship `blob` over the network / write to a queue ...

const { constants } = require('node:sqlite');
const ok = replica.applyChangeset(blob, {
  onConflict: () => constants.SQLITE_CHANGESET_REPLACE,
});
```

## 8. In-memory snapshot / clone

```javascript
const original = new DatabaseSync(':memory:');
original.exec('CREATE TABLE t(x INTEGER)');
original.prepare('INSERT INTO t VALUES (?)').run(42);

const snapshot = original.serialize();   // Uint8Array

const clone = new DatabaseSync(':memory:');
clone.deserialize(snapshot);
console.log(clone.prepare('SELECT * FROM t').get());   // { x: 42 }
```

## 9. Live backup to disk

```javascript
const { backup } = require('node:sqlite');

await backup(db, `backups/app-${Date.now()}.db`, {
  rate: 500,
  progress: ({ totalPages, remainingPages }) => {
    const pct = ((totalPages - remainingPages) / totalPages * 100) | 0;
    process.stderr.write(`\rbackup ${pct}%`);
  },
});
process.stderr.write('\ndone\n');
```

## 10. Sandboxed SQL with the authorizer

```javascript
const { DatabaseSync, constants } = require('node:sqlite');

const db = new DatabaseSync('readonly.db', { readOnly: true });

db.setAuthorizer((action) => {
  switch (action) {
    case constants.SQLITE_SELECT:
    case constants.SQLITE_READ:
    case constants.SQLITE_FUNCTION:
      return constants.SQLITE_OK;
    default:
      return constants.SQLITE_DENY;
  }
});

// User-supplied query — anything other than a pure SELECT now fails to compile.
db.prepare(userSQL).all();
```

## 11. Explicit resource management with `using`

```javascript
// Requires Node 22+ with TC39 explicit resource management enabled.
function summary(path) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db.prepare('SELECT COUNT(*) AS n FROM events').get();
  // db is closed automatically on scope exit, even on throw.
}
```

## 12. BigInt for large IDs

```javascript
const db = new DatabaseSync('big.db', { readBigInts: true });
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');

const insert = db.prepare('INSERT INTO t (id) VALUES (?)');
insert.run(9007199254740993n);

const row = db.prepare('SELECT id FROM t').get();
typeof row.id;   // 'bigint'
```
