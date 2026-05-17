# SQLite Extensions

Capabilities that ship with (or can be linked into) SQLite and may be used to map T-SQL features when building an MSSQL-compatible server backed by SQLite.

## Virtual Tables (concept)

A virtual table is an object registered with a database connection that *looks* like a table from SQL but whose reads/writes are dispatched to a module (a class of callbacks). Most SQLite "extensions" listed here are virtual table modules.

```sql
CREATE VIRTUAL TABLE tablename USING modulename(arg1, arg2, ...);
DROP TABLE tablename;
```

Restrictions vs. ordinary tables: no `CREATE INDEX` on a vtab, no triggers on a vtab, no `ALTER TABLE ... ADD COLUMN`. Individual modules may further be read-only, INSERT-only, etc.

**Eponymous virtual tables.** Some modules can be queried directly by module name with no `CREATE VIRTUAL TABLE` — they live in `main` automatically. `dbstat`, `json_each`, `json_tree`, `generate_series`, `carray`, `bytecode`, `tables_used` are all eponymous.

**Table-valued functions.** An eponymous-only vtab whose hidden columns act as arguments. Invoked like a function in the `FROM` clause: `SELECT * FROM json_each('[1,2,3]')`. Useful for unnesting, ranges, host-language array binding.

## JSON1 (built in since 3.38)

SQLite stores JSON as ordinary `TEXT`. Since 3.45 it can also store JSONB — an internal binary parse tree — as `BLOB`. There is no `JSON` type; numeric/NULL SQLite values map to JSON numbers/null, text is parsed as JSON when fed to JSON functions. Input may be canonical JSON or JSON5 (lenient); output is always canonical JSON. Max nesting 1000.

### Scalar functions

| Function | Purpose |
| --- | --- |
| `json(x)` | Validate + minify text JSON; canonicalize JSONB to text |
| `jsonb(x)` | Convert to JSONB blob |
| `json_array(v1,...)` | Build a JSON array |
| `json_object(k1,v1,...)` | Build a JSON object |
| `json_extract(json, path, ...)` | Extract one or more values by path. Returns SQL text/number, or JSON text for arrays/objects |
| `json_set(json, path, val, ...)` | Insert-or-replace at path |
| `json_replace(json, path, val, ...)` | Replace only if path exists |
| `json_insert(json, path, val, ...)` | Insert only if path does not exist |
| `json_remove(json, path, ...)` | Remove paths |
| `json_patch(j1, j2)` | RFC 7396 merge patch |
| `json_array_length(json [, path])` | Length of JSON array |
| `json_array_insert(json, path, val, ...)` | Insert into array at index |
| `json_type(json [, path])` | One of `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'` |
| `json_valid(x [, flags])` | Is it well-formed JSON? |
| `json_quote(value)` | Wrap a SQL value as a JSON literal |
| `json_pretty(json)` | Indented JSON text |
| `json_error_position(x)` | First error byte offset, or 0 |

Every `json_*` scalar that returns JSON has a `jsonb_*` twin that returns the binary form (e.g. `jsonb_extract`, `jsonb_set`, `jsonb_object`, `jsonb_patch`).

### Path operators `->` and `->>`

```sql
SELECT data -> '$.user' FROM t;     -- returns JSON (subtree as JSON text)
SELECT data ->> '$.user.name' FROM t; -- returns SQL value (text/number/null)
SELECT data -> 'c' -> 2 ->> 'f' FROM t; -- chainable; rhs may be bare label/index
```

`->` keeps the result tagged as JSON (downstream JSON functions treat it as a subtree, not a string). `->>` unwraps to a plain SQL value.

### Path syntax

Paths start with `$`, then `.label` or `[N]`, e.g. `$.users[0].name`. Negative indexing via `[#-N]` from the end (`$[#-1]` is the last element). `$[#]` is a one-past-the-end sentinel for appending: `json_set('[0,1]','$[#]','new')` → `[0,1,"new"]`.

### Aggregates

```sql
SELECT json_group_array(name) FROM users;             -- ["alice","bob",...]
SELECT json_group_object(id, name) FROM users;        -- {"1":"alice",...}
-- jsonb_group_array / jsonb_group_object return JSONB blobs
```

### Table-valued functions

`json_each(X [, path])` — iterate the immediate children (or the single top-level element if scalar).
`json_tree(X [, path])` — recursive walk over the entire substructure.
`jsonb_each` / `jsonb_tree` are the JSONB-returning twins (3.51+).

Schema (same for all four):

```sql
CREATE TABLE json_tree(
  key ANY,        -- array index or object label, NULL otherwise
  value ANY,      -- SQL value, or JSON/JSONB text for arrays/objects
  type TEXT,      -- 'null'|'true'|'false'|'integer'|'real'|'text'|'array'|'object'
  atom ANY,       -- value for primitives, NULL for object/array
  id INTEGER,     -- element id
  parent INTEGER, -- parent's id (NULL at root)
  fullkey TEXT,   -- full path to this element
  path TEXT,      -- path to this element's container
  json HIDDEN,    -- input
  root HIDDEN     -- input path
);
```

```sql
-- Unnest a JSON array of tags into rows:
SELECT t.id, je.value AS tag
FROM   things AS t, json_each(t.tags) AS je;

-- Flatten arbitrary nested JSON:
SELECT fullkey, value FROM json_tree(?);
```

### Storage implications

- Storing JSON as `TEXT` is simplest and human-readable; every read parses.
- Storing JSON as JSONB (`BLOB`) skips parsing on read, is slightly smaller, and is compatible with every `json_*` function (they accept either form).
- JSONB is opaque, SQLite-internal, **not** PostgreSQL-compatible despite the name. Do not pass it across applications. Lookups in JSONB are still O(N), not O(1).
- For MSSQL JSON path features (`JSON_VALUE`, `JSON_QUERY`, `JSON_MODIFY`, `OPENJSON`), map to `->>`, `->`, `json_set`, and `json_each`/`json_tree` respectively.

## FTS5 — full-text search

A virtual table module providing inverted-index full-text search.

```sql
CREATE VIRTUAL TABLE email USING fts5(sender, title, body);
-- options: tokenize='porter unicode61', prefix='2 3', content='', content_rowid='id', etc.
```

No column types, constraints, or `PRIMARY KEY` allowed; the implicit `rowid` is the only key. Insert/update/delete normally.

### Querying

```sql
-- These three are equivalent:
SELECT * FROM email WHERE email MATCH 'fts5';
SELECT * FROM email WHERE email = 'fts5';
SELECT * FROM email('fts5');

-- Rank by relevance (BM25, smaller = better):
SELECT * FROM email WHERE email MATCH 'sqlite' ORDER BY rank;

-- Column filter, phrase, NEAR, boolean, prefix:
SELECT * FROM email WHERE email MATCH 'title:sqlite AND body:"full text" NOT spam';
SELECT * FROM email WHERE email MATCH 'NEAR(sql lite, 5)';
SELECT * FROM email WHERE email MATCH 'sql*';   -- prefix
SELECT * FROM email WHERE email MATCH '^hello'; -- initial token in column
```

### Auxiliary functions

- `bm25(table [, weights...])` — score (used by `ORDER BY rank`)
- `highlight(table, colIdx, open, close)` — wrap hits
- `snippet(table, colIdx, open, close, ellipsis, tokens)` — context snippet

Use FTS5 to back `CONTAINS`/`FREETEXT`-like T-SQL features. `MATCH` is the FTS query operator (do not confuse with the JSON-context use of the same word in other docs).

## R*Tree — spatial / range index

Virtual table for fast multi-dimensional range queries. Use when SQL needs "find all entries whose box overlaps query box" (geospatial, CAD, or time-range overlap).

```sql
CREATE VIRTUAL TABLE demo_index USING rtree(
  id,              -- INTEGER PRIMARY KEY
  minX, maxX,
  minY, maxY
);

SELECT id FROM demo_index
 WHERE minX <= -80.77 AND maxX >= -80.77
   AND minY <=  35.38 AND maxY >=  35.38;
```

3 to 11 columns (1 to 5 dimensions). `rtree` stores coordinates as 32-bit float; `rtree_i32` stores them as 32-bit int. Helpful when implementing geo-style queries that T-SQL would push to spatial types — emulate by storing bounding boxes here and the canonical geometry in a regular table.

## generate_series

Eponymous table-valued function for numeric ranges.

```sql
SELECT value FROM generate_series(5, 100, 5);    -- 5,10,...,100
SELECT value FROM generate_series(1, 20);        -- step defaults to 1
```

`generate_series(START, STOP, STEP)` — `STEP` defaults to 1, `STOP` defaults to 4294967295, `START` is required (3.37+). Useful for tally tables, date spines, generating placeholders for `JOIN`-based bulk operations. Works without loading if you fall back to a recursive CTE.

## carray — bind a host-language array as a vtab

Single-column (`value`) eponymous table-valued function whose contents come from a pointer bound by the host application via `sqlite3_carray_bind()` (or `sqlite3_bind_pointer()` with type `"carray"`). Built into the amalgamation since 3.51 but requires `-DSQLITE_ENABLE_CARRAY`.

```sql
-- $PTR is a parameter bound by host code to a C array:
SELECT obj.* FROM obj, carray($PTR) AS x WHERE obj.rowid = x.value;
SELECT * FROM obj WHERE rowid IN carray($PTR);
```

This is the canonical way to ship a variable-length array into a query without dynamic SQL — important for emulating T-SQL table-valued parameters or `IN (@list)` patterns, and for batching `WHERE id IN (...)` against thousands of ids in one prepared statement. Element types: int32, int64, double, text, blob (struct iovec).

## CSV vtab

Read RFC 4180 CSV files as tables. Loadable extension (`ext/misc/csv.c`); not in the default amalgamation.

```sql
.load ./csv
CREATE VIRTUAL TABLE temp.t1 USING csv(filename='thefile.csv', header=true);
CREATE VIRTUAL TABLE temp.t2 USING csv(data='a,b,c\n1,2,3', header);
CREATE VIRTUAL TABLE temp.t3 USING csv(
  filename='x.csv',
  schema='CREATE TABLE x(a INT, b TEXT)'
);
SELECT * FROM t1;
```

Options: `filename=`, `data=`, `schema=`, `columns=N`, `header`. Read-only. Useful for `BULK INSERT`-like ingestion paths.

## spellfix1 — fuzzy / phonetic search

Loadable extension (not in amalgamation). Virtual table for approximate string matching (edit distance + phonetic hashing).

```sql
CREATE VIRTUAL TABLE demo USING spellfix1;
INSERT INTO demo(word) SELECT word FROM big_vocabulary;

SELECT word FROM demo WHERE word MATCH 'kennasaw';      -- top 20 fuzzy
SELECT word FROM demo WHERE word MATCH 'kennes*';       -- prefix
SELECT word FROM demo WHERE word MATCH 'foo' AND top=5; -- limit
```

Use cases: suggest corrections for misspelled terms, soften user input before feeding to FTS5. Each word may carry a `rank` to bias toward common terms.

## dbstat — page-level introspection

Read-only eponymous virtual table exposing per-page storage metrics (`name`, `path`, `pageno`, `pagetype`, `ncell`, `payload`, `unused`, `pgsize`, ...). Requires `SQLITE_ENABLE_DBSTAT_VTAB`.

```sql
SELECT * FROM dbstat;
SELECT name, SUM(pgsize) FROM dbstat GROUP BY name; -- bytes per btree
```

Useful for implementing MSSQL-style space-usage DMVs (e.g. `sp_spaceused`).

## bytecodevtab — query plan introspection

Two read-only eponymous-only table-valued functions: `bytecode(sql)` and `tables_used(sql)`. Requires `SQLITE_ENABLE_BYTECODE_VTAB`.

```sql
SELECT * FROM bytecode('SELECT * FROM t WHERE id=?');   -- VDBE listing
SELECT * FROM tables_used('SELECT * FROM t JOIN u USING(x)');
```

Useful for emulating `sys.dm_exec_query_plan`-style introspection, or for analyzing which tables a statement touches without executing it.

## Sessions / changesets

Compile-time extension (`-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK`) that records row-level changes on tagged tables into a binary **changeset** or **patchset** blob, then applies it (or its inverse) to another database with the same schema.

Concept:

- A session attaches to a connection and watches selected tables.
- INSERT/UPDATE/DELETE per row become entries in the changeset.
- Apply to a peer DB; conflicts (missing row, value mismatch, constraint failure) are resolved by a callback.
- Changesets can be inverted to undo.

Limitations: target tables must have a declared PRIMARY KEY; virtual tables not captured; rows with NULL in PK columns ignored.

Use cases: cross-database replication, undo/redo, offline edit reconciliation. Complements the Node `node:sqlite` Session API and is the right hook for emulating MSSQL change tracking / change data capture features.
