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
data: {...}

event: delta
data: {...}
```

- `bot` is optional when the process runs a single bot; with several it is
  required and a missing or unknown name is a `404`.
- Every connection starts with `hello` then exactly one `keyframe`. A client
  that reconnects therefore resyncs for free.
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
{"message":"no canvas frame reached tick 1024 within 5000ms"}
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

Everything the stream knows, in one frame.

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
  "entities": [ { "...": "see Entity" } ],
  "ui": { "...": "see UI" }
}
```

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
  "entitiesAdded": [ { "...": "see Entity" } ],
  "entitiesUpdated": [ { "...": "see Entity" } ],
  "entitiesRemoved": [ 41, 42 ],
  "actor": { "...": "see Actor" },
  "ui": { "...": "see UI" }
}
```

- `world` present at all means the dimension changed: the client must drop every
  column and entity it holds before applying the rest of the frame.
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

This is the event the capture harness segments video on, and the source of the
burnt-in caption.

### `capture`

A request for a still. Emitted when the `screenshot` instruction runs.

```json
{"v":1,"type":"capture","bot":"TestBot","id":"cap-3","minTick":1024,"timeoutMs":5000,"ext":"png","label":"after-interact"}
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
      "blocks1": "<base64>"
    }
  ]
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

### Item

```json
{ "name": "minecraft:diamond_sword", "count": 1, "damage": 0, "customName": "Sting" }
```

`damage` and `customName` are omitted when zero and empty.

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
  "title": "", "subtitle": "", "actionBar": ""
}
```

Every key is nullable and absent when there is nothing open. `messages` is the
most recent 20 chat lines, oldest first.

---

## Backpressure

The tick loop is the bot's only goroutine for world state, so a slow client must
never reach it.

- Each subscriber has a buffered channel of encoded frames, capacity 8.
- A send that would block is dropped, and the subscriber is flagged for resync.
- A flagged subscriber's next frame is a fresh `keyframe`, not the delta it
  missed.
- Frames are encoded once per tick and shared across subscribers.
- The stream carries columns within `radius` of the bot's chunk. Columns leaving
  the radius are emitted as `columnsRemoved`.

## Instructions

Three instructions register into `instruction.DefaultPull`. All three are no-ops
or clean errors when no viewer is attached — never a hang.

| Instruction | Parameters | Data | No viewer |
| --- | --- | --- | --- |
| `screenshot` | `{"label":"","timeoutMs":5000}` | `{"path","width","height","bytes","tick"}` | errors: `viewer: no subscriber attached` |
| `viewerMark` | the `mark` frame's fields | none | succeeds, does nothing |
| `pullArtifacts` | `{}` | `{"artifacts":[Artifact]}` | succeeds, returns `[]` |

`Artifact` is the `POST /artifact` metadata plus the resolved `path` and
`bytes`, and is what the SDK attaches to its `testEnd` and `runEnd` reporter
events for `bds-manager` to pick up.

`screenshot` fails rather than waits when no subscriber is attached, because a
test that asks for a frame and gets a 20 s timeout instead of an error is a test
whose verdict the viewer changed.

## Configuration

Following the existing precedence in `config.go` — defaults, then
`config.toml`, then `GOTESTBDS_*`, then flags.

| TOML | Env | Flag | Default |
| --- | --- | --- | --- |
| `Viewer.Enabled` | `GOTESTBDS_VIEWER` | `-viewer` | `false` |
| `Viewer.Address` | `GOTESTBDS_VIEWER_ADDRESS` | `-viewer-address` | `127.0.0.1:24680` |
| `Viewer.Radius` | `GOTESTBDS_VIEWER_RADIUS` | `-viewer-radius` | `4` |
| `Viewer.ArtifactDir` | `GOTESTBDS_VIEWER_ARTIFACTS` | `-viewer-artifacts` | `artifacts` |
| `Viewer.AppDir` | `GOTESTBDS_VIEWER_APP` | `-viewer-app` | `""` |

`GOTESTBDS_VIEWER` accepts `1`/`true` to enable on the default address, or a
`host:port`, which both enables it and sets the address.

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
  [--max-segment-seconds 120] \
  [--browser /path/to/chromium] \
  [--log-level info]
```

- `--stream` is the bot process's viewer address. The harness opens
  `<stream>/?bot=<bot>` — the bot process serves the built app at `/`, so the
  harness needs no filesystem path to it.
- The harness exits `0` when the stream closes cleanly, non-zero only on a
  failure to start. It never fails a test run: a harness that dies mid-run
  leaves the bot untouched and the run continues without artefacts.
- It resolves a browser from `--browser`, then `PLAYWRIGHT_CHROMIUM`, then
  `CHROME_PATH`, then Playwright's own cache. When none resolves it logs one
  clear line and exits non-zero *before* the run starts, so the caller can
  decide to continue without it.

### What it does

1. Opens the viewer app against `--stream`, waits for the first rendered frame.
2. Subscribes to the same SSE stream and reacts to two frame types:
   - `mark`: `testStart` starts a recording segment, `testEnd` stops it and
     uploads it, and a `failed` status additionally uploads a still.
   - `capture`: waits for a rendered frame at or after `minTick`, then uploads
     the still against `X-Capture-Id`.
3. Uploads everything through `POST /artifact`. It never writes to the artefact
   directory itself, so paths are Go's to own and mean the same thing to every
   consumer.

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
