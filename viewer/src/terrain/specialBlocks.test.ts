import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BlockModelResolver } from "./resolve";
import { emitSpecialBlockTris, isSpecialBlock } from "./specialBlocks";
import type { Block } from "../protocol";

const names = [
  "lantern",
  "soul_lantern",
  "waxed_copper_lantern",
  "waxed_exposed_copper_lantern",
  "waxed_weathered_copper_lantern",
  "waxed_oxidized_copper_lantern",
  "end_rod",
  "lightning_rod",
  "waxed_lightning_rod",
  "waxed_exposed_lightning_rod",
  "waxed_weathered_lightning_rod",
  "waxed_oxidized_lightning_rod",
];
const resolver = BlockModelResolver.fromJson(
  Object.fromEntries(
    names.map((name) => [name, { textures: name.replace(/^waxed_/, "") }]),
  ),
);
const block = (name: string, states: Block["states"] = {}): Block => ({
  name: `minecraft:${name}`,
  states,
  rid: 1,
});
function triangles(b: Block) {
  return emitSpecialBlockTris(b, resolver.resolveCube(b, 0, 0, 0)!, 0, 0, 0)!;
}

describe("native lantern and rod meshes", () => {
  it("recognizes the recorded oxidized/waxed families without overriding custom names or sea lanterns", () => {
    for (const name of names) {
      const b = block(name);
      assert.equal(isSpecialBlock(b.name), true, name);
      assert.equal(resolver.occludes(b), false, name);
      assert.equal(resolver.renderClassOf(b), "cutout", name);
      assert.ok(triangles(b).length > 0, name);
    }
    assert.equal(isSpecialBlock("custom:lantern"), false);
    assert.equal(isSpecialBlock("minecraft:sea_lantern"), false);
  });

  it("maps rods only to the populated regions of their UV sheet", () => {
    for (const name of ["end_rod", "waxed_lightning_rod"]) {
      const tris = triangles(block(name));
      assert.equal(tris.length, 22);
      for (const tri of tris) {
        const us = tri.uvs.filter((_, i) => i % 2 === 0);
        assert.ok(Math.max(...us) <= (name === "end_rod" ? 6 / 16 : 4 / 16));
        const xs = tri.positions.filter((_, i) => i % 3 === 0);
        assert.ok(Math.min(...xs) >= 6 / 16 && Math.max(...xs) <= 10 / 16);
      }
      const shaft = tris.filter((t) =>
        t.positions.some((v, i) => i % 3 === 0 && v === 7 / 16),
      );
      assert.ok(shaft.length > 0);
      // A full-sheet tile (the old cube fallback) would extend U to 1.
      assert.ok(
        shaft.every(
          (t) => Math.max(...t.uvs.filter((_, i) => i % 2 === 0)) <= 4 / 16,
        ),
      );
    }
  });

  it("rotates the rod shaft and cap together for every Bedrock facing", () => {
    const directions = [
      [0, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
      [-1, 0, 0],
      [1, 0, 0],
    ];
    for (let facing = 0; facing < 6; facing++) {
      for (const name of ["end_rod", "waxed_weathered_lightning_rod"]) {
        const tris = triangles(block(name, { facing_direction: facing }));
        const points = tris.flatMap((t) => t.positions);
        for (let axis = 0; axis < 3; axis++) {
          const values = points.filter((_, i) => i % 3 === axis);
          const length = Math.max(...values) - Math.min(...values);
          assert.equal(
            length,
            directions[facing]![axis] ? 1 : 4 / 16,
            `${name} facing ${facing} axis ${axis}`,
          );
        }
        // First primitive is the end-rod foot or lightning-rod head.
        const cap = tris.slice(0, 12).flatMap((t) => t.positions);
        const capMean = [0, 1, 2].map(
          (axis) =>
            cap.filter((_, i) => i % 3 === axis).reduce((a, b) => a + b, 0) /
              (cap.length / 3) -
            0.5,
        );
        const along = capMean.reduce(
          (sum, v, axis) => sum + v * directions[facing]![axis]!,
          0,
        );
        assert.ok(name === "end_rod" ? along < 0 : along > 0);
      }
    }
  });

  it("selects powered texture by state, never world-position variation", () => {
    for (const powered of [0, 1]) {
      const b = block("waxed_oxidized_lightning_rod", { powered_bit: powered });
      const model = resolver.resolveCube(b, 39, 70, -112)!;
      for (const face of Object.values(model.faces))
        assert.equal(face.textureIndex, powered);
      for (const tri of triangles(b)) assert.equal(tri.textureIndex, powered);
    }
  });

  it("builds the lantern body, cap and separate hanging chain with frame-local UVs", () => {
    const standing = triangles(block("lantern", { hanging: false }));
    const hanging = triangles(block("lantern", { hanging: true }));
    assert.equal(standing.length, 30);
    assert.equal(hanging.length, 30);
    const ys = (ts: typeof standing) =>
      ts.flatMap((t) => t.positions.filter((_, i) => i % 3 === 1));
    assert.equal(Math.min(...ys(standing)), 0);
    assert.equal(Math.max(...ys(standing)), 11 / 16);
    assert.equal(Math.min(...ys(hanging)), 1 / 16);
    assert.equal(Math.max(...ys(hanging)), 1);
    for (const t of hanging.slice(0, 22))
      assert.ok(Math.max(...t.uvs.filter((_, i) => i % 2 === 0)) <= 6 / 16);
    for (const t of hanging.slice(22)) {
      assert.ok(Math.min(...t.uvs.filter((_, i) => i % 2 === 0)) >= 11 / 16);
      assert.equal(t.faceDimming, false);
    }
  });
});
