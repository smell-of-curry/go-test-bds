import { world } from "@minecraft/server";
import { runAction } from "../index";
import { TemporaryCallback } from "../utils/temporaryCallback";

world.afterEvents.playerSpawn.subscribe(async (e) => {
  const message = "Hello, World!";

  // This is a callback that just verifies that the bot successfully sent the message.
  // This is not necessary for the test to pass, but it's a good way to verify that the bot is working.
  TemporaryCallback.subscribe("beforeEvents", "chatSend", (remove, data) => {
    // Check if e.player, sends a message that contains "Hello, World!"
    if (data.sender.id !== e.player.id) return;
    if (data.message !== message) return;

    // Bot successfully sent the message!
    remove();
    console.log("Bot successfully sent the message");
  });

  await runAction(e.player, "chat", { message });
});
