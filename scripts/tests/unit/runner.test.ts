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
    const result = await driveUntil(pending, msToTicks(timeoutMs) + 10);

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
});
