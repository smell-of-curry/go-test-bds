import assert from "node:assert/strict";
import { it } from "node:test";
import * as THREE from "three";
import { TerrainAtlas } from "./atlas";
import { greedyMerge } from "./mesher";

it("explicit iron-door index always resolves iron instead of random wood", () => {
  const atlas = Object.create(TerrainAtlas.prototype);
  atlas.terrain = {
    door_lower: {
      paths: Array.from({ length: 7 }, (_, i) => ({
        path: `door${i}`,
        weight: 1,
      })),
    },
  };
  atlas.rects = new Map(
    Array.from({ length: 7 }, (_, i) => [`door_lower#${i}`, {}]),
  );
  atlas.uvRect = (id: string) => id;
  for (let x = -20; x <= 20; x++)
    assert.equal(atlas.uvFor("door_lower", 0, x, 70, x * 2, 6), "door_lower#6");
});

it("partial door panels are not greedily joined across separate cells", () => {
  const panel = {
    key: "door",
    pass: "transparent" as const,
    dir: 4 as const,
    x: 0,
    y: 0,
    z: 0,
    du: 1,
    dv: 1,
    rotation: 0 as const,
    color: new THREE.Color(1, 1, 1),
    yBot: 0,
    yTop: 1,
    bounds: [0, 0, 0, 3 / 16, 1, 1] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ],
    uv: { u0: 0, v0: 0, u1: 1, v1: 1, px: { x: 0, y: 0, w: 16, h: 16 } },
  };
  const merged = greedyMerge([panel, { ...panel, x: 1 }]);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((p) => p.du === 1 && p.dv === 1));
});

import { boxFaceCovered, partialTileCorners } from "./mesher";
import { BlockModelResolver } from "./resolve";

it("door edge UVs crop three pixels instead of squeezing the full door", () => {
  const bounds = [0, 0, 0, 3 / 16, 1, 1];
  const edge = partialTileCorners(4, bounds);
  assert.equal(Math.max(...edge.map((p) => p[0])), 3 / 16);
  const broad = partialTileCorners(0, bounds);
  assert.equal(Math.max(...broad.map((p) => p[0])), 1);
  const mirror = partialTileCorners(0, bounds, true);
  broad.forEach((p, i) => assert.deepEqual(mirror[i], [1 - p[0], p[1]]));
});

it("hinge state mirrors the door artwork with the panel", () => {
  const resolver = BlockModelResolver.fromJson({
    iron_door: { textures: { up: "door_lower", side: "door_upper" } },
  });
  for (const right of [true, false]) {
    const model = resolver.resolveCube(
      {
        name: "minecraft:iron_door",
        rid: 1,
        states: { door_hinge_bit: right },
      },
      0,
      0,
      0,
    )!;
    assert.equal(model.faces.north.mirrorU, right);
  }
});

it("slabs use the correct half while double slabs remain full cubes", () => {
  const resolver = BlockModelResolver.fromJson({});
  const slab = (name: string, states = {}) =>
    resolver.resolveCube(
      { name: `minecraft:${name}`, states, rid: 1 },
      0,
      0,
      0,
    )!;
  assert.deepEqual(slab("spruce_slab").bounds, [0, 0, 0, 1, 0.5, 1]);
  assert.deepEqual(
    slab("spruce_slab", { "minecraft:vertical_half": "top" }).bounds,
    [0, 0.5, 0, 1, 1, 1],
  );
  assert.equal(slab("spruce_double_slab").bounds, undefined);
});

it("stairs use six half-cubes, including inverted and corner variants", () => {
  const resolver = BlockModelResolver.fromJson({});
  const stair = (states = {}) =>
    resolver.resolveCube(
      { name: "minecraft:spruce_stairs", states, rid: 1 },
      0,
      0,
      0,
    )!;
  const normal = stair().boxes!;
  assert.equal(normal.length, 6);
  assert.ok(normal.filter((b) => b[1] === 0.5).every((b) => b[0] === 0.5));
  const upside = stair({ upside_down_bit: true, weirdo_direction: 3 }).boxes!;
  assert.ok(upside.filter((b) => b[1] === 0).every((b) => b[2] === 0));
  assert.equal(stair({ "minecraft:corner": "inner_left" }).boxes!.length, 7);
  assert.equal(stair({ "minecraft:corner": "outer_left" }).boxes!.length, 5);
  assert.equal(boxFaceCovered(normal[0]!, 0, normal), true);
  assert.equal(boxFaceCovered(normal[0]!, 1, normal), false);
});

import { interpolateBoundLight } from "./mesher";

it("partial stair top faces share identical light along their seam", () => {
  const full: [number, number, number, number] = [0.2, 0.4, 1, 0.8];
  const west = interpolateBoundLight(full, 2, [0, 0.5, 0, 0.5, 1, 1]);
  const east = interpolateBoundLight(full, 2, [0.5, 0.5, 0, 1, 1, 1]);
  assert.equal(west[3], east[0]);
  assert.equal(west[2], east[1]);
  assert.equal(west[3], 0.5);
  assert.equal(west[2], 0.7);
  assert.deepEqual(interpolateBoundLight(full, 2, [0, 0, 0, 1, 1, 1]), full);
});

it("light interpolation respects reversed west/north winding", () => {
  const full: [number, number, number, number] = [0.2, 0.4, 1, 0.8];
  for (const dir of [1, 5] as const) {
    const lower = interpolateBoundLight(full, dir, [0, 0, 0, 1, 0.5, 1]);
    const upper = interpolateBoundLight(full, dir, [0, 0.5, 0, 1, 1, 1]);
    assert.equal(lower[3], upper[0]);
    assert.equal(lower[2], upper[1]);
    assert.deepEqual(
      interpolateBoundLight(full, dir, [0, 0, 0, 1, 1, 1]),
      full,
    );
  }
});

import { terrainPassForClass, renderClassFromMethod } from "./palette";
import { createTerrainMaterial } from "./material";

it("alpha-tested doors/custom blocks write depth, while blends preserve alpha", () => {
  assert.equal(terrainPassForClass("cutout"), "opaque");
  assert.equal(
    terrainPassForClass(renderClassFromMethod("alpha_test")),
    "opaque",
  );
  assert.equal(
    terrainPassForClass(renderClassFromMethod("blend")),
    "transparent",
  );
  assert.equal(terrainPassForClass("liquid"), "transparent");
  const opaque = createTerrainMaterial({
    map: new THREE.Texture(),
    atlasWidth: 16,
    atlasHeight: 16,
  });
  const blended = createTerrainMaterial({
    map: new THREE.Texture(),
    atlasWidth: 16,
    atlasHeight: 16,
    transparent: true,
  });
  assert.equal(opaque.depthWrite, true);
  assert.equal(opaque.uniforms.preserveAlpha!.value, 0);
  assert.equal(blended.depthWrite, false);
  assert.equal(blended.uniforms.preserveAlpha!.value, 1);
  opaque.dispose();
  blended.dispose();
});
