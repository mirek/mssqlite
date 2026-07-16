import type * as TypeName from './type-name.ts'

/** Multi-part object name, e.g. `db.schema.table` → `[ 'db', 'schema', 'table' ]`. */
export type QualifiedName = readonly string[]

/** Declared source column metadata populated by the execution engine. */
export type SourceColumn = {
  readonly name: string,
  readonly type?: TypeName.t,
  readonly nullable?: boolean
}

/** ORDER BY item. */
export type OrderBy = {
  readonly expression: Expression,
  readonly descending: boolean
}

/** OVER clause of a window function. */
export type Over = {
  readonly partitionBy: readonly Expression[],
  readonly orderBy: readonly OrderBy[]
}

/** Expressions. */
export type Expression =
  | { readonly kind: 'null' }
  | { readonly kind: 'default' }
  | { readonly kind: 'number', readonly value: string }
  | { readonly kind: 'string', readonly value: string, readonly national: boolean }
  | { readonly kind: 'binary', readonly value: string }
  | { readonly kind: 'variable', readonly name: string }
  | { readonly kind: 'column', readonly name: QualifiedName }
  | { readonly kind: 'unary', readonly operator: '-' | '+' | '~' | 'not', readonly operand: Expression }
  | {
      readonly kind: 'binaryOp',
      readonly operator: string,
      readonly left: Expression,
      readonly right: Expression
    }
  | {
      readonly kind: 'call',
      readonly name: QualifiedName,
      readonly args: readonly Expression[],
      readonly star?: boolean,
      readonly distinct?: boolean,
      readonly over?: Over
    }
  | {
      readonly kind: 'cast',
      readonly expression: Expression,
      readonly type: TypeName.t,
      readonly try_: boolean
    }
  | {
      readonly kind: 'convert',
      readonly type: TypeName.t,
      readonly expression: Expression,
      readonly style?: Expression,
      readonly try_: boolean
    }
  | {
      readonly kind: 'case',
      readonly operand?: Expression,
      readonly whens: readonly { readonly when: Expression, readonly then: Expression }[],
      readonly else_?: Expression
    }
  | {
      readonly kind: 'in',
      readonly expression: Expression,
      readonly values: readonly Expression[] | Select,
      readonly negated: boolean
    }
  | {
      readonly kind: 'like',
      readonly expression: Expression,
      readonly pattern: Expression,
      readonly escape?: Expression,
      readonly negated: boolean
    }
  | {
      readonly kind: 'between',
      readonly expression: Expression,
      readonly low: Expression,
      readonly high: Expression,
      readonly negated: boolean
    }
  | { readonly kind: 'isNull', readonly expression: Expression, readonly negated: boolean }
  | { readonly kind: 'exists', readonly select: Select }
  | { readonly kind: 'subquery', readonly select: Select }

/** SELECT list item. */
export type SelectItem =
  | { readonly kind: 'star', readonly qualifier?: QualifiedName }
  | {
      readonly kind: 'expression',
      readonly expression: Expression,
      readonly alias?: string
    }
  | {
      readonly kind: 'assign',
      readonly variable: string,
      readonly operator: string,
      readonly expression: Expression
    }

/** Column projected by an explicit OPENJSON WITH schema. */
export type TableFunctionColumn = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly path?: string,
  readonly asJson: boolean
}

/** Table hint list is parsed and preserved but otherwise ignored. */
export type TableSource =
  | {
      readonly kind: 'table',
      readonly name: QualifiedName,
      readonly alias?: string,
      readonly hints?: readonly string[],
      /** Execution-time source metadata, populated by the engine when needed. */
      readonly columns?: readonly SourceColumn[]
    }
  | {
      readonly kind: 'function',
      readonly name: QualifiedName,
      readonly args: readonly Expression[],
      readonly with?: readonly TableFunctionColumn[],
      readonly alias?: string,
      readonly columns?: readonly string[]
    }
  | { readonly kind: 'derived', readonly select: Select, readonly alias: string }
  | {
      readonly kind: 'pivot',
      readonly source: TableSource,
      readonly aggregate: { readonly name: QualifiedName, readonly expression: Expression },
      readonly pivotColumn: QualifiedName,
      readonly values: readonly string[],
      readonly alias: string
    }
  | {
      readonly kind: 'unpivot',
      readonly source: TableSource,
      readonly valueColumn: string,
      readonly pivotColumn: string,
      readonly columns: readonly string[],
      readonly alias: string
    }
  | {
      readonly kind: 'join',
      readonly join: 'inner' | 'left' | 'right' | 'full' | 'cross' | 'crossApply' | 'outerApply',
      readonly left: TableSource,
      readonly right: TableSource,
      readonly on?: Expression
    }

/** One grouping unit; multiple expressions in a unit roll up together. */
export type GroupingUnit = readonly Expression[]

/** ROLLUP/CUBE or an explicit expression tuple inside GROUPING SETS. */
export type GroupingSetItem =
  | { readonly kind: 'expressions', readonly expressions: readonly Expression[] }
  | { readonly kind: 'rollup', readonly units: readonly GroupingUnit[] }
  | { readonly kind: 'cube', readonly units: readonly GroupingUnit[] }

/** One comma-separated top-level GROUP BY item. */
export type GroupByItem =
  | GroupingSetItem
  | { readonly kind: 'sets', readonly sets: readonly GroupingSetItem[] }

/** FOR JSON output mode and options. */
export type ForJson = {
  readonly mode: 'path' | 'auto',
  readonly root?: string,
  readonly includeNullValues: boolean,
  readonly withoutArrayWrapper: boolean
}

/** Common table expression. */
export type Cte = {
  readonly name: string,
  readonly columns?: readonly string[],
  readonly select: Select
}

/** SELECT statement (also used as subquery). */
export type Select = {
  readonly kind: 'select',
  readonly ctes?: readonly Cte[],
  readonly distinct: boolean,
  readonly top?: { readonly count: Expression, readonly percent: boolean, readonly withTies?: boolean },
  readonly items: readonly SelectItem[],
  readonly into?: QualifiedName,
  readonly from?: TableSource,
  readonly where?: Expression,
  readonly groupBy?: readonly GroupByItem[],
  readonly having?: Expression,
  readonly orderBy?: readonly OrderBy[],
  readonly offset?: Expression,
  readonly fetch?: Expression,
  readonly forJson?: ForJson,
  readonly union?: {
    readonly kind: 'union' | 'unionAll' | 'except' | 'intersect',
    readonly select: Select
  }
}

/** INSERT source. */
export type InsertSource =
  | { readonly kind: 'values', readonly rows: readonly (readonly Expression[])[] }
  | { readonly kind: 'select', readonly select: Select }
  | { readonly kind: 'defaultValues' }

/** Column definition in CREATE TABLE / ALTER TABLE ADD. */
export type ColumnDefinition = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly nullable?: boolean,
  readonly identity?: { readonly seed: number, readonly increment: number },
  readonly default_?: Expression,
  readonly primaryKey?: boolean,
  readonly unique?: boolean,
  readonly check?: Expression,
  readonly references?: {
    readonly table: QualifiedName,
    readonly columns?: readonly string[],
    readonly onDelete?: ReferentialAction,
    readonly onUpdate?: ReferentialAction
  },
  readonly collate?: string,
  readonly rowguidcol?: boolean,
  readonly constraintName?: string
}

export type ReferentialAction =
  'noAction' | 'cascade' | 'setNull' | 'setDefault'

/** Table-level constraint in CREATE TABLE / ALTER TABLE ADD. */
export type TableConstraint =
  | {
      readonly kind: 'primaryKey' | 'unique',
      readonly name?: string,
      readonly clustered?: boolean,
      readonly columns: readonly { readonly name: string, readonly descending: boolean }[]
    }
  | {
      readonly kind: 'foreignKey',
      readonly name?: string,
      readonly columns: readonly string[],
      readonly references: {
        readonly table: QualifiedName,
        readonly columns?: readonly string[],
        readonly onDelete?: ReferentialAction,
        readonly onUpdate?: ReferentialAction
      }
    }
  | { readonly kind: 'check', readonly name?: string, readonly expression: Expression }

/** Parameter declaration of CREATE PROCEDURE. */
export type ProcedureParameter = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly default_?: Expression,
  readonly output: boolean
}

/** Parameter declaration of CREATE FUNCTION. */
export type FunctionParameter = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly default_?: Expression
}

/** Scalar or table-shaped local variable declaration. */
export type Declaration =
  | {
      readonly kind: 'scalar',
      readonly name: string,
      readonly type: TypeName.t,
      readonly initial?: Expression
    }
  | {
      readonly kind: 'table',
      readonly name: string,
      readonly columns: readonly ColumnDefinition[],
      readonly constraints: readonly TableConstraint[]
    }

/**
 * OUTPUT clause of INSERT / UPDATE / DELETE — select items over the
 * `inserted` / `deleted` pseudo-tables, optionally routed INTO a table.
 */
export type Output = {
  readonly items: readonly SelectItem[],
  readonly into?: {
    readonly table: QualifiedName,
    readonly columns?: readonly string[]
  }
}

/** Action of a MERGE WHEN clause. */
export type MergeAction =
  | { readonly kind: 'update', readonly set: readonly Assignment[] }
  | { readonly kind: 'delete' }
  | {
      readonly kind: 'insert',
      readonly columns?: readonly string[],
      /** Single VALUES row; absent for INSERT DEFAULT VALUES. */
      readonly values?: readonly Expression[]
    }

/** WHEN clause of MERGE. */
export type MergeWhen = {
  readonly match: 'matched' | 'notMatchedByTarget' | 'notMatchedBySource',
  readonly condition?: Expression,
  readonly action: MergeAction
}

/** SET assignment in UPDATE. */
export type Assignment = {
  readonly target:
    | { readonly kind: 'column', readonly name: QualifiedName }
    | { readonly kind: 'variable', readonly name: string },
  readonly operator: string,
  readonly value: Expression
}

/** Statements. */
export type Statement =
  | Select
  | {
      readonly kind: 'insert',
      readonly table: QualifiedName,
      readonly columns?: readonly string[],
      readonly output?: Output,
      readonly source: InsertSource
    }
  | {
      readonly kind: 'update',
      readonly target: QualifiedName,
      readonly top?: Expression,
      readonly set: readonly Assignment[],
      readonly output?: Output,
      readonly from?: TableSource,
      readonly where?: Expression
    }
  | {
      readonly kind: 'delete',
      readonly target: QualifiedName,
      readonly top?: Expression,
      readonly output?: Output,
      readonly from?: TableSource,
      readonly where?: Expression
    }
  | {
      readonly kind: 'merge',
      readonly target: QualifiedName,
      readonly alias?: string,
      readonly source: TableSource,
      readonly on: Expression,
      readonly whens: readonly MergeWhen[],
      readonly output?: Output
    }
  | {
      readonly kind: 'createTable',
      readonly name: QualifiedName,
      readonly columns: readonly ColumnDefinition[],
      readonly constraints: readonly TableConstraint[]
    }
  | { readonly kind: 'dropTable', readonly names: readonly QualifiedName[], readonly ifExists: boolean }
  | {
      readonly kind: 'createIndex',
      readonly unique: boolean,
      readonly clustered?: boolean,
      readonly name: string,
      readonly table: QualifiedName,
      readonly columns: readonly { readonly name: string, readonly descending: boolean }[],
      readonly include?: readonly string[],
      readonly where?: Expression
    }
  | { readonly kind: 'dropIndex', readonly name: string, readonly table?: QualifiedName, readonly ifExists: boolean }
  | {
      readonly kind: 'createView',
      readonly name: QualifiedName,
      readonly columns?: readonly string[],
      readonly select: Select,
      readonly orReplace?: boolean
    }
  | { readonly kind: 'dropView', readonly names: readonly QualifiedName[], readonly ifExists: boolean }
  | {
      readonly kind: 'alterTable',
      readonly name: QualifiedName,
      readonly action:
        | { readonly kind: 'addColumns', readonly columns: readonly ColumnDefinition[] }
        | { readonly kind: 'dropColumns', readonly columns: readonly string[] }
        | { readonly kind: 'addConstraints', readonly constraints: readonly TableConstraint[] }
        | { readonly kind: 'dropConstraints', readonly names: readonly string[] }
    }
  | {
      readonly kind: 'declare',
      readonly declarations: readonly Declaration[]
    }
  | {
      readonly kind: 'setVariable',
      readonly name: string,
      readonly operator: string,
      readonly value: Expression
    }
  | {
      readonly kind: 'setOption',
      readonly options: readonly string[],
      readonly value: string
    }
  | { readonly kind: 'if', readonly condition: Expression, readonly then: Statement, readonly else_?: Statement }
  | { readonly kind: 'while', readonly condition: Expression, readonly body: Statement }
  | { readonly kind: 'block', readonly statements: readonly Statement[] }
  | { readonly kind: 'beginTransaction', readonly name?: string }
  | { readonly kind: 'commitTransaction', readonly name?: string }
  | { readonly kind: 'rollbackTransaction', readonly name?: string }
  | { readonly kind: 'saveTransaction', readonly name: string }
  | { readonly kind: 'use', readonly database: string }
  | { readonly kind: 'print', readonly expression: Expression }
  | {
      readonly kind: 'execute',
      readonly procedure: QualifiedName,
      readonly args: readonly {
        readonly name?: string,
        readonly value: Expression,
        readonly output: boolean
      }[],
      readonly result?: string
    }
  | { readonly kind: 'truncate', readonly table: QualifiedName }
  | { readonly kind: 'return', readonly expression?: Expression }
  | {
      readonly kind: 'throw',
      readonly number?: Expression,
      readonly message?: Expression,
      readonly state?: Expression
    }
  | {
      readonly kind: 'createProcedure',
      readonly name: QualifiedName,
      readonly action: 'create' | 'alter' | 'createOrAlter',
      readonly parameters: readonly ProcedureParameter[],
      readonly body: readonly Statement[],
      /** Source text of the whole batch, stored in sys.sql_modules. */
      readonly definition: string
    }
  | {
      readonly kind: 'dropProcedure',
      readonly names: readonly QualifiedName[],
      readonly ifExists: boolean
    }
  | {
      readonly kind: 'createFunction',
      readonly name: QualifiedName,
      readonly action: 'create' | 'alter' | 'createOrAlter',
      readonly parameters: readonly FunctionParameter[],
      readonly returns:
        | { readonly kind: 'scalar', readonly type: TypeName.t, readonly body: readonly Statement[] }
        | { readonly kind: 'table', readonly select: Select },
      /** Source text of the whole batch, stored in sys.sql_modules. */
      readonly definition: string
    }
  | {
      readonly kind: 'dropFunction',
      readonly names: readonly QualifiedName[],
      readonly ifExists: boolean
    }
  | {
      readonly kind: 'tryCatch',
      readonly try_: readonly Statement[],
      readonly catch_: readonly Statement[]
    }
  | {
      readonly kind: 'raiserror',
      readonly args: readonly Expression[],
      readonly options: readonly string[]
    }
  | { readonly kind: 'break' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'empty' }

export type t =
  Statement
