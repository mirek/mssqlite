# Match ISJSON, JSON_VALUE, and JSON_QUERY semantics

## Summary

Direct JSON1 mappings expose SQLite JSON types and normalization where SQL
Server returns nvarchar text, NULL, or a different validity result.

## Reproduction

```sql
SELECT ISJSON('42') AS value;
SELECT ISJSON('true') AS value;
SELECT JSON_VALUE(N'{"a":42}', '$.a') AS value;
SELECT JSON_VALUE(N'{"a":{"b":1}}', '$.a') AS value;
SELECT JSON_VALUE(N'{"a":[1,2]}', '$.a') AS value;
SELECT JSON_VALUE(N'{"a":true}', '$.a') AS value;
SELECT JSON_QUERY(N'{"a": { "b": 1 }}', '$.a') AS value;
```

SQL Server's default `ISJSON` form returns 0 for a top-level number or boolean;
mssqlite returns 1. `JSON_VALUE` returns nvarchar text (`'42'`, `'true'`) for
scalars and NULL for objects/arrays; mssqlite returns SQLite integers or
serialized objects/arrays. SQL Server preserves the selected JSON fragment's
interior whitespace in the `JSON_QUERY` example, while mssqlite minifies it.

## Acceptance criteria

- Implement SQL Server's default object/array constraint for one-argument
  `ISJSON`.
- Make `JSON_VALUE` return scalar nvarchar text only, with NULL for
  objects/arrays and the SQL Server 4000-character lax/strict behavior.
- Preserve the selected fragment text for `JSON_QUERY` where SQL Server does.
- Emit `nvarchar(4000)` metadata for `JSON_VALUE`/`JSON_QUERY` instead of
  value-inferred numeric or nvarchar(max) metadata.
- Cover missing paths, NULL, booleans, numbers, strings, arrays, objects,
  malformed JSON, and strict/lax paths.
