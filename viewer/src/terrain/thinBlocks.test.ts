import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockModelResolver } from "./resolve";
import { groundCoverQuads } from "./thinBlocks";
import type { Block } from "../protocol";

const resolver = BlockModelResolver.fromJson({
  leaf_litter: { textures: "leaf_litter" },
  red_stained_glass_pane: {
    textures: { side: "red_stained_glass", east: "red_stained_glass_pane_top" },
  },
  stone_bricks: { textures: "stonebrick" },
});
const block = (name: string, states: Block["states"] = {}): Block => ({
  name: `minecraft:${name}`,
  states,
  rid: 1,
});

test("leaf litter never removes the pavement underneath its alpha holes", () => {
  const leaves = block("leaf_litter", { growth: 3 });
  assert.equal(resolver.occludes(leaves), false);
  assert.equal(resolver.resolveCube(leaves, 93, 83, -17)!.shape, "ground");
  assert.equal(resolver.resolveCube(leaves, 93, 83, -17)!.faces.up.tint, "dry");
  assert.equal(resolver.renderClassOf(leaves), "cutout");
  assert.equal(resolver.occludes(block("stone_bricks")), true);
  const quads = groundCoverQuads(leaves, 93, 83, -17);
  assert.equal(quads.length, 4);
  assert.ok(quads.every((q) => q.corners.every((p) => p[1] === 83 + 1 / 64)));
  const cells = new Set(
    quads.map(
      (q) =>
        `${Math.min(...q.corners.map((p) => p[0]))},${Math.min(...q.corners.map((p) => p[2]))}`,
    ),
  );
  assert.equal(cells.size, 4);
});

test("litter count and cardinal direction alter the occupied ground quarters", () => {
  const north = groundCoverQuads(
    block("leaf_litter", { growth: 0 }),
    0,
    0,
    0,
  )[0]!;
  assert.equal(Math.max(...north.corners.map((p) => p[0])), 0.5);
  assert.equal(Math.max(...north.corners.map((p) => p[2])), 0.5);
  const origins = new Set<string>();
  for (const direction of ["north", "east", "south", "west"]) {
    const quad = groundCoverQuads(
      block("leaf_litter", {
        growth: 0,
        "minecraft:cardinal_direction": direction,
      }),
      0,
      0,
      0,
    )[0]!;
    origins.add(
      `${Math.min(...quad.corners.map((p) => p[0]))},${Math.min(...quad.corners.map((p) => p[2]))}`,
    );
  }
  assert.equal(origins.size, 4);
  for (let growth = 0; growth < 4; growth++)
    assert.equal(
      groundCoverQuads(block("leaf_litter", { growth }), 0, 0, 0).length,
      growth + 1,
    );
});

test("Poké Center glass panes leave space before the quartz lettering", () => {
  const pane = block("red_stained_glass_pane", {
    "minecraft:connection_east": true,
    "minecraft:connection_west": true,
  });
  const model = resolver.resolveCube(pane, 108, 98, -26)!;
  assert.deepEqual(model.boxes, [[0, 0, 7 / 16, 1, 1, 9 / 16]]);
  // Quartz lies in the next cell at Z=-27; the pane must not touch its face.
  assert.ok(-26 + model.boxes![0]![2] > -26);
  assert.equal(model.renderClass, "translucent");
  assert.equal(resolver.occludes(pane), false);
  assert.equal(model.boxFaces![0]!.north.texture, "red_stained_glass");
  assert.equal(model.boxFaces![0]!.east.texture, "red_stained_glass_pane_top");
  assert.equal(model.boxFaces![0]!.up.rotation, 1);
});

test("pane corners and isolated posts remain thin and connect at cell boundaries", () => {
  const model = resolver.resolveCube(
    block("red_stained_glass_pane", {
      "minecraft:connection_east": true,
      "minecraft:connection_north": true,
    }),
    0,
    0,
    0,
  )!;
  assert.equal(model.boxes!.length, 2);
  assert.equal(
    model.boxFaces![1]!.east.texture,
    "red_stained_glass",
    "wide north arm uses the sheet, not the edge strip",
  );
  assert.equal(model.boxFaces![1]!.north.texture, "red_stained_glass_pane_top");
  assert.equal(model.boxFaces![1]!.up.rotation, 0);
  assert.ok(
    model.boxes!.every((b) => b[3] - b[0] <= 2 / 16 || b[5] - b[2] <= 2 / 16),
  );
  assert.deepEqual(
    resolver.resolveCube(block("red_stained_glass_pane"), 0, 0, 0)!.boxes,
    [[7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16]],
  );
});
