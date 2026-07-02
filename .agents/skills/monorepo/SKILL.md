---
name: monorepo
description: "mssqlite repository conventions: pnpm workspace layout, prelude code style (file-per-function, namespace re-exports, immutable readers/results), node-native TypeScript execution, eslint/vitest toolchain, how to add packages and what every package must ship (tests + Readme). Use when writing or reviewing any code in this repo, adding a package, or setting up tooling."
---

# mssqlite Monorepo Conventions

pnpm TypeScript monorepo in the style of the `@prelude/*` packages
(https://www.npmjs.com/org/prelude). Node ≥ 22.18, no build step.

## Layout

```
packages/
  bytes/       @mssqlite/bytes       binary cursor/codecs
  tds/         @mssqlite/tds         TDS wire protocol
  tsql/        @mssqlite/tsql        T-SQL lexer/parser
  transpile/   @mssqlite/transpile   AST → SQLite SQL
  catalog/     @mssqlite/catalog     sys.* emulation
  engine/      @mssqlite/engine      execution engine
  server/      @mssqlite/server      TCP TDS server
```

Dependencies point strictly downward (bytes ← tds ← server; tsql ←
transpile ← engine ← server). Lower layers never import higher ones.

## Code style (prelude style)

- **No semicolons, single quotes, 2-space indent**, spaced brackets
  (`[ 1, 2 ]`, `{ a: 1 }`), trailing `?`/`:` multi-line ternaries.
  Enforced by `@prelude/eslint-config` — run `pnpm lint`.
- **`type`, never `interface`.** Data is `readonly`; behavior is pure
  functions. Classes only for `Error` subtypes.
- **File-per-function** for combinators/primitives (`decode/uint-le.ts`),
  module-per-concept for cohesive groups (`cursor.ts`, `result.ts`).
  Files export named functions plus `export default` for the main one.
- **OCaml-style module types** — a module's main type is aliased as `t`
  (`Cursor.t`, `Result.t<T>`), consumed via namespace imports:
  `import * as Cursor from './cursor.ts'`.
- **Index files namespace re-export**:
  `export * as Decode from './decode.ts'` plus flat `export * from` for
  functions meant to be spelled unqualified.
- **Failures are values** where parsing/decoding is concerned
  (`Result.ok` / `Result.fail`, `failed()` guard) — exceptions only at
  API boundaries (`parse()` throws `ParseError`, engine throws
  `MssqlError`).
- JSDoc one-liners in `@returns …` form on exported functions.

## TypeScript execution — no build

- Imports use **explicit `.ts` extensions** (`import x from './x.ts'`).
  This deviates from published prelude packages (which compile to `.js`)
  because Node ≥ 22.18 runs TypeScript natively via type stripping and
  requires real specifiers. `rewriteRelativeImportExtensions` is on, so a
  future `tsc` build emits correct `.js`.
- `erasableSyntaxOnly` — no enums, no parameter properties, no value
  namespaces. Class fields assign in the constructor body.
- Cross-package **runtime** imports go through the package root
  (`import { Token } from '@mssqlite/tds'`) whose `exports` maps `"."`
  to `./src/index.ts` (internal-package pattern; workspace symlinks
  resolve outside `node_modules`, so stripping applies). **Type** imports
  also come from the root (`import type { Ast } from '@mssqlite/tsql'`) —
  subpath `.ts` imports across packages trip TS2877.
- One root `tsconfig.json` covers all packages (`pnpm typecheck`).

## Testing

- **vitest**, tests colocated as `src/*.test.ts`
  (`import { expect, test } from 'vitest'` — same shape as prelude's
  jest tests). Single root `vitest.config.ts`, include glob
  `packages/*/src/**/*.test.ts`.
- Test against **ground truth** wherever it exists: tds tests assert
  exact bytes from the MS-TDS annotated hex dumps (tds-protocol skill);
  transpile tests execute emitted SQL on a real `node:sqlite` database;
  server tests drive a real `tedious` client end-to-end.
- `pnpm test` = eslint + tsc + vitest. All three must pass before commit.

## Adding a package

1. `packages/<name>/package.json` — `@mssqlite/<name>`, `"private": true`,
   `"type": "module"`, `exports` `"."` → `./src/index.ts` and `"./*"` →
   `./src/*`, workspace deps as `"workspace:*"`, author/license matching
   the others.
2. `src/index.ts` with namespace re-exports.
3. Colocated tests and a `Readme.md` documenting the API and design
   decisions. A package is not done until both exist.
4. `pnpm install` to link, then `pnpm test`.

## Root eslint deviations

Documented in `eslint.config.mjs`: type-aware `no-use-before-define`
(mutually recursive grammars/AST types, lazy variable refs allowed) and
`no-param-reassign` exemptions for intentionally mutable state carriers
(`ctx`, `session`, `variable`, `connection`).

## Gotchas

- eslint is pinned to `9.5.0` — `@prelude/eslint-config` bundles
  typescript-eslint 7, which breaks against newer eslint rule internals.
- `sonarjs/cognitive-complexity` warnings are tolerated in parser/codec
  dispatch functions; don't contort code to silence them.
- pnpm 10 blocks postinstall scripts — `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` allowlists esbuild.
