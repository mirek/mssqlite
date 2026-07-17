---
name: unique-null-semantics
description: Treat repeated NULL-containing keys as duplicates in SQL Server unique constraints and indexes. Use when changing constraints, indexes, or DML validation.
---

# Enforce SQL Server uniqueness for NULL keys

SQLite permits multiple NULL values in a unique key; SQL Server treats the same
NULL-containing key as a duplicate.

## Reproduction

```sql
CREATE TABLE unique_probe (value INT UNIQUE);
INSERT INTO unique_probe VALUES (NULL);
INSERT INTO unique_probe VALUES (NULL);
```

At `bcad53b`, both inserts succeed. SQL Server rejects the second insert. The
same divergence applies to explicitly created unique indexes and composite keys
when the complete key tuple, including NULL positions, repeats.

## Implementation

- Add SQL Server-compatible validation for unique constraints and unique
  indexes instead of delegating NULL behavior directly to SQLite.
- Preserve collation comparison and declared type conversion for every key
  component.
- Integrate with INSERT, UPDATE, MERGE, bulk load, triggers, transactions, and
  filtered unique indexes without weakening atomicity.
- Map failures to the correct 2601/2627 error according to index/constraint
  origin.

## Completion criteria

- Cover single and composite keys, every NULL position, repeated all-NULL keys,
  filtered indexes, case/accent collations, and concurrent sessions.
- Assert statement rollback, `TRY/CATCH`, `XACT_ABORT`, and TDS error metadata.
- Differentially verify against SQL Server 2025.

## Ground truth

- [Create a unique index — NULL restrictions](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/create-unique-indexes?view=sql-server-ver17#before-you-begin)
