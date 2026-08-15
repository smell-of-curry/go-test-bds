import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Player } from "@minecraft/server";
import {
  cancelAllInstructions,
  InstructionError,
  runAction,
} from "../../client";
import { INSTRUCTION_PREFIX, msToTicks, STATUS_PREFIX } from "../../protocol";
import {
  createFakePlayer,
  dispatchChatSend,
  driveUntil,
  type FakePlayer,
  resetFakeSystem,
} from "../fixtures/minecraftServer";

/**
 * Replies to the latest instruction the fake bot recorded.
 *
 * @param bot The fake bot that received the instruction.
 * @param status Status kind to report.
 * @param extras Optional id override, message, or data.
 */
function replyToLatest(
  bot: FakePlayer,
  status: "success" | "error",
  extras: { id?: string; message?: string; data?: unknown } = {},
): void {
  const raw = bot.messages[bot.messages.length - 1];
  assert.ok(raw, "expected an instruction to have been sent");
  const request = JSON.parse(raw.slice(INSTRUCTION_PREFIX.length)) as {
    id: string;
  };
  dispatchChatSend(
    bot,
    STATUS_PREFIX +
      JSON.stringify({
        id: extras.id ?? request.id,
        status,
        message: extras.message,
        data: extras.data,
      }),
  );
}

describe("client", () => {
  let bot: FakePlayer;

  beforeEach(() => {
    resetFakeSystem();
    cancelAllInstructions("test reset");
    bot = createFakePlayer("Alpha");
    bot.messages.length = 0;
  });

  afterEach(() => {
    cancelAllInstructions("test teardown");
    resetFakeSystem();
  });

  it("resolves concurrent in-flight requests by id", async () => {
    const first = runAction(bot as unknown as Player, "chat", {
      message: "one",
    });
    const second = runAction(bot as unknown as Player, "chat", {
      message: "two",
    });

    assert.equal(bot.messages.length, 2);
    const id1 = JSON.parse(bot.messages[0].slice(INSTRUCTION_PREFIX.length))
      .id as string;
    const id2 = JSON.parse(bot.messages[1].slice(INSTRUCTION_PREFIX.length))
      .id as string;
    assert.notEqual(id1, id2);

    // Reply out of order: second first, then first.
    dispatchChatSend(
      bot,
      STATUS_PREFIX +
        JSON.stringify({ id: id2, status: "success", data: { n: 2 } }),
    );
    dispatchChatSend(
      bot,
      STATUS_PREFIX +
        JSON.stringify({ id: id1, status: "success", data: { n: 1 } }),
    );

    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.data, { n: 1 });
    assert.deepEqual(b.data, { n: 2 });
  });

  it("ignores a STATUS reply whose id belongs to a different request", async () => {
    const pending = runAction(bot as unknown as Player, "chat", {
      message: "stay",
    });
    const realId = JSON.parse(bot.messages[0].slice(INSTRUCTION_PREFIX.length))
      .id as string;

    dispatchChatSend(
      bot,
      STATUS_PREFIX +
        JSON.stringify({ id: "not-the-right-id", status: "success" }),
    );

    // Still pending — a wrong-id success must not settle it.
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);

    dispatchChatSend(
      bot,
      STATUS_PREFIX + JSON.stringify({ id: realId, status: "success" }),
    );
    const envelope = await pending;
    assert.equal(envelope.status, "success");
    assert.equal(settled, true);
  });

  it("rejects when the bot reports an error status", async () => {
    const pending = runAction(bot as unknown as Player, "jump", {});
    replyToLatest(bot, "error", { message: "cannot jump here" });

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof InstructionError);
      assert.equal(error.action, "jump");
      assert.equal(error.status, "error");
      assert.match(error.message, /cannot jump here/);
      return true;
    });
  });

  it("rejects with a useful timeout when the bot never replies", async () => {
    const timeoutMs = 1000;
    const pending = runAction(
      bot as unknown as Player,
      "chat",
      { message: "ghost" },
      { timeoutMs },
    );

    // Addon-side deadline is bot timeout + 10 tick grace (see client.ts).
    const ticksNeeded = msToTicks(timeoutMs) + 10;
    await assert.rejects(
      driveUntil(pending, ticksNeeded + 5),
      (error: unknown) => {
        assert.ok(error instanceof InstructionError);
        assert.equal(error.status, "timeout");
        assert.match(error.message, /did not report a status within 1000ms/);
        return true;
      },
    );
  });

  it("cancels the chat event for STATUS replies", () => {
    // Ensure the shared listener is installed.
    void runAction(bot as unknown as Player, "chat", { message: "ping" });
    const requestId = JSON.parse(
      bot.messages[0].slice(INSTRUCTION_PREFIX.length),
    ).id as string;
    const event = dispatchChatSend(
      bot,
      STATUS_PREFIX + JSON.stringify({ id: requestId, status: "success" }),
    );
    assert.equal(event.cancel, true);
  });
});
