import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import {
  applyEntityYaw,
  expandShortRef,
  isClientEntityPath,
  isRenderControllerPath,
  parseClientEntity,
  parseRenderControllers,
  resolveRenderPasses,
  selectControllers,
} from "../src/entity";
import { encodePng, startMultiPackAssetServer } from "./terrainAssetServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const fixtures = join(viewerRoot, "testdata", "entity");

/**
 * @param name - Fixture file under testdata/entity.
 * @returns parsed JSON.
 */
function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

test.describe("entity parsers (node)", () => {
  test("parses client entity description maps and controller list", () => {
    const def = parseClientEntity(loadJson("simple.entity.json"));
    expect(def).not.toBeNull();
    expect(def!.identifier).toBe("test:blocky");
    expect(def!.geometry.default).toBe("geometry.test.blocky");
    expect(def!.textures.alt).toBe("textures/entity/blocky_alt");
    expect(def!.renderControllers).toEqual([
      { name: "controller.render.blocky" },
    ]);
  });

  test("render controller Array.skins indexes by Molang property", () => {
    const def = parseClientEntity(loadJson("simple.entity.json"))!;
    const controllers = parseRenderControllers(loadJson("blocky.rc.json"));
    expect(controllers.has("controller.render.blocky")).toBe(true);

    const pass0 = resolveRenderPasses(def, controllers, {
      type: "test:blocky",
      player: false,
      props: { "pokeb:skin_index": 0 },
      flags: {},
    });
    expect(pass0).toHaveLength(1);
    expect(pass0[0]!.geometryId).toBe("geometry.test.blocky");
    expect(pass0[0]!.texturePaths).toEqual(["textures/entity/blocky"]);

    const pass1 = resolveRenderPasses(def, controllers, {
      type: "test:blocky",
      player: false,
      props: { "pokeb:skin_index": 1 },
      flags: {},
    });
    expect(pass1[0]!.texturePaths).toEqual(["textures/entity/blocky_alt"]);
  });

  test("conditioned render controllers pick the matching entry", () => {
    const def = parseClientEntity({
      "minecraft:client_entity": {
        description: {
          identifier: "test:cond",
          materials: { default: "entity_alphatest" },
          textures: { default: "textures/entity/blocky" },
          geometry: { default: "geometry.test.blocky" },
          render_controllers: [
            { "controller.render.a": "query.variant == 0" },
            { "controller.render.b": "query.variant == 1" },
          ],
        },
      },
    })!;
    expect(
      selectControllers(def, {
        type: "test:cond",
        player: false,
        props: {},
        flags: {},
        variant: 1,
      }),
    ).toEqual(["controller.render.b"]);
  });

  test("expandShortRef maps Geometry./Texture. through client maps", () => {
    const def = parseClientEntity(loadJson("simple.entity.json"))!;
    expect(expandShortRef("Geometry.default", def, "geometry")).toBe(
      "geometry.test.blocky",
    );
    expect(expandShortRef("Texture.alt", def, "texture")).toBe(
      "textures/entity/blocky_alt",
    );
  });

  test("pack-index path filters match entity + render_controllers", () => {
    expect(isClientEntityPath("entity/pokemon/jynx.entity.json")).toBe(true);
    expect(isClientEntityPath("models/entity/jynx.geo.json")).toBe(false);
    expect(isRenderControllerPath("render_controllers/pokemon.json")).toBe(
      true,
    );
    expect(isRenderControllerPath("entity/foo.json")).toBe(false);
  });

  test("bedrock yaw 0 faces +Z; yaw 90 turns toward −X", () => {
    // Mirror camera.ts convention without importing three in a heavy way —
    // applyEntityYaw sets rotation.y = π − yawRad.
    const fake = {
      rotation: { order: "", x: 0, y: 0, z: 0 },
    };
    applyEntityYaw(fake as never, 0);
    expect(fake.rotation.y).toBeCloseTo(Math.PI, 5);
    applyEntityYaw(fake as never, 90);
    expect(fake.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });
});

test.describe("entity model (browser)", () => {
  test("fixture entity paints non-background pixels at expected coords", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const json = (obj: unknown) =>
      new TextEncoder().encode(JSON.stringify(obj));
    // Bright magenta 8×8 skin — distinct from sky clear.
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i++) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = 255;
    }
    const skin = encodePng(8, 8, rgba);

    const files = new Map<string, Uint8Array>();
    const set = (path: string, data: Uint8Array) =>
      files.set(path.toLowerCase(), data);
    set(
      "entity/blocky.entity.json",
      new Uint8Array(readFileSync(join(fixtures, "simple.entity.json"))),
    );
    set(
      "render_controllers/blocky.rc.json",
      new Uint8Array(readFileSync(join(fixtures, "blocky.rc.json"))),
    );
    // Heuristic: geometry.test.blocky → models/entity/test.blocky.geo.json
    set(
      "models/entity/test.blocky.geo.json",
      new Uint8Array(readFileSync(join(fixtures, "blocky.geo.json"))),
    );
    set("textures/entity/blocky.png", skin);
    set("textures/entity/blocky_alt.png", skin);
    set("blocks.json", json({ format_version: ["1", "1", "0"] }));

    const assets = await startMultiPackAssetServer([
      { id: "vanilla", priority: 0, name: "entity-fixture", files },
    ]);

    let devServer: ViteDevServer | undefined;
    try {
      devServer = await createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { host: "127.0.0.1", port: 5188, strictPort: false },
      });
      await devServer.listen();
      const base = devServer.resolvedUrls?.local[0];
      if (!base) throw new Error("no vite url");
      await page.goto(base, { waitUntil: "domcontentloaded" });

      const result = await page.evaluate(async (assetBase) => {
        const THREE = await import("/node_modules/three/build/three.module.js");
        const { EntityModelRegistry } = await import("/src/entity/index.ts");
        const { AssetClient } = await import("/src/terrain/assetClient.ts");
        const { applyEntityYaw } = await import("/src/entity/buildModel.ts");

        const client = new AssetClient(assetBase);
        const registry = new EntityModelRegistry(client);
        await registry.load();

        const def = registry.getClientEntity("test:blocky");
        if (!def) return { ok: false, reason: "missing client def" };

        const model = await registry.getModel({
          type: "test:blocky",
          player: false,
          props: { "pokeb:skin_index": 0 },
          flags: {},
        });
        if (!model) return { ok: false, reason: "model null" };

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87ceeb);
        // Orthographic top/side view onto the body cube (y 0..0.5 blocks).
        applyEntityYaw(model.root, 180);
        model.root.position.set(0, 0, 0);
        scene.add(model.root);

        const camera = new THREE.OrthographicCamera(
          -0.6,
          0.6,
          0.6,
          -0.6,
          0.1,
          50,
        );
        camera.position.set(0, 0.25, 3);
        camera.lookAt(0, 0.25, 0);

        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
        });
        renderer.setSize(128, 128, false);
        renderer.setPixelRatio(1);
        renderer.setClearColor(0x87ceeb, 1);
        document.body.appendChild(renderer.domElement);
        renderer.render(scene, camera);

        const gl = renderer.getContext() as WebGLRenderingContext;
        const pick = (px: number, py: number) => {
          const buf = new Uint8Array(4);
          // WebGL origin is bottom-left.
          gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          return [buf[0]!, buf[1]!, buf[2]!] as const;
        };

        // Centre of frame should hit the magenta body, not sky blue.
        const centre = pick(64, 64);
        const corner = pick(2, 125);
        const boneNames = [...model.bones.keys()].sort();

        model.dispose();
        renderer.dispose();
        return {
          ok: true,
          centre,
          corner,
          boneNames,
        };
      }, assets.url);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.boneNames).toEqual(["body", "head"]);
      // Centre: magenta skin, not sky.
      expect(result.centre[0]).toBeGreaterThan(200);
      expect(result.centre[2]).toBeGreaterThan(200);
      expect(result.centre[1]).toBeLessThan(80);
      // Corner stays near sky blue (more blue than red).
      expect(result.corner[2]).toBeGreaterThan(result.corner[0]!);
    } finally {
      await page.close().catch(() => undefined);
      await devServer?.close();
      await assets.close();
    }
  });
});
