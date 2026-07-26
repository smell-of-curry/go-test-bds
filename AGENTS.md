# AGENTS.md

## Learned User Preferences

- This repo is an **SDK for everyone**, not a PokeBedrock helper library. Anything
  another addon would plausibly want — a bot action, a wait primitive, an
  assertion, a reporter — belongs here, not in the consuming repo. Only
  project-specific fixtures stay downstream.
- Commit straight to `main` here; consumers get changes via
  `npm i github:smell-of-curry/go-test-bds`.

## Learned Workspace Facts

- The bot's copy of the world and of its own inventory is **not** trustworthy
  against current BDS. Chunk decoding logs `unknown sub chunk version 89`, and a
  player the server has just given items to reads back as an empty inventory —
  so `getBlock` / `getInventory` can disagree with the server for reasons that
  have nothing to do with the addon under test. Assert server-side state for
  those; the two smoke tests covering the client mirror in `pokebedrock-beh` are
  skipped with this reason until the decoding catches up. Undecodable blocks are
  deliberately **solid** (`world.UnknownBlock`): read as air, a floor of custom
  blocks is one the bot falls through, and it never lands because everything
  below is air too.
- A `MovePlayer` handler is what applies server-side teleports (`Player.teleport`,
  `/tp`, portals). Physics is also frozen while the bot's own chunk is missing —
  simulating against an absent world reads it as air and walks the bot out
  through the bottom in the second before its first chunk arrives.
- Custom `UnmarshalJSON` must never unmarshal into its own receiver: `Pos` did,
  which recursed until the stack overflowed and killed the bot on the first
  instruction carrying a position (`getBlock`). Decode through a plain
  array/struct instead.
- Reporter output goes out at `console.warn`. Deployed servers run
  `content-log-level=warning`, which drops info-level script output, so results
  emitted with `console.log` never leave the game.
- Two halves ship together: the Go binary (`main.go` + `gotestbds/`) that runs
  headless clients, and the TypeScript SDK (`scripts/`) that addons import. The
  npm package name is `go-test-bds`; `main`/`types` both point at
  `scripts/index.ts`, so consumers compile the SDK source with their own bundler.
- Configuration precedence for the binary is flags → environment
  (`GOTESTBDS_ADDRESS`, `GOTESTBDS_BOT_NAME`, `GOTESTBDS_BOTS`,
  `GOTESTBDS_LOG_LEVEL`) → `config.toml`. CI and orchestrators use flags/env;
  `config.toml` is for local runs.
- Bots have **no Xbox Live identity**, so they must connect to BDS directly
  (`online-mode=false`, allowlist off) — never through a proxy that terminates
  Xbox auth. In the PokeBedrock deployment that is `instance.port + 2` on
  loopback, which is why running tests never requires weakening production auth.
- The protocol is chat-based because that is the only bidirectional channel a
  Script API addon has to a client: addon → bot as a `[RUN_ACTION]` message,
  bot → addon as a `[STATUS]` message the addon cancels in
  `beforeEvents.chatSend`. Instructions carry an `id` that responses echo;
  without that correlation, concurrent instructions resolve each other's
  promises. Observation instructions return a `data` payload so tests can assert
  on what the *client* sees rather than what the server believes.
- `scripts/__generated__/types.ts` is generated from the Go instruction structs by
  `npm run generate:types`. The generator skips unexported Go fields and parses
  `Name()` methods with named receivers — a stale file silently gives instructions
  the wrong parameter shape, which surfaces as a confusing tsc error in the
  consumer, not here. Regenerate after touching `gotestbds/instruction/`.
- `Bot.clickThrough({ until, … })` walks a form chain positionally until a
  server-observable condition holds. Prefer it over naming each button: labels
  are translated and designers change them.
- `TestContext.track(cleanup)` runs cleanups newest-first even when a test fails
  or times out, and suite-level tracks run after `teardown`. Tests that clean up
  on their last line leave fixtures behind on the first failure, which then fails
  every following test — far harder to diagnose than the original failure.
- `withTimeout` cannot preempt a timed-out test body (the runtime is
  cooperatively scheduled), so it cancels that body's in-flight instructions
  instead; otherwise a late response resolves into the next test.
- `StructuredReporter` emits `[GOTESTBDS]`-prefixed JSON lines on BDS stdout.
  `bds-manager`'s `TestRunAggregator` parses exactly those events, so changing
  the event shape is a breaking change for that consumer.
- Dragonfly/gophertunnel upgrades broke several things worth remembering: the
  `chunk` package now takes a `BlockRegistry` rather than an air runtime id
  (`world.DefaultBlockRegistry`); `block.BreakDuration` takes a
  `block.BreakContext` and applies the airborne/underwater/haste/fatigue
  multipliers itself, so callers must not re-apply them; several packet fields
  widened from `byte`/`uint32` to `int32`; and the `go:linkname` hack for
  `finaliseBlockRegistry` must be replaced with
  `world.DefaultBlockRegistry.Finalize()`.
- The `@minecraft/server` dev dependency must track the consumer's version.
  `beforeEvents.chatSend` was removed in 2.3.0 and is present again in the
  `2.9.0-beta.1.26.33-stable` line that pokebedrock-beh uses; the SDK depends on
  it for the status channel.
- Target lib is pre-ES2022: `Array.prototype.at` is unavailable, use
  `arr[arr.length - 1]`.
