/**
 * Runtime Molang value. Numbers are IEEE floats (Bedrock stores everything as
 * float). `null` means "missing" for null-coalescing; numeric contexts treat
 * missing as `0`. Arrays come from the host (`array.*` or query results).
 */
export type MolangValue = number | string | MolangValue[] | null;

/** Deterministic random source. Must not use `Math.random()`. */
export interface RandomSource {
  /**
   * Next float in `[0, 1)`.
   *
   * @returns a unit-interval sample.
   */
  next(): number;
}

/**
 * Host capabilities the evaluator cannot invent: queries, arrays, per-entity
 * variables, and randomness.
 */
export interface MolangHost {
  /**
   * Resolve `query.<name>` / `query.<name>(args)`.
   *
   * @param name - Query name without the `query.` prefix (lowercase).
   * @param args - Evaluated arguments; empty when parentheses were omitted.
   * @returns the query result, or `null`/missing when unimplemented.
   */
  query(name: string, args: MolangValue[]): MolangValue;

  /**
   * Look up a named resource-pack array (`array.<name>`).
   *
   * @param name - Array name without the `array.` prefix (lowercase).
   * @returns the array contents, or `null` if unknown.
   */
  getArray(name: string): MolangValue[] | null;

  /**
   * Read a persistent entity variable (`variable.` / `v.`).
   *
   * @param name - Variable name without scope prefix (lowercase).
   * @returns the stored value, or `null` if unset.
   */
  getVariable(name: string): MolangValue;

  /**
   * Write a persistent entity variable.
   *
   * @param name - Variable name without scope prefix (lowercase).
   * @param value - Value to store.
   */
  setVariable(name: string, value: MolangValue): void;

  /**
   * Optional read for `context.` / `c.` values. Default host returns missing.
   *
   * @param name - Context name without scope prefix (lowercase).
   * @returns the context value, or `null` if unset.
   */
  getContext?(name: string): MolangValue;

  /**
   * Optional resolver for `geometry.` / `texture.` / `material.` names.
   * Default returns the fully-qualified lowercase identifier string.
   *
   * @param kind - Resource kind.
   * @param name - Short name without kind prefix (lowercase).
   * @returns the resolved resource reference.
   */
  resolveResource?(
    kind: "geometry" | "texture" | "material",
    name: string,
  ): MolangValue;

  /** Injected RNG used by `math.random*` / `math.die_roll*`. */
  random: RandomSource;
}

/** Parse / evaluation error with a source offset. */
export class MolangError extends Error {
  /**
   * @param message - Human-readable problem.
   * @param position - 0-based character offset in the source string.
   */
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
    this.name = "MolangError";
  }
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??";

export type UnaryOp = "!" | "-";

export type AstNode =
  | NumberLiteral
  | StringLiteral
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | AssignExpr
  | AccessExpr
  | CallExpr
  | IndexExpr
  | BlockExpr
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | LoopExpr
  | ForEachExpr
  | StatementList;

export interface NumberLiteral {
  kind: "number";
  value: number;
  pos: number;
}

export interface StringLiteral {
  kind: "string";
  value: string;
  pos: number;
}

export interface UnaryExpr {
  kind: "unary";
  op: UnaryOp;
  operand: AstNode;
  pos: number;
}

export interface BinaryExpr {
  kind: "binary";
  op: BinaryOp;
  left: AstNode;
  right: AstNode;
  pos: number;
}

export interface TernaryExpr {
  kind: "ternary";
  condition: AstNode;
  consequent: AstNode;
  alternate: AstNode | null;
  pos: number;
}

export interface AssignExpr {
  kind: "assign";
  scope: "variable" | "temp";
  name: string;
  value: AstNode;
  pos: number;
}

export interface AccessExpr {
  kind: "access";
  scope:
    | "variable"
    | "temp"
    | "context"
    | "query"
    | "math"
    | "geometry"
    | "texture"
    | "material"
    | "array";
  name: string;
  pos: number;
}

export interface CallExpr {
  kind: "call";
  callee: AccessExpr;
  args: AstNode[];
  pos: number;
}

export interface IndexExpr {
  kind: "index";
  target: AstNode;
  index: AstNode;
  pos: number;
}

export interface BlockExpr {
  kind: "block";
  body: AstNode[];
  pos: number;
}

export interface ReturnStmt {
  kind: "return";
  value: AstNode;
  pos: number;
}

export interface BreakStmt {
  kind: "break";
  pos: number;
}

export interface ContinueStmt {
  kind: "continue";
  pos: number;
}

export interface LoopExpr {
  kind: "loop";
  count: AstNode;
  body: AstNode;
  pos: number;
}

export interface ForEachExpr {
  kind: "for_each";
  variable: AssignTarget;
  array: AstNode;
  body: AstNode;
  pos: number;
}

export interface AssignTarget {
  scope: "variable" | "temp";
  name: string;
  pos: number;
}

export interface StatementList {
  kind: "statements";
  body: AstNode[];
  /** True when the source used `;` / statement form (result defaults to 0). */
  complex: boolean;
  pos: number;
}
