import { ItemStack, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import {
  assert,
  assertContains,
  assertDefined,
  assertEquals,
  assertEventually,
  assertNearPosition,
  defineSuite,
  seconds,
  type TestSuite,
} from "../index";

/** Name of the first bot. Must match the Go binary `--name` / GOTESTBDS_BOT_NAME. */
export const BOT_NAME = "TestBot";

/**
 * Protocol smoke suite exercised by the CI fixture pack against a live BDS.
 *
 * Asserts server-observable outcomes only: what the Script API sees after the
 * bot acts over the chat wire protocol.
 */
export const protocolSuite: TestSuite = defineSuite({
  name: "protocol",
  timeoutMs: seconds(60),
  tests: [
    {
      name: "bot name matches the expected offline identity",
      run(ctx) {
        assertEquals(ctx.bot.name, BOT_NAME, "bot display name");
        assert(ctx.bot.isConnected, "bot should still be connected");
      },
    },
    {
      name: "chat round-trips into server chatSend",
      async run(ctx) {
        const message = `e2e-ping-${ctx.runId}`;
        let seen = false;

        const sub = world.beforeEvents.chatSend.subscribe((event) => {
          if (event.sender.id !== ctx.bot.player.id) return;
          if (event.message !== message) return;
          seen = true;
        });
        ctx.track(() => world.beforeEvents.chatSend.unsubscribe(sub));

        await ctx.bot.chat(message);
        await assertEventually(() => seen, {
          timeoutMs: seconds(15),
          description: `chatSend to observe "${message}"`,
        });
      },
    },
    {
      name: "server teleport moves the player as Script API sees it",
      async run(ctx) {
        const before = ctx.bot.player.location;
        const dest = {
          x: Math.floor(before.x) + 8.5,
          y: before.y,
          z: Math.floor(before.z) + 8.5,
        };
        ctx.bot.player.teleport(dest);
        await assertEventually(
          () => {
            try {
              assertNearPosition(ctx.bot.player.location, dest, 1.5);
              return true;
            } catch {
              return false;
            }
          },
          {
            timeoutMs: seconds(10),
            description: "player location to match teleport destination",
          },
        );
      },
    },
    {
      name: "action form opens and clickFormButton answers it",
      async run(ctx) {
        const form = new ActionFormData()
          .title("GoTestBDS E2E")
          .body("Click Confirm so the protocol path is covered.")
          .button("Confirm")
          .button("Cancel");

        // Show without awaiting — the bot must answer before show() resolves.
        const shown = form.show(ctx.bot.player);
        const open = await ctx.bot.waitForForm(seconds(15));
        assertContains(open.title, "GoTestBDS E2E", "open form title");
        const clicked = await ctx.bot.clickButton("Confirm");
        assertEquals(clicked.text, "Confirm", "clicked button label");

        const response = await shown;
        assert(!response.canceled, "form response should not be canceled");
        assertEquals(response.selection, 0, "Confirm is button index 0");

        // No-op without a viewer, which is how this suite usually runs.
        await ctx.screenshot("form-answered");
      },
    },
    {
      name: "a block the server places reaches the bot",
      async run(ctx) {
        const state = await ctx.bot.getState();
        const pos = {
          x: Math.floor(state.position.x),
          y: Math.floor(state.position.y) - 1,
          z: Math.floor(state.position.z),
        };

        const dimension = ctx.bot.player.dimension;
        const before = dimension.getBlock(pos);
        assertDefined(before, "server should see the block below the bot");
        const restore = before.typeId;
        ctx.track(() => dimension.getBlock(pos)?.setType(restore));

        dimension.getBlock(pos)?.setType("minecraft:gold_block");
        await assertEventually(
          async () => (await ctx.bot.getBlock(pos)).name.includes("gold_block"),
          {
            timeoutMs: seconds(15),
            description: "the placed gold block to reach the bot",
          },
        );

        // Aim at the subject first: a still of a bot looking the other way
        // proves nothing about the block the test just placed.
        await ctx.bot.lookAt(pos);
        await ctx.screenshot("gold-block");
      },
    },
    {
      name: "an item the server gives reaches the bot inventory",
      async run(ctx) {
        const inventory = ctx.bot.player.getComponent("minecraft:inventory");
        assertDefined(inventory, "player should have an inventory");
        const container = inventory.container;
        assertDefined(container, "inventory should have a container");
        ctx.track(() => container.clearAll());

        container.clearAll();
        container.setItem(0, new ItemStack("minecraft:diamond", 5));

        // The client is told nothing about a script write; getInventory forces
        // the resync that a real inventory transaction would have caused.
        const stale = await ctx.bot.getInventory({ sync: false });
        assert(
          stale.items.length === 0,
          "BDS is not expected to push script inventory writes on its own",
        );

        const synced = await ctx.bot.getInventory();
        assert(
          synced.items.some(
            (item) => item.name.includes("diamond") && item.count === 5,
          ),
          `bot should see 5 diamonds, saw ${JSON.stringify(synced.items)}`,
        );
      },
    },
    {
      name: "menuFormRespond dismisses an open form",
      async run(ctx) {
        const form = new ActionFormData()
          .title("GoTestBDS Dismiss")
          .body("This form should be closed without a selection.")
          .button("Leave me");

        const shown = form.show(ctx.bot.player);
        await ctx.bot.waitForForm(seconds(15));
        await ctx.bot.closeForm();

        const response = await shown;
        assert(response.canceled, "dismissed form should report canceled");
      },
    },
  ],
});
