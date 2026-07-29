/**
 * Entity model golden renders — the regression suite for the two production
 * bugs shown in the showcase captures:
 *
 * - Bulbasaur (custom pack geometry) scrambled into a voxel mess because
 *   animation poses rotated bones about the model origin instead of the bone
 *   pivot. Rendered here from the real pokebedrock-res assets (fixtures under
 *   `testdata/entity/bulbasaur/`) with a pack animation applied.
 * - The bot player rendered as a degenerate blob instead of the Steve
 *   humanoid. Rendered here from the bedrock-samples baseline (skipped when no
 *   baseline cache is present) mid walk-cycle.
 *
 * Goldens: viewer/testdata/goldens/{bulbasaur,player-walk}.png. Regenerate with
 * GOLDEN_UPDATE=1; GOLDEN_SOFT=1 reports without failing. Structural pixel
 * assertions run regardless of golden mode so a GPU-rasterizer drift can never
 * hide a real scramble.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { resolveGoldenBaselineDir } from "./goldenApp";
import { assertGolden, decodePng } from "./goldenCompare";
import {
  startMultiPackAssetServer,
  type TerrainAssetServer,
} from "./terrainAssetServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const fixtures = join(viewerRoot, "testdata", "entity");
const goldensDir = join(viewerRoot, "testdata", "goldens");
const resultsDir = join(viewerRoot, "test-results", "entity-golden");

/** Sky-blue clear colour (must match the in-page renderer clear). */
const SKY = [135, 206, 235] as const;

interface ShotRequest {
  /** Entity snapshot fields the registry/resolve context reads. */
  ent: {
    type: string;
    player: boolean;
    props: Record<string, number>;
    flags: Record<string, boolean>;
  };
  /** Pack animation id to sample at a fixed time (pivot-path coverage). */
  packAnim?: { id: string; time: number };
  /** Drive the procedural walk cycle at this horizontal speed (blocks/s). */
  walkSpeed?: number;
  /** Body yaw degrees. */
  yaw: number;
  /** Camera boom: yaw/pitch degrees around the model bounds. */
  camYawDeg: number;
  camPitchDeg: number;
}

interface ShotResult {
  ok: boolean;
  reason?: string;
  boneNames?: string[];
  pngBase64?: string;
}

/**
 * Render one entity model to a 320×320 PNG inside the page.
 *
 * @param page - Playwright page (any origin with vite serving /src).
 * @param assetBase - Fixture asset server URL.
 * @param req - Entity + pose + camera description.
 * @returns bone names and PNG bytes, or a failure reason.
 */
async function renderShot(
  page: Page,
  assetBase: string,
  req: ShotRequest,
): Promise<ShotResult> {
  return page.evaluate(
    async ({ assetBase, req }) => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const {
        EntityModelRegistry,
        applyBonePoses,
        applyEntityYaw,
        addLocomotionPoses,
        createLocomotion,
        tickLocomotion,
        sampleAnimationPoses,
      } = await import("/src/entity/index.ts");
      const { AssetClient } = await import("/src/terrain/assetClient.ts");
      const { createDefaultHost } = await import("/src/molang/host.ts");

      const client = new AssetClient(assetBase);
      const registry = new EntityModelRegistry(client);
      await registry.load();

      const model = await registry.getModel(req.ent as never);
      if (!model) return { ok: false, reason: "model null" };

      // Pose: fixed-time pack animation sample and/or procedural walk cycle.
      const poses = req.packAnim
        ? (() => {
            const anim = registry.getAnimation(req.packAnim.id);
            if (!anim) return null;
            return sampleAnimationPoses(
              anim,
              req.packAnim.time,
              createDefaultHost(),
            );
          })()
        : new Map();
      if (!poses) return { ok: false, reason: `missing ${req.packAnim!.id}` };
      if (req.walkSpeed) {
        const loco = createLocomotion();
        for (let i = 0; i < 40; i++) {
          tickLocomotion(loco, 0.05, req.walkSpeed, 0);
        }
        loco.phase = Math.PI / 2; // full stride for a deterministic pose
        addLocomotionPoses(loco, model.bones.keys(), poses);
      }
      applyBonePoses(model.bones, poses, 0);
      applyEntityYaw(model.root, req.yaw);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x87ceeb);
      scene.add(model.root);
      model.root.updateMatrixWorld(true);

      // Frame the model bounds from a yaw/pitch boom.
      const box = new THREE.Box3().setFromObject(model.root);
      if (box.isEmpty()) return { ok: false, reason: "empty bounds" };
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.72;
      const yawR = (req.camYawDeg * Math.PI) / 180;
      const pitchR = (req.camPitchDeg * Math.PI) / 180;
      const dist = radius * 2.6;
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
      camera.position.set(
        centre.x + dist * Math.cos(pitchR) * Math.sin(yawR),
        centre.y + dist * Math.sin(pitchR),
        centre.z + dist * Math.cos(pitchR) * Math.cos(yawR),
      );
      camera.lookAt(centre);

      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      renderer.setSize(320, 320, false);
      renderer.setPixelRatio(1);
      document.body.appendChild(renderer.domElement);
      renderer.render(scene, camera);

      const dataUrl = renderer.domElement.toDataURL("image/png");
      const boneNames = [...model.bones.keys()].sort();
      model.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      return {
        ok: true,
        boneNames,
        pngBase64: dataUrl.slice("data:image/png;base64,".length),
      };
    },
    { assetBase, req },
  );
}

/** Pixel stats over a rendered shot (background = sky clear colour). */
interface PixelStats {
  /** Fraction of non-sky pixels 0..1. */
  coverage: number;
  /** Mean RGB over non-sky pixels. */
  mean: [number, number, number];
}

/**
 * @param png - PNG bytes.
 * @returns coverage + mean colour of non-background pixels.
 */
function pixelStats(png: Buffer): PixelStats {
  const img = decodePng(png);
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    const r = img.data[o]!;
    const g = img.data[o + 1]!;
    const b = img.data[o + 2]!;
    const sky =
      Math.abs(r - SKY[0]) <= 6 &&
      Math.abs(g - SKY[1]) <= 6 &&
      Math.abs(b - SKY[2]) <= 6;
    if (sky) continue;
    n++;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
  }
  const total = img.width * img.height;
  return {
    coverage: n / total,
    mean: n
      ? [sum[0]! / n, sum[1]! / n, sum[2]! / n]
      : [SKY[0], SKY[1], SKY[2]],
  };
}

/**
 * Read a fixture file into an asset-server pack map.
 *
 * @param files - Destination map (lowercased keys).
 * @param packPath - Pack-relative destination path.
 * @param absPath - Source file.
 */
function put(
  files: Map<string, Uint8Array>,
  packPath: string,
  absPath: string,
): void {
  files.set(packPath.toLowerCase(), new Uint8Array(readFileSync(absPath)));
}

/** Bulbasaur fixture pack laid out the way the registry indexes packs. */
function bulbasaurPack(): Map<string, Uint8Array> {
  const dir = join(fixtures, "bulbasaur");
  const files = new Map<string, Uint8Array>();
  put(
    files,
    "entity/bulbasaur.entity.json",
    join(dir, "bulbasaur.entity.json"),
  );
  put(
    files,
    "render_controllers/pokemon.rc.json",
    join(dir, "pokemon.rc.json"),
  );
  put(
    files,
    "animation_controllers/pokemon.ac.json",
    join(dir, "pokemon.ac.json"),
  );
  put(
    files,
    "animations/bulbasaur.animation.json",
    join(dir, "bulbasaur.animation.json"),
  );
  put(
    files,
    "animations/look_at_target.animation.json",
    join(dir, "look_at_target.animation.json"),
  );
  put(
    files,
    "models/entity/bulbasaur.geo.json",
    join(dir, "bulbasaur.geo.json"),
  );
  put(
    files,
    "textures/entity/pokemon/bulbasaur/bulbasaur.png",
    join(dir, "bulbasaur.png"),
  );
  files.set(
    "blocks.json",
    new TextEncoder().encode(
      JSON.stringify({ format_version: ["1", "1", "0"] }),
    ),
  );
  return files;
}

/**
 * Player pack from the extracted bedrock-samples baseline.
 *
 * @param baselineDir - Extracted samples root (has resource_pack/).
 * @returns pack map, or null when a needed file is missing.
 */
function playerPack(baselineDir: string): Map<string, Uint8Array> | null {
  const rp = join(baselineDir, "resource_pack");
  const files = new Map<string, Uint8Array>();
  const needed: Array<[string, string]> = [
    ["entity/player.entity.json", "entity/player.entity.json"],
    [
      "models/entity/humanoid.custom.geo.json",
      "models/entity/humanoid.custom.geo.json",
    ],
    [
      "render_controllers/player.render_controllers.json",
      "render_controllers/player.render_controllers.json",
    ],
    [
      "animations/humanoid.animation.json",
      "animations/humanoid.animation.json",
    ],
    ["textures/entity/steve.png", "textures/entity/steve.png"],
  ];
  for (const [dst, src] of needed) {
    const abs = join(rp, src);
    if (!existsSync(abs)) return null;
    put(files, dst, abs);
  }
  files.set(
    "blocks.json",
    new TextEncoder().encode(
      JSON.stringify({ format_version: ["1", "1", "0"] }),
    ),
  );
  return files;
}

test.describe("entity model goldens (browser)", () => {
  let devServer: ViteDevServer | undefined;
  let base: string | undefined;

  test.beforeAll(async () => {
    devServer = await createServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 5189, strictPort: false },
    });
    await devServer.listen();
    base = devServer.resolvedUrls?.local[0];
    if (!base) throw new Error("no vite url");
  });

  test.afterAll(async () => {
    await devServer?.close();
    devServer = undefined;
  });

  test("bulbasaur renders the pack model, not a scramble", async ({ page }) => {
    test.setTimeout(120_000);
    let assets: TerrainAssetServer | undefined;
    try {
      assets = await startMultiPackAssetServer([
        {
          id: "server",
          priority: 1,
          name: "pokebedrock",
          files: bulbasaurPack(),
        },
      ]);
      await page.goto(base!, { waitUntil: "domcontentloaded" });

      const shot = await renderShot(page, assets.url, {
        ent: {
          type: "pokemon:bulbasaur",
          player: false,
          props: { "pokeb:shiny": 0, "pokeb:skin_index": 0 },
          flags: {},
        },
        // Idle keyframe mid-cycle: head dips, vine whips rotate — exercises the
        // pivot path that used to scramble the model.
        packAnim: { id: "animation.bulbasaur.ground_idle", time: 1 },
        yaw: 0,
        camYawDeg: 205,
        camPitchDeg: 18,
      });
      expect(shot.ok, shot.reason).toBe(true);
      expect(shot.boneNames).toContain("head");
      expect(shot.boneNames).toContain("body");
      expect(shot.boneNames).toContain("vinewhip_left");

      const png = Buffer.from(shot.pngBase64!, "base64");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, "bulbasaur.last.png"), png);
      const stats = pixelStats(png);
      // Bounds include the idle-curled vine whips, so the body itself is a
      // modest share of the framed shot; a scramble scatters cubes across huge
      // bounds → far smaller coverage; a missing texture is magenta.
      expect(stats.coverage).toBeGreaterThan(0.04);
      expect(stats.coverage).toBeLessThan(0.85);
      // Bulbasaur reads teal-green: mean green channel dominates red.
      expect(stats.mean[1]).toBeGreaterThan(stats.mean[0]);
      // The bulb / leaf spots are saturated green — wrong UVs lose them.
      const img = decodePng(png);
      let bulb = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        const o = i * 4;
        if (
          img.data[o + 1]! - img.data[o + 2]! > 60 &&
          img.data[o + 1]! > img.data[o]!
        ) {
          bulb++;
        }
      }
      expect(bulb).toBeGreaterThan(100);

      assertGolden({
        name: "bulbasaur",
        goldenPath: join(goldensDir, "bulbasaur.png"),
        resultsDir,
        actual: png,
      });
    } finally {
      await assets?.close();
    }
  });

  test("player renders as the Steve humanoid mid walk-cycle", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const baselineDir = resolveGoldenBaselineDir();
    test.skip(!baselineDir, "no bedrock-samples baseline cache");
    const files = playerPack(baselineDir!);
    test.skip(!files, "baseline missing player assets");

    let assets: TerrainAssetServer | undefined;
    try {
      assets = await startMultiPackAssetServer([
        { id: "vanilla", priority: 0, name: "baseline", files: files! },
      ]);
      await page.goto(base!, { waitUntil: "domcontentloaded" });

      const shot = await renderShot(page, assets.url, {
        ent: { type: "minecraft:player", player: true, props: {}, flags: {} },
        walkSpeed: 3,
        yaw: 0,
        camYawDeg: 335,
        camPitchDeg: 12,
      });
      expect(shot.ok, shot.reason).toBe(true);
      // The player-fallback regression: a full humanoid rig must come back.
      for (const bone of [
        "head",
        "body",
        "leftArm",
        "rightArm",
        "leftLeg",
        "rightLeg",
      ]) {
        expect(shot.boneNames, `bone ${bone}`).toContain(bone);
      }

      const png = Buffer.from(shot.pngBase64!, "base64");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, "player-walk.last.png"), png);
      const stats = pixelStats(png);
      expect(stats.coverage).toBeGreaterThan(0.1);
      expect(stats.coverage).toBeLessThan(0.8);

      assertGolden({
        name: "player-walk",
        goldenPath: join(goldensDir, "player-walk.png"),
        resultsDir,
        actual: png,
      });
    } finally {
      await assets?.close();
    }
  });
});
