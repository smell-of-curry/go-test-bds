import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Player } from "@minecraft/server";
import { Bot } from "../../bot";
import type { OpenForm } from "../../types";
import { TimeoutError } from "../../wait";
import { createFakePlayer } from "../fixtures/minecraftServer";

function menu(title: string): OpenForm {
  return { type: "menu", title, buttons: [{ text: "Continue" }] };
}

describe("Bot.clickThrough", () => {
  it("stops as soon as until() holds and reports answered forms", async () => {
    const bot = new Bot(createFakePlayer("FormBot") as unknown as Player);
    const queue = [menu("One"), menu("Two"), menu("Three")];
    let answered = 0;
    const seen: string[] = [];

    bot.waitForForm = async () => {
      const form = queue.shift();
      assert.ok(form, "ran out of forms");
      return form;
    };
    bot.clickButtonAt = async () => {
      answered += 1;
      return { index: 0, text: "Continue" };
    };

    const forms = await bot.clickThrough({
      until: () => answered >= 2,
      onForm: (form) => seen.push(form.title),
    });

    assert.deepEqual(
      forms.map((form) => form.title),
      ["One", "Two"],
    );
    assert.deepEqual(seen, ["One", "Two"]);
    assert.equal(queue.length, 1);
  });

  it("respects maxForms and names the last form in the error", async () => {
    const bot = new Bot(createFakePlayer("FormBot") as unknown as Player);
    let n = 0;
    bot.waitForForm = async () => menu(`Form-${n++}`);
    bot.clickButtonAt = async () => ({ index: 0, text: "Continue" });

    await assert.rejects(
      bot.clickThrough({
        until: () => false,
        maxForms: 2,
        description: "quest complete",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /clicked through 2 forms without reaching quest complete/,
        );
        assert.match(error.message, /last form was "Form-1"/);
        return true;
      },
    );
  });

  it("surfaces a TimeoutError when no further form opens", async () => {
    const bot = new Bot(createFakePlayer("FormBot") as unknown as Player);
    bot.waitForForm = async () => {
      throw new Error("bot waitForForm timed out");
    };

    await assert.rejects(
      bot.clickThrough({
        until: () => false,
        formTimeoutMs: 1500,
        description: "flag set",
      }),
      (error: unknown) => {
        assert.ok(error instanceof TimeoutError);
        assert.match(error.message, /flag set/);
        assert.match(error.message, /no further form opened/);
        assert.match(error.message, /bot waitForForm timed out/);
        return true;
      },
    );
  });

  it("calls onForm for each answered form", async () => {
    const bot = new Bot(createFakePlayer("FormBot") as unknown as Player);
    const queue = [menu("A"), menu("B")];
    let clicks = 0;
    const titles: string[] = [];

    bot.waitForForm = async () => queue.shift()!;
    bot.clickButtonAt = async () => {
      clicks += 1;
      return { index: 0, text: "Continue" };
    };

    await bot.clickThrough({
      until: () => clicks >= 2,
      onForm: (form) => titles.push(form.title),
    });

    assert.deepEqual(titles, ["A", "B"]);
  });
});
