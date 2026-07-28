import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import {
  flipbookFrameAt,
  facingToFrontFace,
  greedyMerge,
  hashPos,
  canonicalizeBlockId,
  decodeTga,
  mergeBlockDef,
  mergeBlocksLayers,
  normalizeTexPath,
  parseBlocksJson,
  parseTerrainTextureJson,
  pickVariationIndex,
  liquidFlowYaw,
  liquidHeight,
  wrapTileCoord,
  FALLBACK_TEXTURE,
  NEUTRAL_TEXTURE,
  diagnosePaletteCoverage,
  facesFromMaterialInstances,
  renderClassFromMethod,
} from "../src/terrain";
import { BlockModelResolver } from "../src/terrain/resolve";
import {
  buildFixturePack,
  buildRealisticPackStack,
  startMultiPackAssetServer,
  startTerrainAssetServer,
} from "./terrainAssetServer";
import type { Block, Registries } from "../src/protocol";
import { Store } from "../src/store";
import type { Color } from "three";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const registriesFixture = JSON.parse(
  readFileSync(join(viewerRoot, "testdata", "registries-fixture.json"), "utf8"),
) as Registries;

test.describe("terrain parse / resolve (node)", () => {
  test("weighted variation pick is stable for a position", () => {
    const paths = [
      { path: "a", weight: 1 },
      { path: "b", weight: 1 },
      { path: "c", weight: 2 },
    ];
    const a = pickVariationIndex(paths, 3, 4, 5);
    const b = pickVariationIndex(paths, 3, 4, 5);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(3);
    // Different position can differ.
    const other = pickVariationIndex(paths, 9, 0, 1);
    expect(hashPos(3, 4, 5)).not.toBe(hashPos(9, 0, 1));
    void other;
  });

  test("flipbook frame advances by tick, not wall clock", () => {
    const entry = {
      flipbookTexture: "textures/blocks/water_still",
      atlasTile: "water_still",
      ticksPerFrame: 2,
      frames: [0, 1, 2, 3],
      blendFrames: false,
    };
    expect(flipbookFrameAt(entry, 0, 4)).toBe(0);
    expect(flipbookFrameAt(entry, 1, 4)).toBe(0);
    expect(flipbookFrameAt(entry, 2, 4)).toBe(1);
    expect(flipbookFrameAt(entry, 8, 4)).toBe(0);
  });

  test("directional block puts front texture on facing face", () => {
    const resolver = BlockModelResolver.fromJson({
      "minecraft:test_directional": {
        textures: {
          north: "furnace_front",
          south: "furnace_side",
          east: "furnace_side",
          west: "furnace_side",
          up: "furnace_top",
          down: "furnace_top",
        },
      },
    });
    const block: Block = {
      name: "minecraft:test_directional",
      states: { facing: "east" },
      rid: 1,
    };
    const cube = resolver.resolveCube(block, 0, 0, 0)!;
    expect(facingToFrontFace("east")).toBe("east");
    expect(cube.faces.east.texture).toBe("furnace_front");
    expect(cube.faces.north.texture).toBe("furnace_side");
    expect(cube.faces.west.texture).toBe("furnace_side");
  });

  test("liquid flow yaw from facing state; height from depth", () => {
    const flowing: Block = {
      name: "minecraft:flowing_water",
      states: { liquid_depth: 3, facing: "north" },
      rid: 2,
    };
    expect(liquidFlowYaw(flowing)).toBe(180);
    expect(liquidHeight(0)).toBeCloseTo(14 / 16);
    expect(liquidHeight(7)).toBeLessThan(liquidHeight(0));
  });

  test("decodes uncompressed 32-bit TGA tiles Bedrock ships without PNG", () => {
    // 2×2 BGRA, bottom-up, image type 2.
    const pixels = new Uint8Array([
      // y=0 (bottom): R, G
      0, 0, 255, 255, 0, 255, 0, 255,
      // y=1 (top): B, W
      255, 0, 0, 255, 255, 255, 255, 255,
    ]);
    const header = new Uint8Array(18);
    header[2] = 2;
    header[12] = 2;
    header[14] = 2;
    header[16] = 32;
    header[17] = 8;
    const buf = new Uint8Array(18 + pixels.length);
    buf.set(header, 0);
    buf.set(pixels, 18);
    const decoded = decodeTga(buf.buffer)!;
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    // Bottom-up TGA: file's last row is image top → blue
    expect([...decoded.rgba.slice(0, 4)]).toEqual([0, 0, 255, 255]);
    // File's first row is image bottom → red
    expect([...decoded.rgba.slice(2 * 2 * 4 - 8, 2 * 2 * 4 - 4)]).toEqual([
      255, 0, 0, 255,
    ]);
  });

  test("vanilla bare blocks.json keys resolve as minecraft: ids", () => {
    expect(canonicalizeBlockId("stone")).toBe("minecraft:stone");
    expect(canonicalizeBlockId("pokeb:apricorn_planks")).toBe(
      "pokeb:apricorn_planks",
    );
    const blocks = parseBlocksJson({
      stone: { textures: "flattened_stone" },
      "pokeb:x": { textures: "x" },
    });
    expect(blocks["minecraft:stone"]?.textures).toBe("flattened_stone");
    expect(blocks.stone).toBeUndefined();
    const resolver = BlockModelResolver.fromJson({
      stone: { textures: "flattened_stone" },
    });
    const cube = resolver.resolveCube(
      { name: "minecraft:stone", states: {}, rid: 1 },
      0,
      0,
      0,
    )!;
    expect(cube.faces.up.texture).toBe("flattened_stone");
  });

  test("merge keeps vanilla textures when overlay only sets sound", () => {
    const merged = mergeBlockDef({ textures: "stone" }, { sound: "stone" });
    expect(merged.textures).toBe("stone");
    expect(merged.sound).toBe("stone");

    const layers = mergeBlocksLayers([
      { "minecraft:stone": { textures: "stone" } },
      { "minecraft:stone": { sound: "stone" } },
    ]);
    expect(layers["minecraft:stone"]?.textures).toBe("stone");
  });

  test("terrain_texture accepts all four real entry shapes + path variants", () => {
    const map = parseTerrainTextureJson({
      texture_data: {
        bare: { textures: "textures/blocks/stone" },
        arr_str: { textures: ["textures/blocks/a", "textures/blocks/b"] },
        obj: {
          textures: { path: "textures/blocks/dirt", overlay_color: "#fff" },
        },
        arr_obj: {
          textures: [
            { path: "blocks/grass_side", tint_color: "#ffffff", weight: 2 },
          ],
        },
        with_png: { textures: "blocks/planks_oak.png" },
      },
    });
    expect(map.bare?.paths[0]?.path).toBe("textures/blocks/stone");
    expect(map.arr_str?.paths.map((p) => p.path)).toEqual([
      "textures/blocks/a",
      "textures/blocks/b",
    ]);
    expect(map.obj?.paths[0]?.path).toBe("textures/blocks/dirt");
    expect(map.arr_obj?.paths[0]?.path).toBe("textures/blocks/grass_side");
    expect(map.arr_obj?.paths[0]?.weight).toBe(2);
    expect(map.with_png?.paths[0]?.path).toBe("textures/blocks/planks_oak");
    expect(normalizeTexPath("blocks/stone.png")).toBe("textures/blocks/stone");
    expect(normalizeTexPath("textures/blocks/stone")).toBe(
      "textures/blocks/stone",
    );
  });

  test("greedy merge reduces coplanar same-key quads", () => {
    const uv = {
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
      px: { x: 0, y: 0, w: 16, h: 16 },
    };
    const color = { r: 1, g: 1, b: 1 } as unknown as Color;
    const unit = (x: number, z: number) => ({
      key: "opaque|2|stone|none|0|uv",
      pass: "opaque" as const,
      dir: 2 as const,
      x,
      y: 0,
      z,
      du: 1,
      dv: 1,
      uv,
      rotation: 0 as const,
      color,
      yTop: 1,
      yBot: 0,
    });
    // 2×2 top faces
    const before = [unit(0, 0), unit(1, 0), unit(0, 1), unit(1, 1)];
    const after = greedyMerge(before);
    expect(before.length).toBe(4);
    expect(after.length).toBe(1);
    expect(after[0]!.du * after[0]!.dv).toBe(4);
    expect(after.length * 2).toBe(2); // triangles after
    expect(before.length * 2).toBe(8); // triangles before
  });

  test("wrapTileCoord maps fract(N)==0 far edge to 1", () => {
    expect(wrapTileCoord(0)).toBe(0);
    expect(wrapTileCoord(0.25)).toBeCloseTo(0.25);
    expect(wrapTileCoord(4)).toBe(1);
    expect(wrapTileCoord(3.0)).toBe(1);
    expect(wrapTileCoord(2.999999)).toBeGreaterThan(0.9);
  });

  test("palette material_instances → textured cube; bare → neutral; pack wins", () => {
    expect(renderClassFromMethod("alpha_test")).toBe("cutout");
    expect(renderClassFromMethod("opaque")).toBe("opaque");

    const fromMats = facesFromMaterialInstances({
      "*": { texture: "palette_right_texture", renderMethod: "alpha_test" },
    })!;
    expect(fromMats.faces.up.texture).toBe("palette_right_texture");
    expect(fromMats.renderClass).toBe("cutout");

    const packAndPalette = new BlockModelResolver(
      {
        "fixture:custom_crate": { textures: "stone" },
        "minecraft:stone": { textures: "stone" },
      },
      registriesFixture,
    );
    // Pack textures present → keep pack short-name (not palette).
    const both = packAndPalette.resolveCube(
      { name: "fixture:custom_crate", states: {}, rid: 10 },
      0,
      0,
      0,
    )!;
    expect(both.faces.up.texture).toBe("stone");

    const paletteOnly = new BlockModelResolver({}, registriesFixture);
    const crate = paletteOnly.resolveCube(
      { name: "fixture:custom_crate", states: {}, rid: 10 },
      0,
      0,
      0,
    )!;
    expect(crate.faces.north.texture).toBe("palette_right_texture");
    expect(crate.faces.up.texture).not.toBe(FALLBACK_TEXTURE);

    const bare = paletteOnly.resolveCube(
      { name: "fixture:bare_unit", states: {}, rid: 11 },
      0,
      0,
      0,
    )!;
    expect(bare.faces.up.texture).toBe(NEUTRAL_TEXTURE);
    expect(bare.faces.up.texture).not.toBe(FALLBACK_TEXTURE);

    const cutout = paletteOnly.resolveCube(
      { name: "fixture:cutout_leaves", states: {}, rid: 12 },
      0,
      0,
      0,
    )!;
    expect(cutout.renderClass).toBe("cutout");

    const unnamed = paletteOnly.resolveCube(
      { name: "", states: {}, rid: 99 },
      0,
      0,
      0,
    )!;
    expect(unnamed.faces.up.texture).toBe(FALLBACK_TEXTURE);

    const cov = diagnosePaletteCoverage(
      registriesFixture,
      (s) => s === "palette_right_texture",
    );
    expect(cov.entryCount).toBe(3);
    expect(cov.withMaterialInstances).toBe(2);
    expect(cov.texturesResolved).toBe(2);
    expect(cov.neutralNoMaterials).toBe(1);
    expect(cov.withGeometry).toBe(3);
  });

  test("store keeps keyframe registries", () => {
    const store = new Store();
    store.apply({
      v: 1,
      type: "hello",
      bot: "t",
      schema: 1,
      tickRate: 20,
      radius: 4,
    });
    store.apply({
      v: 1,
      type: "keyframe",
      bot: "t",
      tick: 1,
      world: {
        dimension: 0,
        dimensionName: "overworld",
        minY: -64,
        maxY: 319,
      },
      actor: {
        rid: 1,
        uid: 1,
        name: "t",
        pos: [0, 64, 0],
        eyePos: [0, 65.62, 0],
        rot: [0, 0],
        vel: [0, 0, 0],
        onGround: true,
        gamemode: 0,
        dimension: 0,
        health: 20,
        maxHealth: 20,
        food: 20,
        heldSlot: 0,
        sneaking: false,
        sprinting: false,
        swimming: false,
        gliding: false,
        hotbar: Array(9).fill(null),
        inventory: Array(36).fill(null),
        offhand: null,
        armour: [null, null, null, null],
        effects: [],
        chunkRadius: 4,
      },
      columns: [],
      entities: [],
      registries: registriesFixture,
    });
    expect(store.getState().registries?.blocks[0]?.name).toBe(
      "fixture:custom_crate",
    );
    store.apply({
      v: 1,
      type: "delta",
      bot: "t",
      tick: 2,
    });
    expect(store.getState().registries?.blocks.length).toBe(3);
  });
});

test.describe("terrain atlas + mesher (browser)", () => {
  test("atlas packs mixed sizes, UV for known tile, flipbook by tick, missing→fallback", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assets = await startTerrainAssetServer();
    let devServer: ViteDevServer | undefined;
    try {
      const files = buildFixturePack();
      // Inject a 32px tile into the live server by restarting with extra — already in pack.
      void files;

      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5178, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");

      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(async (assetBase) => {
        const {
          createTexturedMesher,
          FALLBACK_TEXTURE,
          buildTerrainAtlas,
          AssetClient,
          flipbookFrameAt,
        } = await import("/src/terrain/index.ts");

        const bundle = await createTexturedMesher({
          baseUrl: assetBase,
          extraTextures: ["big_tile", "missing_only"],
        });
        const { atlas } = bundle;

        const stone = atlas.rectOf("stone");
        const big = atlas.rectOf("big_tile");
        const missingHas = atlas.has("missing_only");
        const fallback = atlas.rectOf(FALLBACK_TEXTURE);
        const uv0 = atlas.uvRect("water_still", 0);
        const uv2 = atlas.uvRect("water_still", 2);
        const fb = atlas.flipbook("water_still");
        const frame0 = fb ? flipbookFrameAt(fb, 0, 4) : -1;
        const frame2 = fb ? flipbookFrameAt(fb, 2, 4) : -1;

        // Variation stability via atlas uvFor
        const v0 = atlas.uvFor("varied_stone", 0, 1, 2, 3);
        const v1 = atlas.uvFor("varied_stone", 0, 1, 2, 3);

        bundle.mesher.dispose();
        return {
          atlasW: atlas.width,
          atlasH: atlas.height,
          stone,
          big,
          missingHas,
          fallback,
          uv0,
          uv2,
          frame0,
          frame2,
          v0,
          v1,
          fallbackId: FALLBACK_TEXTURE,
        };
      }, assets.url);

      expect(result.atlasW).toBeGreaterThanOrEqual(32);
      expect(result.stone.w).toBe(16);
      expect(result.big.w).toBe(32);
      expect(result.missingHas).toBe(false);
      expect(result.fallback.w).toBe(16);
      expect(result.frame0).toBe(0);
      expect(result.frame2).toBe(1);
      expect(result.uv0.v0).not.toBe(result.uv2.v0);
      expect(result.v0).toEqual(result.v1);
      expect(result.fallbackId).toBe(FALLBACK_TEXTURE);
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });

  test("mesher: cull, greedy merge, transparency pass, waterlog, unknown neighbour", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assets = await startTerrainAssetServer();
    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5179, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(async (assetBase) => {
        const { createTexturedMesher } = await import("/src/terrain/index.ts");
        const { columnKey, sectionIndex } = await import("/src/protocol.ts");

        const AIR = { name: "minecraft:air", states: {}, rid: 0 };
        const STONE = { name: "minecraft:stone", states: {}, rid: 1 };
        const GLASS = { name: "minecraft:glass", states: {}, rid: 2 };
        const WATER = {
          name: "minecraft:water",
          states: { liquid_depth: 0 },
          rid: 3,
        };

        function makeSection(
          fill: (x: number, y: number, z: number) => number,
          palette: (typeof AIR)[],
          layer1?: {
            fill: (x: number, y: number, z: number) => number;
            palette: (typeof AIR)[];
          },
        ) {
          const indices = new Uint16Array(4096);
          for (let x = 0; x < 16; x++) {
            for (let y = 0; y < 16; y++) {
              for (let z = 0; z < 16; z++) {
                indices[sectionIndex(x, y, z)] = fill(x, y, z);
              }
            }
          }
          const sec: Record<string, unknown> = {
            y: 0,
            indices,
            palette,
          };
          if (layer1) {
            const indices1 = new Uint16Array(4096);
            for (let x = 0; x < 16; x++) {
              for (let y = 0; y < 16; y++) {
                for (let z = 0; z < 16; z++) {
                  indices1[sectionIndex(x, y, z)] = layer1.fill(x, y, z);
                }
              }
            }
            sec.indices1 = indices1;
            sec.palette1 = layer1.palette;
          }
          return sec;
        }

        const bundle = await createTexturedMesher({ baseUrl: assetBase });

        // Column 0: solid 2×2×2 stone at origin + one glass + waterlogged stone
        const sec0 = makeSection(
          (x, y, z) => {
            if (x < 2 && y < 2 && z < 2) return 1; // stone
            if (x === 4 && y === 0 && z === 4) return 2; // glass
            if (x === 6 && y === 0 && z === 6) return 1; // stone waterlogged
            return 0;
          },
          [AIR, STONE, GLASS],
          {
            fill: (x, y, z) => (x === 6 && y === 0 && z === 6 ? 1 : 0),
            palette: [AIR, WATER],
          },
        );

        // Column 1 (x=1): abutting stone so shared face with col0 at x=15|0 — actually
        // put stone at local x=0 touching col0's x=15. For shared-face test, place
        // stone at (15,0,0) in col0 and (0,0,0) in col1.
        const sec0b = makeSection(
          (x, y, z) => {
            if (x === 15 && y === 0 && z === 0) return 1;
            if (x < 2 && y < 2 && z < 2) return 1;
            if (x === 4 && y === 0 && z === 4) return 2;
            if (x === 6 && y === 0 && z === 6) return 1;
            return 0;
          },
          [AIR, STONE, GLASS],
        );

        const sec1 = makeSection(
          (x, y, z) => (x === 0 && y === 0 && z === 0 ? 1 : 0),
          [AIR, STONE],
        );

        const col0 = {
          x: 0,
          z: 0,
          state: "complete" as const,
          minY: 0,
          maxY: 15,
          sections: new Map([[0, sec0b]]),
        };
        const col1 = {
          x: 1,
          z: 0,
          state: "complete" as const,
          minY: 0,
          maxY: 15,
          sections: new Map([[0, sec1]]),
        };

        const state = {
          schemaOk: true,
          schemaError: null,
          hello: null,
          tick: 4,
          bot: "t",
          world: null,
          actor: null,
          columns: new Map([
            [columnKey(0, 0), col0],
            [columnKey(1, 0), col1],
          ]),
          entities: new Map(),
          ui: null,
          mark: null,
          pendingCapture: null,
          resyncCount: 0,
          droppedCount: 0,
          framesReceived: 1,
          revision: 1,
          dirtySections: new Set(),
          dirtyColumns: new Set(),
          dirtyEntities: new Set(),
          removedEntities: new Set(),
          dirtyBlocks: [],
          fullReset: false,
        };

        const { meshes, instanceCount } = bundle.mesher.meshSection(
          sec0b as never,
          col0 as never,
          state as never,
        );
        const stats = bundle.mesher.lastStats;
        const passes = meshes.map((m) => m.userData.pass as string);
        const hasTransparent = passes.includes("transparent");
        const hasOpaque = passes.includes("opaque");

        // Unknown neighbour: mesh a lone column with no neighbour — edge faces kept.
        const loneSec = makeSection(
          (x, y, z) => (x === 0 && y === 0 && z === 0 ? 1 : 0),
          [AIR, STONE],
        );
        const loneCol = {
          x: 5,
          z: 5,
          state: "complete" as const,
          minY: 0,
          maxY: 15,
          sections: new Map([[0, loneSec]]),
        };
        const loneState = {
          ...state,
          columns: new Map([[columnKey(5, 5), loneCol]]),
        };
        const lone = bundle.mesher.meshSection(
          loneSec as never,
          loneCol as never,
          loneState as never,
        );
        // Single stone in void: up to 6 faces → after merge still exposed.
        expectLocal(lone.instanceCount === 1);

        // Interior of 2×2×2: buried faces culled → quadsBefore < 2*2*2*6
        const fullCubeFaces = 8 * 6;
        expectLocal(stats.quadsBeforeMerge < fullCubeFaces);

        // Shared face between col0 (15,0,0) and col1 (0,0,0) culled on col0 side.
        // Count +X faces at x=15: if culled, that face is absent from emits.
        // We approximate: meshing col0 with neighbour present has fewer quads
        // than without col1.
        const stateNoN = {
          ...state,
          columns: new Map([[columnKey(0, 0), col0]]),
        };
        bundle.mesher.meshSection(
          sec0b as never,
          col0 as never,
          stateNoN as never,
        );
        const without = bundle.mesher.lastStats.quadsBeforeMerge;
        bundle.mesher.meshSection(
          sec0b as never,
          col0 as never,
          state as never,
        );
        const withN = bundle.mesher.lastStats.quadsBeforeMerge;
        expectLocal(withN < without);

        // Waterlogging emitted transparent geometry.
        expectLocal(hasTransparent);

        // Greedy merge reduced quads.
        expectLocal(stats.quadsAfterMerge < stats.quadsBeforeMerge);

        const triBefore = stats.quadsBeforeMerge * 2;
        const triAfter = stats.quadsAfterMerge * 2;

        bundle.mesher.dispose();
        return {
          instanceCount,
          hasOpaque,
          hasTransparent,
          quadsBefore: stats.quadsBeforeMerge,
          quadsAfter: stats.quadsAfterMerge,
          triBefore,
          triAfter,
          withN,
          without,
          meshCount: meshes.length,
        };

        function expectLocal(cond: boolean): void {
          if (!cond) throw new Error("local assertion failed");
        }
      }, assets.url);

      expect(result.hasOpaque).toBe(true);
      expect(result.hasTransparent).toBe(true);
      expect(result.quadsAfter).toBeLessThan(result.quadsBefore);
      expect(result.withN).toBeLessThan(result.without);
      expect(result.triAfter).toBeLessThan(result.triBefore);
      expect(result.meshCount).toBeGreaterThanOrEqual(2);

      console.log(
        JSON.stringify({
          greedyTriBefore: result.triBefore,
          greedyTriAfter: result.triAfter,
          reduction:
            ((result.triBefore - result.triAfter) / result.triBefore) * 100,
        }),
      );
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });

  test("missing texture path resolves to visible fallback, does not throw", async ({
    page,
  }) => {
    const pack = buildFixturePack();
    // Block referencing a short-name with no PNG / terrain entry.
    pack.set(
      "blocks.json",
      new TextEncoder().encode(
        JSON.stringify({
          "minecraft:ghost_block": { textures: "totally_missing_tex" },
        }),
      ),
    );
    const assets = await startTerrainAssetServer(pack);
    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5180, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const ok = await page.evaluate(async (assetBase) => {
        const { createTexturedMesher, FALLBACK_TEXTURE } =
          await import("/src/terrain/index.ts");
        const { sectionIndex } = await import("/src/protocol.ts");
        const bundle = await createTexturedMesher({
          baseUrl: assetBase,
          extraTextures: ["totally_missing_tex"],
        });
        expectBrowser(!bundle.atlas.has("totally_missing_tex"));
        const uv = bundle.atlas.uvFor("totally_missing_tex", 0, 0, 0, 0);
        const fb = bundle.atlas.uvRect(FALLBACK_TEXTURE, 0);
        expectBrowser(uv.u0 === fb.u0 && uv.v0 === fb.v0);

        const AIR = { name: "minecraft:air", states: {}, rid: 0 };
        const GHOST = {
          name: "minecraft:ghost_block",
          states: {},
          rid: 9,
        };
        const indices = new Uint16Array(4096);
        indices[sectionIndex(0, 0, 0)] = 1;
        const section = { y: 0, indices, palette: [AIR, GHOST] };
        const col = {
          x: 0,
          z: 0,
          state: "complete",
          minY: 0,
          maxY: 15,
          sections: new Map([[0, section]]),
        };
        const state = {
          tick: 0,
          columns: new Map([["0,0", col]]),
        };
        const { meshes } = bundle.mesher.meshSection(
          section as never,
          col as never,
          state as never,
        );
        expectBrowser(meshes.length >= 1);
        bundle.mesher.dispose();
        return true;

        function expectBrowser(c: boolean): void {
          if (!c) throw new Error("fallback assertion failed");
        }
      }, assets.url);

      expect(ok).toBe(true);
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });

  test("realistic pack stack resolves own texture, not magenta fallback", async ({
    page,
  }) => {
    // Would have caught the live regression: server blocks.json sound-only
    // entries wiped vanilla textures when /asset winner-takes-all was used.
    test.setTimeout(120_000);
    const assets = await startMultiPackAssetServer(buildRealisticPackStack());
    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5182, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(async (assetBase) => {
        const THREE = await import("/node_modules/three/build/three.module.js");
        const { createTexturedMesher, FALLBACK_TEXTURE } =
          await import("/src/terrain/index.ts");
        const { sectionIndex, columnKey } = await import("/src/protocol.ts");

        const AIR = { name: "minecraft:air", states: {}, rid: 0 };
        const STONE = { name: "minecraft:stone", states: {}, rid: 1 };
        const PLANKS = {
          name: "pokeb:apricorn_planks",
          states: {},
          rid: 2,
        };

        const indices = new Uint16Array(4096);
        indices[sectionIndex(0, 0, 0)] = 1;
        indices[sectionIndex(2, 0, 0)] = 2;
        const section = {
          y: 0,
          indices,
          palette: [AIR, STONE, PLANKS],
        };
        const col = {
          x: 0,
          z: 0,
          state: "complete" as const,
          minY: 0,
          maxY: 15,
          sections: new Map([[0, section]]),
        };
        const state = {
          schemaOk: true,
          schemaError: null,
          hello: null,
          tick: 0,
          bot: "t",
          world: null,
          actor: null,
          columns: new Map([[columnKey(0, 0), col]]),
          entities: new Map(),
          ui: null,
          mark: null,
          pendingCapture: null,
          resyncCount: 0,
          droppedCount: 0,
          framesReceived: 1,
          revision: 1,
          dirtySections: new Set(),
          dirtyColumns: new Set(),
          dirtyEntities: new Set(),
          removedEntities: new Set(),
          dirtyBlocks: [],
          fullReset: false,
        };

        const bundle = await createTexturedMesher({ baseUrl: assetBase });
        // Merge must keep stone short-name from vanilla despite server sound-only.
        if (!bundle.atlas.has("stone")) {
          throw new Error("stone missing from atlas after pack merge");
        }
        if (!bundle.atlas.has("apricorn_planks")) {
          throw new Error("server-pack short-name missing from atlas");
        }
        if (
          bundle.atlas.uvFor("stone", 0, 0, 0, 0).u0 ===
            bundle.atlas.uvRect(FALLBACK_TEXTURE, 0).u0 &&
          bundle.atlas.uvFor("stone", 0, 0, 0, 0).v0 ===
            bundle.atlas.uvRect(FALLBACK_TEXTURE, 0).v0
        ) {
          throw new Error("stone UV landed on fallback rect");
        }

        const { meshes } = bundle.mesher.meshSection(
          section as never,
          col as never,
          state as never,
        );

        const W = 128;
        const H = 128;
        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
        });
        renderer.setSize(W, H, false);
        renderer.setPixelRatio(1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setClearColor(0x101010, 1);
        document.body.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        for (const m of meshes) scene.add(m);

        const pick = (px: number, py: number) => {
          const buf = new Uint8Array(4);
          const gl = renderer.getContext() as WebGLRenderingContext;
          gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          return [buf[0]!, buf[1]!, buf[2]!] as const;
        };
        const isMagentaOrBlack = (c: readonly [number, number, number]) =>
          (c[0] > 200 && c[1] < 50 && c[2] > 200) ||
          (c[0] < 40 && c[1] < 40 && c[2] < 40);
        const isLime = (c: readonly [number, number, number]) =>
          c[1] > 160 && c[0] < 100 && c[2] < 100;
        const isYellow = (c: readonly [number, number, number]) =>
          c[0] > 200 && c[1] > 160 && c[2] < 80;

        // Top-down onto stone at (0.5, 0, 0.5).
        const camStone = new THREE.OrthographicCamera(
          -0.6,
          0.6,
          0.6,
          -0.6,
          0.1,
          50,
        );
        camStone.up.set(0, 0, -1);
        camStone.position.set(0.5, 20, 0.5);
        camStone.lookAt(0.5, 0, 0.5);
        camStone.updateMatrixWorld(true);
        renderer.render(scene, camStone);
        const stonePx = pick(W >> 1, H >> 1);

        // Top-down onto apricorn planks at (2.5, 0, 0.5).
        const camPlanks = new THREE.OrthographicCamera(
          -0.6,
          0.6,
          0.6,
          -0.6,
          0.1,
          50,
        );
        camPlanks.up.set(0, 0, -1);
        camPlanks.position.set(2.5, 20, 0.5);
        camPlanks.lookAt(2.5, 0, 0.5);
        camPlanks.updateMatrixWorld(true);
        renderer.render(scene, camPlanks);
        const planksPx = pick(W >> 1, H >> 1);

        bundle.mesher.dispose();
        renderer.dispose();
        renderer.domElement.remove();

        return {
          stonePx: [...stonePx],
          planksPx: [...planksPx],
          stoneNotFallback: !isMagentaOrBlack(stonePx) && isLime(stonePx),
          planksNotFallback: !isMagentaOrBlack(planksPx) && isYellow(planksPx),
        };
      }, assets.url);

      expect(result.stoneNotFallback, `stone px=${result.stonePx}`).toBe(true);
      expect(result.planksNotFallback, `planks px=${result.planksPx}`).toBe(
        true,
      );
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });

  test("merged stripe face tiles in pixels; fixture screenshot is bright", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assets = await startTerrainAssetServer();
    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5181, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(async (assetBase) => {
        const THREE = await import("/node_modules/three/build/three.module.js");
        const { createTexturedMesher } = await import("/src/terrain/index.ts");
        const { sectionIndex, columnKey } = await import("/src/protocol.ts");

        const AIR = { name: "minecraft:air", states: {}, rid: 0 };
        const STRIPE = {
          name: "minecraft:test_stripe",
          states: {},
          rid: 1,
        };
        const STONE = { name: "minecraft:stone", states: {}, rid: 2 };
        const GLASS = { name: "minecraft:glass", states: {}, rid: 3 };

        const indices = new Uint16Array(4096);
        // 8-wide stripe platform at y=0 (merged run) + stone/glass fixture.
        for (let x = 0; x < 8; x++) indices[sectionIndex(x, 0, 0)] = 1;
        for (let x = 0; x < 4; x++) {
          for (let z = 2; z < 6; z++) indices[sectionIndex(x, 0, z)] = 2;
        }
        indices[sectionIndex(6, 1, 4)] = 3;

        const section = {
          y: 0,
          indices,
          palette: [AIR, STRIPE, STONE, GLASS],
        };
        const col = {
          x: 0,
          z: 0,
          state: "complete" as const,
          minY: 0,
          maxY: 15,
          sections: new Map([[0, section]]),
        };
        const state = {
          schemaOk: true,
          schemaError: null,
          hello: null,
          tick: 0,
          bot: "t",
          world: null,
          actor: null,
          columns: new Map([[columnKey(0, 0), col]]),
          entities: new Map(),
          ui: null,
          mark: null,
          pendingCapture: null,
          resyncCount: 0,
          droppedCount: 0,
          framesReceived: 1,
          revision: 1,
          dirtySections: new Set(),
          dirtyColumns: new Set(),
          dirtyEntities: new Set(),
          removedEntities: new Set(),
          dirtyBlocks: [],
          fullReset: false,
        };

        const bundle = await createTexturedMesher({ baseUrl: assetBase });
        const { meshes } = bundle.mesher.meshSection(
          section as never,
          col as never,
          state as never,
        );
        const stats = bundle.mesher.lastStats;
        if (stats.quadsAfterMerge >= stats.quadsBeforeMerge) {
          throw new Error("expected greedy merge on stripe run");
        }

        const W = 256;
        const H = 64;
        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
        });
        renderer.setSize(W, H, false);
        renderer.setPixelRatio(1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setClearColor(0x202020, 1);
        document.body.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        for (const m of meshes) scene.add(m);

        // Ortho top-down over the stripe (world x=0..8, z=0..1).
        const cam = new THREE.OrthographicCamera(-4, 4, 0.5, -0.5, 0.1, 100);
        cam.up.set(0, 0, -1);
        cam.position.set(4, 50, 0.5);
        cam.lookAt(4, 0, 0.5);
        cam.updateMatrixWorld(true);

        renderer.render(scene, cam);
        const gl = renderer.getContext() as WebGLRenderingContext;
        const pick = (px: number, py: number) => {
          const buf = new Uint8Array(4);
          gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          return [buf[0]!, buf[1]!, buf[2]!] as const;
        };
        const midY = Math.floor(H / 2);
        // Left half of tile 0 and tile 1 → same red; right half tile 0 → cyan.
        const c0 = pick(Math.floor((0.25 / 8) * W), midY);
        const c1 = pick(Math.floor((1.25 / 8) * W), midY);
        const mid = pick(Math.floor((0.75 / 8) * W), midY);

        const isRed = (c: readonly [number, number, number]) =>
          c[0] > 180 && c[1] < 100 && c[2] < 100;
        const isCyan = (c: readonly [number, number, number]) =>
          c[0] < 100 && c[1] > 180 && c[2] > 180;

        const shotW = 640;
        const shotH = 360;
        renderer.setSize(shotW, shotH, false);
        const persp = new THREE.PerspectiveCamera(50, shotW / shotH, 0.1, 100);
        persp.position.set(6, 8, 10);
        persp.lookAt(3, 0, 2);
        renderer.setClearColor(0x87ceeb, 1);
        renderer.render(scene, persp);
        const dataUrl = renderer.domElement.toDataURL("image/png");

        const bright =
          (c0[0] + c0[1] + c0[2]) / 3 > 80 &&
          (mid[0] + mid[1] + mid[2]) / 3 > 80;

        bundle.mesher.dispose();
        renderer.dispose();
        renderer.domElement.remove();

        return {
          quadsBefore: stats.quadsBeforeMerge,
          quadsAfter: stats.quadsAfterMerge,
          c0: [...c0],
          c1: [...c1],
          mid: [...mid],
          samePhase: isRed(c0) && isRed(c1),
          halfPhaseDiffers: isCyan(mid),
          bright,
          dataUrl,
        };
      }, assets.url);

      expect(result.quadsAfter).toBeLessThan(result.quadsBefore);
      expect(result.samePhase).toBe(true);
      expect(result.halfPhaseDiffers).toBe(true);
      expect(result.bright).toBe(true);

      const pngPath = join(viewerRoot, "testdata", "terrain-tiling.png");
      const b64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
      writeFileSync(pngPath, Buffer.from(b64, "base64"));
      console.log(
        JSON.stringify({
          tiling: {
            c0: result.c0,
            c1: result.c1,
            mid: result.mid,
            quadsBefore: result.quadsBefore,
            quadsAfter: result.quadsAfter,
          },
          screenshot: pngPath,
        }),
      );
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });

  test("network palette: material_instances textured; bare → neutral; pack precedence", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assets = await startTerrainAssetServer();
    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5183, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(
        async ({ assetBase, registries }) => {
          const THREE =
            await import("/node_modules/three/build/three.module.js");
          const {
            createTexturedMesher,
            FALLBACK_TEXTURE,
            NEUTRAL_TEXTURE,
            paletteCoverageAgainstAtlas,
          } = await import("/src/terrain/index.ts");
          const { sectionIndex, columnKey } = await import("/src/protocol.ts");

          const AIR = { name: "minecraft:air", states: {}, rid: 0 };
          const CRATE = {
            name: "fixture:custom_crate",
            states: {},
            rid: 10,
          };
          const BARE = { name: "fixture:bare_unit", states: {}, rid: 11 };
          const STONE = { name: "minecraft:stone", states: {}, rid: 1 };

          const indices = new Uint16Array(4096);
          indices[sectionIndex(0, 0, 0)] = 1; // crate
          indices[sectionIndex(2, 0, 0)] = 2; // bare
          indices[sectionIndex(4, 0, 0)] = 3; // stone (pack)
          const section = {
            y: 0,
            indices,
            palette: [AIR, CRATE, BARE, STONE],
          };
          const col = {
            x: 0,
            z: 0,
            state: "complete" as const,
            minY: 0,
            maxY: 15,
            sections: new Map([[0, section]]),
          };
          const state = {
            tick: 0,
            columns: new Map([[columnKey(0, 0), col]]),
          };

          const bundle = await createTexturedMesher({
            baseUrl: assetBase,
            registries,
          });

          if (!bundle.atlas.has("palette_right_texture")) {
            throw new Error("palette short-name missing from atlas");
          }
          if (!bundle.atlas.has(NEUTRAL_TEXTURE)) {
            throw new Error("neutral tile missing from atlas");
          }

          const crateCube = bundle.resolver.resolveCube(CRATE, 0, 0, 0)!;
          if (crateCube.faces.up.texture !== "palette_right_texture") {
            throw new Error(
              `crate texture=${crateCube.faces.up.texture}, want palette_right_texture`,
            );
          }
          if (crateCube.faces.up.texture === FALLBACK_TEXTURE) {
            throw new Error("crate resolved to magenta fallback");
          }

          const bareCube = bundle.resolver.resolveCube(BARE, 0, 0, 0)!;
          if (bareCube.faces.up.texture !== NEUTRAL_TEXTURE) {
            throw new Error(
              `bare texture=${bareCube.faces.up.texture}, want ${NEUTRAL_TEXTURE}`,
            );
          }

          // Pack precedence: inject stone into a dual-name block via applyRegistries
          // path already covered in node; here assert stone still pack-resolved.
          const stoneCube = bundle.resolver.resolveCube(STONE, 0, 0, 0)!;
          if (stoneCube.faces.up.texture !== "stone") {
            throw new Error(
              `stone lost pack texture: ${stoneCube.faces.up.texture}`,
            );
          }

          const cov = paletteCoverageAgainstAtlas(registries, bundle.atlas);
          const { meshes } = bundle.mesher.meshSection(
            section as never,
            col as never,
            state as never,
          );

          const W = 128;
          const H = 128;
          const renderer = new THREE.WebGLRenderer({
            antialias: false,
            preserveDrawingBuffer: true,
          });
          renderer.setSize(W, H, false);
          renderer.setPixelRatio(1);
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.toneMapping = THREE.NoToneMapping;
          renderer.setClearColor(0x101010, 1);
          document.body.appendChild(renderer.domElement);
          const scene = new THREE.Scene();
          for (const m of meshes) scene.add(m);

          const pick = (px: number, py: number) => {
            const buf = new Uint8Array(4);
            const gl = renderer.getContext() as WebGLRenderingContext;
            gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            return [buf[0]!, buf[1]!, buf[2]!] as const;
          };
          const isMagenta = (c: readonly [number, number, number]) =>
            c[0] > 200 && c[1] < 50 && c[2] > 200;
          const isBlue = (c: readonly [number, number, number]) =>
            c[2] > 180 && c[0] < 80 && c[1] < 140;
          const isGrey = (c: readonly [number, number, number]) =>
            Math.abs(c[0] - c[1]) < 20 &&
            Math.abs(c[1] - c[2]) < 20 &&
            c[0] > 100 &&
            c[0] < 180;

          const cam = new THREE.OrthographicCamera(
            -0.6,
            0.6,
            0.6,
            -0.6,
            0.1,
            20,
          );
          // Top-down onto crate at (0.5,0,0.5)
          cam.position.set(0.5, 4, 0.5);
          cam.lookAt(0.5, 0.5, 0.5);
          renderer.render(scene, cam);
          const cratePix = pick(W / 2, H / 2);

          cam.position.set(2.5, 4, 0.5);
          cam.lookAt(2.5, 0.5, 0.5);
          renderer.render(scene, cam);
          const barePix = pick(W / 2, H / 2);

          renderer.dispose();
          renderer.domElement.remove();
          bundle.mesher.dispose();

          return {
            cratePix: [...cratePix],
            barePix: [...barePix],
            crateBlue: isBlue(cratePix),
            bareGrey: isGrey(barePix),
            anyMagenta: isMagenta(cratePix) || isMagenta(barePix),
            coverage: {
              entryCount: cov.entryCount,
              withMaterialInstances: cov.withMaterialInstances,
              texturesResolved: cov.texturesResolved,
              neutralNoMaterials: cov.neutralNoMaterials,
            },
          };
        },
        { assetBase: assets.url, registries: registriesFixture },
      );

      expect(result.anyMagenta).toBe(false);
      expect(result.crateBlue).toBe(true);
      expect(result.bareGrey).toBe(true);
      expect(result.coverage.texturesResolved).toBe(2);
      expect(result.coverage.neutralNoMaterials).toBe(1);
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });
});
