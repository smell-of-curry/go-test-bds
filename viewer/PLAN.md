# Viewer — plan

A renderer for what a go-test-bds bot sees. The bot is already a real network
client: it receives the same chunks, entities, forms and inventory a player
does. Everything below is about turning that state into pixels, and eventually
into pixels a person cannot tell apart from the Bedrock client.

The end state is a 1:1 client-faithful renderer. Nothing here is scoped to
PokeBedrock — the viewer resolves what it draws from what the server sends, so
any addon gets the same fidelity without the viewer knowing about it.

## Why it lives in this repo

The renderer consumes `gotestbds/world.World` and moves in lockstep with the
protocol version the bot speaks. A split repo would need the world model, the
block registry and the packet handlers versioned across a module boundary for
no gain. The viewer stays an opt-in subtree with its own dependencies so the
core `npm i github:smell-of-curry/go-test-bds` install is unaffected.

## Why capture comes before fidelity

Stages 0–4 are the whole point of the project arriving early: a screenshot
instruction a suite can call, a video of the run, and both published by CI.
None of that depends on the renderer being pretty. A capture path that records
coloured cubes is already useful — it tells you where the bot was standing and
what it could see when an assertion failed — and every later stage improves what
that same path records without touching it. Building fidelity first would mean
months of work before anyone outside this directory benefits.

## Status

Stages 0–4 are shipped and running in CI. `pokebedrock-beh`'s `addon-tests` job
asks the dev-server manager for capture, and each run publishes its stills and
run video as the `addon-test-viewer` workflow artefact.

Stages 5, 6 and 8 are shipped too, and the viewer now renders the real server
world with the server's own pack textures during a live run — including custom
palette blocks (geometry + `material_instances`, permutations, transforms;
cube fallback when `.geo.json` missing). Stage 7 draws textured entity models from client
entity defs + render controllers; Stage 9 plays animations/controllers/scripts
on those bones (`EntityAnimator`) and applies motion-lerped poses. Stage 11's
form panel, player HUD DOM, and particle JSON runtime are done; JSON UI /
font atlas remain open. Stage 12's golden
suite + `viewer-golden` workflow are in, including vanilla-baseline bump
wiring (`baseline-bump.yml` → golden fetch + `GOLDEN_USE_BASELINE`). Stage 10a
(Go light fill + biome export) and 10b (viewer lighting, biome tint, gradient
sky + distance fog) are in; Stage 10 camera + time-of-day sky (sun/moon/stars)
landed — weather / fog JSON / clouds remain open. Attachables and the rest of
7/11 still have open boxes below. Capture presentation is deliberate: a loading
screen until the atlas settles, stills gated on asset readiness, then the
gradient sky once the world shows.

Getting the picture right cost a run of bugs worth naming, because each was
invisible from outside and each looked like a different problem:

- A keyframe carried the whole world (~6.8 MB) twenty times a second, so the SSE
  writer never finished one and the viewer sat frozen. Frames are paced now.
- A column with no sections in range encoded as `null`, which threw in the
  consumer and froze every frame after it.
- Playwright closes the browser on `SIGTERM` by default — which is how the runner
  ends a harness — so the run video was lost every time.
- `blocks.json` resolved winner-takes-all, letting a sound-only server entry erase
  vanilla's textures.
- Vanilla keys blocks bare while the wire namespaces them, so 4 identifiers out of
  1231 resolved and the whole world drew as the missing-texture fallback.
- Superseding a paced catch-up delta flagged a full keyframe restart, which wiped
  the client's valid columns and re-dirtied every section — the remesh storm made
  the client slower, causing the next supersede. A still burnt in the result:
  `columns 4`, `resync 70`. A supersede now re-queues only the lost columns, and
  an unsent keyframe is regenerated fresh instead of dropping deltas against it.

The lesson that generalises: **judge a capture by decoding it.** Every one of those
was found by pulling frames out of a recording and reading the burnt-in overlay,
and none was visible in a run that reported itself green.

Four things shipped differently from what the boxes below predicted, each noted
where it applies: the stream is Server-Sent Events rather than a WebSocket,
there is one video per run rather than a segment per test, frame rate is not a
knob (the recording is a time lapse of whatever the software renderer painted),
and the caption burnt into the frame names the suite, test, elapsed time and
verdict (assertion text on failure).

Written down along the way, and normative from here on:

- [`PROTOCOL.md`](PROTOCOL.md) — stream schema, endpoints, harness contract.
- [`PACKETS.md`](PACKETS.md) — the unhandled-packet audit stage 0 asked for.
- [`FINDINGS-capture.md`](FINDINGS-capture.md) — capture-mechanism research.
- [`FINDINGS-wire.md`](FINDINGS-wire.md) — network palette NBT, blocks.json
  precedence, BP-only gaps (stage 8 Go side).
- [`README.md`](README.md) — the app, the harness flags, the frame budget.

## Invariants

These hold at every stage. Breaking one is what turns a renderer into a second
codebase that has to be maintained by hand.

- **No behaviour pack, ever.** A real client is never sent one — `packet.ResourcePackStack`
  says so outright ("Behaviour packs never have to be downloaded") — and it still
  draws every custom block and entity correctly, because everything needed to
  draw them arrives over the wire or in a resource pack. Reading a behaviour
  pack would let the viewer render things a player cannot see, and would break
  it for every server whose source you do not have on disk. The behaviour pack
  is not an asset source; it is not an input at all.
- **Packs are the source of truth for appearance.** Geometry, textures, render
  controllers and animations are read from resource packs at runtime. No asset
  is transcoded, vendored or hardcoded. A pack update is picked up with no
  viewer change.
- **The vanilla baseline is pinned, fetched and never vendored.** Vanilla assets
  come from `Mojang/bedrock-samples` at a pinned tag, fetched into a cache that
  is not committed. Its licence is "(c) Mojang AB. All rights reserved." under
  the Minecraft EULA, so depending on it is fine and redistributing it is not.
- **The wire carries names, not indices.** Blocks cross as identifier plus state
  properties, entities as their type identifier. Runtime IDs and palette hashes
  are registry-local and change under the bot; a snapshot that leaks them dates
  instantly.
- **Go streams state, the web renders it.** No meshing, no image decoding and no
  Molang evaluation in Go. The Go side stays a projection of `World`.
- **The viewer is a read-only observer.** It never sends packets and never
  drives the bot. A run behaves identically whether or not anyone is watching.
- **The viewer is optional.** Every feature that reaches into the SDK — the
  screenshot instruction above all — must fail with a clear "no viewer attached"
  error when nobody is rendering, never hang and never change a verdict.
- **Every fidelity claim has a fixture.** A stage is done when a golden image or
  a parsed-structure assertion fails if it regresses, not when a screenshot
  looks right once.

---

## Stage 0 — bot-side correctness the renderer depends on

The world mirror is currently good enough for physics and assertions. Rendering
exposes gaps physics never noticed.

- [x] Reconcile entity removal. `bot.RemoveActorHandler` looks up
      `packet.RemoveActor.EntityUniqueID`, while `world.World.AddEntity` keys the
      map on `Entity.RuntimeID()`. Removed entities therefore survive in the map
      whenever the two IDs differ, which a renderer shows as ghosts. Store the
      unique ID on the entity at spawn and resolve removals through it.
- [x] Partition chunk storage by dimension. `World.chunks` is one
      `map[world.ChunkPos]*Column` with no dimension key, and `Actor.Dimension()`
      reads the spawn dimension out of `GameData` rather than tracking
      `packet.ChangeDimension`. Overworld and a custom dimension currently share
      one coordinate space.
- [x] Handle `packet.ChangeDimension`: flush columns, update the actor's
      dimension, and expose the change as an event the snapshot stream forwards.
      Entities are flushed with the columns — the server stops mentioning the old
      dimension's mobs rather than removing them, so keeping them is the same
      ghost the unique-ID fix exists to prevent, one dimension over.
- [x] Distinguish "not loaded" from "air" in `World.block`. Both return
      `block.Air{}` today; a renderer must not draw a chunk boundary as an open
      void, and must not mesh a column it has not received.
- [x] Record per-column receipt state (requested / partial / complete) so the
      viewer can show load progress instead of holes. An all-air sub-chunk answers
      a request with no payload, so it has to retire that request like any other
      or every column with sky above it reads as a permanent hole.
- [x] Audit which packets are dropped by `Bot.HandlePacket`'s default debug log
      and classify each as render-relevant or not. The list is the input to the
      later fidelity stages — [`PACKETS.md`](PACKETS.md).

**Check:** `gotestbds/world/world_test.go` covers removal by unique ID
(`TestRemoveEntityByUniqueID`), dimension isolation (`TestDimensionIsolation`),
unloaded-versus-air (`TestBlockAtUnloadedVersusAir`) and receipt state
(`TestColumnReceiptState`); `gotestbds/bot` covers the dimension flush and the
all-air sub-chunk case.

---

## Stage 1 — state export

- [x] Define the snapshot schema: world metadata (dimension, range, tick), block
      volumes, entities, the observed actor's pose, held items, and open UI
      state. Version the schema explicitly from the first commit — schema 1, spelled
      out in [`PROTOCOL.md`](PROTOCOL.md).
- [x] Encode blocks as identifier plus state properties, sourced from
      `world.Block`'s `EncodeBlock()`. Carry the raw network runtime ID
      alongside it as an opaque fallback for blocks the registry cannot name —
      those are exactly the addon blocks a renderer most needs to draw.
- [x] Encode entities with type identifier, unique and runtime IDs, position,
      rotation, velocity, bounding box, name tag, held and armour items, and the
      full decoded `metadata.State` flag set. Molang queries later read from this
      set, so drop nothing that decodes cleanly.
- [x] Emit a keyframe (everything in radius) on connect and deltas after: block
      changes from `UpdateBlockHandler` and `UpdateSubChunkBlocksHandler`,
      column add/remove, entity add/move/update/remove.
- [x] Serve the stream from the bot's tick loop so snapshots are consistent
      within a tick and never race a partial mutation. **Server-Sent Events, not a
      WebSocket:** the viewer only ever listens (the read-only-observer invariant)
      and SSE reconnects on its own, so a socket would have been a second protocol
      to write for nothing it needs.
- [x] Stamp every snapshot with the tick it describes. Capture correlates frames
      to ticks through this field, so it exists from the first commit rather
      than being retrofitted once screenshots turn out to be stale.
- [x] Add `--viewer` / `GOTESTBDS_VIEWER` / `config.toml` plumbing following the
      existing precedence in `config.go`, plus the bind address and radius.
- [x] Make the stream multi-bot aware. `main.go` runs N bots concurrently; the
      viewer selects among them, so identify streams by bot name.
- [x] Bound memory and bandwidth: a radius cap (horizontal and vertical), a
      per-column revision counter so an unchanged column is never re-encoded, and
      backpressure that drops snapshot frames rather than stalling the tick loop —
      a dropped frame is followed by a keyframe resync, and the count is on the
      overlay. Event frames (mark, capture) wait briefly instead of dropping,
      because losing one strands a capture request.
- [x] Sanitize every HUD lane the same way, including the eventful one.
      `flattenRawtext` locates the rawtext JSON anywhere in a string;
      `filterHudControlText` shows the value of display-worthy PHUD tokens
      (`loadingScreen`, `battleWait`, `evolutionWait`, `currency`) and blanks
      pure control tokens — and when filtering leaves nothing, the title event
      is not emitted at all, because a real client's HUD would not have
      changed and a clear frame would wipe a visible title.

**Check:** `gotestbds/viewer/encode_test.go` drives a synthetic `World` through
add/modify/remove and asserts the delta sequence reconstructs the same state;
`stream_test.go` covers the drop-then-resync path, and `fixture_test.go` writes
the golden stream the web app's smoke test replays.

---

## Stage 2 — viewer shell

- [x] Scaffold `viewer/` as a self-contained web app with its own
      `package.json`, kept out of the published SDK entry points.
- [x] Implement the client side of the snapshot protocol with reconnect and
      keyframe resync.
- [x] Build the scene: first-person camera locked to the actor's eye position
      and rotation, plus a detached orbit camera for inspection.
- [x] Render placeholder geometry — colored cubes per block identifier, boxes
      per entity bounding box — so the pipeline is verifiable before any asset
      work. This is deliberately the last thing before capture: it is enough to
      make a recording worth watching. Only exposed faces are emitted: dense
      terrain is ~650k blocks in radius, and drawing the buried ones put a single
      screenshot past its timeout under software GL.
- [x] Add a diagnostic overlay: bot name, position, dimension, tick, loaded
      column count, and the identifier under the crosshair.
- [x] Decide and document the frame budget and the chunk update strategy
      (dirty-section remesh, worker pool) before the mesher exists, since both
      constrain its interface — [`README.md`](README.md).

**Check:** `viewer/tests/smoke.spec.ts` boots the app against the golden stream
`gotestbds/viewer/testdata/go-stream.jsonl` (written by the Go fixture test, so
the two languages cannot drift apart quietly) and asserts the scene graph node
counts and that pixels reached the canvas.

---

## Stage 3 — capture

The first stage that produces something a test author uses directly. Screenshots
come before video: they are the smaller contract and the one the Script API
suites are waiting on.

- [x] Add a screenshot instruction to `instruction.DefaultPull`, so a suite can
      ask for a frame mid-test the same way it asks for a block. It is registered
      only when a viewer hub exists, so a bot without one rejects the instruction
      instead of pretending to serve it.
- [x] Settle what the instruction returns. A PNG does not fit in the chat
      message the `[STATUS]` channel rides on, so the instruction writes the
      image to the artefact directory and returns its path, dimensions and byte
      count as instruction data. Tests assert on the artefact's existence and
      metadata; humans and CI consume the file.
- [x] Make the frame correspond to the moment the instruction was issued.
      Resolve it only once a frame rendered from a snapshot at or after the
      current tick has been captured, or the screenshot silently shows a stale
      world and is worse than none. The wait runs outside `Execute`: the loop it
      would block is the one producing the ticks it waits for.
- [x] Decide the headless capture mechanism and write down why. The viewer is a
      web app, so a headless browser driving `Page.captureScreenshot` is the
      path of least resistance and needs no GPU on a CI runner; a native GL
      context in Node is the alternative. Both must produce identical output to
      the interactive path — [`FINDINGS-capture.md`](FINDINGS-capture.md);
      Playwright's Chromium on SwiftShader won.
- [x] Support headless capture in CI, where no display exists and frames must be
      produced deterministically rather than in real time.
- [x] Capture the rendered canvas to a video stream, started and stopped by the
      run rather than by hand. Playwright's `recordVideo` on the same long-lived
      context as the stills, so the DOM overlay is in frame.
- [x] Drive capture from the run lifecycle. `StructuredReporter` already emits
      `runStart`, `suiteStart`, `testEnd`, `suiteEnd` and `runEnd` as
      `[GOTESTBDS]`-prefixed lines; the viewer subscribes to the same events.
      **One recording per run, not per suite or test:** segmenting was built and
      reverted — short tests ended before a fresh page had painted, leaving blank
      files and a context that kept closing under the next test.
- [x] Burn in a caption track: suite, test, elapsed time, and the assertion text
      when one fails. Bottom caption band draws suite · test · elapsed · status,
      plus the assertion `message` on `failed`; the small diagnostic HUD stays.
- [x] Write per-test artefacts: a still at the moment of failure plus any the
      test asked for, named so they correlate with the run record by `runId` —
      `<suite>/<test>/<label>.png` under the run's artefact directory, with the
      run video beside them.
- [x] Bound artefact size: resolution and recording length are harness flags,
      retention and a byte cap are the manager's. **Frame rate is not a knob:**
      Playwright's recorder does not take one; the app paints on rAF with pose
      interpolation, so quiet stretches still compress in the webm — read the
      caption elapsed time and overlay tick for real timing.
- [x] Never let a busy mesher cost a still. The `__viewer.settled` gate is
      best-effort with a 10s grace (a world still streaming keeps meshing
      indefinitely — runs 13–15 lost their opening shot to it), Chromium runs
      with backgrounding/timer-throttling disabled, and `waitForFunction`
      polls on a timer rather than rAF. The capture error message carries the
      underlying Playwright error, not a summary that hides it.

**Check:** `viewer/tests/capture.spec.ts` runs the harness against a fake bot
server and asserts a PNG (magic bytes and all) of the requested size at a tick at
or after the request, a still for the failing test, and exactly one WebM for the
run; `gotestbds/viewer/capture_test.go` asserts a request with nobody rendering
fails fast rather than hanging until its deadline.

A run with the viewer switched off was checked against the live dev server: the
bot rejects `screenshot` as unregistered, `ctx.screenshot` returns null, and the
same tests pass with the same verdicts.

---

## Stage 4 — integration

- [x] Extend the aggregator contract so screenshots and recordings are
      discoverable alongside results. `bds-manager`'s `TestRunAggregator` parses
      the `[GOTESTBDS]` event shape, so any addition to it is a breaking change
      for that consumer and has to be made deliberately. `artifacts` rides on
      `testEnd` and `runEnd`; the manager also reconciles the artefact directory
      after teardown, because the run video is finalised after the last event a
      dying bot can report.
- [x] Publish artefacts from the `addon-tests` CI job and attach them to the
      pull request that produced them — the `addon-test-viewer` workflow artefact
      plus a list in the job summary.
- [x] Document the viewer's configuration, asset requirements and CI wiring in
      the repository README, and record the architectural rules from this file
      where a future contributor will read them — this repo's `README.md`,
      `viewer/README.md`, [`PROTOCOL.md`](PROTOCOL.md), and the dev-server section
      of `bds-manager`'s README.

**Check:** verified on PR #704 of `pokebedrock-beh` — the `addon-tests` job
published three stills and the run video with no manual step, and an earlier run
with two failing tests carried a still of each failure.

---

## Stage 5 — assets

Two sources, no third. What the server sends, and a pinned vanilla baseline.

- [x] Implement resource pack acquisition over the wire.
      `minecraft.Dialer.DownloadResourcePack` decides per pack whether to accept
      it and `Conn.ResourcePacks()` returns the ones received, so a bot that
      accepts them holds exactly the pack stack the real client would. Neither is
      used today. This is the mechanism that makes the viewer self-maintaining
      for addon content.
- [x] Cache downloaded packs by UUID and version so a repeat run against the
      same server does not re-download a multi-hundred-megabyte pack.
- [x] Depend on `Mojang/bedrock-samples` for the vanilla baseline. It ships the
      full vanilla resource pack — real textures, `blocks.json`,
      `terrain_texture.json`, `item_texture.json`, `flipbook_textures.json`,
      `biomes_client.json`, entity definitions, models, render controllers,
      animations, attachables, particles and fogs — which is the entire vanilla
      half of what the renderer resolves.
- [x] Pin it by tag in a version file, fetch into a gitignored cache, verify what
      was fetched, and fail startup with an actionable message when it is
      missing. Never commit the assets: the licence is all rights reserved under
      the Minecraft EULA.
- [x] Automate the bump. `version.json` at the repo root maps `latest` to the
      current version and is updated per release; a scheduled workflow reads it,
      opens a PR moving the pin, and lets the visual-regression suites show the
      asset diff. That is the dependabot-shaped loop, and it is the whole
      version-update story: pull the new pack, review the image diff, merge.
      _(`.github/workflows/baseline-bump.yml` — weekly cron + dispatch; pin =
      `v` + `latest.version`; PR via peter-evans/create-pull-request.)_
- [x] Use `metadata/vanilladata_modules/` from the same repo where a
      generated-and-authoritative list beats parsing: `mojang-blocks.json` is the
      complete vanilla block and block-state list, with `mojang-items.json`,
      `mojang-entities.json`, `mojang-biomes.json` and `mojang-dimensions.json`
      alongside it. Cheaper and more reliable than deriving the same lists from
      pack files.
      _(`diagnose:terrain` labels unresolved ids `vanilla_baseline_gap` vs
      `custom_server_pack_gap` from `mojang-blocks.json`.)_
- [x] Record what `bedrock-samples` does not ship and what the viewer does about
      each: no `materials/` (the vanilla material definitions behind
      `material.default` and friends), no shaders, and no font glyph atlas. The
      material mapping has to be established empirically and documented; text
      rendering needs its own answer. For anyone who wants exactness here, the
      escape hatch is extracting from an installation they own — the
      `minecraft-linux` tooling reads the Android package, though it hosts no
      assets itself — and the viewer must treat that as an optional overlay, not
      a requirement.
      _(answered in `FINDINGS-assets.md`: Stage 7 material table + terrain shader;
      gradient sky / vertex light; canvas name tags + DOM HUD text.)_
- [x] Build the pack stack resolver: vanilla baseline lowest, server packs in the
      order `packet.ResourcePackStack` gives (first applied first), with correct
      override precedence and subpack selection including the
      `memory_performance_tier` rule.

**Check:** resolve a texture path through a two-pack stack and assert the server
pack wins; assert a missing baseline fails loudly at startup rather than
rendering grey; assert the fetched baseline matches the pinned version.
Covered by `gotestbds/assets` tests plus `gotestbds/viewer/assets_http_test.go`
path-traversal coverage. Endpoints documented in [`PROTOCOL.md`](PROTOCOL.md).

---

## Stage 6 — terrain

- [x] Parse `blocks.json` and `terrain_texture.json`, including per-face texture
      maps, `carried_textures`, and weighted `variations`. Two things about real
      packs that fixtures will not teach you: vanilla keys blocks **bare**
      (`stone`, not `minecraft:stone`) while every name on the wire is namespaced,
      and `blocks.json` must be **merged across the stack** rather than resolved
      winner-takes-all, because a server pack routinely ships an entry carrying
      only `sound` and would otherwise erase vanilla's textures. Either mistake
      renders the entire world as the missing-texture fallback.
- [x] Build the terrain atlas with nearest-neighbour filtering, correct handling
      of non-16px textures, and animated flipbook entries from
      `flipbook_textures.json`. Much of the vanilla foliage ships as **TGA only**,
      so that decodes too (uncompressed and run-length), with `_opaque.png` as a
      fallback.
- [x] Implement the chunk mesher: face culling against neighbours, greedy
      merging, a transparency pass, and correct behaviour at column boundaries
      that have not loaded. Merged quads carry tile-space coordinates and their
      atlas rect so the texture repeats across the run instead of the sheet being
      stretched over it.
- [x] Map block state properties to visual variation — rotation, axis, facing,
      open/closed, age — for vanilla blocks.
- [x] Implement liquids: surface geometry, flow direction from state, animated
      texture, and the layer-1 waterlogging the world already tracks through
      `World.Liquid`.
- [x] Implement biome tinting for grass, foliage and water. **Go half landed
      (Stage 10a):** request-mode `LevelChunk` biomes decode via dragonfly
      `NetworkDecodeBuffer(..., 0, ...)`, and complete columns export a 16×16
      surface `biomePalette` + `biomes` on the snapshot (see `PROTOCOL.md`).
      **Renderer half landed (Stage 10b):** the column fields feed the
      `biomeAt` lookup (`terrain/biome.ts`, store decode) and tinting degrades
      to untinted when biomes are absent.
- [x] Render block entities that the client draws with dedicated geometry rather
      than from the atlas: chests, signs, banners, beds, skulls. Column
      `blockEntities` on the wire (sign text); chest/sign shaped boxes + sign
      canvas text; banner/bed/skull = flat coloured boxes (no banner patterns).
      Non-cube shapes (slabs, stairs, fences, doors) still full cubes.

**Check:** unit tests for the atlas builder and the state-to-model resolver, a
mesher fixture that proves interior faces are culled and merging reduces
triangles, and a pixel assertion that a merged run repeats its texture rather
than sampling the sheet. Golden images belong to stage 12.

Reality check that fixtures cannot give you: `npm run diagnose:terrain` serves the
**real** pinned baseline and a **real** server pack through the bot's own routes
and counts how many block identifiers resolve against how many fall back, naming
the reason for each failure and dumping the atlas to a PNG. It found the bare-key
mismatch above in one local run after three deploy-and-look cycles had failed to,
and it skips itself when those packs are absent.

---

## Stage 7 — entities

- [x] Parse `.geo.json` geometry: bone hierarchy, pivots, cube inflation,
      per-face UVs, mesh (poly) elements, and the coordinate conversion between
      Bedrock and the renderer's handedness. _(library: `viewer/src/geometry/`)_
- [x] Parse client entity definitions: geometry, texture, material and animation
      short-name tables. _( `viewer/src/entity/` — materials/animations stored;
      geometry+texture drive the renderer)_
- [x] Implement render controllers. Resolve `geometry`, `textures`, `materials`
      and `part_visibility`, including `arrays` indexed by Molang expressions and
      the `color` / `overlay_color` / `on_fire_color` / `is_hurt_color` fields.
      This needs the Molang interpreter, so land a constant-expression subset
      here and revisit.
      _(geometry / textures / part_visibility / arrays+Molang + colour overlays
      via `evaluatePassTint`; hurt flash needs `hurt_time` on the wire — open)_
- [x] Implement the material layer: alpha test versus blend, backface culling,
      emissive materials, and the tinting a controller applies. The vanilla
      material definitions are not in `bedrock-samples`, so the mapping from
      material name to render state has to be established empirically and
      documented per material.
      _(`entity/material.ts` + table in `entity/README.md`; emissive = unlit
      MeshBasicMaterial note; default = alphatest@0.5)_
- [x] Render players: skin geometry from the wire, slim versus classic arms,
      cape, and the metadata-driven pose set (sneaking, swimming, crawling,
      gliding, sleeping, riding).
      _(basic: `geometry.humanoid.custom` + Steve texture; wire carries no skin —
      documented gap; no slim/cape/pose set yet)_
- [x] Render armour and held items using the vanilla layer geometry and the
      equipment state the world already tracks.
      _(armour: `geometry.humanoid.armor.*` + `textures/models/armor/<stem>_{1,2}`
      reparented onto body bones; held: flat icon quad on right-hand bone;
      attachables / thickness extrusion punted)_
- [x] Render dropped items and item frames, including the flat-item geometry the
      client generates from a sprite.
      _(dropped: `held.main` from Go `Item()`; spin+bob sprite. Item frames ride
      the Stage 6 block-entity pipeline — not built here)_
- [x] Render name tags with the client's font, ordering and occlusion rules.
      _(in-scene canvas billboards; § colours; hide on sneak; plain depth-test
      occlusion — no through-wall dimming; DOM labels retired)_

**Check:** golden images per entity type at fixed camera and pose, and unit
tests for the geometry parser against fixture `.geo.json` files covering nested
bones, inflation and mesh elements.

---

## Stage 8 — custom content, from the wire

Custom blocks are not in `blocks.json` and never will be. They arrive in the
join sequence, which is exactly how a real client learns to draw them without
ever seeing a behaviour pack.

- [x] Read the network block palette. `GameData.CustomBlocks` is
      `[]protocol.BlockEntry` — a name plus the block's definition NBT — and it
      carries the components the renderer needs, `minecraft:geometry` and
      `minecraft:material_instances` among them. Decode components, properties,
      permutations and the Molang version. (`gotestbds/wire`, keyframe
      `registries`)
- [x] Establish precedence between the network palette and `blocks.json`, and
      assert it with a fixture rather than assuming it. (`FINDINGS-wire.md`,
      `TestPaletteWinsOverBlocksJSON`)
- [x] Resolve the geometry and texture names the palette references against the
      resource pack stack from stage 5. The palette says what to draw with; the
      pack holds the thing itself. _(renderer: `material_instances` →
      `terrain_texture.json` atlas; pack `blocks.json` textures win when present,
      palette covers the rest; `createTexturedMesher({ registries })` /
      `applyRegistries`)_
- [x] Support custom block geometry with per-instance materials, including
      `render_method`, face-dimming and ambient-occlusion flags. _(renderer:
      `.geo.json` via `BlockGeometryCache` + atlas textures; missing geo → cube
      fallback; no greedy merge / no neighbour occlusion for custom cells)_
- [x] Support permutations: evaluate permutation conditions against the state
      properties carried in the snapshot and select the resulting components.
      _(renderer: `query.block_property` / `q.block_state`; compile-cached)_
- [x] Support transformation components (rotation, scale, translation), bone
      visibility, and `minecraft:light_emission` where it affects appearance.
      _(renderer: transform about block centre; bone_visibility molang/bool;
      emission boosted into vertex colour — no light propagation)_
- [x] Read custom item components from `packet.ItemRegistry`, whose entries carry
      them for exactly the same reason, and resolve item icons through the pack
      stack's `item_texture.json`. _(decode + icon short-name on wire; pack
      resolve is renderer)_
- [x] Read entity property definitions from `packet.SyncActorProperty` so
      `query.property` has something to resolve against.
- [x] Establish the fallback chain for a block the palette and pack stack cannot
      resolve: named-but-unknown, unnamed-but-present, and absent, each visually
      distinct so a missing asset is never silently a solid grey cube.
      _(classification + PROTOCOL; renderer: magenta `__missing__` = unnamed /
      load bug; stone-grey `__neutral__` = named gap / palette without materials)_

**Check (Go):** fixture join sequence under `gotestbds/wire/testdata` — custom
block resolves geometry and materials from palette NBT alone; no behaviour pack
in the fixtures. Palette-vs-`blocks.json` precedence and three-way fallback
asserted. Renderer pack resolution remains for later stage boxes.

---

## Stage 9 — animation and Molang

- [x] Integrate a Molang interpreter and bind the query surface the renderer can
      answer: entity state flags, health and attributes, position and rotation,
      velocity-derived queries, `query.life_time`, `query.anim_time`,
      `query.modified_distance_moved`, variant and mark-variant, and the
      `query.property` accessor for entity properties. The interpreter is in
      `viewer/src/molang/` (tokeniser, Pratt parser, evaluator, compile cache) with
      the host supplying queries, arrays, variables and an **injectable** random
      source — a golden-image renderer cannot call `Math.random`. Unknown queries
      resolve to 0 and are recorded, so an unimplemented one is reportable rather
      than silently wrong. Trig is in degrees and out-of-range array indices wrap;
      both verified against the documentation, not assumed.
- [x] Extend the snapshot with everything those queries need, including entity
      properties, which the world does not currently decode. _(entity `props`,
      flags and attributes ride the snapshot; property **definitions** come from
      `packet.SyncActorProperty` in stage 8)_
- [x] Implement animation playback: bone keyframes, interpolation modes,
      `anim_time_update`, looping, and Molang-valued channels.
      (`viewer/src/entity/parseAnimation.ts`, `animation.ts` — linear +
      catmullrom per actor_animation 1.8.0 schema; older bedrock.dev text that
      claimed "only linear" is outdated. `loop` / `hold_on_last_frame` / stop.)
- [x] Implement animation controllers: states, transitions with Molang
      conditions, blend transitions, and per-state animation weights.
      (`parseAnimController.ts`, `controllerRuntime.ts` — one transition/frame,
      `blend_transition` on the leaving state.)
- [x] Implement the client-side animation entrypoints from the entity
      definition's `scripts` block — `animate`, `pre_animation`,
      `initialize`, and variable assignment ordering.
- [ ] ~~Implement attachables for held and worn items, including their own
      geometry, animations and bone binding.~~ **Punted** with Stage 7 item work
      (armour / held items / attachables).
- [x] Handle interpolation of networked motion: the client smooths between
      `MoveActorAbsolute` updates rather than snapping, and matching that is
      most of what makes motion look right. _(already in `viewer/src/motion.ts`
      `MotionLerp` — inter-arrival span clamped ~16–250 ms ≈ 1–5 ticks; scene
      `upsertEntity` no longer snaps pose on sync; `tickEntities` applies lerped
      samples + bone animation. Particle / sound keyframes from animations also
      **punted**.)_

**Check:** evaluate fixture animations at fixed times and assert bone transforms
against recorded values; assert controller state sequences for a scripted input
series. ✓ `tests/entity.animation.spec.ts`

---

## Stage 10 — lighting and environment

- [x] ~~Decode and store sky and block light from the chunk payload; the world
      currently discards it.~~ **Wrong premise, corrected.** Bedrock does not send
      light at all — the client computes it, which is why nothing in the chunk
      decode touches it. Fill it locally instead: dragonfly already implements the
      propagation (`chunk.LightArea(...).Fill()` + `Spread()`), so a column
      completing runs a fill and the snapshot carries the result per section
      (`skyLight` / `blockLight`, with all-15 / all-0 omission defaults). **Go
      half landed (Stage 10a).** Reimplementing propagation in the browser would
      be a great deal of code for something already sitting in a dependency.
- [x] Implement the client's lighting model: per-face shading, smooth lighting,
      ambient occlusion. **Viewer half landed (Stage 10b):** samples light at the
      face-neighbour cell (smooth: average 4 corner-adjacent cells + classic AO),
      brightness curve `L/(4−3L)` with `L=level/15`, face shade
      up/down/N-S/E-W = 1.0/0.5/0.8/0.6, baked into `vertColor`. Smooth lighting
      flag defaults ON (skips greedy merge when on). Light on block change arrives
      as re-encoded `columnsAdded` sections (Go refill) — store decode remeshes.
- [x] Wire column `biomePalette` + `biomes` into the existing `biomeAt` / tint
      path (`plains` → `minecraft:plains`; numeric ids → untinted fallback).
- [~] Implement the sky: time of day, sun and moon, star field, clouds, and the
      horizon gradient per dimension. **Partial:** gradient sky dome + distance
      fog (10b); when snapshot `time` is present — 4-keyframe palette lerp
      (sunrise/noon/sunset/midnight), sun + moon quads (`textures/environment/`),
      seeded star field, ambient/dir light scale. **Absent `time` = fixed noon
      look (goldens unchanged).** Clouds punted (flat drifting plane not worth
      the atlas cost for captures). Per-dimension horizon tables still open.
- [ ] Implement fog from client biome definitions and `fog` JSON, including
      distance fog, water fog and the dimension defaults. **Partial (10b):**
      basic distance fog only (horizon colour follows sky palette when `time`
      present; near/far from chunk radius). Water fog / fog JSON **punted**.
- [ ] Implement weather: rain, snow, and their effect on lighting. **Punted.**
- [x] Implement camera state: field of view and its modifiers, view bobbing,
      third-person offsets, and the camera instruction packets a server can send
      to override any of it. Go handles `CameraPresets` / `CameraInstruction` /
      `SetTime`; snapshot exports additive `camera` + `time`. Viewer: server
      pos/rot override with ease lerp; FOV sprint widen + instruction FOV;
      follow offset = Bedrock 4-block third-person + single-ray occlusion
      pull-in; view bobbing opt-in via `?bobbing=1` (default OFF for goldens).
      Base FOV stays 70° (current PerspectiveCamera) — Bedrock ~66 would shift
      goldens. Fade export only (no overlay draw yet).

**Check:** golden images at fixed times of day and weather states. Stage 12
goldens regenerated after 10b shading/sky landed; 10c keeps absent-`time`
noon so goldens need no regen.

---

## Stage 11 — effects and interface

- [x] Implement the particle system from particle JSON: emitters, curves, and
      the Molang-driven components, matching the documented component set.
      (`viewer/src/particles/`: parse + curves + runtime Points; components =
      rate instant/steady/manual, lifetime once/looping/expression, shapes
      point/sphere/box/disc, lifetime/speed/spin, motion dynamic/parametric,
      billboard + tinting, kill_plane; lighting no-op; collision/events/custom
      shape/manual-only path recorded-unsupported. Cap 4096, injectable RNG.
      `SpawnParticleEffect` → event-lane `particle` frame.)
- [~] Render server-triggered effects: block-break particle bursts go through
      the particle system (vanilla `breaking_item_terrain` when resolvable and
      non-atlas; else built-in gray fallback). Damage flash, death animation,
      `packet.ActorEvent` and `packet.LevelEvent` decoding are punted.
- [x] Render the heads-up display as a plain DOM overlay (`viewer/src/ui/hud.ts`):
      chat (last ~8 lines, `§` colour codes, fade after ~10s), title/subtitle +
      action bar (fadeIn/stay/fadeOut from SetTitle ticks), hotbar (short-name
      text + count + selected slot), health/hunger when the actor carries them.
      Wire: actor already had hotbar/health/food; UI now fills title fields;
      event-lane `chat`/`title` frames never drop. Boss bar punted. Item icons
      punted (no atlas). Protocol noise (`[RUN_ACTION]`/`[STATUS]`/`[GOTESTBDS]`)
      filtered on the Go side.
- [x] Render forms and containers. The bot tracks open forms, containers, signs
      and NPC dialogues; drawing them is what makes a recording of a test show
      what the player would have seen at the moment of failure. Drawn as a plain
      DOM panel showing the open form's title, body and buttons, or a container's
      name and slot count — which is the half that matters for a recording. JSON
      UI and the font atlas are the boxes below, and are untouched.
- [ ] Implement JSON UI to the extent the HUD and forms require, driven by the
      pack stack so a server's custom UI appears. **Punt for recordings:** the
      DOM approximation (forms panel + `#player-hud`) is the deliberate scope —
      JSON UI is a fidelity goal, not what capture needs to read as gameplay.
- [ ] Render text with the client's font atlas, including glyph pages, format
      codes and the custom glyph sheets packs ship. The vanilla atlas is not in
      `bedrock-samples`, so this stage owns the answer to where it comes from.
      **Punt for recordings:** `§` codes → coloured DOM spans is enough; the
      font atlas is the same fidelity track as JSON UI above.

**Check:** golden images for each UI surface against recorded state. (HUD
covered by Playwright DOM asserts in `viewer/tests/hud.spec.ts` until goldens
exist for these surfaces.)

---

## Stage 12 — visual regression in CI

- [x] Add the golden-image suites to CI with a tolerance that survives driver
      differences, and a documented procedure for reviewing and accepting
      intentional visual changes.
      (`viewer/tests/golden.spec.ts` + `goldenCompare.ts`; thresholds Δ8 /
      0.5% pixels; `GOLDEN_UPDATE=1` accept; `GOLDEN_SOFT=1` local escape;
      workflow `.github/workflows/viewer-golden.yml`.)
- [x] Wire the vanilla-baseline bump PRs into the same suites, so a Mojang asset
      change arrives as a reviewable image diff rather than a surprise.
      _(`viewer-golden.yml`: `viewer/**` paths catch pin-only PRs; fetches
      baseline via `cmd/fetch-baseline`; goldenApp overlays real textures;
      accept with `GOLDEN_UPDATE=1` / workflow_dispatch `golden_update`.)_

**Check:** a deliberate one-pixel regression fails the job; an accepted change
is a one-command update with the diff visible in review.

---

## Research

Each of these has to be answered with a written finding — a note in this
directory, a fixture, or a test — before the stage that depends on it is built.

**Assets and packs**

- How the client resolves a pack stack: order, subpack selection, and what a
  partial override does to a texture that other packs also define.
- What a real installation has that `bedrock-samples` omits, item by item, and
  which rendering surfaces degrade without each. Materials, shaders and fonts
  are the known three; confirm there is not a fourth.
- How vanilla materials map to concrete render state, and how far the mapping
  can be inferred from observed behaviour rather than from definitions the
  samples repo does not ship.
- What happens when a bot declines a server's pack, and whether declining is
  ever the right default given a required pack is a join condition.

**Wire-carried definitions**

- Exactly what the block palette NBT contains per version, and whether every
  component the renderer needs is present for a block authored today. This is
  the load-bearing assumption behind the no-behaviour-pack rule and deserves a
  recorded palette in `testdata` as evidence. **Answered:**
  [`FINDINGS-wire.md`](FINDINGS-wire.md) + `gotestbds/wire/testdata`.
- Whether the palette's component set and `blocks.json` ever describe the same
  block, and which wins if so. **Answered:** same name can appear in both;
  palette wins for geometry/materials (`TestPaletteWinsOverBlocksJSON`).
- Which registries beyond blocks and items cross the wire, and whether any
  render-relevant data is only ever in a behaviour pack. If something is, the
  finding is what the viewer approximates instead — not a behaviour-pack
  dependency. **Answered:** SyncActorProperty; BP-only gaps listed in
  FINDINGS-wire.

**Geometry and animation**

- The exact coordinate, pivot and rotation-order conventions between Bedrock
  geometry, Blockbench's editor space and the renderer's space, verified against
  a model with nested rotated bones rather than assumed.
- Which Molang queries the renderer can answer from packet-visible state, which
  need state the bot does not yet track, and which are client-only and must be
  approximated. The result determines what stage 1 must carry.
- How the client interpolates entity motion and rotation between updates, and
  how head yaw is separated from body yaw.

**Protocol**

- The full set of currently unhandled packets, each classified as render-
  relevant or not, and the cost of handling each. **Answered:**
  [`PACKETS.md`](PACKETS.md).
- How the client renders block updates it has not yet been told about, and what
  a chunk boundary looks like when the neighbour is unloaded. **Half answered:**
  the placeholder mesher's policy is decided and documented (an unknown neighbour
  counts as exposed, so the frontier is drawn rather than hidden, and a column
  still missing sub-chunks is outlined instead of drawn solid). What the real
  client does there is still unstudied.
- Whether the client cache blob protocol needs implementing for chunks to arrive
  intact on servers that enable it.

**Capture**

- Which headless capture mechanism produces frames identical to the interactive
  path, and whether a CI runner without a GPU can sustain the frame rate a
  watchable video needs. **Answered:** [`FINDINGS-capture.md`](FINDINGS-capture.md)
  picks Playwright's Chromium, and no — SwiftShader paints a few frames a second
  on real terrain, which is why the video is a time lapse and why the mesher only
  emits exposed faces.
- How a screenshot request is made deterministic with respect to the bot's tick,
  and what the failure mode is when the requested tick never renders.
  **Answered:** the request carries `minTick` and a deadline, the harness resolves
  it on the first frame at or past that tick, and a deadline that expires comes
  back as an error the SDK turns into a null screenshot and a log line.
- What a practical golden-image tolerance is across GPUs and drivers, and
  whether software rendering is fast enough for CI.

**Rendering**

- The client's lighting model in enough detail to reproduce it: shading per
  face, smooth lighting interpolation, and how ambient occlusion is applied.
- How Vibrant Visuals and Texture Sets change the pipeline, and what a
  non-PBR renderer should do with a pack that ships PBR layers.

**Prior art worth reading before writing the equivalent**

- `bridge-core/model-viewer` and `bridge-core/molang` — the closest open
  implementations of Bedrock geometry rendering and Molang evaluation.
- `JustTalDevelops/worldcompute` — a gophertunnel and Dragonfly client that
  renders live chunk data, and the nearest precedent for stage 1.
- `PrismarineJS/prismarine-viewer` — a mature bot viewer for the Java protocol;
  its `Viewer` and `WorldView` split is a working answer to the question stages
  1 and 2 are dividing.
- Blockbench — the reference implementation for reading every Bedrock model
  format the viewer has to parse.
