import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { captureWithPageRecovery, waitForCaptureFrame } from "./capturePage";

const crash = new Error("page.waitForFunction: Target crashed");

test("resumes the pending capture once on the replacement page", async () => {
  const original = {};
  const replacement = {};
  const pages: object[] = [];
  const completed: object[] = [];

  await captureWithPageRecovery(
    original,
    async (page, remainingMs) => {
      pages.push(page);
      assert(remainingMs() > 0);
      if (page === original) throw crash;
      completed.push(page);
    },
    async (failed) => {
      assert.equal(failed, original);
      return replacement;
    },
    Date.now() + 1_000,
  );

  assert.deepEqual(pages, [original, replacement]);
  assert.deepEqual(completed, [replacement]);
});

test("does not retry a still on the same crashed page", async () => {
  const original = {};
  let attempts = 0;

  await assert.rejects(
    captureWithPageRecovery(
      original,
      async () => {
        attempts++;
        throw crash;
      },
      async () => original,
      Date.now() + 1_000,
    ),
    crash,
  );
  assert.equal(attempts, 1);
});

test("does not start another recovery if the replacement crashes", async () => {
  let attempts = 0;
  let recoveries = 0;
  await assert.rejects(
    captureWithPageRecovery(
      {},
      async () => {
        attempts++;
        throw crash;
      },
      async () => {
        recoveries++;
        return {};
      },
      Date.now() + 1_000,
    ),
    crash,
  );
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
});

test("reports an ordinary capture error without replacing the page", async () => {
  const failure = new Error("frame wait expired");

  await assert.rejects(
    captureWithPageRecovery(
      {},
      async () => {
        throw failure;
      },
      async () => {
        assert.fail("only a crash should trigger recovery");
      },
      Date.now() + 1_000,
    ),
    failure,
  );
});

test("drops a queued capture whose original deadline passed", async () => {
  await assert.rejects(
    captureWithPageRecovery(
      {},
      async () => {
        assert.fail("expired request should not start");
      },
      async () => {
        assert.fail("expired request should not recover");
      },
      Date.now() - 1,
    ),
    /capture deadline exceeded/,
  );
});

const frameTimeout = Object.assign(new Error("viewer read timed out"), {
  name: "TimeoutError",
});

function framePage(observations: Array<number | null>, timeouts: number) {
  const tickRequests: number[] = [];
  const page = {
    evaluate: async () => {
      assert(observations.length, "unexpected viewport sample");
      return observations.shift();
    },
    waitForFunction: async (_predicate: unknown, minTick: number) => {
      tickRequests.push(minTick);
      if (timeouts-- > 0) throw frameTimeout;
    },
  } as unknown as Page;
  return { page, tickRequests };
}

test("reconnects one stalled page without changing the requested tick", async () => {
  const { page, tickRequests } = framePage([30, 30], 1);
  const recovery: boolean[] = [];
  await captureWithPageRecovery(
    page,
    async (current, remaining, mayRecover) => {
      assert.equal(current, page);
      recovery.push(mayRecover);
      await waitForCaptureFrame(current, 40, remaining, mayRecover);
    },
    async (current, reason) => {
      assert.equal(reason, "frame-stalled");
      return current;
    },
    Date.now() + 25_000,
  );
  assert.deepEqual(recovery, [true, false]);
  assert.deepEqual(tickRequests, [40, 40]);
});

test("does not reconnect while assets are loading or the tick is advancing", async () => {
  const { page, tickRequests } = framePage([null, 30, 33, 36], 3);
  await waitForCaptureFrame(page, 40, () => 25_000, true);
  assert.deepEqual(tickRequests, [40, 40, 40, 40]);
});

test("a stalled-stream retry can time out without another recovery", async () => {
  const { page, tickRequests } = framePage([30, 30], 2);
  let recoveries = 0;
  await assert.rejects(
    captureWithPageRecovery(
      page,
      (current, remaining, mayRecover) =>
        waitForCaptureFrame(current, 40, remaining, mayRecover),
      async (current) => {
        recoveries++;
        return current;
      },
      Date.now() + 25_000,
    ),
    frameTimeout,
  );
  assert.equal(recoveries, 1);
  assert.deepEqual(tickRequests, [40, 40]);
});

test("leaves a short capture's entire budget for its ordinary frame wait", async () => {
  const { page, tickRequests } = framePage([], 0);
  await waitForCaptureFrame(page, 40, () => 10_000, true);
  assert.deepEqual(tickRequests, [40]);
});
