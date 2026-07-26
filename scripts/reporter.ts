/** Outcome of a single test case. */
export type TestStatus = "passed" | "failed" | "skipped";

/** Result of one test case. */
export interface TestResult {
  /** Name of the suite the test belongs to. */
  suite: string;
  /** Name of the test case. */
  name: string;
  status: TestStatus;
  /** Wall-clock duration of the test body, in milliseconds. */
  durationMs: number;
  /** Failure message, present only when `status` is `"failed"`. */
  error?: string;
  /** Why the test was skipped, present only when `status` is `"skipped"`. */
  skipReason?: string;
  /** Lines the test emitted through `ctx.log`. */
  logs: string[];
}

/** Result of one suite, including every test it ran. */
export interface SuiteResult {
  name: string;
  durationMs: number;
  tests: TestResult[];
  /**
   * Failure raised by the suite's own `setup`/`teardown` rather than by a test.
   * When `setup` throws, every test in the suite is reported as skipped.
   */
  error?: string;
}

/** Aggregate counts for a run. */
export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** Result of a whole run. */
export interface RunResult {
  /** Identifier for this run, echoed in every structured line. */
  runId: string;
  startedAtMs: number;
  durationMs: number;
  suites: SuiteResult[];
  totals: RunTotals;
}

/**
 * Receives run progress. Implement this to send results somewhere other than
 * the console — an HTTP endpoint, a scoreboard, a database table.
 */
export interface Reporter {
  /** Called once before the first suite. */
  onRunStart?(runId: string, suiteNames: string[]): void;
  /** Called before each suite's setup. */
  onSuiteStart?(suiteName: string): void;
  /** Called once per test, as soon as it settles. */
  onTestEnd?(result: TestResult): void;
  /** Called after each suite's teardown. */
  onSuiteEnd?(result: SuiteResult): void;
  /** Called once after the last suite. */
  onRunEnd?(result: RunResult): void;
}

/**
 * Prefix of every machine-readable line written by {@link StructuredReporter}.
 * An external process (CI runner, server manager) can tail the server log and
 * pick these out without parsing human-facing output.
 */
export const STRUCTURED_LOG_PREFIX = "[GOTESTBDS]";

/** Kinds of structured line, in the order they are emitted. */
export type StructuredEventKind =
  | "runStart"
  | "suiteStart"
  | "testEnd"
  | "suiteEnd"
  | "runEnd";

/** Envelope of a single structured line. */
export interface StructuredEvent {
  kind: StructuredEventKind;
  runId: string;
  payload: unknown;
}

/**
 * Writes one JSON line per event, prefixed with {@link STRUCTURED_LOG_PREFIX},
 * for a process outside the game to consume.
 */
export class StructuredReporter implements Reporter {
  private readonly write: (line: string) => void;
  private runId = "";

  /**
   * @param write Sink for each line. Defaults to `console.log`, which lands in
   * the dedicated server's stdout.
   */
  constructor(write: (line: string) => void = (line) => console.log(line)) {
    this.write = write;
  }

  /**
   * Emits one structured line.
   *
   * @param kind The event kind.
   * @param payload Event-specific body.
   */
  private emit(kind: StructuredEventKind, payload: unknown): void {
    const event: StructuredEvent = { kind, runId: this.runId, payload };
    this.write(STRUCTURED_LOG_PREFIX + JSON.stringify(event));
  }

  /** @inheritdoc */
  onRunStart(runId: string, suiteNames: string[]): void {
    this.runId = runId;
    this.emit("runStart", { suiteNames });
  }

  /** @inheritdoc */
  onSuiteStart(suiteName: string): void {
    this.emit("suiteStart", { suiteName });
  }

  /** @inheritdoc */
  onTestEnd(result: TestResult): void {
    this.emit("testEnd", result);
  }

  /** @inheritdoc */
  onSuiteEnd(result: SuiteResult): void {
    // Tests already went out individually; repeating them would double the
    // volume of a long run's log for no benefit.
    this.emit("suiteEnd", {
      name: result.name,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  /** @inheritdoc */
  onRunEnd(result: RunResult): void {
    this.emit("runEnd", {
      durationMs: result.durationMs,
      totals: result.totals,
    });
  }
}

/** Writes a human-readable progress log. */
export class ConsoleReporter implements Reporter {
  private readonly write: (line: string) => void;

  /**
   * @param write Sink for each line. Defaults to `console.log`.
   */
  constructor(write: (line: string) => void = (line) => console.log(line)) {
    this.write = write;
  }

  /** @inheritdoc */
  onRunStart(runId: string, suiteNames: string[]): void {
    this.write(
      `[tests] run ${runId} starting: ${suiteNames.length} suite(s) — ` +
        suiteNames.join(", "),
    );
  }

  /** @inheritdoc */
  onSuiteStart(suiteName: string): void {
    this.write(`[tests] suite: ${suiteName}`);
  }

  /** @inheritdoc */
  onTestEnd(result: TestResult): void {
    const mark =
      result.status === "passed"
        ? "PASS"
        : result.status === "failed"
          ? "FAIL"
          : "SKIP";
    this.write(
      `[tests]   ${mark} ${result.name} (${result.durationMs}ms)` +
        (result.error ? ` — ${result.error}` : "") +
        (result.skipReason ? ` — ${result.skipReason}` : ""),
    );
    // Only failures need their breadcrumbs; a passing test's log is noise.
    if (result.status !== "failed") return;
    for (const line of result.logs) this.write(`[tests]     · ${line}`);
  }

  /** @inheritdoc */
  onRunEnd(result: RunResult): void {
    const { passed, failed, skipped, total } = result.totals;
    this.write(
      `[tests] run ${result.runId} finished in ${result.durationMs}ms: ` +
        `${passed}/${total} passed, ${failed} failed, ${skipped} skipped`,
    );
  }
}

/** Fans every event out to several reporters. */
export class MultiReporter implements Reporter {
  private readonly reporters: Reporter[];

  /**
   * @param reporters Reporters to notify, in order.
   */
  constructor(...reporters: Reporter[]) {
    this.reporters = reporters;
  }

  /** @inheritdoc */
  onRunStart(runId: string, suiteNames: string[]): void {
    for (const r of this.reporters) r.onRunStart?.(runId, suiteNames);
  }

  /** @inheritdoc */
  onSuiteStart(suiteName: string): void {
    for (const r of this.reporters) r.onSuiteStart?.(suiteName);
  }

  /** @inheritdoc */
  onTestEnd(result: TestResult): void {
    for (const r of this.reporters) r.onTestEnd?.(result);
  }

  /** @inheritdoc */
  onSuiteEnd(result: SuiteResult): void {
    for (const r of this.reporters) r.onSuiteEnd?.(result);
  }

  /** @inheritdoc */
  onRunEnd(result: RunResult): void {
    for (const r of this.reporters) r.onRunEnd?.(result);
  }
}
