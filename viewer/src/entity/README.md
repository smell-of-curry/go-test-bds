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

## Material layer

Vanilla `materials/` definitions are **not** in `bedrock-samples`. Mapping from
material name → render state lives in `material.ts` (`materialStateFromName`).

| Name pattern | Transparency | Cull | Emissive |
| --- | --- | --- | --- |
| `entity`, `entity_static` | opaque | yes | no |
| `entity_alphatest` (+ most short names: `sheep`, `zombie`, …) | alpha_test@0.5 | yes | no |
| `entity_alphablend` | blend | yes | no |
| `entity_emissive` | opaque | yes | yes |
| `entity_emissive_alpha` | alpha_test@0.5 | no | yes |
| `entity_emissive_alpha_one_sided` | alpha_test@0.5 | yes | yes |
| `entity_nocull` | opaque | no | no |
| `charged_creeper` | blend | no | yes |
| `slime_outer` | blend | no | no |
| `spider`, `enderman` | alpha_test@0.5 | yes | yes |
| `*alphablend*` / `*blend*` | blend | (see nocull) | — |
| `*emissive*` / `*glow*` | (keep mode) | — | yes |
| `*nocull*` / `*invisible*` / `*_outer` | — | no | — |
| **default** (unknown) | alpha_test@0.5 | yes | no |

RC tint: evaluate `color` / `overlay_color` / `on_fire_color` / `is_hurt_color`
(Molang RGBA); `overlay_color` (and hurt/fire) lerps RGB toward the overlay by
its alpha. Hurt flash needs `query.hurt_time` on the wire — not exported yet.

## Entity light

Non-emissive materials use the Java/Bedrock entity two-light (`lighting.ts`):

```
L0 = normalize(0.2, 1, -0.7)
L1 = normalize(-0.2, 1, 0.7)
shade = min(1, (max(0, N·L0) + max(0, N·L1)) * 0.6 + 0.4)
```

Axis boxes: up ≈ 1, ±Z ≈ 0.74, ±X ≈ 0.50, down = 0.4. World light at the
feet (sky × daylight, max with block light, brightness curve `L/(4−3L)`)
multiplies `shade`. Emissive materials stay unlit `MeshBasicMaterial`.

## Blob shadows

A generated radial disc (bedrock-samples ships no `textures/misc/shadow.png`)
is projected onto block tops within 4 blocks under the feet, sized by
collision width, fading with height. Items get none.

## Player skins and emotes

`skin` on the entity loads `url` (same origin) and
`geometry.humanoid.custom` / `geometry.humanoid.customSlim` (the slim geo
lives in vanilla `models/mobs.json`). Missing skin → Steve.

Persona emotes are **not** in any resource pack. `src/entity/emotes/` is the
documented exception: Bedrock animation JSON parsed by `parseAnimations`.
Wave id `4c8ae710-df2e-47cd-814d-cc7bf21a3d67` raises `rightArm` and swings
it for 3 s, then idle. Unknown ids do nothing.

## Equipment / items / name tags

- **Armour + held:** snapshot already carries `armour[4]` + `held`; layers use
  `geometry.humanoid.armor.*` + `textures/models/armor/<stem>_{1,2}`; held item
  is a flat alpha-tested icon quad on the right-hand bone.
- **Dropped items:** `minecraft:item` stack rides `held.main` (Go `Item()` →
  encode); rendered as spinning/bobbing sprite.
- **Item frames:** blocks with block-entity NBT — rides Stage 6 block-entity
  pipeline (not built here).
- **Name tags:** in-scene canvas billboards (`nameTag.ts`); hidden when
  sneaking; depth-tested (no through-wall dimming).

## Known gaps

- **Player skins:** carried on the entity as `skin` when the bot has one.
  Absent → Steve. Cape / persona geometry beyond classic vs slim is not drawn.
- Attachables (full item geometry / animations) — flat held quad only.
- Particle / sound effect keyframes from animations — not played.
- Multi-pass / overlay render controllers — first matching pass only.
- Hurt-time / on-fire flags not on the entity snapshot yet (tint math is ready).

## Fallback

Any load / parse / resolve failure leaves the existing wireframe box (no DOM
label). Missing animation bindings leave the textured model in rest pose.
