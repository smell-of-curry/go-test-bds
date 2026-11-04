/**
 * Block identity vs blocks.json keys, and partial-cube extents.
 *
 * Run: `cd viewer ; npx tsx --test src/terrain/resolve.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BlockModelResolver } from "./resolve";

const grass = { name: "minecraft:grass_block", states: {}, rid: 1 };
const carpet = { name: "minecraft:white_carpet", states: {}, rid: 2 };

describe("blocks.json identity", () => {
  it("grass_block uses the legacy grass row; a modern key still wins", () => {
    const legacy = BlockModelResolver.fromJson({
      grass: {
        textures: { up: "grass_top", down: "dirt", side: "grass_side" },
      },
    });
    const cube = legacy.resolveCube(grass, 0, 0, 0)!;
    assert.equal(cube.faces.up.texture, "grass_top");
    assert.equal(cube.faces.north.texture, "grass_side");
    assert.equal(cube.faces.down.texture, "dirt");

    const modern = BlockModelResolver.fromJson({
      grass: { textures: "wrong" },
      grass_block: { textures: { up: "modern_top", side: "modern_side" } },
    });
    assert.equal(
      modern.resolveCube(grass, 0, 0, 0)!.faces.up.texture,
      "modern_top",
    );
  });

  it("carpet is a 1/16 slab and does not occlude", () => {
    const resolver = BlockModelResolver.fromJson({
      white_carpet: { textures: "wool_colored_white" },
    });
    const cube = resolver.resolveCube(carpet, 0, 0, 0)!;
    assert.equal(cube.faces.up.texture, "wool_colored_white");
    assert.equal(cube.yBot ?? 0, 0);
    assert.equal(cube.yTop, 1 / 16);
    assert.equal(resolver.occludes(carpet), false);
  });
});

import { pairedDoorBlock } from "./resolve";

describe("vanilla doors and trapdoors", () => {
  const resolver = BlockModelResolver.fromJson({
    iron_door: {
      textures: { up: "door_lower", down: "door_lower", side: "door_upper" },
    },
    oak_trapdoor: { textures: "trapdoor" },
    furnace: { textures: { north: "front", side: "side", up: "top" } },
  });
  const door = (states: Record<string, any>) => ({
    name: "minecraft:iron_door",
    rid: 1,
    states,
  });
  it("selects two distinct iron halves, independent of world position", () => {
    for (const upper of [false, true]) {
      const block = door({ upper_block_bit: upper, direction: 0 });
      const model = resolver.resolveCube(block, 10, upper ? 71 : 70, 22)!;
      assert.equal(
        model.faces.north.texture,
        upper ? "door_upper" : "door_lower",
      );
      assert.equal(model.faces.north.textureIndex, 6);
      assert.deepEqual(model.bounds, [0, 0, 0, 3 / 16, 1, 1]);
      assert.equal(resolver.occludes(block), false);
      assert.equal(model.renderClass, "cutout");
    }
  });
  it("joins direction/open from below and hinge from above", () => {
    const lower = door({
      upper_block_bit: false,
      direction: 2,
      open_bit: true,
      door_hinge_bit: false,
    });
    const upper = door({
      upper_block_bit: true,
      direction: 0,
      open_bit: false,
      door_hinge_bit: true,
    });
    const a = resolver.resolveCube(pairedDoorBlock(lower, upper), 0, 0, 0)!;
    const b = resolver.resolveCube(
      pairedDoorBlock(upper, undefined, lower),
      0,
      1,
      0,
    )!;
    assert.deepEqual(a.bounds, b.bounds);
    assert.deepEqual(a.bounds, [0, 0, 0, 1, 1, 3 / 16]);
    assert.equal(
      a.faces.north.rotation,
      0,
      "opening moves the panel, not the artwork",
    );
  });
  it("uses horizontal trapdoors when shut and vertical panels when open", () => {
    const trap = (states: Record<string, any>) =>
      resolver.resolveCube(
        { name: "minecraft:oak_trapdoor", states, rid: 2 },
        0,
        0,
        0,
      )!;
    assert.deepEqual(trap({}).bounds, [0, 0, 0, 1, 3 / 16, 1]);
    assert.deepEqual(trap({ upside_down_bit: true }).bounds, [
      0,
      13 / 16,
      0,
      1,
      1,
      1,
    ]);
    assert.deepEqual(trap({ open_bit: true, direction: 2 }).bounds, [
      0,
      0,
      0,
      1,
      1,
      3 / 16,
    ]);
  });
  it("reads modern door cardinal states with the Bedrock quarter-turn offset", () => {
    const bounds = resolver.resolveCube(
      door({ "minecraft:cardinal_direction": "east" }),
      0,
      0,
      0,
    )!.bounds;
    assert.deepEqual(bounds, [0, 0, 13 / 16, 1, 1, 1]);
  });
  it("reads Bedrock facing_direction for directional textures", () => {
    const model = resolver.resolveCube(
      { name: "minecraft:furnace", rid: 3, states: { facing_direction: 5 } },
      0,
      0,
      0,
    )!;
    assert.equal(model.faces.east.texture, "front");
    assert.equal(model.faces.north.texture, "side");
  });
});
