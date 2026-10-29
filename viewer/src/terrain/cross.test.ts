/**
 * Cross plants — run: `cd viewer && npx tsx --test src/terrain/cross.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { crossQuadsAt } from "./customGeometry";
import { createTerrainMaterial } from "./material";
import { BlockModelResolver } from "./resolve";

const blocks = {
  short_grass: { textures: "short_grass" },
  tall_grass: {
    textures: {
      up: "tall_grass_top",
      down: "tall_grass_bottom",
      side: "sunflower_additional",
    },
  },
  dandelion: { textures: "dandelion" },
  fern: { textures: "fern" },
  stone: { textures: "stone" },
  grass: {
    textures: { up: "grass_top", down: "dirt", side: "grass_side" },
  },
};

function quadNormal(
  corners: Array<[number, number, number]>,
): [number, number, number] {
  const [a, b, c] = corners;
  const ux = b![0] - a![0];
  const uy = b![1] - a![1];
  const uz = b![2] - a![2];
  const vx = c![0] - a![0];
  const vy = c![1] - a![1];
  const vz = c![2] - a![2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

describe("cross plants", () => {
  const resolver = BlockModelResolver.fromJson(blocks);

  it("short_grass is two diagonal double-sided quads, not a cube", () => {
    const block = { name: "minecraft:short_grass", states: {}, rid: 1 };
    const cube = resolver.resolveCube(block, 0, 0, 0)!;
    assert.equal(cube.shape, "cross");
    assert.equal(cube.renderClass, "cutout");
    assert.equal(cube.faces.up.texture, "short_grass");
    assert.equal(cube.faces.up.tint, "grass");
    assert.equal(cube.ambientOcclusion, false);
    assert.equal(resolver.occludes(block), false);
    assert.equal(resolver.renderClassOf(block), "cutout");

    const quads = crossQuadsAt(4, 70, 9);
    assert.equal(quads.length, 2);
    assert.equal(quads[0]!.doubleSided, true);
    assert.equal(quads[1]!.doubleSided, true);
    for (const q of quads) {
      const ys = q.corners.map((c) => c[1]);
      assert.equal(Math.min(...ys), 70);
      assert.equal(Math.max(...ys), 71);
      const n = quadNormal(q.corners);
      const nonzero = n.filter((v) => Math.abs(v) > 1e-6).length;
      assert.equal(nonzero, 2, "diagonal, not an axis-aligned cube face");
    }
    const bottoms = quads.flatMap((q) =>
      q.corners.filter((c) => c[1] === 70).map((c) => `${c[0]},${c[2]}`),
    );
    assert.deepEqual(
      [...new Set(bottoms)].sort(),
      ["4,9", "4,10", "5,9", "5,10"].sort(),
    );

    const mat = createTerrainMaterial({
      map: new THREE.Texture(),
      atlasWidth: 16,
      atlasHeight: 16,
    });
    assert.equal(mat.side, THREE.DoubleSide);
    mat.dispose();
  });

  it("tall grass halves are full-height crosses with top and bottom textures", () => {
    const lower = resolver.resolveCube(
      {
        name: "minecraft:tall_grass",
        states: { upper_block_bit: false },
        rid: 2,
      },
      0,
      0,
      0,
    )!;
    const upper = resolver.resolveCube(
      {
        name: "minecraft:tall_grass",
        states: { upper_block_bit: true },
        rid: 3,
      },
      0,
      0,
      0,
    )!;
    assert.equal(lower.shape, "cross");
    assert.equal(upper.shape, "cross");
    assert.equal(lower.faces.up.texture, "tall_grass_bottom");
    assert.equal(upper.faces.up.texture, "tall_grass_top");
    assert.equal(lower.faces.up.tint, "grass");
    assert.notEqual(lower.faces.up.texture, "sunflower_additional");
    const q = crossQuadsAt(0, 0, 0);
    assert.equal(Math.max(...q[0]!.corners.map((c) => c[1])), 1);
    assert.equal(
      resolver.occludes({
        name: "minecraft:tall_grass",
        states: { upper_block_bit: false },
        rid: 2,
      }),
      false,
    );
  });

  it("flowers are crosses without a grass tint; stone stays a cube", () => {
    const flower = resolver.resolveCube(
      { name: "minecraft:dandelion", states: {}, rid: 4 },
      0,
      0,
      0,
    )!;
    assert.equal(flower.shape, "cross");
    assert.equal(flower.faces.up.tint, "none");
    const fern = resolver.resolveCube(
      { name: "minecraft:fern", states: {}, rid: 5 },
      0,
      0,
      0,
    )!;
    assert.equal(fern.shape, "cross");
    assert.equal(fern.faces.up.tint, "grass");
    const stone = resolver.resolveCube(
      { name: "minecraft:stone", states: {}, rid: 6 },
      0,
      0,
      0,
    )!;
    assert.equal(stone.shape, undefined);
    assert.equal(
      resolver.occludes({ name: "minecraft:stone", states: {}, rid: 6 }),
      true,
    );
    const grass = resolver.resolveCube(
      { name: "minecraft:grass_block", states: {}, rid: 7 },
      0,
      0,
      0,
    )!;
    assert.equal(grass.shape, undefined);
    assert.equal(grass.faces.up.tint, "grass");
    assert.equal(grass.faces.up.overlay, false);
    assert.equal(grass.faces.north.tint, "grass");
    assert.equal(grass.faces.north.overlay, true);
    assert.equal(grass.faces.down.tint, "none");
  });

  it("registry geometry.cross is a cross even without a vanilla name", () => {
    const reg = new BlockModelResolver(
      {},
      {
        blocks: [
          {
            name: "pack:shrub",
            components: {
              geometry: "minecraft:geometry.cross",
              materialInstances: {
                "*": { texture: "red_shrub", renderMethod: "alpha_test" },
              },
            },
          },
          {
            name: "pack:crate",
            components: {
              geometry: "minecraft:geometry.full_block",
              materialInstances: {
                "*": { texture: "planks", renderMethod: "opaque" },
              },
            },
          },
        ],
        items: [],
        actors: [],
      },
    );
    const shrub = reg.resolveCube(
      { name: "pack:shrub", states: {}, rid: 1 },
      0,
      0,
      0,
    )!;
    assert.equal(shrub.shape, "cross");
    assert.equal(shrub.faces.up.texture, "red_shrub");
    assert.equal(
      reg.occludes({ name: "pack:shrub", states: {}, rid: 1 }),
      false,
    );
    const crate = reg.resolveCube(
      { name: "pack:crate", states: {}, rid: 2 },
      0,
      0,
      0,
    )!;
    assert.equal(crate.shape, undefined);
    assert.equal(crate.faces.up.texture, "planks");
  });
});
