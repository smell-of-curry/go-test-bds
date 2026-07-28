# Entity rendering (Stage 7)

Turns wireframe entity boxes into textured Bedrock models using pack assets.

## Pack index

`GET /packs/index` returns `path → winning packId` for every file in the stack
(see `gotestbds/assets/stack.go` `Stack.Index`). The registry:

1. Lists `entity/**/*.json` and `render_controllers/**/*.json` from that index
2. Fetches each path via `/asset/…` (winner bytes)
3. Merges by identifier / controller name; higher `priority` pack wins

Geometry files are resolved lazily: path heuristics
(`geometry.humanoid.custom` → `models/entity/humanoid.custom.geo.json`) then a
one-shot scan of `*.geo.json` under `models/` to build an identifier → path map.

## Rotation

Wire `rot` is **`[yaw, pitch]`** degrees (optional third = head yaw) — see
`gotestbds/viewer/encode.go` (`rot.Yaw(), rot.Pitch()`) and `PROTOCOL.md`.
Body yaw uses the same mapping as the camera (`π − yawRad` about Y). Pitch is
applied to a `head` / `Head` bone when present.

## Known gaps

- **Player skins:** the stream does not carry skin PNG / persona data. Players
  always use the vanilla Steve texture (`textures/entity/steve`).
- Armour, held items, item frames, dropped items — not drawn yet.
- Material layer (blend vs alphatest, emissive, hurt tint) — alphatest cutout only.
- Multi-pass / overlay render controllers — first matching pass only.
- Animations — rest pose only; bone groups exist for Stage 9.

## Fallback

Any load / parse / resolve failure leaves the existing wireframe box + label.
