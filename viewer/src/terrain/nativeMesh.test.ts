import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type DecodedSection, type StoredColumn } from "../store";
import { sectionIndex, type Block } from "../protocol";
import { TexturedMesher } from "./mesher";
import { BlockModelResolver } from "./resolve";
import type { TerrainAtlas } from "./atlas";

/** No browser/GPU: inspect the actual geometry sent to the renderer. */
function mesh(
  blocks: Array<{ x: number; y: number; z: number; block: Block }>,
  opaqueInterior = false,
) {
  const atlas = {
    width: 16,
    height: 16,
    enableAnimation() {},
    imageSource: () => null,
    has: () => false,
    uvFor: () => ({
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
      px: { x: 0, y: 0, w: 16, h: 16 },
    }),
  } as unknown as TerrainAtlas;
  const section: DecodedSection = {
    y: 0,
    indices: new Uint16Array(4096),
    palette: [{ name: "minecraft:air", states: {}, rid: 0 }],
    skyLight: new Uint8Array(4096).fill(15),
    blockLight: new Uint8Array(4096),
  };
  const defs: Record<string, { textures: string }> = {};
  for (const b of blocks) {
    section.indices[sectionIndex(b.x, b.y, b.z)] = section.palette.length;
    if (opaqueInterior) section.skyLight![sectionIndex(b.x, b.y, b.z)] = 0;
    section.palette.push(b.block);
    defs[b.block.name] = { textures: b.block.name.split(":")[1]! };
  }
  const column: StoredColumn = {
    x: 0,
    z: 0,
    state: "complete",
    minY: 0,
    maxY: 15,
    sections: new Map([[0, section]]),
    biomePalette: [],
    biomeIndices: null,
    blockEntities: [],
  };
  const state = new Store().getState();
  state.columns.set("0,0", column);
  const mesher = new TexturedMesher(atlas, BlockModelResolver.fromJson(defs), {
    smoothLighting: false,
  });
  const result = mesher.meshSection(section, column, state);
  const positions = result.meshes.flatMap((m) =>
    Array.from(m.geometry.getAttribute("position").array),
  );
  const colors = result.meshes.flatMap((m) =>
    Array.from(m.geometry.getAttribute("vertColor").array),
  );
  for (const m of result.meshes) m.geometry.dispose();
  mesher.dispose();
  return { positions, colors };
}
const block = (name: string, states: Block["states"] = {}): Block => ({
  name: `minecraft:${name}`,
  states,
  rid: 1,
});

test("mesher draws litter flat and keeps the opaque floor underneath", () => {
  const { positions: p } = mesh([
    { x: 4, y: 1, z: 4, block: block("stone_bricks") },
    { x: 4, y: 2, z: 4, block: block("leaf_litter", { growth: 3 }) },
  ]);
  const ys = p.filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...ys), 2 + 1 / 64);
  assert.ok(
    ys.filter((y) => y === 2).length >= 6,
    "the pavement top must survive under litter",
  );
});

test("mesher uses native rod geometry and connected pane thickness", () => {
  const { positions: rod } = mesh([
    {
      x: 4,
      y: 4,
      z: 4,
      block: block("waxed_lightning_rod", { facing_direction: 1 }),
    },
  ]);
  assert.ok(rod.length > 0);
  assert.ok(
    rod.filter((_, i) => i % 3 !== 1).every((v) => v > 4 && v < 5),
    "rod must not become a unit cube",
  );
  const { positions: pane } = mesh([
    {
      x: 4,
      y: 4,
      z: 4,
      block: block("red_stained_glass_pane", {
        "minecraft:connection_east": true,
        "minecraft:connection_west": true,
      }),
    },
  ]);
  const zs = pane.filter((_, i) => i % 3 === 2);
  assert.equal(Math.min(...zs), 4 + 7 / 16);
  assert.equal(Math.max(...zs), 4 + 9 / 16);
});

test("native partial surfaces receive exterior light when the recorded interior is dark", () => {
  for (const name of ["leaf_litter", "waxed_lightning_rod"]) {
    const { colors } = mesh(
      [
        {
          x: 4,
          y: 4,
          z: 4,
          block: block(name, { growth: 3, facing_direction: 1 }),
        },
      ],
      true,
    );
    assert.ok(colors.length > 0);
    assert.ok(
      Math.min(...colors) >= 0.49,
      `${name} must receive surrounding daylight with ordinary directional shade`,
    );
  }
});
