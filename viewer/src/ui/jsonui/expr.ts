/**
 * Bedrock JSON UI binding-expression parser + evaluator.
 *
 * These are NOT Molang. Real pack usage (pokebedrock-res sidebar / phone /
 * hud_screen) drives string slicing of `#hud_title_text_string` via
 * `%.Ns` truncation, concat, remove, int-parse, and comparisons.
 */

import type { BindingValue } from "./types.js";

export type BinaryOp =
  "+" | "-" | "*" | "/" | "=" | ">" | "<" | ">=" | "<=" | "and" | "or";

export type UnaryOp = "not" | "-";

export type Expr =
  | { kind: "literal"; value: BindingValue }
  | { kind: "binding"; name: string }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: UnaryOp; arg: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr };

/** Scope for evaluating a parsed expression. */
export interface ExprScope {
  /** Resolve `#name` (name without '#'). */
  binding(name: string): BindingValue | undefined;
  /** Resolve `$name` (name without '$'). */
  variable(name: string): unknown;
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bind"; v: string }
  | { t: "var"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "eof" };

const FORMAT_RE = /^%\.\d+s$/;
const INT_STR_RE = /^-?\d+$/;

/**
 * Tokenize a JSON UI binding expression.
 *
 * @param src Expression source.
 * @returns Token stream including a trailing eof.
 */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    if (c === "'") {
      i++;
      let s = "";
      while (i < src.length && src[i] !== "'") {
        s += src[i];
        i++;
      }
      if (i >= src.length)
        throw new Error(`expr: unterminated string in ${JSON.stringify(src)}`);
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    if (c === "#") {
      i++;
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (i === start)
        throw new Error(`expr: empty binding ref in ${JSON.stringify(src)}`);
      out.push({ t: "bind", v: src.slice(start, i) });
      continue;
    }
    if (c === "$") {
      i++;
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (i === start)
        throw new Error(`expr: empty variable ref in ${JSON.stringify(src)}`);
      out.push({ t: "var", v: src.slice(start, i) });
      continue;
    }
    // Bare %.Ns format token (unquoted), as in `(%.1s * #hud_title_text_string)`.
    if (c === "%" && src[i + 1] === ".") {
      const m = src.slice(i).match(/^%\.\d+s/);
      if (m) {
        out.push({ t: "str", v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (c === ">" || c === "<") {
      if (src[i + 1] === "=") {
        out.push({ t: "op", v: c + "=" });
        i += 2;
      } else {
        out.push({ t: "op", v: c });
        i++;
      }
      continue;
    }
    if (c === "=" || c === "+" || c === "-" || c === "*" || c === "/") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (
      /[0-9]/.test(c) ||
      (c === "." && i + 1 < src.length && /[0-9]/.test(src[i + 1]!))
    ) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
      out.push({ t: "num", v: Number(src.slice(start, i)) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const word = src.slice(start, i);
      if (word === "and" || word === "or" || word === "not") {
        out.push({ t: "op", v: word });
        continue;
      }
      throw new Error(`expr: unexpected identifier ${JSON.stringify(word)}`);
    }
    throw new Error(`expr: unexpected char ${JSON.stringify(c)} at ${i}`);
  }
  out.push({ t: "eof" });
  return out;
}

/**
 * Parse a JSON UI binding expression into an AST.
 *
 * @param src Expression source (may include surrounding whitespace).
 * @returns Parsed expression tree.
 * @throws If the expression is malformed.
 */
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Tok => tokens[pos]!;
  const bump = (): Tok => tokens[pos++]!;
  const opIs = (...ops: string[]): boolean =>
    peek().t === "op" && ops.includes((peek() as { v: string }).v);

  const parsePrimary = (): Expr => {
    const tok = peek();
    if (tok.t === "num") {
      bump();
      return { kind: "literal", value: tok.v };
    }
    if (tok.t === "str") {
      bump();
      return { kind: "literal", value: tok.v };
    }
    if (tok.t === "bind") {
      bump();
      return { kind: "binding", name: tok.v };
    }
    if (tok.t === "var") {
      bump();
      return { kind: "variable", name: tok.v };
    }
    if (tok.t === "lp") {
      bump();
      const inner = parseOr();
      if (peek().t !== "rp")
        throw new Error(`expr: expected ')' in ${JSON.stringify(src)}`);
      bump();
      return inner;
    }
    throw new Error(
      `expr: unexpected token ${JSON.stringify(tok)} in ${JSON.stringify(src)}`,
    );
  };

  const parseUnary = (): Expr => {
    if (opIs("not")) {
      bump();
      return { kind: "unary", op: "not", arg: parseUnary() };
    }
    if (opIs("-")) {
      bump();
      return { kind: "unary", op: "-", arg: parseUnary() };
    }
    return parsePrimary();
  };

  const parseMul = (): Expr => {
    let left = parseUnary();
    while (opIs("*", "/")) {
      const op = (bump() as { t: "op"; v: "*" | "/" }).v;
      left = { kind: "binary", op, left, right: parseUnary() };
    }
    return left;
  };

  const parseAdd = (): Expr => {
    let left = parseMul();
    while (opIs("+", "-")) {
      const op = (bump() as { t: "op"; v: "+" | "-" }).v;
      left = { kind: "binary", op, left, right: parseMul() };
    }
    return left;
  };

  const parseCmp = (): Expr => {
    let left = parseAdd();
    while (opIs("=", ">", "<", ">=", "<=")) {
      const op = (bump() as { t: "op"; v: "=" | ">" | "<" | ">=" | "<=" }).v;
      left = { kind: "binary", op, left, right: parseAdd() };
    }
    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseCmp();
    while (opIs("and")) {
      bump();
      left = { kind: "binary", op: "and", left, right: parseCmp() };
    }
    return left;
  };

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (opIs("or")) {
      bump();
      left = { kind: "binary", op: "or", left, right: parseAnd() };
    }
    return left;
  };

  const expr = parseOr();
  if (peek().t !== "eof")
    throw new Error(`expr: trailing junk in ${JSON.stringify(src)}`);
  return expr;
}

function asString(v: BindingValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function asNumber(v: BindingValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function truthy(v: BindingValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "";
}

function coerceVar(v: unknown): BindingValue {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return v;
  if (v == null) return "";
  return String(v);
}

function isFormat(s: string): boolean {
  return FORMAT_RE.test(s);
}

/**
 * Evaluate a parsed expression against a scope.
 *
 * String-op semantics (from shipping sidebar/phone expressions):
 * - `+` concat if either side is string, else numeric add
 * - `('%.Ns' * str)` / `(%.Ns * str)` → first N chars
 * - `(str * 1)` (numeric string × number) → parseInt
 * - `(str - substr)` → remove first occurrence of substr
 * - `=` equality (strings compare as strings)
 *
 * @param expr Parsed expression.
 * @param scope Binding / variable lookup.
 * @returns Evaluated scalar.
 */
export function evalExpr(expr: Expr, scope: ExprScope): BindingValue {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "binding": {
      const v = scope.binding(expr.name);
      return v === undefined ? "" : v;
    }
    case "variable":
      return coerceVar(scope.variable(expr.name));
    case "unary": {
      const arg = evalExpr(expr.arg, scope);
      if (expr.op === "not") return !truthy(arg);
      return -asNumber(arg);
    }
    case "binary": {
      const left = evalExpr(expr.left, scope);
      if (expr.op === "and")
        return truthy(left) ? truthy(evalExpr(expr.right, scope)) : false;
      if (expr.op === "or")
        return truthy(left) ? true : truthy(evalExpr(expr.right, scope));

      const right = evalExpr(expr.right, scope);

      switch (expr.op) {
        case "+": {
          if (typeof left === "string" || typeof right === "string") {
            return asString(left) + asString(right);
          }
          return asNumber(left) + asNumber(right);
        }
        case "-": {
          if (typeof left === "string" || typeof right === "string") {
            const l = asString(left);
            const r = asString(right);
            const idx = l.indexOf(r);
            if (idx < 0) return l;
            return l.slice(0, idx) + l.slice(idx + r.length);
          }
          return asNumber(left) - asNumber(right);
        }
        case "*": {
          if (typeof left === "string" && isFormat(left)) {
            const n = Number(left.slice(2, -1));
            return asString(right).slice(0, n);
          }
          // `(str * 1)` idiom: numeric string × number → integer parse.
          if (
            typeof left === "string" &&
            typeof right === "number" &&
            INT_STR_RE.test(left.trim())
          ) {
            return parseInt(left.trim(), 10);
          }
          return asNumber(left) * asNumber(right);
        }
        case "/":
          return asNumber(left) / asNumber(right);
        case "=": {
          if (typeof left === "string" || typeof right === "string") {
            return asString(left) === asString(right);
          }
          return asNumber(left) === asNumber(right);
        }
        case ">":
          return asNumber(left) > asNumber(right);
        case "<":
          return asNumber(left) < asNumber(right);
        case ">=":
          return asNumber(left) >= asNumber(right);
        case "<=":
          return asNumber(left) <= asNumber(right);
      }
    }
  }
}
