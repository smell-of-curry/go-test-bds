import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AssertionError,
  assert as assertTrue,
  assertContains,
  assertDefined,
  assertEquals,
  assertEventually,
  assertInRange,
  assertThrows,
} from "../../assert";
import { msToTicks } from "../../protocol";
import { TimeoutError, waitFor, waitForValue } from "../../wait";
import {
  driveUntil,
  resetFakeSystem,
  system,
} from "../fixtures/minecraftServer";

describe("assert", () => {
  it("assertEquals and assert succeed on match", () => {
    assertEquals(1, 1);
    assertTrue(true, "ok");
    assertDefined("x", "present");
    assertContains("Hello World", "hello");
    assertInRange(5, 1, 10);
  });

  it("assertEquals and assert throw AssertionError on mismatch", () => {
    assert.throws(() => assertEquals(1, 2, "nums"), AssertionError);
    assert.throws(
      () => assertTrue(false, "should hold"),
      (error: unknown) => {
        assert.ok(error instanceof AssertionError);
        assert.match(error.message, /should hold/);
        return true;
      },
    );
    assert.throws(() => assertDefined(null, "missing"), AssertionError);
  });

  it("assertThrows returns the error when the operation fails", async () => {
    const error = await assertThrows(() => {
      throw new Error("expected");
    }, "op");
    assert.ok(error instanceof Error);
    assert.equal(error.message, "expected");
  });

  it("assertThrows fails when the operation does not throw", async () => {
    await assert.rejects(
      assertThrows(() => 1, "op"),
      AssertionError,
    );
  });
});

describe("wait", () => {
  beforeEach(() => {
    resetFakeSystem();
  });

  afterEach(() => {
    resetFakeSystem();
  });

  it("waitFor resolves when the condition becomes true via the fake scheduler", async () => {
    let ready = false;
    const pending = waitFor(() => ready, {
      timeoutMs: 5000,
      intervalMs: 50,
      description: "ready flag",
    });

    system.runTimeout(() => {
      ready = true;
    }, 3);

    await driveUntil(pending, 50);
  });

  it("waitFor rejects with TimeoutError without wall-clock sleeping", async () => {
    const timeoutMs = 200;
    const pending = waitFor(() => false, {
      timeoutMs,
      intervalMs: 50,
      description: "never",
    });

    await assert.rejects(
      driveUntil(pending, msToTicks(timeoutMs) + 10),
      (error: unknown) => {
        assert.ok(error instanceof TimeoutError);
        assert.match(error.message, /timed out after 200ms waiting for never/);
        return true;
      },
    );
  });

  it("waitForValue returns the first defined getter result", async () => {
    let value: string | undefined;
    const pending = waitForValue(() => value, {
      timeoutMs: 2000,
      intervalMs: 50,
      description: "value",
    });

    system.runTimeout(() => {
      value = "here";
    }, 2);

    assert.equal(await driveUntil(pending, 50), "here");
  });

  it("assertEventually maps a wait timeout to AssertionError", async () => {
    const timeoutMs = 200;
    const pending = assertEventually(() => false, {
      timeoutMs,
      intervalMs: 50,
      description: "state",
    });

    await assert.rejects(
      driveUntil(pending, msToTicks(timeoutMs) + 10),
      (error: unknown) => {
        assert.ok(error instanceof AssertionError);
        assert.match(error.message, /state never became true within 200ms/);
        return true;
      },
    );
  });
});
