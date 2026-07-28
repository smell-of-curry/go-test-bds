import type { MolangValue } from "./types";

/**
 * Coerce a Molang value to a number. Missing/`null` and non-numeric values
 * become `0` (Bedrock's general error fallback).
 *
 * @param value - Any runtime value.
 * @returns a finite number, or `0` on failure.
 */
export function asNumber(value: MolangValue | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Truthiness: anything not exactly `0` / missing is true.
 *
 * @param value - Any runtime value.
 * @returns whether the value is truthy in Molang.
 */
export function isTruthy(value: MolangValue): boolean {
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return value.length > 0;
}

/**
 * Whether a value is "missing" for `??`.
 *
 * @param value - Any runtime value.
 * @returns true when the left-hand side of `??` should be skipped.
 */
export function isMissing(value: MolangValue): boolean {
  return value === null;
}

/**
 * Wrap an array index per Bedrock:
 * `index = max(0, trunc(expression)) % array_size`
 * (Microsoft Molang Syntax Guide / bedrock.dev Array Expressions).
 *
 * @param raw - Evaluated index expression.
 * @param length - Array length; must be > 0.
 * @returns a safe in-range index.
 */
export function wrapIndex(raw: number, length: number): number {
  if (length <= 0) return 0;
  const truncated = raw < 0 ? 0 : Math.trunc(raw);
  return truncated % length;
}

/**
 * Compare two Molang values with `==` / `!=` semantics.
 *
 * @param a - Left value.
 * @param b - Right value.
 * @returns true when equal.
 */
export function valuesEqual(a: MolangValue, b: MolangValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") {
    return String(a) === String(b);
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  return false;
}
