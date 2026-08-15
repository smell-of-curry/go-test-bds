# Findings — wire-carried definitions (stage 8)

## What the network block palette NBT contains

Evidence from structures, not guesswork:

1. `protocol.BlockEntry` (`gophertunnel` `minecraft/protocol/block.go`): `Name string` +
   `Properties map[string]any` encoded as network-little-endian NBT.
2. Dragonfly’s `blockinternal.ComponentBuilder.Construct`
   (`dragonfly/server/internal/blockinternal/builder.go`) is what a modern
   Go server puts in that map — and matches the shape BDS sends for data-driven
   custom blocks. Top-level keys:

| Key | Role |
| --- | --- |
| `components` | Component map (geometry, materials, boxes, …) |
| `properties` | `[{name, enum}]` state property declarations |
| `permutations` | `[{condition, components}]` Molang → override sets |
| `molangVersion` | int32 (Construct uses `10`) |
| `menu_category` | Creative inventory (not render-critical) |
| `vanilla_block_data` | Internal block id (not render-critical) |

3. Render-relevant component keys decoded in `gotestbds/wire`:

| Component | Wire shape |
| --- | --- |
| `minecraft:geometry` | string **or** `{identifier: string}` |
| `minecraft:unit_cube` | empty compound |
| `minecraft:material_instances` | `{mappings, materials: {face: {texture, render_method, face_dimming, ambient_occlusion}}}` |
| `minecraft:transformation` | `RX/RY/RZ`, `SX/SY/SZ`, `TX/TY/TZ` |
| `minecraft:light_emission` / `minecraft:block_light_emission` | number or `{emission}` (0–1 or 0–15) |
| `minecraft:collision_box` | `{enabled, boxes:[{minX…maxZ}]}` (pixels) |
| `minecraft:selection_box` | `{enabled, origin, size}` (pixels) |
| `minecraft:bone_visibility` | map (passed through) |

Fixture: `gotestbds/wire/testdata` + `TestPaletteResolvesGeometryWithoutBehaviourPack`.
No behaviour pack in the tree — geometry and materials come from palette NBT alone.

## Palette vs `blocks.json` precedence

**Verdict: network palette wins for geometry and material_instances.**

Evidence:

1. Resource-pack `blocks.json` rows carry `textures` / `sound` (atlas short-names).
   They do **not** carry `minecraft:geometry` or `minecraft:material_instances`.
   Confirmed against the fixture `gotestbds/wire/testdata/blocks.json` and the
   vanilla samples shape.
2. Custom-block geometry/materials are authored in the behaviour definition and
   **copied onto the wire** in `StartGame` / `GameData.CustomBlocks` (dragonfly
   `makeBlockEntries` → `blockinternal.Components`). A real client never opens
   the behaviour pack; it uses this palette.
3. Fixture `TestPaletteWinsOverBlocksJSON`: same name `fixture:custom_crate` in
   both sources — `blocks.json` says texture `blocks_json_wrong_texture`, palette
   says geometry + texture `palette_right_texture`.
   `ResolveBlockAppearance` returns `SourcePalette` with the palette texture.

Fallback when the palette has no geometry/materials: use the `blocks.json`
texture name (`SourceBlocksJSON`) — the legacy / vanilla path.

## Other registries on the wire

| Registry | Packet / field | Notes |
| --- | --- | --- |
| Custom blocks | `GameData.CustomBlocks` from `StartGame` | Seeded at viewer enable |
| Items | `packet.ItemRegistry` → `GameData.Items` | Join packet consumed by gophertunnel; bot seeds from GameData; handler for late re-sends |
| Entity properties | `packet.SyncActorProperty` (+ `GameData.PropertyData`) | NBT `{type, properties:[{name,type,enum,default,range…}]}`; type ids 1=bool 2=int 3=enum 4=float (Azvyl gist) |

## Render-relevant data that stays in the behaviour pack

Entity property *defaults and server-side logic* are authored in BP entity JSON,
but **client_sync** definitions are what SyncActorProperty carries — enough for
`query.property` in resource packs.

Still BP-only (viewer approximates):

| Gap | Approximation |
| --- | --- |
| Full entity component lists (collision, movement, …) | Use metadata bbox / flags already on the snapshot Entity |
| Block permutation Molang beyond state queries | Evaluate against snapshot `states` only; skip unknown queries |
| Item cooldown / food behaviour | Not drawn; icon via `item_texture.json` + wire `icon` short-name |
| Creative `menu_category` grouping | Ignore for world rendering |

## Concurrency

Registries are written on the bot goroutine (`EnsureWireRegistries`, packet
handlers) and snapshotted into keyframe JSON on that same goroutine. HTTP only
sees the immutable encoded frame. Viewer-off runs never call
`EnsureWireRegistries` — zero decode cost.
