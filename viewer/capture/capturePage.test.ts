import assert from "node:assert/strict";
import test from "node:test";

import { captureWithPageRecovery } from "./capturePage";

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
