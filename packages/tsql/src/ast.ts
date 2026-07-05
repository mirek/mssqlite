import type * as TypeName from './type-name.ts'

/** Multi-part object name, e.g. `db.schema.table` → `[ 'db', 'schema', 'table' ]`. */
export type QualifiedName = readonly string[]

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

/** Table hint list is parsed and preserved but otherwise ignored. */
export type TableSource =
  | {
      readonly kind: 'table',
      readonly name: QualifiedName,
      readonly alias?: string,
      readonly hints?: readonly string[]
    }
  | { readonly kind: 'derived', readonly select: Select, readonly alias: string }
  | {
      readonly kind: 'join',
      readonly join: 'inner' | 'left' | 'right' | 'full' | 'cross',
      readonly left: TableSource,
      readonly right: TableSource,
      readonly on?: Expression
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
  readonly groupBy?: readonly Expression[],
  readonly having?: Expression,
  readonly orderBy?: readonly OrderBy[],
  readonly offset?: Expression,
  readonly fetch?: Expression,
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
      readonly source: InsertSource
    }
  | {
      readonly kind: 'update',
      readonly target: QualifiedName,
      readonly top?: Expression,
      readonly set: readonly Assignment[],
      readonly from?: TableSource,
      readonly where?: Expression
    }
  | {
      readonly kind: 'delete',
      readonly target: QualifiedName,
      readonly top?: Expression,
      readonly from?: TableSource,
      readonly where?: Expression
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
      readonly declarations: readonly {
        readonly name: string,
        readonly type: TypeName.t,
        readonly initial?: Expression
      }[]
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
  | { readonly kind: 'break' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'empty' }

export type t =
  Statement
