# GO TEST BDS

![Logo](images/banner.png)

End-to-end testing for Minecraft Bedrock Dedicated Server addons.

GoTestBDS connects headless clients to your BDS instance and hands your Script
API addon a way to drive them. Because the bots are real network clients, a test
exercises the same code a player does: the same packets, the same forms, the same
rejections. It is built on [GopherTunnel](https://github.com/Sandertv/gophertunnel).

Two halves ship together:

- **A Go binary** that connects one or more bots and carries out instructions.
- **A TypeScript SDK** (`./scripts`) your addon imports to write tests: a bot
  wrapper, a test runner, assertions, waits, and a machine-readable report
  format for CI.

## Quick start

### 1. Run the bots

```bash
go run . --address 127.0.0.1:19134 --name "Test Bot" --bots 1
```

Every flag also reads from the environment (`GOTESTBDS_ADDRESS`,
`GOTESTBDS_BOT_NAME`, `GOTESTBDS_BOTS`, `GOTESTBDS_LOG_LEVEL`) and from
`config.toml`, in that order of precedence — flags win, then environment, then
file. That makes the same binary usable from a shell, a CI job and an
orchestrator without three ways to configure it.

Point `--address` at BDS directly, not at a proxy. Bots have no Xbox Live
identity, so they need an instance with `online-mode=false` and the allowlist
off — normally a dev or staging instance bound to loopback.

### 2. Install the SDK in your addon

```bash
npm i github:smell-of-curry/go-test-bds
```

### 3. Write a suite

```typescript
import { assert, assertEventually, defineSuite } from "go-test-bds";

export const shrineSuite = defineSuite({
  name: "Shrines",
  tests: [
    {
      name: "using the orb on a frozen shrine spawns its Pokémon",
      async run(ctx) {
        const shrine = { x: 2, y: 60, z: 0 };
        ctx.bot.player.dimension.setBlockType(shrine, "pokeb:frozen_shrine");
        ctx.track(() =>
          ctx.bot.player.dimension.setBlockType(shrine, "minecraft:air"),
        );

        giveOrb(ctx.bot.player);
        await ctx.bot.interactWithBlock(shrine);

        await assertEventually(() => shrineHasSpawned(shrine), {
          timeoutMs: 10_000,
          description: "the shrine to spawn its Pokémon",
        });
      },
    },
  ],
});
```

### 4. Run it from your addon

```typescript
import { Bot, runSuites } from "go-test-bds";

const bot = await Bot.waitForJoin("Test Bot", { timeoutMs: 60_000 });
const result = await runSuites([shrineSuite], { bots: [bot] });
```

Trigger that from a script event so CI can start a run over the BDS console
rather than by editing the addon:

```
scriptevent yourns:run {"runId":"ci-123"}
```

## How the protocol works

The addon and the bot talk over chat, because that is the only bidirectional
channel a Script API addon has to a client.

The addon sends an instruction as a message to the bot's player, prefixed
`[RUN_ACTION]`. The bot performs it and replies with a `[STATUS]` message that
the addon intercepts in `beforeEvents.chatSend` and cancels, so it never reaches
other players.

Each instruction carries an `id`. Responses echo it, which is what makes
concurrent instructions and per-instruction timeouts possible — without
correlation, two bots acting at once would resolve each other's promises. A
response may also carry a `data` payload, which is how observation instructions
(`getState`, `getInventory`, `getForm`, `getBlock`, `getNearbyEntities`,
`getMessages`) return what the *client* sees rather than what the server
believes.

`scripts/client.ts` implements all of this. You should not need to build an
envelope by hand; use `Bot` or, for an instruction the wrapper does not cover
yet, `runAction` / `runActionForData`.

## What the SDK gives you

| Module | Purpose |
|-----|-----|
| `bot.ts` | `Bot` — actions (chat, navigate, interact, break, forms) and observations (state, inventory, blocks, nearby entities, messages) |
| `runner.ts` | `defineSuite`, `runSuites` — suites, per-test timeouts, tag filtering, hooks, and `ctx.track` cleanups that run even when a test fails |
| `assert.ts` | Minecraft-shaped assertions: `assertNearPosition`, `assertBlockAt`, `assertEventually`, … |
| `wait.ts` | `waitFor`, `waitForValue`, `retry`, `sleep` — polling with timeouts that name what they were waiting for |
| `reporter.ts` | `ConsoleReporter` for humans, `StructuredReporter` for CI (`[GOTESTBDS]`-prefixed JSON lines on stdout) |
| `protocol.ts` | The wire format, if you are building your own client |

### Walking dialogue chains

Most addons talk to players through chained forms. Naming every button makes a
test depend on wording that is translated and that designers change, so walk the
chain positionally and stop on a condition the server can observe:

```typescript
await ctx.bot.clickThrough({
  until: () => getQuestStep(ctx.bot.player) === "accepted",
  description: "the quest to be accepted",
  onForm: (form) => ctx.log(`answered "${form.title}"`),
});
```

### Reporting to CI

`StructuredReporter` prints one JSON object per event, prefixed
`[GOTESTBDS]`, to BDS stdout:

```
[GOTESTBDS]{"kind":"testEnd","suite":"Shrines","name":"...","status":"passed","durationMs":812}
[GOTESTBDS]{"kind":"runEnd","runId":"ci-123","totals":{"total":1,"passed":1,"failed":0,"skipped":0}}
```

Whatever supervises BDS can tail stdout, aggregate those events, and decide a
build's fate without parsing human-readable log output.

## Regenerating instruction types

The TypeScript instruction parameter types are generated from the Go
instruction structs, so the two cannot drift:

```bash
npm run generate:types
```

Adding an instruction means adding it in `gotestbds/instruction/`, registering it
in `pull.go`, regenerating, and — if it is worth a friendlier signature — adding a
method to `Bot`.

## License

...
