import { compile, type CompiledMolang, type MolangHost } from "../molang";
import type { MolangExpr } from "./types";

/**
 * Strip Bedrock float suffixes (`0.2f`) so the Molang lexer accepts the token.
 *
 * @param source - Raw expression text from particle JSON.
 * @returns sanitised Molang source.
 */
export function sanitizeMolangSource(source: string): string {
  return source.replace(/(\d+\.?\d*)[fF]\b/g, "$1");
}

/**
 * Parse a particle-JSON Molang field (number, string, or `{expression,version}`).
 *
 * @param raw - Unknown JSON value.
 * @param fallback - Used when the field is missing / unreadable.
 * @returns a number or compiled program.
 */
export function parseExpr(raw: unknown, fallback = 0): MolangExpr {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") {
    const s = sanitizeMolangSource(raw.trim());
    if (!s) return fallback;
    const asNum = Number(s);
    if (s !== "" && Number.isFinite(asNum) && /^-?\d/.test(s)) return asNum;
    try {
      return compile(s);
    } catch {
      return fallback;
    }
  }
  if (raw && typeof raw === "object") {
    const expr = (raw as { expression?: unknown }).expression;
    if (typeof expr === "string") return parseExpr(expr, fallback);
    if (typeof expr === "number") return parseExpr(expr, fallback);
  }
  return fallback;
}

/**
 * Evaluate an expression against a host.
 *
 * @param expr - Number or compiled Molang.
 * @param host - Variable / RNG bridge.
 * @returns numeric result (non-numbers → 0).
 */
export function evalExpr(expr: MolangExpr, host: MolangHost): number {
  if (typeof expr === "number") return expr;
  try {
    const v = (expr as CompiledMolang).evaluate(host);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Parse a length-3 Molang vector, padding missing slots with `fallback`.
 *
 * @param raw - JSON array or missing.
 * @param fallback - Per-component default.
 * @returns three expressions.
 */
export function parseVec3(
  raw: unknown,
  fallback: [number, number, number] = [0, 0, 0],
): [MolangExpr, MolangExpr, MolangExpr] {
  if (!Array.isArray(raw)) {
    return [fallback[0], fallback[1], fallback[2]];
  }
  return [
    parseExpr(raw[0], fallback[0]),
    parseExpr(raw[1], fallback[1]),
    parseExpr(raw[2], fallback[2]),
  ];
}

/**
 * Evaluate a length-3 expression vector.
 *
 * @param v - Expression triple.
 * @param host - Molang host.
 * @returns numeric xyz.
 */
export function evalVec3(
  v: [MolangExpr, MolangExpr, MolangExpr],
  host: MolangHost,
): [number, number, number] {
  return [evalExpr(v[0], host), evalExpr(v[1], host), evalExpr(v[2], host)];
}
