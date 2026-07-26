import { system } from "@minecraft/server";
import type { Bot } from "./bot";
import { cancelAllInstructions } from "./client";
import {
  ConsoleReporter,
  MultiReporter,
  type Reporter,
  type RunResult,
  type RunTotals,
  StructuredReporter,
  type SuiteResult,
  type TestResult,
  type TestStatus,
} from "./reporter";
import { msToTicks } from "./protocol";

/** Handed to every test, hook and suite callback. */
export interface TestContext {
  /** The first bot in the run. Most tests only need this one. */
  readonly bot: Bot;
  /** Every bot in the run, for tests that need more than one player. */
  readonly bots: Bot[];
  /** Identifier of the current run. */
  readonly runId: string;
  /**
   * Records a breadcrumb. Lines are attached to the test's result and printed
   * when it fails, so log the things you would want to know from a CI log you
   * cannot reproduce locally.
   *
   * @param message The line to record.
   */
  log(message: string): void;
}

/** A single test case. */
export interface TestCase {
  /** Unique-within-its-suite name. Shown in reports; keep it a sentence. */
  name: string;
  /**
   * The test body. Throw (or let an assertion throw) to fail.
   *
   * @param ctx The run context.
   * @returns Nothing, or a promise for an async test.
   */
  run(ctx: TestContext): Promise<void> | void;
  /** Overrides the suite's per-test timeout. */
  timeoutMs?: number;
  /** Skip this test; a string is reported as the reason. */
  skip?: boolean | string;
  /** Labels for filtering, e.g. `["tutorial", "slow"]`. */
  tags?: string[];
}

/** A group of related tests sharing setup. */
export interface TestSuite {
  /** Unique name across the whole run. */
  name: string;
  /** The tests, run in order. */
  tests: TestCase[];
  /** Default per-test timeout for this suite. */
  timeoutMs?: number;
  /** Labels for filtering. Tests inherit these for filter purposes. */
  tags?: string[];
  /**
   * Runs once before the suite's tests. If it throws, every test in the suite
   * is reported as skipped rather than failed, so one broken fixture does not
   * masquerade as many broken features.
   *
   * @param ctx The run context.
   * @returns Nothing, or a promise.
   */
  setup?(ctx: TestContext): Promise<void> | void;
  /**
   * Runs once after the suite's tests, even when they failed.
   *
   * @param ctx The run context.
   * @returns Nothing, or a promise.
   */
  teardown?(ctx: TestContext): Promise<void> | void;
  /**
   * Runs before each test.
   *
   * @param ctx The run context.
   * @returns Nothing, or a promise.
   */
  beforeEach?(ctx: TestContext): Promise<void> | void;
  /**
   * Runs after each test, even when it failed.
   *
   * @param ctx The run context.
   * @returns Nothing, or a promise.
   */
  afterEach?(ctx: TestContext): Promise<void> | void;
}

/** Narrows which suites and tests a run executes. */
export interface TestFilter {
  /** Only run suites whose name contains one of these (case-insensitive). */
  suites?: string[];
  /** Only run tests whose name contains one of these (case-insensitive). */
  tests?: string[];
  /** Only run tests carrying at least one of these tags. */
  tags?: string[];
  /** Skip tests carrying any of these tags, e.g. `["slow"]`. */
  excludeTags?: string[];
}

/** Options for {@link runSuites}. */
export interface RunOptions {
  /** Bots available to the tests. At least one is required. */
  bots: Bot[];
  /** Where results go. Defaults to console + structured reporters. */
  reporter?: Reporter;
  /** Identifier for this run. Defaults to a timestamp-derived id. */
  runId?: string;
  /** Per-test timeout when neither the test nor its suite sets one. */
  defaultTestTimeoutMs?: number;
  /** Restricts what runs. */
  filter?: TestFilter;
  /** Abandon the remaining tests after the first failure. */
  stopOnFirstFailure?: boolean;
}

/**
 * Identity helper that gives editors full type inference when declaring a
 * suite, and a single place to change if the shape grows.
 *
 * @param suite The suite to declare.
 * @returns The same suite.
 */
export function defineSuite(suite: TestSuite): TestSuite {
  return suite;
}

/**
 * Runs test suites in order and reports the outcome.
 *
 * A failing test never aborts the run: it is recorded and the next test starts,
 * so one regression does not hide the rest of the report.
 *
 * @param suites The suites to run.
 * @param options Bots, reporter, filter and timeouts.
 * @returns The aggregate result, including every test's outcome.
 * @throws if `options.bots` is empty.
 */
export async function runSuites(
  suites: TestSuite[],
  options: RunOptions,
): Promise<RunResult> {
  if (options.bots.length === 0) {
    throw new Error("runSuites requires at least one bot");
  }

  const runId = options.runId ?? `run-${Date.now()}`;
  const reporter =
    options.reporter ??
    new MultiReporter(new ConsoleReporter(), new StructuredReporter());
  const defaultTimeoutMs = options.defaultTestTimeoutMs ?? 60_000;

  const selected = suites
    .map((suite) => ({ suite, tests: selectTests(suite, options.filter) }))
    .filter(
      ({ suite, tests }) =>
        tests.length > 0 && matchesName(suite.name, options.filter?.suites),
    );

  const startedAtMs = Date.now();
  reporter.onRunStart?.(
    runId,
    selected.map(({ suite }) => suite.name),
  );

  const suiteResults: SuiteResult[] = [];
  let stopped = false;

  for (const { suite, tests } of selected) {
    if (stopped) break;
    const result = await runSuite(suite, tests, {
      runId,
      reporter,
      bots: options.bots,
      defaultTimeoutMs,
      stopOnFirstFailure: options.stopOnFirstFailure ?? false,
    });
    suiteResults.push(result);
    if (
      options.stopOnFirstFailure &&
      result.tests.some((t) => t.status === "failed")
    ) {
      stopped = true;
    }
  }

  const runResult: RunResult = {
    runId,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    suites: suiteResults,
    totals: tally(suiteResults),
  };
  reporter.onRunEnd?.(runResult);
  return runResult;
}

/**
 * Runs one suite, including its hooks.
 *
 * @param suite The suite to run.
 * @param tests The already-filtered tests to run.
 * @param env Shared run environment.
 * @returns The suite's result.
 */
async function runSuite(
  suite: TestSuite,
  tests: TestCase[],
  env: {
    runId: string;
    reporter: Reporter;
    bots: Bot[];
    defaultTimeoutMs: number;
    stopOnFirstFailure: boolean;
  },
): Promise<SuiteResult> {
  env.reporter.onSuiteStart?.(suite.name);
  const startedAt = Date.now();
  const results: TestResult[] = [];

  const { ctx } = createContext(env.runId, env.bots);

  let setupError: string | undefined;
  if (suite.setup) {
    try {
      await suite.setup(ctx);
    } catch (error) {
      setupError = describeError(error);
    }
  }

  if (setupError) {
    // The fixture never came up, so the tests were never really exercised.
    for (const test of tests) {
      const result: TestResult = {
        suite: suite.name,
        name: test.name,
        status: "skipped",
        durationMs: 0,
        skipReason: `suite setup failed: ${setupError}`,
        logs: [],
      };
      results.push(result);
      env.reporter.onTestEnd?.(result);
    }
  } else {
    for (const test of tests) {
      const result = await runTest(suite, test, env);
      results.push(result);
      env.reporter.onTestEnd?.(result);
      if (env.stopOnFirstFailure && result.status === "failed") break;
    }
  }

  let teardownError: string | undefined;
  if (suite.teardown) {
    try {
      await suite.teardown(ctx);
    } catch (error) {
      teardownError = describeError(error);
    }
  }

  const suiteResult: SuiteResult = {
    name: suite.name,
    durationMs: Date.now() - startedAt,
    tests: results,
    error: setupError ?? teardownError,
  };
  env.reporter.onSuiteEnd?.(suiteResult);
  return suiteResult;
}

/**
 * Runs a single test with its hooks and timeout.
 *
 * @param suite The owning suite.
 * @param test The test to run.
 * @param env Shared run environment.
 * @returns The test's result.
 */
async function runTest(
  suite: TestSuite,
  test: TestCase,
  env: { runId: string; bots: Bot[]; defaultTimeoutMs: number },
): Promise<TestResult> {
  const { ctx, logs } = createContext(env.runId, env.bots);
  const base = {
    suite: suite.name,
    name: test.name,
    logs,
  };

  if (test.skip) {
    return {
      ...base,
      status: "skipped" as TestStatus,
      durationMs: 0,
      skipReason: typeof test.skip === "string" ? test.skip : "skipped",
    };
  }

  const timeoutMs = test.timeoutMs ?? suite.timeoutMs ?? env.defaultTimeoutMs;
  const startedAt = Date.now();

  let error: string | undefined;
  try {
    if (suite.beforeEach) await suite.beforeEach(ctx);
    await withTimeout(() => test.run(ctx), timeoutMs, test.name);
  } catch (thrown) {
    error = describeError(thrown);
  }

  // afterEach runs even after a failure, and its own failure is reported
  // rather than swallowed — a leaking fixture breaks every later test.
  try {
    if (suite.afterEach) await suite.afterEach(ctx);
  } catch (thrown) {
    const detail = `afterEach failed: ${describeError(thrown)}`;
    error = error ? `${error}; ${detail}` : detail;
  }

  return {
    ...base,
    status: error ? "failed" : "passed",
    durationMs: Date.now() - startedAt,
    error,
  };
}

/**
 * Races an operation against a deadline.
 *
 * The runtime is cooperatively scheduled, so a timed-out test body cannot be
 * preempted — it keeps running in the background. Any instruction it still has
 * in flight is cancelled so it cannot resolve into a later test.
 *
 * @param operation The test body.
 * @param timeoutMs The deadline.
 * @param label Name used in the timeout message.
 * @returns A promise resolving when the operation finishes.
 * @throws if the operation throws, or the deadline passes first.
 */
async function withTimeout(
  operation: () => Promise<void> | void,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let handle = -1;
  const deadline = new Promise<never>((_, reject) => {
    handle = system.runTimeout(() => {
      cancelAllInstructions(`test "${label}" timed out`);
      reject(new Error(`test timed out after ${timeoutMs}ms`));
    }, msToTicks(timeoutMs));
  });

  try {
    await Promise.race([Promise.resolve(operation()), deadline]);
  } finally {
    system.clearRun(handle);
  }
}

/**
 * Builds a fresh context and its log buffer.
 *
 * @param runId The current run's id.
 * @param bots The bots available to tests.
 * @returns The context and the array its `log` appends to.
 */
function createContext(
  runId: string,
  bots: Bot[],
): { ctx: TestContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: TestContext = {
    bot: bots[0],
    bots,
    runId,
    log(message: string) {
      logs.push(message);
    },
  };
  return { ctx, logs };
}

/**
 * Applies a filter to a suite's tests.
 *
 * @param suite The suite whose tests to filter.
 * @param filter The filter, or `undefined` to keep everything.
 * @returns The tests that should run.
 */
function selectTests(suite: TestSuite, filter?: TestFilter): TestCase[] {
  if (!filter) return suite.tests;
  return suite.tests.filter((test) => {
    if (!matchesName(test.name, filter.tests)) return false;
    const tags = [...(suite.tags ?? []), ...(test.tags ?? [])];
    if (filter.excludeTags?.some((tag) => tags.includes(tag))) return false;
    if (filter.tags && !filter.tags.some((tag) => tags.includes(tag))) {
      return false;
    }
    return true;
  });
}

/**
 * Case-insensitive substring match against a list of needles.
 *
 * @param name The name to test.
 * @param needles Accepted substrings, or `undefined` to accept anything.
 * @returns Whether the name is accepted.
 */
function matchesName(name: string, needles?: string[]): boolean {
  if (!needles || needles.length === 0) return true;
  const lower = name.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * Renders a thrown value as a report line, keeping the stack when there is one.
 *
 * @param error The thrown value.
 * @returns A printable description.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }
  return String(error);
}

/**
 * Sums per-test outcomes across suites.
 *
 * @param suites The suite results to tally.
 * @returns The aggregate counts.
 */
function tally(suites: SuiteResult[]): RunTotals {
  const totals: RunTotals = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const suite of suites) {
    for (const test of suite.tests) {
      totals.total++;
      if (test.status === "passed") totals.passed++;
      else if (test.status === "failed") totals.failed++;
      else totals.skipped++;
    }
  }
  return totals;
}
