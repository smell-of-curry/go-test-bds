# Bedrock geometry → three.js

Answers the plan's **Geometry and animation** research question for coordinates,
pivots and rotation order. Evidence is a hand-authored nested-bone fixture plus
cross-checks against `bridge-core/model-viewer` and Microsoft's geometry schema
docs — not a guess from looking at one screenshot.

## Format surface covered

| Feature | Support |
|---|---|
| `format_version` + `minecraft:geometry[]` (1.12.0+) | parse + mesh |
| Legacy top-level `geometry.<name>` (`texturewidth` / `textureheight`) | parse + mesh |
| `description` (`identifier`, `texture_*`, `visible_bounds_*`) | parse |
| Bones: `name`, `parent`, `pivot`, `rotation`, `bind_pose_rotation`, `mirror`, `inflate`, `locators`, `binding` | parse; `binding` kept as raw string (no Molang) |
| Cubes: `origin`, `size`, `rotation`, `pivot`, `inflate`, `mirror`, box UV + per-face UV (`uv`, `uv_size`, `uv_rotation`, `material_instance`) | parse + mesh |
| `poly_mesh` indexed form (`positions` / `normals` / `uvs` / `polys`, `normalized_uvs`) | parse + mesh |
| `poly_mesh` `tri_list` / `quad_list` string form | rejected with a clear error |
| `texture_meshes` | parse only — expanding needs a loaded texture (out of scope) |
| Materials / textures / Molang | **not** here |

## Conventions established

### 1. Units

Bedrock geometry is authored in **model units** where **16 units = 1 block**.
Output positions are in **three.js block units** (`/ 16`).

**Evidence:** Microsoft creator docs (`texture_width` described in texels;
Blockbench Bedrock guide); every entity model in pokebedrock-res uses this scale
(e.g. a 16×16×16 cube is one block).

### 2. Handedness / axis conversion

Bedrock model space and three.js are both Y-up. This module converts:

```
(x, y, z)_three = (−x / 16, y / 16, z / 16)_bedrock
```

Normals use the same X negate without the scale.

**Evidence:** `bridge-core/model-viewer` (`Model.ts` / `Cube.ts`) places pivots at
`(−pX, pY, pZ)` and cube origins with a negated X term — the same reflection.
Bedrock Wiki "Coordinate Space Conversion" notes the entity frame is rotated /
mirrored relative to world +X; matching bridge keeps us compatible with the
prior art the plan cites.

**Still uncertain:** whether the live Bedrock client applies an additional 180°
Y yaw when binding an entity to world space (entity facing). That is an entity-
placement concern for stage 7's renderer, not this module's model-local output.

### 3. Rotation order and pivots

Bone and cube rotations are **extrinsic XYZ Euler angles in degrees** — apply
X, then Y, then Z to the point — equivalent to matrix `R = Rz · Ry · Rx`.
Rotations are about the bone/cube **pivot**: `T(p) · R · T(−p)`.

Parent chain (all pivots in the same model space):

```
M_world = M_root · M_… · M_bone
M_bone  = T(pivot) · R(rotation) · R(bind_pose_rotation)? · T(−pivot)
```

`bind_pose_rotation`, when present, is applied to the point **before**
`rotation`.

**Evidence:**

- Blockbench format notes: extrinsic XYZ about the origin/pivot.
- three.js `Euler` order `'ZYX'` with the same angle components matches that
  extrinsic XYZ convention (verified by the nested-bone fixture below).
- Microsoft schema: cube `mirror` is "about the unrotated x axis"; bone
  `rotation` is consumed as degrees by every open viewer we checked.

### 4. Nested-bone fixture (hand computation)

`tests/fixtures/geometry/nested_bones.geo.json`:

- `root`: pivot `(0,0,0)`, rotation `(0, 90, 0)`
- `arm` (child of root): pivot `(16,0,0)`, rotation `(90, 0, 0)`
- cube on `arm`: origin `(16,0,0)`, size `(16,16,16)`
- known vertex = cube max corner `(32, 16, 16)`

Hand evaluation (Rx then Ry):

1. Arm: `(32,16,16) − (16,0,0) = (16,16,16)` → Rx(90°) → `(16,−16,16)` →
   `+ pivot` → `(32,−16,16)`
2. Root: Ry(90°) → `(16,−16,−32)`

three.js: `(−1, −1, −2)`.

The test asserts both the Bedrock-space chain and that
`boneWorldMatrix_three · localVertex` recovers that point from the mesh
buffers. **If rotation order or pivot handling were wrong, this fails.**

### 5. Inflate

`inflate` grows the cube by that many model units on **every** side:

```
origin' = origin − inflate
size'   = size + 2 · inflate
```

Cube `inflate` overrides; when omitted, bone `inflate` applies (same as
bridge-core).

**Evidence:** Microsoft / Blockbench inflate behaviour; fixture
`inflate.geo.json` asserts Y span `18/16` for inflate `1` on a 16-unit cube.

### 6. Mirror

`mirror` (bone or cube) mirrors about the cube's **unrotated local X centre**
(swaps east/west inside the same AABB) and flips face U. Winding is corrected
so fronts stay outward after the mirror and the Bedrock→three.js X reflection.

**Evidence:** Microsoft geometry schema wording ("about the unrotated x axis",
"east/west faces get flipped"); `mirrored_cube.geo.json` asserts every triangle
normal · (centroid − cubeCentre) > 0.

### 7. UV

- Per-face: `uv` + `uv_size` (sign flips axis), optional `uv_rotation`
  ∈ {0,90,180,270}, optional `material_instance`.
- Box UV: Java/Bedrock entity unwrap (east/north/west/south row under up/down),
  sizes floored — matches `bridge-core` `CubeFaces` layout.
- Texels → GL: `(u / texture_width, 1 − v / texture_height)`.
- Non-16 / non-square textures use `description.texture_width/height` only
  (no image load here).

## Output

`buildGeometryMeshes(geometry)` → per-bone `{ positions, normals, uvs, indices,
materialInstances, faces }` in three.js block space, **authored model space**
(the `.geo.json` numbers after axis/scale conversion). Pose with
`computeBoneWorldMatrices(geometry, pose?)`: `M_bone * position` applies that
bone's full pivot/rotation chain (parent → self). Rest-pose matrices turn
authored corners into the hand-computed displayed positions.

## Seen in real packs, not handled yet

Read-only survey of pokebedrock-res `models/entity/**/*.geo.json`:

| Seen | Status |
|---|---|
| `binding` Molang (`q.item_slot_to_bone_name`, `\'head\'`) | stored raw; not evaluated |
| Locator as bare `[x,y,z]` (common) and object form | both parsed |
| Negative `uv_size` (flip) | handled |
| `poly_mesh` | handled (indexed); no `tri_list`/`quad_list` samples found |
| `texture_meshes` | none in that pack; parsed, not meshed |
| `item_display_transforms` / `cape` / `render_group_id` | ignored |
| Zero-thickness cubes (`size` with a 0 axis) | meshed (degenerate faces) |
| `bind_pose_rotation` | parsed + applied; no live sample confirmed in that pack |

## API entry

```ts
import {
  parseGeometryDocument,
  buildGeometryMeshes,
  computeBoneWorldMatrices,
} from "./geometry";
```
