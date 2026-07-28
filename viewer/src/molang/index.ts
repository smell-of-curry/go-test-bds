import { evaluateAst } from "./eval";
import { createDefaultHost, type DefaultMolangHost } from "./host";
import { parse } from "./parse";
import type { MolangHost, MolangValue, StatementList } from "./types";

export type {
  MolangHost,
  MolangValue,
  RandomSource,
  AstNode,
  StatementList,
} from "./types";
export { MolangError } from "./types";
export {
  createDefaultHost,
  sequenceRandom,
  zeroRandom,
  type DefaultHostOptions,
  type DefaultMolangHost,
} from "./host";
export { MAX_LOOP_ITERATIONS } from "./eval";
export { parse } from "./parse";
export { tokenize } from "./tokenize";

/** Precompiled program: parse once, evaluate many times. */
export interface CompiledMolang {
  readonly source: string;
  readonly ast: StatementList;
  /**
   * Evaluate against a host.
   *
   * @param host - Query / array / variable / RNG bridge.
   * @returns the expression result.
   * @throws {MolangError} on evaluation errors (e.g. runaway loop).
   */
  evaluate(host: MolangHost): MolangValue;
}

const cache = new Map<string, CompiledMolang>();

/**
 * Parse (or fetch a cached) compiled program for `source`.
 *
 * @param source - Molang source text.
 * @returns a cheap-to-re-evaluate compiled handle.
 * @throws {MolangError} when the source is malformed.
 */
export function compile(source: string): CompiledMolang {
  const hit = cache.get(source);
  if (hit) return hit;

  const ast = parse(source);
  const compiled: CompiledMolang = {
    source,
    ast,
    evaluate(host: MolangHost): MolangValue {
      return evaluateAst(ast, host);
    },
  };
  cache.set(source, compiled);
  return compiled;
}

/**
 * Clear the compile-by-source cache (tests / hot reload).
 */
export function clearCompileCache(): void {
  cache.clear();
}

/**
 * Convenience: compile (cached) and evaluate once.
 *
 * When `host` is omitted, a fresh {@link createDefaultHost} is used for that
 * call only (so `temp.*` / query recordings do not leak across calls, while
 * callers that pass a host keep `variable.*` themselves).
 *
 * @param source - Molang source text.
 * @param host - Optional host; defaults to {@link createDefaultHost}.
 * @returns the expression result.
 * @throws {MolangError} on parse or evaluation errors.
 */
export function evaluate(source: string, host?: MolangHost): MolangValue {
  const h = host ?? createDefaultHost();
  return compile(source).evaluate(h);
}

/**
 * Evaluate and return both the result and the default host (for inspecting
 * unimplemented queries / variables in tests).
 *
 * @param source - Molang source text.
 * @param host - Optional prebuilt default host.
 * @returns result plus the host used.
 * @throws {MolangError} on parse or evaluation errors.
 */
export function evaluateWithHost(
  source: string,
  host: DefaultMolangHost = createDefaultHost(),
): { result: MolangValue; host: DefaultMolangHost } {
  return { result: compile(source).evaluate(host), host };
}
