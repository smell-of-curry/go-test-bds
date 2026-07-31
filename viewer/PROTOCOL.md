# Viewer protocol — schema v1

The contract between the Go side (which projects `world.World` into snapshots)
and the web side (which draws them and captures pixels). Everything in this file
is normative: an implementation that disagrees with it is wrong.

`PLAN.md` says what to build and why. This file says exactly what the bytes look
like. Read `PLAN.md`'s invariants first — in particular, the viewer never sends a
packet, never drives a bot, and a run behaves identically whether or not anyone
is watching.

## Versioning

Every frame carries `"v": 1`. The version is the schema version, bumped on any
change that an older client could misread. A client that receives an unknown `v`
must refuse to render and say so, rather than guessing.

---

## Transport

Server-Sent Events over plain HTTP, served by the bot process from Go's
standard library. Not a WebSocket, for three reasons worth writing down because
`PLAN.md` originally assumed one:

1. The snapshot stream is strictly server → client. The viewer being a read-only
   observer is an invariant, so the client half of a duplex channel would exist
   only to be unused.
2. `net/http` serves SSE with no dependency. A WebSocket needs one.
3. `EventSource` reconnects on its own. Stage 2 requires "reconnect and keyframe
   resync"; with SSE that is a server that always opens a stream with a
   keyframe, and no client reconnect logic at all.

The directions that genuinely need client → server — a capture harness handing
back a PNG, or reporting that it could not — are plain `POST`s, listed below.

### `GET /stream?bot=<name>`

`Content-Type: text/event-stream`. Emits, in order:

```
event: hello
data: {"v":1,"type":"hello","bot":"TestBot","schema":1,"tickRate":20,"radius":4}

event: keyframe
data: {...}   // includes registries (join-static)

event: delta
data: {...}
```

- `bot` is optional when the process runs a single bot; with several it is
  required and a missing or unknown name is a `404`.
- Every connection starts with `hello` then exactly one `keyframe`. A client
  that reconnects therefore resyncs for free.
- Join-static registries (custom blocks, component items, entity property
  defs) ride on the keyframe as `registries` — same timing as a one-shot
  registry frame after hello, without a third SSE event type. Deltas omit
  them; they do not change during a run.
- The server writes a comment line (`: keepalive`) every 15 s so idle
  connections survive proxies.
- Frames are flushed per event. The server never blocks the bot's tick loop to
  write one; see *Backpressure*.

### `GET /bots`

```json
{"v":1,"bots":[{"name":"TestBot","tick":1024,"dimension":0,"attached":1}]}
```

`attached` is the number of live stream subscribers for that bot. This is how a
harness discovers what to attach to, and how `screenshot` decides whether a
viewer exists at all.

### `POST /artifact`

Raw body is the artefact's bytes. Metadata rides in headers so the body stays a
single blob:

| Header | Required | Meaning |
| --- | --- | --- |
| `X-Artifact-Kind` | yes | `screenshot` or `video` |
| `X-Artifact-Ext` | yes | `png` or `webm` |
| `X-Artifact-Bot` | yes | bot name |
| `X-Capture-Id` | no | fulfils the pending capture with this id |
| `X-Artifact-Tick` | no | tick the frame was rendered from |
| `X-Artifact-Width` / `-Height` | no | pixels |
| `X-Artifact-Duration-Ms` | no | video length |
| `X-Artifact-Run` / `-Suite` / `-Test` | no | run correlation, used for the path |
| `X-Artifact-Label` | no | free-text label, slugged into the filename |

Response `200`:

```json
{"v":1,"path":"machines/places-a-crate/failure.png","bytes":48213}
```

Go owns the artefact directory and therefore owns naming. Every reported `path`
is **relative to the run's artefact directory, with `/` separators** — never
absolute, never relative to the process working directory. That is the one form
`bds-manager` will resolve and serve: a consumer joins it onto the directory it
already knows, and a path that escapes that directory is rejected rather than
guessed at.

### `POST /capture/<id>/error`

```json
{"message":"no canvas frame reached tick 1024 within 30000ms"}
```

Fails the pending capture with that message. A harness that cannot produce a
frame must say so; the alternative is an instruction that hangs, which the
invariants forbid.

### `GET /` and `GET /health`

`GET /health` returns `{"v":1,"ok":true,"bots":[...]}`. `GET /` serves the built
viewer app when the process was given one (`--viewer-app <dir>`), otherwise a
one-line explanation of how to start it. Serving the app from the bot process is
what makes the harness a single URL to open.

---

## Client readiness (`window.__viewer`)

The web app assigns `window.__viewer` at startup (before any SSE frame) so a
capture harness can distinguish "app never loaded" from "stream stuck":

| Field | Meaning |
| --- | --- |
| `schemaOk` | `false` until a `hello` or `keyframe` with supported `v` arrives; then `true` |
| `tick` | Latest applied frame tick |
| `framesReceived` | Count of frames that reached the store |
| `lastError` | Schema refusal or latest stream/parse error; `null` when healthy |

A harness that times out waiting for readiness should log these fields rather
than only the Playwright timeout string.

## Viewer page query parameters

The app is opened as `GET /?bot=<name>` (or `?stream=<sse-url>` against a Vite
dev server). Extra query parameters select client-only view options — they never
reach the bot and do not change the stream.

| Param | Values | Default | Notes |
| --- | --- | --- | --- |
| `bot` | bot name | (required when not using `stream`) | Selects which bot's `/stream` to open |
| `stream` | absolute SSE URL | derived from `bot` | Used by the Vite dev server / tests |
| `camera` | `follow` \| `first` \| `firstPerson` \| `orbit` | `firstPerson` | Initial camera mode. Capture harness opens with `camera=follow` so the bot body and surroundings are in frame; press **C** to cycle first-person → follow → orbit |
| `bobbing` | `1` / `true` / `on` | off | Opt-in view bobbing in follow mode. Default off so goldens/captures stay deterministic |

Follow mode sits behind and slightly above the observed actor (over-the-shoulder;
Bedrock third-person distance = 4 blocks, with a single terrain occlusion ray).
First-person stays locked to `eyePos`/`rot`. Orbit is the free inspection camera.
A present snapshot `camera` object overrides follow/first-person with the
server-driven position/rotation (eased over `easeDurationMs`); `cameraCleared`
on a delta restores the client default.

---

## Frames

### `hello`

| Field | Type | Notes |
| --- | --- | --- |
| `v` | `1` | schema version |
| `type` | `"hello"` | |
| `bot` | string | bot display name |
| `schema` | `1` | same as `v`, kept explicit for clients that log it |
| `tickRate` | number | server ticks per second, `20` |
| `radius` | number | column radius the stream carries |

### `keyframe`

World metadata, actor, entities, UI, and registries, plus a **budgeted** subset
of columns. A full radius (tens of columns, hundreds of sections) is several
megabytes; the stream therefore paces columns the way a real client streams
chunks — first batch on the keyframe, the rest on later `delta.columnsAdded`.

```json
{
  "v": 1,
  "type": "keyframe",
  "bot": "TestBot",
  "tick": 1024,
  "world": {
    "dimension": 0,
    "dimensionName": "overworld",
    "minY": -64,
    "maxY": 319
  },
  "actor": { "...": "see Actor" },
  "columns": [ { "...": "see Column" } ],
  "columnsPending": 77,
  "entities": [ { "...": "see Entity" } ],
  "ui": { "...": "see UI" },
  "registries": { "...": "see Registries" },
  "time": 6000,
  "camera": { "...": "see Camera" }
}
```

- `time` is absolute world time ticks from `packet.SetTime`. Absent means the
  client keeps its fixed noon sky (Stage 10b goldens). Present → ticks-of-day
  `time % 24000`, day count `floor(time / 24000)` for moon phase.
- `camera` is a server `CameraInstruction` override. Absent means the client's
  default follow / first-person / orbit mode. See *Camera* below.
- `columns` holds at most `ColumnBudget` columns (config; default 4), nearest the
  actor first. It may be empty when the radius holds nothing yet.
- `columnsPending` is how many columns in the stream radius have **not** been
  delivered to this subscriber yet. Absent or `0` means the world is fully
  delivered; a positive value means more columns follow on `delta.columnsAdded`.
- A consumer applies the keyframe as a wholesale replace (drop prior columns /
  entities), then merges later `columnsAdded` the same way it would for any
  delta. Partial keyframe + `columnsAdded` is the normal catch-up path, not an
  error.
- Every connection still starts with exactly one `keyframe` before any `delta`.
  A mid-run attach or a full resync (fresh attach, dimension change, or a
  superseded unsent keyframe) re-queues columns from scratch rather than
  blasting the full radius in one frame. Superseding an unsent catch-up
  `delta` only re-queues that frame's columns — already-delivered columns stay.

`dimensionName` is one of `overworld`, `nether`, `end`, or `custom:<id>` for a
script-registered dimension the bot only knows by number.

### `delta`

Only the keys that changed since the previous frame are present. An absent key
means "unchanged", never "empty".

```json
{
  "v": 1,
  "type": "delta",
  "bot": "TestBot",
  "tick": 1025,
  "world": { "dimension": 1, "dimensionName": "nether", "minY": 0, "maxY": 127 },
  "blocks": [ { "pos": [12, 64, -8], "layer": 0, "block": { "...": "see Block" } } ],
  "columnsAdded": [ { "...": "see Column" } ],
  "columnsRemoved": [ [0, 0], [0, 1] ],
  "columnsState": [ { "x": 0, "z": 1, "state": "complete" } ],
  "columnsPending": 60,
  "entitiesAdded": [ { "...": "see Entity" } ],
  "entitiesUpdated": [ { "...": "see Entity" } ],
  "entitiesRemoved": [ 41, 42 ],
  "actor": { "...": "see Actor" },
  "ui": { "...": "see UI" },
  "time": 18000,
  "camera": { "...": "see Camera" },
  "cameraCleared": false
}
```

- `world` present at all means the dimension changed: the client must drop every
  column and entity it holds before applying the rest of the frame. (Dimension
  changes are delivered as a fresh paced keyframe, not a delta with `world`.)
- `time` present means world time changed; absent means unchanged.
- `camera` present means the override changed; `cameraCleared: true` means an
  active override was cleared (return to the client default). Absent both =
  camera unchanged.
- `columnsAdded` is both "chunk entered the radius" and "next batch of a paced
  keyframe catch-up". At most `ColumnBudget` columns per frame. An unchanged
  column that the subscriber already has is never re-sent.
- `columnsPending` mirrors the keyframe field: columns still outstanding for
  this subscriber. Absent or `0` when caught up.
- `entitiesUpdated` carries whole entity objects, not field patches. An entity
  is a few hundred bytes and a patch protocol is a second schema to maintain.
- `actor` is sent every tick — it is small and always moving.
- `ui` is sent only when it changed, and is a whole `UI` object when it is.

### `mark`

Run lifecycle, forwarded from the addon's reporter through the `viewerMark`
instruction. Broadcast to every bot's stream, because a run is not per-bot.

```json
{
  "v": 1, "type": "mark", "bot": "TestBot", "tick": 1024,
  "phase": "testEnd",
  "runId": "run-7", "suite": "machines", "test": "places a crate",
  "status": "failed",
  "message": "expected pokeb:crate, got minecraft:air",
  "elapsedMs": 3412
}
```

`phase` is one of `runStart`, `suiteStart`, `testStart`, `testEnd`, `suiteEnd`,
`runEnd`. `status` and `message` appear on `testEnd` and `runEnd`. Everything
else is optional and absent when unknown.

This is the source of the burnt-in caption (suite/test/phase). The capture
harness records **one** continuous video for the whole run; marks do not start
or stop recording.

Suites may additionally emit `phase: "segment"` marks to annotate spans of the
run timeline. Conventions:

- `message: "walk:start"` / `message: "walk:end"` — bracket a long walking
  leg. After the recording is written these intervals play sped-up
  (`--timelapse <factor>`, default 8, env `GOTESTBDS_TIMELAPSE`; requires a
  full ffmpeg — see the capture CLI help).
- `message: "idle:start"` / `message: "idle:end"` — bracket a sit-and-wait
  (VO, form pause). Play at `--idle-timelapse` (default 24, env
  `GOTESTBDS_IDLE_TIMELAPSE`). Unmarked gaps between walks use the same
  idle factor.
- `message: "loading:start"` / `message: "loading:end"` — bracket a
  chunk-load wait (e.g. after a teleport). These intervals are **cut** from
  the output video entirely (not sped). Cuts shorter than ~1s are kept to
  avoid jarring pops. An unmatched `loading:start` is ignored (never
  cut-to-EOF). Loading wins over walk/idle on overlap.

The harness also synthesises `suite:start` / `suite:end` timeline marks from
`suiteStart` / `suiteEnd` lifecycle frames and **cuts** suites whose names do
not match `GOTESTBDS_TIMELAPSE_KEEP_SUITES` (default `/showcase/i`), plus the
prefix before the first kept suite. The post-suite tail is kept so celebration
frames after the last assertion still land in the reel.

The harness times `segment` / suite marks against the run video; message
strings pass through untouched. `segment` marks never update the caption.

### `capture`

A request for a still. Emitted when the `screenshot` instruction runs.

```json
{"v":1,"type":"capture","bot":"TestBot","id":"cap-3","minTick":1024,"timeoutMs":30000,"ext":"png","label":"after-interact"}
```

The harness must not answer until it has rendered a frame from a snapshot whose
`tick` is `>= minTick`, then `POST /artifact` with `X-Capture-Id: cap-3`. If it
cannot, `POST /capture/cap-3/error`. Answering early is worse than failing: a
stale screenshot is a lie about when the test was.

`timeoutMs` is the `screenshot` instruction's own deadline, carried on the frame
so both sides give up at the same moment. A harness that used its own shorter
constant would fail captures the waiting instruction was still willing to wait
for, and silently cap every caller's `timeoutMs`.

---

## Objects

### Block

```json
{ "name": "minecraft:stone", "states": {}, "rid": 12345 }
```

- `name` and `states` come from `world.Block.EncodeBlock()` — identifiers and
  state properties, never indices, because runtime IDs are registry-local.
- `rid` is the raw network runtime ID, carried as an opaque fallback for the
  blocks the registry cannot name. Those are exactly the addon blocks a renderer
  most needs to draw, so they must survive the trip.
- A block the registry cannot name has `"name": ""` and a non-zero `rid`. The
  renderer's fallback chain keys on that.

#### Fallback classification

A consumer distinguishes three unresolved cases from Block fields +
`registries.blocks` + pack resolution (see `wire.ClassifyFallback`):

| Case | How to tell | Draw as |
| --- | --- | --- |
| **absent** | `name` is `minecraft:air`, or empty name with `rid == 0`; or the column `state` is not `complete` / section missing for "not loaded" | nothing (or column outline for unloaded) |
| **unnamed_but_present** | `name == ""` and `rid != 0` | distinct debug mesh (not grey cube) |
| **named_but_unknown** | non-empty `name`, not air, and neither `registries.blocks[name]` nor the pack stack produced an appearance | distinct debug mesh (different from unnamed) |

Resolved custom blocks: `name` matches an entry in `registries.blocks` whose
components carry geometry / material_instances (network palette wins over any
`blocks.json` row for the same name — `viewer/FINDINGS-wire.md`).

### Column

```json
{
  "x": 0, "z": 0,
  "state": "complete",
  "minY": -64, "maxY": 319,
  "sections": [
    {
      "y": -4,
      "palette": [ { "name": "minecraft:air", "states": {}, "rid": 0 } ],
      "blocks": "<base64>",
      "blocks1": "<base64>",
      "skyLight": "<base64>",
      "blockLight": "<base64>"
    }
  ],
  "biomePalette": ["plains", "forest", 192],
  "biomes": "<base64>"
}
```

- `state` is `requested`, `partial` or `complete`. A renderer draws
  `requested` as nothing at all and must not treat the boundary of a
  non-`complete` column as an open void.
- `y` is the section index: the section covers blocks `y*16` to `y*16+15`.
- `sections` omits sections that hold only air. An absent section is air, not
  "unknown" — unknown is what `state` is for.
- `palette` is that section's distinct blocks. `blocks` indexes into it.
- `blocks` is base64 of 4096 little-endian `uint16` palette indices, ordered
  `index = (x << 8) | (z << 4) | y` with `x`, `y`, `z` local to the section.
  That is Bedrock's own sub-chunk order, so the encoder is a straight loop.
- `blocks1` is layer 1 (the waterlogging layer) in the same encoding, present
  only when that layer holds something other than air.
- `skyLight` / `blockLight` are base64 of **2048 bytes** (4096 four-bit
  nibbles) in the **same index order as `blocks`**:
  `index = (x << 8) | (z << 4) | y`, packed two nibbles per byte with the
  even index in the low nibble (Bedrock / dragonfly packing). Bedrock never
  sends light on the wire — the bot fills it with dragonfly
  `chunk.LightArea(...).Fill()` + `Spread()` when a column completes, and
  re-fills on block edits (debounced to once per snapshot tick).
  - Absent `skyLight` means every nibble is `15` (full sky).
  - Absent `blockLight` means every nibble is `0`.
  - Incomplete columns (`requested` / `partial`) omit both fields.
  - Fill uses a 3×3 `LightArea` when neighbours exist; `Spread()` runs only
    when every neighbour column is `complete`. Missing edges use empty
    placeholder chunks and skip Spread (no open-sky leak under platforms).
- `biomePalette` + `biomes` are a **16×16 surface** map for grass/foliage/water
  tinting. For each local `(x, z)`, the biome is sampled at the top non-air
  block Y (`HighestBlock`). `biomes` is base64 of 256 `uint8` indices into
  `biomePalette`, ordered `index = (x << 4) | z`. Palette entries are
  dragonfly `Biome.String()` names when the network id is registered (e.g.
  `"plains"`), otherwise the numeric id. Both fields are omitted on
  incomplete columns. On block edits, the stream re-queues the column through
  budgeted `columnsAdded` so light/biomes stay in sync (per-block deltas do
  not carry those fields).
- `blockEntities` (optional) lists NBT-backed tile entities in the column for
  dedicated geometry: `{ pos:[x,y,z], id, textFront?, textBack? }`. Sign text
  comes from `FrontText`/`BackText` NBT. Absent or empty when the column has
  none. Additive — not a schema `v` bump; older clients ignore it.

### Entity

```json
{
  "rid": 41, "uid": -1103, "type": "minecraft:pig",
  "pos": [12.5, 64.0, -8.5],
  "rot": [90.0, 0.0],
  "vel": [0.0, -0.08, 0.0],
  "bbox": [0.9, 0.9],
  "name": "Porkchop",
  "player": false,
  "flags": { "onFire": false, "sneaking": false },
  "props": { "variant": 0, "markVariant": 0, "scale": 1.0 },
  "attributes": { "health": 10.0, "maxHealth": 10.0 },
  "held": { "main": { "...": "see Item" }, "off": null },
  "armour": [ null, null, null, null ]
}
```

- `rid` is the runtime ID and the map key. `uid` is the unique ID, which is what
  `packet.RemoveActor` names — carrying both is what keeps removed entities from
  surviving as ghosts.
- `rot` is `[yaw, pitch]` in degrees. A third element is head yaw where the
  entity has one.
- `bbox` is `[width, height]` from the entity's metadata state.
- `flags` is the full decoded metadata flag set, every flag that decodes, as
  `flagName -> bool`. Molang queries read from this later, so drop nothing.
- `props` carries the numeric and string metadata properties that decode
  cleanly. Same rule: drop nothing.
- `armour` is always four entries, helmet to boots, `null` for empty.
- `held.main` / `held.off` are the mob's equipment. For `minecraft:item`
  (dropped stacks) the stack rides `held.main` — the Go world stores it on
  `Item.Item()`, and the encoder copies that into `held.main` so the viewer
  needs no extra field.

### Item

```json
{ "name": "minecraft:diamond_sword", "count": 1, "damage": 0, "customName": "Sting" }
```

`damage` and `customName` are omitted when zero and empty.

### Registries

Join-sequence definitions. Names only — never runtime IDs as identity. Present
on keyframes; absent on deltas.

```json
{
  "blocks": [
    {
      "name": "fixture:custom_crate",
      "molangVersion": 10,
      "properties": [{ "name": "fixture:open", "enum": [false, true] }],
      "components": {
        "geometry": "geometry.fixture.custom_crate",
        "materialInstances": {
          "*": {
            "texture": "palette_right_texture",
            "renderMethod": "opaque",
            "faceDimming": true,
            "ambientOcclusion": true
          }
        },
        "transformation": { "rx": 0, "ry": 90, "rz": 0, "sx": 1, "sy": 1, "sz": 1, "tx": 0, "ty": 0, "tz": 0 },
        "lightEmission": 0.4,
        "collisionBox": { "enabled": true, "minX": 0, "minY": 0, "minZ": 0, "maxX": 16, "maxY": 16, "maxZ": 16 },
        "selectionBox": { "enabled": true, "origin": [-8, 0, -8], "size": [16, 16, 16] }
      },
      "permutations": [
        {
          "condition": "query.block_state('fixture:open') == true",
          "components": { "geometry": "geometry.fixture.custom_crate_open" }
        }
      ]
    }
  ],
  "items": [
    {
      "name": "fixture:custom_widget",
      "componentBased": true,
      "icon": "fixture_custom_widget",
      "components": { "...": "decoded item component NBT" }
    }
  ],
  "actors": [
    {
      "type": "minecraft:armadillo",
      "properties": [
        {
          "name": "minecraft:armadillo_state",
          "type": "enum",
          "default": "unrolled",
          "enum": ["unrolled", "rolled_up", "rolled_up_peeking", "rolled_up_relaxing", "rolled_up_unrolling"]
        }
      ]
    }
  ]
}
```

- `blocks` is `GameData.CustomBlocks` decoded — the network palette. Geometry
  and material short-names resolve against the resource pack stack; the
  behaviour pack is never an input.
- `items` lists component-based (custom) items only. `icon` is the
  `minecraft:icon` / `textures.default` short-name for `item_texture.json`.
- `actors` lists entity property definitions from `SyncActorProperty` /
  `GameData.PropertyData`. `type` is bool/int/float/enum so snapshot entity
  `props` can be typed against ranges and defaults.
- Precedence vs resource-pack `blocks.json`: palette components win for
  geometry and materials (`viewer/FINDINGS-wire.md`).

### Camera

Server-driven camera override from `packet.CameraInstruction` (+ presets from
`packet.CameraPresets`). Additive — absent on frames that have no active
override. Does **not** change `[GOTESTBDS]` stdout.

```json
{
  "preset": "free",
  "pos": [12.5, 72.0, -4.0],
  "rot": [90.0, 15.0],
  "easeDurationMs": 500,
  "fov": 50,
  "fade": {
    "fadeInSec": 0.5, "waitSec": 1.0, "fadeOutSec": 0.5,
    "colour": [0, 0, 0]
  }
}
```

- `rot` is `[yaw, pitch]` degrees (same convention as Actor).
- `pos` / `rot` absent → keep prior override values for those axes; a clear
  (`cameraCleared` or keyframe without `camera`) drops the whole override.
- `fade` is exported for consumers; the web viewer does not draw it yet.
- Client FOV default stays 70° (PerspectiveCamera); sprint widens slightly when
  no instruction FOV is set.

### Actor

The observed bot. A superset of `Entity` for the fields a first-person camera
and a HUD need.

```json
{
  "rid": 1, "uid": 1, "name": "TestBot",
  "pos": [12.5, 64.0, -8.5],
  "eyePos": [12.5, 65.62, -8.5],
  "rot": [90.0, 0.0],
  "vel": [0.0, 0.0, 0.0],
  "onGround": true,
  "gamemode": 0,
  "dimension": 0,
  "health": 20.0, "maxHealth": 20.0, "food": 20.0,
  "heldSlot": 0,
  "sneaking": false, "sprinting": false, "swimming": false, "gliding": false,
  "hotbar": [ { "...": "see Item" }, null ],
  "inventory": [ null ],
  "offhand": null,
  "armour": [ null, null, null, null ],
  "effects": [ { "name": "minecraft:speed", "level": 1, "durationMs": 30000 } ],
  "chunkRadius": 4,
  "lookingAt": { "pos": [12, 63, -8], "face": "up", "block": { "...": "see Block" } }
}
```

`hotbar` is slots 0–8, `inventory` all 36. `lookingAt` is what the crosshair is
on, or absent when the ray hit nothing.

### UI

Present so a recording shows what the player would have seen. Stage 11 draws it;
stage 1 only has to carry it.

```json
{
  "form": { "type": "menu", "title": "PC", "content": "", "buttons": ["Slot 1"] },
  "container": { "type": "chest", "title": "Crate", "slots": [ null ] },
  "sign": { "front": ["a", "b", "c", "d"], "back": [] },
  "dialogue": { "npcName": "Oak", "text": "...", "buttons": ["Yes"] },
  "messages": ["§aWelcome"],
  "title": "Level Up!",
  "subtitle": "Charizard",
  "actionBar": "Press F",
  "fadeInTicks": 10,
  "stayTicks": 70,
  "fadeOutTicks": 20
}
```

Every key is nullable and absent when there is nothing open. `messages` is the
most recent 20 player-facing chat lines, oldest first. Internal bot protocol
lines (`[RUN_ACTION]`, `[STATUS]`, `[GOTESTBDS]`) are never included.

`title` / `subtitle` / `actionBar` come from `packet.SetTitle`. Fade timings are
in Bedrock ticks (20ths of a second); when absent the client uses 10 / 70 / 20.

Actor already carries hotbar (slots 0–8), `heldSlot`, `health`, `maxHealth`, and
`food` for the HUD — those ride the world frames, not this object.

### `chat` (event lane)

One player-facing chat/system line. Queued like `mark` / `capture` — never
dropped for world-frame backpressure.

```json
{ "v": 1, "type": "chat", "bot": "TestBot", "tick": 1025, "text": "§aWelcome" }
```

Protocol noise prefixes are filtered on the Go side before emit.

### `title` (event lane)

Title / subtitle / action-bar snapshot after a `SetTitle` mutation. Same
never-drop queue as `chat`.

```json
{
  "v": 1, "type": "title", "bot": "TestBot", "tick": 1025,
  "title": "Level Up!", "subtitle": "Charizard", "actionBar": "Press F",
  "fadeInTicks": 10, "stayTicks": 70, "fadeOutTicks": 20,
  "clear": false
}
```

`clear` is true when the packet cleared/reset every title surface.

### `particle` (event lane)

One `packet.SpawnParticleEffect` spawn. Same never-drop queue as `chat` /
`title`. LevelEvent-based vanilla particles are **not** on this lane.

```json
{
  "v": 1, "type": "particle", "bot": "TestBot", "tick": 1025,
  "name": "minecraft:basic_smoke_particle",
  "pos": [1.5, 64.0, -3.25],
  "dimension": 0,
  "entityId": -1
}
```

`entityId` is omitted (or absent) when the position is absolute; when present
and not `-1`, `pos` is relative to that entity's unique id.

---

## Backpressure

The tick loop is the bot's only goroutine for world state, so a slow client must
never reach it.

- World state is projected once per tick on the bot goroutine. Each subscriber
  then gets its own paced frame (column bookkeeping differs per connection).
- Each subscriber keeps at most one pending world frame: a newer frame replaces
  an unread one. Events (`mark` / `capture` / `chat` / `title` / `particle`)
  queue separately and never drop for world backpressure.
- Superseding an unsent catch-up `delta` re-queues only that frame's columns
  (its `columnsAdded` batch plus any columns it patched in place). The client
  keeps every column already delivered — a full keyframe restart here is what
  thrashed remeshing under load (`resync` climbing on the overlay while the
  world never finished arriving).
- A full paced `keyframe` restart happens only when the client has nothing
  valid: fresh attach, dimension change / encoder keyframe, or an unsent
  `keyframe` that itself was superseded. A delta never replaces an unsent
  keyframe.
- Per-subscriber `sentColumns` tracks what the SSE writer has actually
  dequeued, so a mid-run attach or full resync re-queues columns instead of
  re-sending the full radius in one frame. Pending-frame column claims prevent
  double-send while a frame waits on the writer.
- Stream-health warnings include `resyncReason` (`attach`, `dimension`,
  `encoder-keyframe`, `superseded-keyframe`) so a delivery loop names itself.
- The stream carries columns within `radius` of the bot's chunk. Columns leaving
  the radius are emitted as `columnsRemoved`.
- `ColumnBudget` (default 4) caps columns per frame so a single write stays in
  the few-hundred-KB range even when the radius holds ~80 columns.

## Instructions

Three instructions register into `instruction.DefaultPull`. All three are no-ops
or clean errors when no viewer is attached — never a hang.

| Instruction | Parameters | Data | No viewer |
| --- | --- | --- | --- |
| `screenshot` | `{"label":"","timeoutMs":30000}` | `{"path","width","height","bytes","tick"}` | errors: `viewer: no subscriber attached` |
| `viewerMark` | the `mark` frame's fields | none | succeeds, does nothing |
| `pullArtifacts` | `{}` | `{"artifacts":[Artifact]}` | succeeds, returns `[]` |

`Artifact` is the `POST /artifact` metadata plus the resolved `path` and
`bytes`, and is what the SDK attaches to its `testEnd` and `runEnd` reporter
events for `bds-manager` to pick up.

`screenshot` fails rather than waits when no subscriber is attached, because a
test that asks for a frame and gets a 20 s timeout instead of an error is a test
whose verdict the viewer changed.

## Assets

Resource packs are the appearance source of truth. Go never decodes images or
evaluates Molang; it only resolves paths and serves bytes. Behaviour packs are
never an input. The vanilla baseline is `Mojang/bedrock-samples` at the tag in
`viewer/baseline.tag`, fetched into a gitignored cache — never committed.

Endpoints (available when the viewer was started with an asset manager):

### `GET /packs`

Resolved stack, lowest priority first:

```json
[
  {"id":"vanilla","uuid":"…","version":"1.26.30.5","name":"…","priority":0,"fileCount":12345},
  {"id":"22222222-2222-2222-2222-222222222222","uuid":"22222222-…","version":"1.2.3","name":"…","priority":1,"fileCount":40}
]
```

`vanilla` is always present at priority 0. Server packs follow in
`packet.ResourcePackStack` apply order (first applied first).

### `GET /packs/index`

Merged file index mapping every pack-relative path to the winning pack id:

```json
{"textures/blocks/stone.png":"22222222-2222-2222-2222-222222222222","texts/en_us.lang":"vanilla"}
```

Paths are pack-relative, POSIX, lower-cased. Later packs in the stack win.
Within a pack, the selected subpack overrides the pack root
(`memory_performance_tier` / `memory_tier` rule; see Microsoft Learn —
Building Sub-Packs). An explicit `SubPackName` on the stack entry wins over
auto-select.

### `GET /pack/<packId>/<path…>`

Raw bytes from that pack, with a sensible `Content-Type`. `404` when absent.
Path traversal (`..`, absolute paths) is rejected with `400`.

### `GET /asset/<path…>`

Winning bytes for that path after stack resolution. `404` when no pack has it.
Same traversal rules as `/pack/…`.

## Configuration

Following the existing precedence in `config.go` — defaults, then
`config.toml`, then `GOTESTBDS_*`, then flags.

| TOML | Env | Flag | Default |
| --- | --- | --- | --- |
| `Viewer.Enabled` | `GOTESTBDS_VIEWER` | `-viewer` | `false` |
| `Viewer.Address` | `GOTESTBDS_VIEWER_ADDRESS` | `-viewer-address` | `127.0.0.1:24680` |
| `Viewer.Radius` | `GOTESTBDS_VIEWER_RADIUS` | `-viewer-radius` | `4` |
| `Viewer.SectionRadius` | `GOTESTBDS_VIEWER_SECTION_RADIUS` | `-viewer-section-radius` | `4` |
| `Viewer.ColumnBudget` | `GOTESTBDS_VIEWER_COLUMN_BUDGET` | `-viewer-column-budget` | `4` |
| `Viewer.ArtifactDir` | `GOTESTBDS_VIEWER_ARTIFACTS` | `-viewer-artifacts` | `artifacts` |
| `Viewer.AppDir` | `GOTESTBDS_VIEWER_APP` | `-viewer-app` | `""` |
| `Viewer.CacheDir` | `GOTESTBDS_VIEWER_CACHE` | `-viewer-cache` | `<ArtifactDir>/.cache` |
| `Viewer.BaselineTag` | `GOTESTBDS_VIEWER_BASELINE` | `-viewer-baseline` | `v1.26.30.5` (or `viewer/baseline.tag`) |
| `Viewer.AcceptServerPacks` | `GOTESTBDS_VIEWER_PACKS` | `-viewer-packs` | `true` |
| `Viewer.Offline` | `GOTESTBDS_VIEWER_OFFLINE` | `-viewer-offline` | `false` |
| `Viewer.MemoryPerformanceTier` | `GOTESTBDS_VIEWER_MEMORY_TIER` | `-viewer-memory-tier` | `5` |

`GOTESTBDS_VIEWER` accepts `1`/`true` to enable on the default address, or a
`host:port`, which both enables it and sets the address.

Server pack download is gated on the viewer being enabled: with the viewer
off, `DownloadResourcePack` always returns false so a normal test run does
not pull pack archives.

---

## The capture harness

The harness is the process that turns the stream into pixels headlessly. It is a
separate process from the bot on purpose: a browser is a heavy, optional
dependency, and a run must survive its absence.

### Command line

```
node viewer/dist-capture/cli.cjs \
  --stream http://127.0.0.1:24680 \
  --bot TestBot \
  [--width 1280] [--height 720] \
  [--max-segment-seconds 120] \  # cap whole-run recording length
  [--browser /path/to/chromium] \
  [--log-level info]
```

- `--stream` is the bot process's viewer address. The harness opens
  `<stream>/?bot=<bot>&camera=follow` — the bot process serves the built app at
  `/`, so the harness needs no filesystem path to it. `camera=follow` is the
  capture default (over-the-shoulder); a human can override with `first` or
  `orbit` on the same URL.
- The harness exits `0` when the stream closes cleanly, non-zero only on a
  failure to start. It never fails a test run: a harness that dies mid-run
  leaves the bot untouched and the run continues without artefacts.
- It resolves a browser from `--browser`, then `PLAYWRIGHT_CHROMIUM`, then
  `CHROME_PATH`, then Playwright's own cache. When none resolves it logs one
  clear line and exits non-zero *before* the run starts, so the caller can
  decide to continue without it.

### What it does

1. Opens the viewer app against `--stream` in a context with `recordVideo`,
   waits for the first rendered frame. That single page is both the stills
   source and the run recording (mark overlay included).
2. Subscribes to the same SSE stream and reacts to two frame types:
   - `mark`: updates caption state; a `failed` `testEnd` additionally uploads
     a still. Video is **not** started/stopped per test.
   - `capture`: waits for a rendered frame at or after `minTick`, then uploads
     the still against `X-Capture-Id`.
3. When the stream closes (or `--max-segment-seconds` elapses), finalises the
   one run webm and uploads it through `POST /artifact`. It never writes to the
   artefact directory itself, so paths are Go's to own and mean the same thing
   to every consumer.

### Artefact naming

Go writes to:

```
<ArtifactDir>/<runId>/<suite-slug>/<test-slug>/<label-slug>.<ext>
```

and reports the part below `<runId>` — `<suite-slug>/<test-slug>/<label-slug>.<ext>`
— as the artefact's `path`. `runId` defaults to `no-run` outside a run, and each
slug is lowercased with non-alphanumerics collapsed to `-`. A name collision gets
a `-2`, `-3` suffix rather than overwriting: two screenshots in one test are both
worth keeping.

`bds-manager` points `-viewer-artifacts` at a retained root and creates
`<root>/<runId>` before the bot starts, so the run directory a reported path is
relative to is the one it already serves downloads from.
