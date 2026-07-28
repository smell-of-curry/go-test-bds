# AGENTS.md

## Learned User Preferences

- This repo is an **SDK for everyone**, not a PokeBedrock helper library. Anything
  another addon would plausibly want — a bot action, a wait primitive, an
  assertion, a reporter — belongs here, not in the consuming repo. Only
  project-specific fixtures stay downstream.
- Commit straight to `main` here; consumers get changes via
  `npm i github:smell-of-curry/go-test-bds`.
- Judge a capture by decoding it, not by the run reporting green: pull evenly
  spaced frames out of the webm and read the burnt-in overlay, then say plainly
  what the recording is worth. Every real bug in the viewer path — an empty
  world after a teleport, columns stuck `partial`, a recording covering ten
  seconds of a minute-long run — was found that way and was invisible otherwise.

## Learned Workspace Facts

- The bot's world copy took three fixes to become trustworthy against current
  BDS, all of which showed up as `unknown sub chunk version 89` and a bot that
  could not see a block the server had just placed: `LevelChunk.SubChunkCount`
  is a **request-mode sentinel** (limited/limitless), not a count, so the raw
  payload holds biomes rather than sub-chunks and the sub-chunks must be
  requested (in sub-chunk units, `0..count-1`, capped at `HighestSubChunk+1`);
  with `block-network-ids-are-hashes` (the BDS default, mirrored on `World` as
  `hashedIDs`) palette entries are **FNV hashes**, decoded through
  `blockRegistry.HashToRuntimeID`; and server-side edits arrive as
  `UpdateSubChunkBlocks`, which used to be unhandled. Undecodable blocks are
  deliberately **solid** (`world.UnknownBlock`): read as air, a floor of custom
  blocks is one the bot falls through, and it never lands because everything
  below is air too.
- A sub-chunk request answered `SubChunkResultSuccessAllAir` carries **no
  payload**, so a decode loop that skips every non-`Success` entry never retires
  it, the column's pending count never reaches zero, and every column with sky
  above it stays `partial` forever. Call `ReceiveSubChunk()` for it and leave
  only genuine failures (`ChunkNotFound`, index out of bounds) pending. Bedrock
  also never sends light — the client computes it, and dragonfly already
  implements the propagation — so anything that needs light fills it locally
  instead of reading it off the wire.
- **BDS never syncs a Script API inventory write to the client.**
  `Container.setItem`/`addItem`/`swapItems` and
  `EntityEquippable.setEquipment` all leave the client's copy stale, and no
  client-side action shakes it loose — opening the inventory screen, switching
  the held slot, jumping, breaking a block and `clear` all do nothing, and a
  deliberately-rejected `ItemStackRequest` earns a `PacketViolationWarning` and
  a kick. Only a real inventory transaction (`/give`, `/replaceitem`, a player
  move) resyncs the window, and it resyncs the whole thing. So the resync is
  forced **server-side**: `Bot.getInventory` `/replaceitem`s a marker into an
  empty slot and `clear`s it again before reading, leaving the inventory
  untouched. `{ sync: false }` reads the stale copy on purpose. This is the
  long-standing Script API sync bug (MicrosoftDocs/minecraft-creator#594),
  closed upstream but still live for these paths on 1.26.34.
- A `MovePlayer` handler is what applies server-side teleports (`Player.teleport`,
  `/tp`, portals). Physics is also frozen while the bot's own chunk is missing —
  simulating against an absent world reads it as air and walks the bot out
  through the bottom in the second before its first chunk arrives. Moving the
  actor is not enough on a teleport: `unloadChunks` prunes against
  `loadingCenter` rather than the actor position, so destination columns are
  discarded as they arrive unless the handler also calls `SetChunkLoadCenter`,
  and the server keeps streaming around the old position until the bot
  acknowledges with a `PlayerAuthInput` at the destination (`SendMovement()`)
  instead of waiting for the next tick. `NetworkChunkPublisherUpdate.Radius` is
  in **blocks** (`chunkRadius << 4`), so it decodes with `>> 4` — shifting it the
  other way turns an 8-chunk view into 2048 and disables pruning entirely.
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
- `viewer/` is an optional in-repo web app — its own `package.json`, Vite and
  Playwright, excluded from the root `tsconfig.json` and `eslint.config.mjs` so
  the published SDK stays light — fed by the Go hub in `gotestbds/viewer` over
  SSE, not a WebSocket: the viewer only listens and `EventSource` reconnects
  itself. `viewer/PROTOCOL.md` is the normative wire contract and
  `viewer/PLAN.md` the staged roadmap. Rendering never needs a behaviour pack:
  `GameData.CustomBlocks` (`[]protocol.BlockEntry` — name plus the definition NBT
  holding `minecraft:geometry` and `material_instances`) and
  `packet.ItemRegistry` carry the custom definitions, and
  `packet.ResourcePackStack` states outright that behaviour packs are never
  downloaded. The vanilla baseline is Mojang's `bedrock-samples` pinned by tag
  and fetched into a gitignored cache — depending on it is fine, vendoring it is
  not (Minecraft EULA); it ships no `materials/`, no shaders and no font glyph
  atlas, but `metadata/vanilladata_modules/mojang-blocks.json` is the complete
  vanilla block-and-state list. Pack precedence follows `ResourcePackStack`
  order with later winning, and a subpack is the highest
  `memory_performance_tier` at or below the device tier.
- Headless capture runs Chromium on software SwiftShader, which sets the real
  limits. Drawing every block as an instance (~536k) made `page.screenshot()`
  exceed 30 s; emitting only air-exposed faces (~95k) brings it to ~70 ms, so
  the mesher has to cull. A PNG cannot ride the `[STATUS]` chat channel, so the
  `screenshot` instruction writes into the artifact directory and returns path,
  dimensions, bytes and tick. Playwright's `recordVideo` takes no frame rate and
  Chromium emits a video frame only when the page paints, so an app that paints
  on snapshot arrival records a time lapse; per-test segments were built and
  reverted (short tests end before a fresh page paints, leaving blank files), so
  it is one `run.webm` per run written with `--video-out` into the artifact
  directory — POSTing it to the bot loses the race against the bot's own exit at
  run end (`ECONNREFUSED`). When the hub serves the built app, hand `AppDir` to
  `http.FileServer`: a root handler that 404s anything but `/` never serves
  `/assets/*`, and a blank page reads as a stream failure.
