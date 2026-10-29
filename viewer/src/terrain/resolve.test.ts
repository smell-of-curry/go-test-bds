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
