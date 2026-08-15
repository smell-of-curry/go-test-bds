# Terrain (stage 6 + stage 8 palette textures)

Real textured block meshing for the viewer. Drop-in replacement for
`PlaceholderMesher`.

## Wire-in

```ts
import { createTexturedMesher } from "./terrain";
import { Scene } from "./scene";

const bundle = await createTexturedMesher({ baseUrl });
const scene = new Scene(camera, bundle.asMesher);

// After the keyframe lands (store keeps `registries`):
await bundle.applyRegistries(store.getState().registries);
```

Entry: `createTexturedMesher` → `TexturedMesher` implements `Mesher`.
`registries` is optional at create time (default `null`) so existing call sites
keep compiling; pass it up front or via `applyRegistries` once the keyframe
arrives so custom-block short-names enter the atlas.

## Material (what it does / does not)

Unlit GLSL3 `RawShaderMaterial` (`toneMapped: false`, atlas `NoColorSpace`):

- Samples the terrain atlas at **full authored texel brightness**.
- Multiplies by vertex colour (biome tint when `biomeAt` is wired).
- Resolves greedy-merged faces in the fragment shader:
  `atlasUV = rect.xy + wrap(tileUV) * rect.zw` with a half-texel inset.
- Far-edge fix: `fract(N) == 0` maps to `1.0` so the last pixel of a merge
  run samples the end of the tile, not the start.

Does **not** do (later stages): block light, sky light, ambient occlusion,
smooth lighting, direction lights, or fog.

## What resolves from where

| Need | Source |
| --- | --- |
| Pack stack | `GET /packs` (low → high priority) |
| Winning PNG bytes | `GET /asset/<path>` |
| Merged JSON | `GET /pack/<id>/blocks.json` etc. from **every** pack, then merge |
| Block → texture short-names | Merged `blocks.json` (`textures` preserved when a later pack only sets `sound`) |
| Custom blocks | Keyframe `registries.blocks` → permutations → geometry + `materialInstances` |
| Custom geometry | Pack `models/**/*.geo.json` by identifier (`BlockGeometryCache`); else cube |
| Short-name → PNG path(s) | Merged `terrain_texture.json` (`texture_data`, all entry shapes) |
| Animated tiles | Merged `flipbook_textures.json` (frame from **snapshot tick**) |
| Image pixels | Via `/asset` — `.png`, `_opaque.png`, then `.tga` (many foliage tiles) |
| Neighbour / tick | `WorldState` from the SSE snapshot |
| Layer-1 waterlogging | `TerrainSection.indices1` / `palette1` (duck-typed; store decode TBD) |
| Biome tint | `biomeAt(x,z)` hook — **snapshot has no biome yet** |

**Why merge:** `/asset/blocks.json` is winner-takes-all. A server pack that ships a
`blocks.json` with only `sound` would otherwise erase vanilla `textures` and
every surface would resolve to `__missing__`. The Bedrock client merges
per-block; we do the same via `/pack/<id>/…`.

**Why namespace bare ids:** vanilla `blocks.json` keys are bare (`stone`); the
snapshot always names blocks `minecraft:stone`. `parseBlocksJson` canonicalises
bare keys to `minecraft:…` so lookups hit.

**Palette vs pack (renderer):** when `blocks.json` has a `textures` field, that
pack path wins. The network palette covers names the pack cannot paint (typical
`pokeb:*` custom blocks). When the palette carries `minecraft:geometry` and the
pack has that `.geo.json`, the mesher emits that mesh (per-instance materials,
no greedy merge); otherwise it falls back to a textured unit cube.

No behaviour pack. Nothing vendored. Vanilla baseline arrives as pack id `vanilla`.

## Real-pack diagnosis

When a fixture is green but a live frame is all magenta, stop authoring more
fixtures and run the packs you actually ship:

```bash
# Vanilla: Mojang/bedrock-samples @ viewer/baseline.tag →
#   ../.cache/baseline/<tag>/resource_pack
# Server (optional): pokebedrock-res development_resource_packs path
# Registries (optional): keyframe shape; defaults to testdata/registries-fixture.json
node tools/diagnose-terrain-packs.mjs
# or:
# VANILLA_PACK=… SERVER_PACK=… REGISTRIES_JSON=… node tools/diagnose-terrain-packs.mjs
```

Prints resolve/fallback counts for `blocks.json`, **palette coverage**
(`withMaterialInstances` / `texturesResolved` / `neutralNoMaterials` /
`atlasMiss`), the first ten failure reasons, and writes
`testdata/diagnose/atlas.png`. Exits 0 with `{ skipped: true }` when the
vanilla pack is absent (CI without the cache).

## Fallback chain

1. Pack `blocks.json` textures → resolve short-name via `terrain_texture.json`.
2. Else network palette `materialInstances` → same short-name resolve.
3. Else named custom / unknown → generated stone-grey `__neutral__` tile.
4. Else try `textures/blocks/<short-name>.png` for a known short-name miss.
5. Magenta/black `__missing__` only for unnamed non-zero `rid` or a short-name
   that failed to load (bug marker — not "custom block").

## Culling / passes

- Unknown / `requested` neighbour column → **exposed** (same as placeholder).
- Absent section in a known column → air.
- Opaque full cubes occlude; cutout/translucent do not occlude opaques.
- Adjacent same glass/leaves cull the shared face.
- Transparent / cutout / liquid faces → second mesh (`userData.pass = "transparent"`).
- Palette `renderMethod: alpha_test` → cutout pass (leaves-like custom blocks).
- Coplanar same-texture faces greedy-merged; tile UVs repeat per block via the
  shader above (keeps triangle count down without stretching the atlas).

## Deliberately not handled yet

- Banner pattern compositing / per-skull geo variants (coloured boxes for now).
- Non-cube vanilla shapes (slabs, stairs, fences, doors as meshes).
- Biome tint wiring from column `biomePalette`/`biomes` into `biomeAt` (decode
  landed; finish the lookup hook).
- `blocks1` decode in `store.ts` (mesher already reads it when present).
