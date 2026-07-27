import { expect, test, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { createPushableStream, type JsonlFrame } from "./fixtureServer";
import { createServer as createHttpServer, type Server } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

/** 9×9 columns — same footprint as the production probe that timed out. */
const GRID = 9;
const SECTIONS_PER_COLUMN = 6;
const CELLS_PER_SECTION = 4096;
const SOLID_BLOCK_COUNT = GRID * GRID * SECTIONS_PER_COLUMN * CELLS_PER_SECTION;

/**
 * In-section-only cull (pre-fix) kept every section shell:
 * 16³ − 14³ = 1352 instances × section count.
 */
const PRE_CULL_SECTION_SHELL =
  GRID * GRID * SECTIONS_PER_COLUMN * (4096 - 14 * 14 * 14);

const AIR = { name: "minecraft:air", states: {}, rid: 0 };
const STONE = { name: "minecraft:stone", states: {}, rid: 1 };

function solidSection(sy: number): {
  y: number;
  palette: Array<{ name: string; states: Record<string, never>; rid: number }>;
  blocks: string;
} {
  const indices = new Uint16Array(CELLS_PER_SECTION);
  indices.fill(1);
  const buf = Buffer.alloc(CELLS_PER_SECTION * 2);
  for (let i = 0; i < CELLS_PER_SECTION; i++) {
    buf.writeUInt16LE(indices[i]!, i * 2);
  }
  return {
    y: sy,
    palette: [AIR, STONE],
    blocks: buf.toString("base64"),
  };
}

function buildHeavyKeyframe(): JsonlFrame {
  const half = (GRID - 1) >> 1;
  const columns: unknown[] = [];
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) {
      columns.push({
        x,
        z,
        state: "complete",
        minY: 0,
        maxY: SECTIONS_PER_COLUMN * 16 - 1,
        sections: Array.from({ length: SECTIONS_PER_COLUMN }, (_, sy) =>
          solidSection(sy),
        ),
      });
    }
  }

  return {
    v: 1,
    type: "keyframe",
    bot: "TestBot",
    tick: 100,
    world: {
      dimension: 0,
      dimensionName: "overworld",
      minY: 0,
      maxY: SECTIONS_PER_COLUMN * 16 - 1,
    },
    actor: {
      rid: 1,
      uid: 1,
      name: "TestBot",
      pos: [8.5, 70, 8.5],
      eyePos: [8.5, 71.62, 8.5],
      rot: [180, 20],
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
    columns,
    entities: [],
    ui: { messages: [], title: "", subtitle: "", actionBar: "" },
  };
}

async function startHeavyFixture(): Promise<{
  streamUrl: string;
  close: () => Promise<void>;
}> {
  const hello: JsonlFrame = {
    v: 1,
    type: "hello",
    bot: "TestBot",
    schema: 1,
    tickRate: 20,
    radius: 4,
  };
  const stream = createPushableStream([hello, buildHeavyKeyframe()]);
  const server: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/stream") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    stream.handle(req, res);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  return {
    streamUrl: `http://127.0.0.1:${addr.port}/stream?bot=TestBot`,
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function waitForHeavySettled(page: Page): Promise<{
  blockInstanceCount: number;
  sectionMeshCount: number;
  columnCount: number;
}> {
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      return !!v && v.schemaOk && v.tick >= 100 && v.columnCount >= 81;
    },
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(() => window.__viewer?.flush(), undefined, {
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => window.__viewer?.settled === true,
    undefined,
    {
      timeout: 30_000,
    },
  );
  return page.evaluate(() => {
    const v = window.__viewer!;
    return {
      blockInstanceCount: v.blockInstanceCount,
      sectionMeshCount: v.sectionMeshCount,
      columnCount: v.columnCount,
    };
  });
}

test("occlusion cull: heavy solid terrain screenshots inside capture budget", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = await startHeavyFixture();
  let devServer: ViteDevServer | undefined;
  try {
    await page.setViewportSize({ width: 960, height: 540 });

    devServer = await createServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 5176, strictPort: false },
    });
    await devServer.listen();
    const base = devServer.resolvedUrls?.local[0];
    if (!base) throw new Error("vite dev server has no local URL");

    const appUrl = `${base}?stream=${encodeURIComponent(fixture.streamUrl)}`;
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });

    const got = await waitForHeavySettled(page);
    expect(got.columnCount).toBe(GRID * GRID);

    // Post-cull must beat both the raw solid count and the old per-section shell.
    expect(got.blockInstanceCount).toBeLessThan(SOLID_BLOCK_COUNT * 0.1);
    expect(got.blockInstanceCount).toBeLessThan(PRE_CULL_SECTION_SHELL * 0.25);
    expect(got.blockInstanceCount).toBeGreaterThan(0);

    // Solid AABB shell: W*H*D − (W-2)*(H-2)*(D-2) with W=D=144, H=96.
    const w = GRID * 16;
    const h = SECTIONS_PER_COLUMN * 16;
    const d = GRID * 16;
    const exactShell = w * h * d - (w - 2) * (h - 2) * (d - 2);
    expect(got.blockInstanceCount).toBe(exactShell);

    const t0 = Date.now();
    const shot = await page.screenshot({ type: "png", timeout: 5_000 });
    const screenshotMs = Date.now() - t0;

    // Production capture deadline is 5s; keep real headroom on SwiftShader.
    expect(screenshotMs).toBeLessThan(2_500);
    expect(shot.length).toBeGreaterThan(5_000);

    // Surfaced for the agent report / CI log — not asserted as a golden.
    console.log(
      JSON.stringify({
        solidBlockCount: SOLID_BLOCK_COUNT,
        preCullSectionShell: PRE_CULL_SECTION_SHELL,
        blockInstanceCount: got.blockInstanceCount,
        sectionMeshCount: got.sectionMeshCount,
        screenshotMs,
      }),
    );
  } finally {
    await page.close().catch(() => undefined);
    await devServer?.close();
    await fixture.close();
  }
});
