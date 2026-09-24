import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Player } from "@minecraft/server";
import { Bot } from "../../bot";
import { cancelAllInstructions } from "../../client";
import { msToTicks } from "../../protocol";
import type { Reporter } from "../../reporter";
import { defineSuite, runSuites } from "../../runner";
import {
  createFakePlayer,
  driveUntil,
  resetFakeSystem,
} from "../fixtures/minecraftServer";

const silentReporter: Reporter = {};

describe("runner", () => {
  let bot: Bot;

  beforeEach(() => {
    resetFakeSystem();
    cancelAllInstructions("test reset");
    bot = new Bot(createFakePlayer("RunnerBot") as unknown as Player);
    // Unit tests have no bot reply channel. viewerMark / pullArtifacts go
    // through runAction and would hang forever waiting on fake ticks that
    // only the timeout-driving tests advance.
    bot.viewerMark = async () => {};
    bot.pullArtifacts = async () => [];
  });

  afterEach(() => {
    cancelAllInstructions("test teardown");
    resetFakeSystem();
  });

  it("reports a passing suite", async () => {
    const suite = defineSuite({
      name: "smoke",
      tests: [
        {
          name: "does nothing",
          run() {
            /* pass */
          },
        },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "pass-1",
    });

    assert.equal(result.totals.passed, 1);
    assert.equal(result.totals.failed, 0);
    assert.equal(result.suites[0].tests[0].status, "passed");
  });

  it("records a failure without aborting later tests", async () => {
    const suite = defineSuite({
      name: "continue-after-fail",
      tests: [
        {
          name: "throws",
          run() {
            throw new Error("boom");
          },
        },
        {
          name: "still runs",
          run() {
            /* pass */
          },
        },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "fail-1",
    });

    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.passed, 1);
    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.match(result.suites[0].tests[0].error ?? "", /boom/);
    assert.equal(result.suites[0].tests[1].status, "passed");
  });

  it("runs ctx.track cleanups in reverse order after a pass", async () => {
    const order: string[] = [];
    const suite = defineSuite({
      name: "cleanup-pass",
      tests: [
        {
          name: "tracks three",
          run(ctx) {
            ctx.track(() => {
              order.push("a");
            });
            ctx.track(() => {
              order.push("b");
            });
            ctx.track(() => {
              order.push("c");
            });
          },
        },
      ],
    });

    await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "cleanup-1",
    });
    assert.deepEqual(order, ["c", "b", "a"]);
  });

  it("runs tracked cleanups when the test throws", async () => {
    const order: string[] = [];
    const suite = defineSuite({
      name: "cleanup-throw",
      tests: [
        {
          name: "fails after track",
          run(ctx) {
            ctx.track(() => {
              order.push("cleanup");
            });
            throw new Error("nope");
          },
        },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "cleanup-2",
    });
    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.deepEqual(order, ["cleanup"]);
  });

  it("runs tracked cleanups when the test times out", async () => {
    const order: string[] = [];
    const timeoutMs = 500;
    const suite = defineSuite({
      name: "cleanup-timeout",
      timeoutMs,
      tests: [
        {
          name: "hangs",
          async run(ctx) {
            ctx.track(() => {
              order.push("cleanup");
            });
            await new Promise(() => {
              /* never settles */
            });
          },
        },
      ],
    });

    const pending = runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "cleanup-3",
    });
    const result = await driveUntil(pending, msToTicks(timeoutMs) + 40);

    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.match(result.suites[0].tests[0].error ?? "", /timed out/);
    assert.deepEqual(order, ["cleanup"]);
  });

  it("orders setup, beforeEach, test, afterEach, teardown, then suite cleanups", async () => {
    const order: string[] = [];
    const suite = defineSuite({
      name: "hooks",
      setup(ctx) {
        order.push("setup");
        ctx.track(() => {
          order.push("suite-cleanup");
        });
      },
      beforeEach() {
        order.push("beforeEach");
      },
      afterEach() {
        order.push("afterEach");
      },
      teardown() {
        order.push("teardown");
      },
      tests: [
        {
          name: "body",
          run(ctx) {
            order.push("test");
            ctx.track(() => {
              order.push("test-cleanup");
            });
          },
        },
      ],
    });

    await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "hooks-1",
    });

    assert.deepEqual(order, [
      "setup",
      "beforeEach",
      "test",
      "afterEach",
      "test-cleanup",
      "teardown",
      "suite-cleanup",
    ]);
  });

  it("marks tests failed when suite setup throws", async () => {
    const lines: string[] = [];
    const reporting: Reporter = {
      onTestEnd(result) {
        lines.push(
          `[GOTESTBDS]${JSON.stringify({ kind: "testEnd", payload: { status: result.status, error: result.error, skipReason: result.skipReason } })}`,
        );
      },
      onRunEnd(result) {
        lines.push(
          `[GOTESTBDS]${JSON.stringify({ kind: "runEnd", payload: { totals: result.totals } })}`,
        );
      },
    };
    const suite = defineSuite({
      name: "setup-boom",
      setup() {
        throw new Error("form is of type modal, not form");
      },
      tests: [
        {
          name: "never runs",
          run() {
            throw new Error("should not reach test body");
          },
        },
        {
          name: "also never runs",
          run() {
            /* pass */
          },
        },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: reporting,
      runId: "setup-fail-1",
    });

    assert.equal(result.totals.failed, 2);
    assert.equal(result.totals.skipped, 0);
    assert.equal(result.totals.passed, 0);
    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.match(
      result.suites[0].tests[0].error ?? "",
      /^suite setup failed:.*form is of type modal/s,
    );
    assert.match(result.suites[0].error ?? "", /suite setup failed:/);
    const runEnd = lines[lines.length - 1];
    assert.match(runEnd, /"failed":2/);
    assert.doesNotMatch(runEnd, /"failed":0/);
  });

  it("mutation: setup-failure must not report skipped or green totals", async () => {
    // Invert the guards from the setup-failure test: if someone reverts tests
    // to skipped / leaves totals.failed at 0, this fails.
    const suite = defineSuite({
      name: "setup-mutation",
      setup() {
        throw new Error("fixture down");
      },
      tests: [{ name: "body", run() {} }],
    });
    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "setup-mut-1",
    });
    const test = result.suites[0].tests[0];
    assert.notEqual(test.status, "skipped");
    assert.equal(test.status, "failed");
    assert.ok((result.totals.failed ?? 0) > 0);
    assert.equal(result.totals.skipped, 0);
  });

  it("marks passed tests failed when suite teardown throws", async () => {
    const ends: Array<{ status: string; error?: string }> = [];
    const reporting: Reporter = {
      onTestEnd(result) {
        ends.push({ status: result.status, error: result.error });
      },
    };
    const suite = defineSuite({
      name: "teardown-boom",
      teardown() {
        throw new Error("teardown exploded");
      },
      tests: [
        {
          name: "passed then red",
          run() {
            /* pass */
          },
        },
        {
          name: "explicit skip stays skip",
          skip: "not today",
          run() {
            /* pass */
          },
        },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: reporting,
      runId: "teardown-fail-1",
    });

    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.skipped, 1);
    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.match(
      result.suites[0].tests[0].error ?? "",
      /suite teardown failed:.*teardown exploded/s,
    );
    assert.equal(result.suites[0].tests[1].status, "skipped");
    // Final testEnd for the formerly-passed test must be failed.
    const lastPassSlot = ends.filter((e) => e.error?.includes("teardown"));
    assert.ok(lastPassSlot.length >= 1);
    assert.equal(lastPassSlot[lastPassSlot.length - 1].status, "failed");
  });

  it("runs suite ctx.track cleanups after setup failure", async () => {
    const order: string[] = [];
    const suite = defineSuite({
      name: "setup-cleanup",
      setup(ctx) {
        ctx.track(() => {
          order.push("suite-cleanup");
        });
        order.push("setup");
        throw new Error("setup died");
      },
      teardown() {
        order.push("teardown");
      },
      tests: [{ name: "body", run() {} }],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "setup-cleanup-1",
    });

    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.deepEqual(order, ["setup", "teardown", "suite-cleanup"]);
  });

  it("leaves filter-excluded tests out (not failed) when setup throws", async () => {
    const suite = defineSuite({
      name: "filter-setup",
      setup() {
        throw new Error("setup died");
      },
      tests: [
        { name: "keep me", run() {} },
        { name: "drop me please", run() {} },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "filter-1",
      filter: { tests: ["keep"] },
    });

    assert.equal(result.suites[0].tests.length, 1);
    assert.equal(result.suites[0].tests[0].name, "keep me");
    assert.equal(result.suites[0].tests[0].status, "failed");
    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.skipped, 0);
  });

  it("keeps explicit skip as skipped when setup throws", async () => {
    const suite = defineSuite({
      name: "skip-setup",
      setup() {
        throw new Error("setup died");
      },
      tests: [
        { name: "would run", run() {} },
        { name: "parked", skip: true, run() {} },
      ],
    });

    const result = await runSuites([suite], {
      bots: [bot],
      reporter: silentReporter,
      runId: "skip-setup-1",
    });

    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.skipped, 1);
    assert.equal(result.suites[0].tests[1].status, "skipped");
  });
});
