# Fixed integer result metadata

## Evidence

The live differential run on 2026-07-18 against SQL Server 2025
17.0.4065.4 shows integer wire mismatches in six independent cases:

- `system scalar result metadata`, projections 0 and 1
- `ordered result token stream`, projection 0
- `implicit type conversions`, projection 1
- `string comparison padding`, projection 0
- `derived table apply`, projection 0
- `identity seed and increment`, projection 0

SQL Server exposes each proven non-null `int` result as fixed TDS `Int` with no
length byte. mssqlite exposes `IntN` with length 4. The trace also revealed that
`@@TRANCOUNT` is incorrectly marked nullable and `XACT_STATE()` is advertised
as 4-byte rather than SQL Server's nullable 2-byte integer. Values are correct;
TYPE_INFO is not.

The exact paths and values are declared through `fixedInt()` in
`packages/differential/src/corpus.ts`.

## Work

Carry expression/source nullability far enough through engine metadata
inference to select fixed integer TYPE_INFO for non-null tinyint, smallint, int,
and bigint results. Do not globally replace nullable-family types: nullable
columns and expressions must continue to use `IntN` with the correct width.

Likely boundaries are `packages/transpile/src/implicit.ts`, engine projection
metadata, and `packages/server/src/respond.ts` / TDS TYPE_INFO selection.

## Acceptance

- The live `fixedInt()` expectations plus the `@@TRANCOUNT` nullability and
  `XACT_STATE()` width expectations become stale and can be removed without
  adding normalization.
- Add focused metadata tests for fixed and nullable expressions at every
  integer width, including an empty result set.
- `pnpm test` and `pnpm test:differential` pass.
