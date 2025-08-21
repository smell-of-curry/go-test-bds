# GO TEST BDS

![Logo](images/logo.png)

## Overview

GoTestBDS is a designed to be a complete end-to-end testing framework for Minecraft Bedrock Dedicated Servers written in Go and TypeScript. GoTestBDS is built on top of [GopherTunnel](https://github.com/Sandertv/gophertunnel) giving the ability to register fake clients to test your Script API BDS Addons.

## Features

- [x] Connect Fake Clients to a BDS Server
- [x] Implements all [clientOriginating](https://github.com/Sandertv/gophertunnel/blob/master/minecraft/protocol/packet/pool.go#L279) packets to simple JSON interfaces
- [x] Parses text packets from the BDS Server to JSON
- [x] Sends text JSON packets to the BDS Server
- [x] Smooth Navigation simulation
- [x] Full UI and Form Automation

## How it works

GoTestBds enables a script api project to completely fake a player on its server and run tests on it.

To do this, GoTestBds created a simple chat API that allows script api to send a instruction to the bot.

For example:

```ts
import { world } from "@minecraft/server";

world.afterEvents.playerSpawn.subscribe((e) => {
  if (e.player.name !== "My Custom Bot") return;

  const message = `[RUN_ACTION]${JSON.stringify({
    action: "chat",
    parameters: {
      message: "Hello, World!",
    },
  })}`;
  e.player.sendMessage(message);
});
```

This basically listens for a player to spawn, and then sends a instruction to the bot that is named "My Custom Bot".

The bot will then preform that action, and the script api will listen for a message from the bot that contains the prefix `[STATUS]`. Listen for the status to be `success` or `error`.

```ts
import { world } from "@minecraft/server";

world.beforeEvents.chatSend.subscribe((e) => {
  if (e.sender.name !== "My Custom Bot") return;

  // Check if this a status message, not a chat message
  if (!e.message.startsWith("[STATUS]")) return;

  // It is, cancel the message so it doesn't get sent to the server
  e.cancel = true;

  try {
    // Parse the status message
    const ctx = JSON.parse(e.message.replace(/^\[STATUS\]/, ""));
    if (ctx.status === "success") {
      console.log("Action was successful");
    } else {
      console.error("Action failed", statusDetails.message);
    }
  } catch (error) {
    console.error("Error parsing status message", error);
  }
});
```

Doing this allows you to fully test functionality like can a user move to this location, what happens when they break a block here or there, what happens when they click this message on a form, etc.

This give you the ability to FULLY test your script API Addon, giving you full end-to-end testing.

## So how do I use it?

Well, you could just use the scripts above, but that would be a pain.

So GoTestBds provides a custom library that is built for using it. Located in `./scripts` we auto generate types from go to typescript and export functions that allow you to send and receive instructions with the bot.

This makes it easy and can be setup easily:

1. Install the `gotestbds` npm package:

   ```bash
   npm i gotestbds
   ```

2. Create a folder in your project for tests, something like: `src/__tests__/`
3. Create a script to test what you have built... For example: `testShrines.ts`

   ```ts
   import { type Player, EquipmentSlot, ItemStack } from "@minecraft/server";
   import gotestbds from "gotestbds";

   /**
    * This function will test the functionality of the PokeBedrock Shrines.
    */
   export async function testShrines(bot: Player) {
     // Set the start location of the bot
     bot.teleport({ x: 0, y: 90, z: 0 });

     // Ensure the shrine is set right in front of the bot
     const shrinePos = { x: 2, y: 60, z: 0 };
     bot.dimension.setBlockType(shrinePos, "pokeb:frozen_shrine");

     // Give the bot the Orb of Frozen Souls
     const equippableComponent = player.getComponent("equippable");
     if (!equippableComponent) return;
     const heldSlot = equippableComponent.setEquipment(
       EquipmentSlot.Mainhand,
       new ItemStack("pokeb:orb_of_frozen_souls"),
     );

     // Make the bot use the orb on the shrine
     // This will throw an error if the action fails, stopping the test instantly.
     await gotestbds.runAction(bot, "interactWithBlock", {
       pos: shrinePos,
     });

     // Continue test with checking if the orb was removed, pokemon spawned, etc...
   }
   ```

4. Create a main `index.ts` file that will actually run the tests and such.
   TODO: Add example

## License

...
