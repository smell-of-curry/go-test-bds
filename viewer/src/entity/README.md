# Entity rendering (Stage 7 + 9)

Turns wireframe entity boxes into textured Bedrock models using pack assets,
then drives bone animations from the entity `scripts` block and animation
controllers.

## Pack index

`GET /packs/index` returns `path → winning packId` for every file in the stack
(see `gotestbds/assets/stack.go` `Stack.Index`). The registry:

1. Lists `entity/**/*.json`, `render_controllers/**/*.json`,
   `animations/**/*.json`, and `animation_controllers/**/*.json` from that index
2. Fetches each path via `/asset/…` (winner bytes)
3. Merges by identifier / controller name; higher `priority` pack wins

Geometry files are resolved lazily: path heuristics
(`geometry.humanoid.custom` → `models/entity/humanoid.custom.geo.json`) then a
one-shot scan of `*.geo.json` under `models/` to build an identifier → path map.

## Animation (Stage 9)

Per entity instance, `EntityAnimator` (`controllerRuntime.ts`):

1. `scripts.initialize` once
2. Each frame: `pre_animation` → `animate` (short names / `{name: condition}`)
3. Controllers: transitions (first non-zero, one/frame), state anim weights,
   `blend_transition` cross-fade from the leaving state
4. Sample bone channels (linear / catmullrom, Molang-valued) and compose onto
   Stage 7 rest-pose matrices (`userData.restMatrix`)

Queries filled each frame: `anim_time`, `delta_time`, `life_time`,
`modified_distance_moved`, `modified_move_speed` / `ground_speed`, flags,
`query.property`.

Networked motion is lerped in `viewer/src/motion.ts` (`MotionLerp`); the scene
applies those samples in `tickEntities` rather than snapping on sync.

## Rotation

Wire `rot` is **`[yaw, pitch]`** degrees (optional third = head yaw) — see
`gotestbds/viewer/encode.go` (`rot.Yaw(), rot.Pitch()`) and `PROTOCOL.md`.
Body yaw uses the same mapping as the camera (`π − yawRad` about Y). Pitch is
applied to a `head` / `Head` bone when present (after animation sample).

## Known gaps

- **Player skins:** the stream does not carry skin PNG / persona data. Players
  always use the vanilla Steve texture (`textures/entity/steve`).
- Armour, held items, attachables, item frames, dropped items — not drawn yet.
- Particle / sound effect keyframes from animations — not played.
- Material layer (blend vs alphatest, emissive, hurt tint) — alphatest cutout only.
- Multi-pass / overlay render controllers — first matching pass only.

## Fallback

Any load / parse / resolve failure leaves the existing wireframe box + label.
Missing animation bindings leave the textured model in rest pose.
