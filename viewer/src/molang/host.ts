import type { MolangHost, MolangValue, RandomSource } from "./types";

/** Always returns `0` — safe default for golden-image renders. */
export const zeroRandom: RandomSource = {
  next(): number {
    return 0;
  },
};

/**
 * Build a sequential random source from an explicit unit-interval stream.
 *
 * @param values - Samples in `[0, 1)`; cycles if exhausted.
 * @returns a {@link RandomSource}.
 */
export function sequenceRandom(values: number[]): RandomSource {
  let i = 0;
  return {
    next(): number {
      if (values.length === 0) return 0;
      const v = values[i % values.length]!;
      i++;
      return v;
    },
  };
}

export interface DefaultHostOptions {
  /** Seed entity variables. */
  variables?: Record<string, MolangValue>;
  /** Named arrays for `array.*`. */
  arrays?: Record<string, MolangValue[]>;
  /** Context values for `context.*` / `c.*`. */
  context?: Record<string, MolangValue>;
  /** Known query implementations; unknowns are recorded and return `0`. */
  queries?: Record<
    string,
    MolangValue | ((args: MolangValue[]) => MolangValue)
  >;
  /** Injected RNG (defaults to {@link zeroRandom}). */
  random?: RandomSource;
}

export interface DefaultMolangHost extends MolangHost {
  /** Queries that fell through to the unimplemented path. */
  readonly unimplementedQueries: readonly string[];
  /** Clear the unimplemented-query log. */
  clearUnimplemented(): void;
}

/**
 * Default host: persistent `variable.*` storage, injectable arrays/queries/RNG,
 * and a recorder for unknown queries (returns `0` so renders stay deterministic).
 *
 * @param options - Optional seeds and overrides.
 * @returns a mutable host suitable for tests and as a caller baseline.
 */
export function createDefaultHost(
  options: DefaultHostOptions = {},
): DefaultMolangHost {
  const variables = new Map<string, MolangValue>(
    Object.entries(options.variables ?? {}).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  const arrays = new Map<string, MolangValue[]>(
    Object.entries(options.arrays ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const context = new Map<string, MolangValue>(
    Object.entries(options.context ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const queries = new Map(
    Object.entries(options.queries ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const unimplemented: string[] = [];

  return {
    random: options.random ?? zeroRandom,
    unimplementedQueries: unimplemented,
    clearUnimplemented(): void {
      unimplemented.length = 0;
    },
    query(name: string, args: MolangValue[]): MolangValue {
      const impl = queries.get(name);
      if (impl === undefined) {
        const key = args.length ? `${name}(${args.length})` : name;
        unimplemented.push(key);
        return 0;
      }
      return typeof impl === "function" ? impl(args) : impl;
    },
    getArray(name: string): MolangValue[] | null {
      return arrays.get(name) ?? null;
    },
    getVariable(name: string): MolangValue {
      return variables.has(name) ? variables.get(name)! : null;
    },
    setVariable(name: string, value: MolangValue): void {
      variables.set(name, value);
    },
    getContext(name: string): MolangValue {
      return context.has(name) ? context.get(name)! : null;
    },
  };
}
