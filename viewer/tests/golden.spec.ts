/**
 * Stage 12 — visual regression goldens against the deterministic fixture stream.
 *
 * Shots (1280×720, SwiftShader Chromium):
 *   overview  — camera=orbit (default yaw/pitch/distance)
 *   terrain   — camera=firstPerson (eye aimed at textured netherrack wall)
 *   entity    — orbit nudged via __viewerInternals toward the magma cube
 *
 * Gate: schemaOk && assetsSettled → flush() → settled (same as capture harness).
 *
 * Env:
 *   GOLDEN_UPDATE=1  rewrite viewer/testdata/goldens/*.png
 *   GOLDEN_SOFT=1    report diffs, do not fail (local GPU ≠ CI SwiftShader)
 *
 * Goldens must be regenerated on CI's SwiftShader stack to be stable; Windows
 * GPU stills will differ slightly — use GOLDEN_SOFT locally or update from CI.
 */
import { expect, test, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGoldenApp, type GoldenApp } from "./goldenApp";
import { assertGolden } from "./goldenCompare";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const goldensDir = join(viewerRoot, "testdata", "goldens");
const resultsDir = join(viewerRoot, "test-results", "golden");

const VIEWPORT = { width: 1280, height: 720 } as const;

test.use({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
});

interface Shot {
  name: string;
  /** Appended to the app URL (leading &…). */
  cameraQuery: string;
  /**
   * Optional post-settle camera nudge. Prefer URL params; entity needs
   * internals because debug handle exposes mode read-only only.
   */
  setup?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    name: "overview",
    cameraQuery: "camera=orbit",
  },
  {
    name: "terrain",
    cameraQuery: "camera=firstPerson",
  },
  {
    name: "entity",
    cameraQuery: "camera=orbit",
    // Magma cube at ~[4,4,4]; actor at [7.5,4,7.5]. Pull orbit in and yaw
    // toward −X/−Z so the placeholder entity fills the frame.
    setup: async (page) => {
      await page.evaluate(() => {
        const cam = window.__viewerInternals?.camera as
          | {
              setMode: (m: string) => void;
              orbitYaw: number;
              orbitPitch: number;
              orbitDistance: number;
            }
          | undefined;
        if (!cam) throw new Error("__viewerInternals.camera missing");
        cam.setMode("orbit");
        cam.orbitYaw = Math.PI * 0.85;
        cam.orbitPitch = 0.45;
        cam.orbitDistance = 5.5;
      });
      // One rAF so CameraController.update applies the new orbit.
      await page.waitForTimeout(50);
    },
  },
];

/**
 * Wait for schema + assets, drain remesh, wait settled — capture harness gate.
 *
 * @param page - Playwright page.
 */
async function waitForCaptureReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      return !!v && v.schemaOk && v.tick === 200 && v.assetsSettled;
    },
    undefined,
    { timeout: 45_000 },
  );
  await page.evaluate(() => window.__viewer?.flush());
  await page.waitForFunction(
    () => window.__viewer?.settled === true,
    undefined,
    {
      timeout: 15_000,
    },
  );
}

test.describe("golden images", () => {
  let app: GoldenApp | undefined;

  test.beforeAll(async () => {
    app = await startGoldenApp();
  });

  test.afterAll(async () => {
    await app?.close();
    app = undefined;
  });

  for (const shot of SHOTS) {
    test(`shot: ${shot.name}`, async ({ page }) => {
      if (!app) throw new Error("golden app not started");

      const url =
        `${app.url}/?stream=${encodeURIComponent(app.streamUrl)}` +
        `&${shot.cameraQuery}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForCaptureReady(page);

      const mode = await page.evaluate(() => window.__viewer!.cameraMode);
      if (shot.name === "overview" || shot.name === "entity") {
        expect(mode).toBe("orbit");
      } else {
        expect(mode).toBe("firstPerson");
      }

      const entityCount = await page.evaluate(
        () => window.__viewer!.entityCount,
      );
      expect(entityCount).toBe(1);

      if (shot.setup) await shot.setup(page);
      // Allow one paint after camera nudge / settle.
      await page.waitForTimeout(100);

      const png = await page.screenshot({
        type: "png",
        animations: "disabled",
      });
      expect(png.length).toBeGreaterThan(5_000);

      assertGolden({
        name: shot.name,
        goldenPath: join(goldensDir, `${shot.name}.png`),
        resultsDir,
        actual: png,
      });
    });
  }
});
