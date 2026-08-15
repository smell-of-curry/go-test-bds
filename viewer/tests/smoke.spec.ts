import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import type { ViewerHandle } from "../src/debug";
import { startFixtureServer } from "./fixtureServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const smokePng = join(viewerRoot, "test-results", "smoke.png");

interface Expected {
  blockInstanceCount: number;
  sectionMeshCount: number;
  columnCount: number;
  entityCount: number;
  tick: number;
  dimension: number;
  schemaOk: boolean;
  resyncCount: number;
  frames: string[];
}

const expected = JSON.parse(
  readFileSync(join(viewerRoot, "testdata", "expected.json"), "utf8"),
) as Expected;

async function waitForSettled(
  page: Page,
): Promise<Omit<ViewerHandle, "flush" | "settled"> & { settled: boolean }> {
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      // assetsSettled: ready or failed. Fixture has no /packs → fail-fast
      // placeholder path; still must settle before counting the scene.
      return !!v && v.schemaOk && v.tick === 200 && v.assetsSettled;
    },
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(() => window.__viewer?.flush());
  await page.waitForFunction(() => window.__viewer?.settled === true);

  return page.evaluate(() => {
    const v = window.__viewer!;
    return {
      blockInstanceCount: v.blockInstanceCount,
      sectionMeshCount: v.sectionMeshCount,
      columnCount: v.columnCount,
      entityCount: v.entityCount,
      tick: v.tick,
      dimension: v.dimension,
      schemaOk: v.schemaOk,
      resyncCount: v.resyncCount,
      settled: v.settled,
    };
  });
}

test("viewer smoke: fixture stream yields exact scene counts", async ({
  page,
}) => {
  const fixture = await startFixtureServer();
  let devServer: ViteDevServer | undefined;
  try {
    devServer = await createServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 5174, strictPort: false },
    });
    await devServer.listen();
    const base = devServer.resolvedUrls?.local[0];
    if (!base) throw new Error("vite dev server has no local URL");

    const appUrl = `${base}?stream=${encodeURIComponent(fixture.streamUrl)}`;
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });

    const got = await waitForSettled(page);

    expect(got.schemaOk).toBe(expected.schemaOk);
    expect(got.tick).toBe(expected.tick);
    expect(got.dimension).toBe(expected.dimension);
    expect(got.resyncCount).toBe(expected.resyncCount);
    expect(got.columnCount).toBe(expected.columnCount);
    expect(got.entityCount).toBe(expected.entityCount);
    expect(got.sectionMeshCount).toBe(expected.sectionMeshCount);
    expect(got.blockInstanceCount).toBe(expected.blockInstanceCount);

    // Stay in first-person (aimed at the netherrack wall) for a readable still.
    await page.waitForTimeout(200);

    const shot = await page.screenshot({ type: "png" });
    mkdirSync(dirname(smokePng), { recursive: true });
    writeFileSync(smokePng, shot);
    expect(shot.length).toBeGreaterThan(5_000);

    // Sample the screenshot PNG itself (decode IHDR + scan a few IDAT bytes via canvas).
    const samples = await page.evaluate(async (pngB64) => {
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("png decode failed"));
      });
      img.src = `data:image/png;base64,${pngB64}`;
      await loaded;
      const tmp = document.createElement("canvas");
      tmp.width = img.width;
      tmp.height = img.height;
      const ctx = tmp.getContext("2d");
      if (!ctx) return { ok: false, reason: "no 2d", colours: [] as string[] };
      ctx.drawImage(img, 0, 0);
      const points = [
        [tmp.width * 0.5, tmp.height * 0.5],
        [tmp.width * 0.35, tmp.height * 0.55],
        [tmp.width * 0.65, tmp.height * 0.45],
        [tmp.width * 0.25, tmp.height * 0.25],
        [tmp.width * 0.75, tmp.height * 0.75],
        [40, 40], // overlay region — should be non-clear
      ] as const;
      const colours = points.map(([x, y]) => {
        const data = ctx.getImageData(x | 0, y | 0, 1, 1).data;
        return `${data[0]},${data[1]},${data[2]}`;
      });
      const unique = new Set(colours);
      // Background clear is sky blue #87CEEB ≈ 135,206,235; require variety
      // and at least one far-from-sky pixel (world geometry).
      const nonBg = colours.some((c) => {
        const [r, g, b] = c.split(",").map(Number);
        return (
          Math.abs((r ?? 0) - 135) +
            Math.abs((g ?? 0) - 206) +
            Math.abs((b ?? 0) - 235) >
          40
        );
      });
      return {
        ok: nonBg && unique.size >= 2,
        reason: !nonBg
          ? "all-near-clear"
          : unique.size < 2
            ? "single-colour"
            : "ok",
        colours,
        size: [img.width, img.height],
      };
    }, shot.toString("base64"));

    expect(
      samples.ok,
      `screenshot looks blank: ${JSON.stringify(samples)}`,
    ).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    await devServer?.close();
    await fixture.close();
  }
});

test("fixture expected.json lists the authored frame types", () => {
  const raw = readFileSync(join(viewerRoot, "testdata", "basic.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/);
  const types = raw.map((line) => (JSON.parse(line) as { type: string }).type);
  expect(types).toEqual(expected.frames);
});
