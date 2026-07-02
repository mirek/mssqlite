# mssqlite — Agent Guide

MSSQL compatible, SQLite backed, SQL Server. pnpm TypeScript monorepo,
Node ≥ 22.18, no build step (native type stripping).

## Commands

- `pnpm test` — eslint + tsc + vitest; must pass before committing.
- `pnpm vitest run packages/<name>` — one package's tests.
- `pnpm start` — run the TDS server (`packages/server/src/bin.ts`).

## Skills — read before working

The [.agents/skills](.agents/skills) directory holds living documents —
extend and correct them as part of any change that touches their areas:

- [monorepo](.agents/skills/monorepo/SKILL.md) — repo conventions, prelude
  code style, toolchain. **Read first for any code change.**
- [architecture](.agents/skills/architecture/SKILL.md) — package graph,
  request lifecycle, design decisions, extension points.
- [tds-protocol](.agents/skills/tds-protocol/SKILL.md) — MS-TDS wire
  reference with annotated hex dumps (test vectors).
- [t-sql](.agents/skills/t-sql/SKILL.md) — T-SQL language reference and
  parser implementation notes.
- [sqlite](.agents/skills/sqlite/SKILL.md) — SQLite target reference and
  how mssqlite leans on it.
- [node-sqlite](.agents/skills/node-sqlite/SKILL.md) — `node:sqlite` API
  with version-availability notes.
- [sys](.agents/skills/sys/SKILL.md) — sys.* catalog spec and status.
- [tedious](.agents/skills/tedious/SKILL.md) — e2e testing with the
  tedious client.

## Ground rules

- Bottom-up: a package is done only with tests and a Readme.
- Prelude style (see monorepo skill): no semicolons, `type` over
  `interface`, readonly data, pure functions, results-as-values.
- Test against ground truth: spec hex dumps, real SQLite execution,
  real tedious connections.
