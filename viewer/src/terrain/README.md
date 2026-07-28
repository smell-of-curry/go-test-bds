# Terrain (stage 6)

Real textured block meshing for the viewer. Drop-in replacement for
`PlaceholderMesher`.

## Wire-in

```ts
import { createTexturedMesher } from "./terrain";
import { Scene } from "./scene";

const { asMesher } = await createTexturedMesher({ baseUrl });
const scene = new Scene(camera, asMesher);
```

Entry: `createTexturedMesher` → `TexturedMesher` implements `Mesher`.

## What resolves from where

| Need | Source |
| --- | --- |
| Pack stack / winning paths | `GET /packs`, `GET /packs/index` |
| Bytes | `GET /asset/<path>` |
| Block → texture short-names | `blocks.json` (`textures`, `carried_textures`, per-face maps) |
| Short-name → PNG path(s) | `textures/terrain_texture.json` (`texture_data`, weighted `variations`) |
| Animated tiles | `textures/flipbook_textures.json` (frame from **snapshot tick**, not wall clock) |
| PNG pixels | `textures/blocks/*.png` (via `/asset`) |
| Neighbour / tick | `WorldState` from the SSE snapshot |
| Layer-1 waterlogging | `TerrainSection.indices1` / `palette1` (duck-typed; store decode TBD) |
| Biome tint | `biomeAt(x,z)` hook — **snapshot has no biome yet** |

No behaviour pack. Nothing vendored. Vanilla baseline arrives as pack id `vanilla`.

## Fallback chain

1. Resolve short-name via `terrain_texture.json` (weighted pick by block pos).
2. Else try `textures/blocks/<short-name>.png`.
3. Else use the generated magenta/black `__missing__` atlas tile.
4. Missing paths never throw; they show the checker.

Unnamed non-zero `rid` blocks (registry misses) also get `__missing__`.

## Culling / passes

- Unknown / `requested` neighbour column → **exposed** (same as placeholder).
- Absent section in a known column → air.
- Opaque full cubes occlude; cutout/translucent do not occlude opaques.
- Adjacent same glass/leaves cull the shared face.
- Transparent / cutout / liquid faces → second mesh (`userData.pass = "transparent"`).
- Coplanar same-texture faces greedy-merged (triangle count down). UV across a
  merge currently stretches the tile — fine for solid test colours; proper
  world-pos tiling needs a shader later.

## Deliberately not handled yet

- Block entities with dedicated geometry (chests, signs, banners, beds, skulls).
- Custom block geometry from the network palette (stage 8) — seam is
  `CustomGeometryHook` / `CubeModel.customGeometryKey`.
- Non-cube vanilla shapes (slabs, stairs, fences, doors as meshes).
- Biome-coloured grass/foliage/water until Go adds biome data to the snapshot
  (see `BIOME_SNAPSHOT_NOTE` in `biome.ts`).
- `blocks1` decode in `store.ts` (mesher already reads it when present).
