/**
 * Biome colormap tint — run: `cd viewer && npx tsx --test src/terrain/biome.test.ts`
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  climateFor,
  colormapCoords,
  sampleColormap,
  setBiomeColormaps,
  tintAt,
  type Colormap,
} from "./biome";
import type { TintRgb } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

function findColormap(file: string): string {
  const tag = "v1.26.50.4";
  const roots = [
    process.env.GOLDEN_BASELINE_DIR,
    join(here, "../../../.cache/baseline", tag, "resource_pack"),
    join(
      here,
      "../../../../pokebedrock-studio/.cache/film-cache/baseline",
      tag,
      "resource_pack",
    ),
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    const path = join(root, "textures/colormap", file);
    if (existsSync(path)) return path;
  }
  throw new Error(`colormap ${file} not found under baseline or film-cache`);
}

function pngColormap(file: string): Colormap {
  const png = PNG.sync.read(readFileSync(findColormap(file)));
  return {
    width: png.width,
    height: png.height,
    rgba: new Uint8ClampedArray(png.data),
  };
}

function hex(n: number): TintRgb {
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function assertNear(got: TintRgb, want: TintRgb, tol: number, label: string) {
  const d = Math.max(
    Math.abs(got.r - want.r),
    Math.abs(got.g - want.g),
    Math.abs(got.b - want.b),
  );
  assert.ok(
    d <= tol,
    `${label} Δ=${d.toFixed(4)} got ${Math.round(got.r * 255)},${Math.round(got.g * 255)},${Math.round(got.b * 255)}`,
  );
}

describe("biome colormap tint", () => {
  const grass = pngColormap("grass.png");
  const foliage = pngColormap("foliage.png");
  const swamp = pngColormap("swamp_grass.png");
  setBiomeColormaps({ grass, foliage, swampGrass: swamp });

  it("savanna grass matches the colormap, near vanilla #BFB755", () => {
    const climate = climateFor("minecraft:savanna")!;
    assert.equal(climate.t, 1.2);
    assert.equal(climate.d, 0);
    const { x, y } = colormapCoords(
      climate.t,
      climate.d,
      grass.width,
      grass.height,
    );
    assert.deepEqual({ x, y }, { x: 0, y: 255 });
    const sampled = sampleColormap(grass, climate.t, climate.d)!;
    const tint = tintAt(() => "minecraft:savanna", "grass", 0, 0);
    assertNear(tint, sampled, 1 / 255, "sample");
    // Vanilla savanna grass is quoted as #BFB755; the 1.26.50 colormap pixel
    // is one step away (#BEB654).
    assertNear(tint, hex(0xbfb755), 3 / 255, "vanilla");
    const leaves = tintAt(() => "savanna", "foliage", 10, 10);
    const leafPx = sampleColormap(foliage, climate.t, climate.d)!;
    assertNear(leaves, leafPx, 1 / 255, "acacia foliage");
  });

  it("unknown biome falls back to plains climate, missing id stays untinted", () => {
    const plains = tintAt(() => "minecraft:plains", "grass", 0, 0);
    const unknown = tintAt(() => "minecraft:not_a_biome", "grass", 3, 4);
    assertNear(unknown, plains, 1 / 255, "unknown→plains");
    const none = tintAt(() => null, "grass", 0, 0);
    assert.deepEqual(none, { r: 1, g: 1, b: 1 });
    const absent = tintAt(null, "foliage", 0, 0);
    assert.deepEqual(absent, { r: 1, g: 1, b: 1 });
  });

  it("badlands and swamp use vanilla overrides, not the generic colormap", () => {
    const mesa = tintAt(() => "minecraft:mesa", "grass", 0, 0);
    assertNear(mesa, hex(0xaea42a), 1 / 255, "badlands grass");
    const mesaLeaf = tintAt(() => "badlands", "foliage", 0, 0);
    assertNear(mesaLeaf, hex(0x90814d), 1 / 255, "badlands foliage");
    const swampLeaf = tintAt(() => "minecraft:swampland", "foliage", 0, 0);
    assertNear(swampLeaf, hex(0x6a7039), 1 / 255, "swamp foliage");
    const seen = new Set<string>();
    for (let x = 0; x < 64; x++) {
      for (let z = 0; z < 64; z++) {
        const c = tintAt(() => "swampland", "grass", x * 3, z * 5);
        seen.add(
          `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`,
        );
      }
    }
    assert.ok(seen.has("76,118,60"), `swamp dark missing: ${[...seen]}`);
    assert.ok(seen.has("106,112,57"), `swamp light missing: ${[...seen]}`);
    const water = tintAt(() => "savanna", "water", 0, 0);
    assertNear(water, hex(0x2c8b9c), 1 / 255, "savanna water");
    const birch = tintAt(() => "minecraft:savanna", "birch", 0, 0);
    assertNear(birch, hex(0x80a755), 1 / 255, "birch");
    const spruce = tintAt(null, "spruce", 0, 0);
    assertNear(spruce, hex(0x619961), 1 / 255, "spruce");
  });
});
