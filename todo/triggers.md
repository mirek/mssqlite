---
name: triggers
description: Implement persisted AFTER and INSTEAD OF triggers. Use when adding trigger DDL, inserted/deleted transition tables, or trigger execution semantics.
---

# Triggers

Support `CREATE`, `ALTER`, and `DROP TRIGGER` with `AFTER` and `INSTEAD OF`
execution for DML statements.

## Implementation

- Parse trigger targets, event lists, options, and statement bodies.
- Map directly transpilable bodies to SQLite triggers; interpret bodies that
  require T-SQL control flow.
- Present statement-level `inserted` and `deleted` rowsets, including
  multi-row operations.
- Persist definitions and catalog metadata, and define nesting, recursion,
  transaction, error, and row-count behavior.

## Completion criteria

- Cover trigger DDL and transition-table references in parser tests.
- Exercise each event, multi-row images, rollback, persistence, and drop/alter.
- Verify trigger effects and errors through `tedious`.
- Update architecture, T-SQL, SQLite, and catalog skills with the final model.
