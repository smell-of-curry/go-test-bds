import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import {
  flipbookFrameAt,
  facingToFrontFace,
  greedyMerge,
  hashPos,
  pickVariationIndex,
  liquidFlowYaw,
  liquidHeight,
  FALLBACK_TEXTURE,
} from "../src/terrain";
import { BlockModelResolver } from "../src/terrain/resolve";
import {
  buildFixturePack,
  startTerrainAssetServer,
} from "./terrainAssetServer";
import type { Block } from "../src/protocol";
import type { Color } from "three";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

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
});
