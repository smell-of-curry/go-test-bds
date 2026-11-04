import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { TerrainAtlas } from "./atlas";
import { BlockModelResolver } from "./resolve";
import { parseFlipbookJson, parseTerrainTextureJson } from "./parse";
import { createTerrainMaterial } from "./material";
import * as THREE from "three";

const root = new URL(
  "../../../.cache/baseline/v1.26.50.4/resource_pack/textures/",
  import.meta.url,
);
test("liquid resolver uses atlas tile identifiers, not image filenames", () => {
  const resolver = BlockModelResolver.fromJson({});
  for (const name of ["water", "flowing_water", "lava", "flowing_lava"]) {
    const model = resolver.resolveLiquid({
      name: `minecraft:${name}`,
      rid: 1,
      states: { liquid_depth: 0 },
    })!;
    assert.deepEqual(
      [model.textureStill, model.textureFlow],
      name.includes("water")
        ? ["still_water_grey", "flowing_water_grey"]
        : ["still_lava", "flowing_lava"],
    );
  }
});

test(
  "liquid keys select real vanilla square flipbook frames and tint-neutral water",
  {
    skip:
      !existsSync(new URL("terrain_texture.json", root)) ||
      !existsSync(new URL("flipbook_textures.json", root))
        ? "optional Mojang baseline cache unavailable"
        : false,
  },
  () => {
    const terrain = parseTerrainTextureJson(
      JSON.parse(
        readFileSync(new URL("terrain_texture.json", root), "utf8").replace(
          /^\s*\/\/.*$/gm,
          "",
        ),
      ),
    );
    const flipbooks = parseFlipbookJson(
      JSON.parse(
        readFileSync(new URL("flipbook_textures.json", root), "utf8").replace(
          /^\s*\/\/.*$/gm,
          "",
        ),
      ),
    );
    const resolver = BlockModelResolver.fromJson({});
    for (const name of ["water", "flowing_water", "lava", "flowing_lava"]) {
      const model = resolver.resolveLiquid({
        name: `minecraft:${name}`,
        rid: 1,
        states: { liquid_depth: 0 },
      })!;
      for (const key of [model.textureStill, model.textureFlow]) {
        assert.ok(terrain[key], `${key} exists in vanilla terrain`);
        assert.ok(
          flipbooks.some((f) => f.atlasTile === key),
          `${key} has a flipbook`,
        );
        if (name.includes("water")) assert.match(key, /grey$/);
      }
    }
  },
);

test("live atlas animation advances and rewinds without changing mesh UVs", () => {
  const draws: number[][] = [];
  const canvas = {
    getContext: () => ({
      clearRect: () => {},
      drawImage: (_: unknown, ...args: number[]) => draws.push(args),
    }),
  } as unknown as OffscreenCanvas;
  const bitmap = {} as ImageBitmap;
  const atlas = new TerrainAtlas(
    canvas,
    64,
    128,
    {},
    [
      {
        atlasTile: "water",
        flipbookTexture: "water",
        ticksPerFrame: 2,
        frames: null,
        blendFrames: false,
      },
    ],
    [{ id: "water", x: 0, y: 0, w: 16, h: 64, bitmap }],
  );
  atlas.enableAnimation();
  const uv = atlas.uvRect("water", 0);
  assert.equal(atlas.updateAnimation(0), true);
  assert.equal(atlas.updateAnimation(1), false);
  assert.equal(atlas.updateAnimation(4), true);
  assert.equal(draws[1]![1], 32);
  assert.deepEqual(atlas.uvRect("water", 4), uv);
  assert.equal((uv.v1 - uv.v0) * 128, 16);
  assert.equal(atlas.updateAnimation(0), true);
  assert.equal(draws[2]![1], 0);
});

test("transparent terrain preserves texture opacity; opaque terrain writes solid alpha", () => {
  const map = new THREE.Texture();
  for (const transparent of [false, true]) {
    const mat = createTerrainMaterial({
      map,
      atlasWidth: 64,
      atlasHeight: 64,
      transparent,
    });
    assert.equal(mat.uniforms.preserveAlpha!.value, transparent ? 1 : 0);
    assert.match(mat.fragmentShader, /mix\(1\.0, tex\.a, preserveAlpha\)/);
    assert.equal(mat.depthWrite, !transparent);
    mat.dispose();
  }
  map.dispose();
});

test("flowing liquids share sloping corners and fill stacked columns", async () => {
  const { liquidCornerHeights, liquidHeight } = await import("./mesher");
  const source = {
    name: "minecraft:water",
    rid: 1,
    states: { liquid_depth: 0 },
  };
  const flow = {
    name: "minecraft:flowing_water",
    rid: 2,
    states: { liquid_depth: 5 },
  };
  const sample = (x: number, y: number, _z: number) =>
    y === 0 ? (x <= 0 ? source : flow) : undefined;
  const left = liquidCornerHeights(source, 0, 0, 0, sample, () => false);
  const right = liquidCornerHeights(flow, 1, 0, 0, sample, () => false);
  assert.equal(left[2], right[1]);
  assert.equal(left[3], right[0]);
  assert.ok(left[0] > left[3]);
  assert.ok(right[0] > right[3]);
  const stacked = liquidCornerHeights(
    source,
    0,
    0,
    0,
    () => source,
    () => false,
  );
  assert.deepEqual(stacked, [1, 1, 1, 1]);
  assert.equal(
    liquidHeight(8),
    liquidHeight(0),
    "falling fluid does not collapse to a shallow puddle",
  );
  const stone = { name: "minecraft:stone", rid: 3, states: {} };
  const walled = liquidCornerHeights(
    source,
    0,
    0,
    0,
    (x, y, z) => (y !== 0 ? undefined : x === 0 && z === 0 ? source : stone),
    (b) => b.name === stone.name,
  );
  assert.deepEqual(
    walled,
    Array(4).fill(liquidHeight(0)),
    "solid banks do not pull the surface downward",
  );
});
