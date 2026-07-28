import { expect, test, type Page } from "@playwright/test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { ViewerHandle } from "../src/debug";
import {
  createPushableStream,
  loadJsonlFrames,
  startFixtureServer,
} from "./fixtureServer";
import {
  buildFixturePack,
  startTerrainAssetServer,
} from "./terrainAssetServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

/**
 * Sample one canvas pixel via WebGL (preserveDrawingBuffer is on).
 * Origin is top-left in the arguments; GL reads bottom-left.
 *
 * @param page - Playwright page.
 * @param x - X in CSS/canvas pixels from left.
 * @param y - Y in CSS/canvas pixels from top.
 * @returns RGB triple.
 */
async function readCanvasRgb(
  page: Page,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("no webgl");
      const buf = new Uint8Array(4);
      const gy = canvas.height - 1 - y;
      gl.readPixels(x, gy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0]!, buf[1]!, buf[2]!] as [number, number, number];
    },
    { x, y },
  );
}

/** Gradient sky: zenith deeper blue, horizon lighter — accept either band. */
function nearSky(rgb: [number, number, number]): boolean {
  const [r, g, b] = rgb;
  return b > 130 && b > r && g > 90 && r < 200;
}

function nearDark(rgb: [number, number, number], tol = 25): boolean {
  return (
    Math.abs(rgb[0] - 11) + Math.abs(rgb[1] - 14) + Math.abs(rgb[2] - 20) <= tol
  );
}

interface GatedApp {
  url: string;
  releasePacks: () => void;
  close: () => Promise<void>;
}

/**
 * Vite + fixture SSE + pack routes on one origin. Pack index is held until
 * `releasePacks()` so the loading screen can be observed.
 *
 * @param holdPacks - When true, `/packs/index` waits on a latch.
 * @returns app URL and release handle.
 */
async function startGatedAssetApp(holdPacks: boolean): Promise<GatedApp> {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello");
  const keyframe = all.find((f) => f.type === "keyframe");
  if (!hello || !keyframe) throw new Error("testdata missing hello/keyframe");

  const stream = createPushableStream([hello, keyframe]);
  const assets = await startTerrainAssetServer(buildFixturePack());

  let release!: () => void;
  const gate = holdPacks
    ? new Promise<void>((r) => {
        release = r;
      })
    : Promise.resolve();
  if (!holdPacks) release = () => undefined;

  const vite: ViteDevServer = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  async function proxyAsset(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const target = `${assets.url}${req.url ?? "/"}`;
    const upstream = await fetch(target);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/stream") {
      stream.handle(req, res);
      return;
    }
    if (
      url.pathname === "/packs" ||
      url.pathname === "/packs/index" ||
      url.pathname.startsWith("/pack/") ||
      url.pathname.startsWith("/asset/")
    ) {
      if (url.pathname === "/packs/index" || url.pathname === "/packs") {
        await gate;
      }
      await proxyAsset(req, res);
      return;
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  }

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    releasePacks: () => release(),
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => {
          void Promise.all([vite.close(), assets.close()]).then(
            () => (err ? reject(err) : resolve()),
            reject,
          );
        });
      }),
  };
}

test("fixture boot without packs: placeholder fallback + sky clear", async ({
  page,
}) => {
  const fixture = await startFixtureServer();
  let vite: ViteDevServer | undefined;
  try {
    vite = await createViteServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await vite.listen();
    const base = vite.resolvedUrls?.local[0];
    if (!base) throw new Error("no vite url");

    await page.goto(`${base}?stream=${encodeURIComponent(fixture.streamUrl)}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () => {
        const v = window.__viewer;
        return !!v && v.schemaOk && v.tick >= 100 && v.assetsSettled;
      },
      undefined,
      { timeout: 30_000 },
    );

    const got = await page.evaluate(() => {
      const v = window.__viewer!;
      return {
        assetsSettled: v.assetsSettled,
        sectionMeshCount: v.sectionMeshCount,
        blockInstanceCount: v.blockInstanceCount,
        loadingVisible: document
          .getElementById("loading")
          ?.classList.contains("visible"),
      };
    });

    expect(got.assetsSettled).toBe(true);
    expect(got.loadingVisible).toBe(false);
    // Placeholder path must still produce the fixture scene.
    expect(got.sectionMeshCount).toBeGreaterThan(0);
    expect(got.blockInstanceCount).toBeGreaterThan(0);

    // Force a paint so the sky clear is in the drawing buffer.
    await page.waitForTimeout(100);
    const top = await readCanvasRgb(page, 40, 20);
    expect(nearSky(top), `top pixel ${top.join(",")} not sky`).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    await vite?.close();
    await fixture.close();
  }
});

test("working packs: loading screen first, world after assetsSettled", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const app = await startGatedAssetApp(true);
  try {
    const streamUrl = `${app.url}/stream?bot=TestBot`;
    await page.goto(
      `${app.url}/?stream=${encodeURIComponent(streamUrl)}&camera=follow`,
      { waitUntil: "domcontentloaded" },
    );

    // Stream can attach and schema can go green while packs are still gated.
    await page.waitForFunction(
      () => {
        const v = window.__viewer;
        return !!v && v.schemaOk && v.tick >= 100;
      },
      undefined,
      { timeout: 30_000 },
    );

    const mid = await page.evaluate(() => {
      const v = window.__viewer!;
      return {
        assetsSettled: v.assetsSettled,
        loadingVisible: document
          .getElementById("loading")
          ?.classList.contains("visible"),
        loadingText: document.getElementById("loading")?.textContent ?? "",
      };
    });
    expect(mid.assetsSettled).toBe(false);
    expect(mid.loadingVisible).toBe(true);
    expect(mid.loadingText.toLowerCase()).toContain("loading");

    // Harness still-wait predicate must block here (tick ok, assets not settled).
    const harnessReadyMid = await page.evaluate((need) => {
      const v = (
        window as unknown as {
          __viewer?: {
            schemaOk: boolean;
            tick: number;
            assetsSettled: boolean;
          };
        }
      ).__viewer;
      return !!v && v.schemaOk && v.tick >= need && v.assetsSettled;
    }, 100);
    expect(harnessReadyMid).toBe(false);

    // Canvas under the loading state stays near-black, not sky.
    await page.waitForTimeout(80);
    const loadingPixel = await readCanvasRgb(page, 40, 20);
    expect(
      nearDark(loadingPixel),
      `loading clear ${loadingPixel.join(",")} not dark`,
    ).toBe(true);

    app.releasePacks();

    await page.waitForFunction(
      () => window.__viewer?.assetsSettled === true,
      undefined,
      { timeout: 30_000 },
    );

    const after = await page.evaluate(() => ({
      assetsSettled: window.__viewer!.assetsSettled,
      loadingVisible: document
        .getElementById("loading")
        ?.classList.contains("visible"),
      sectionMeshCount: window.__viewer!.sectionMeshCount,
    }));
    expect(after.assetsSettled).toBe(true);
    expect(after.loadingVisible).toBe(false);

    await page.evaluate(() => window.__viewer?.flush());
    await page.waitForFunction(() => window.__viewer?.settled === true);
    await page.waitForTimeout(100);

    const sky = await readCanvasRgb(page, 40, 20);
    expect(nearSky(sky), `settled sky ${sky.join(",")}`).toBe(true);

    const harnessReady = await page.evaluate((need) => {
      const v = (
        window as unknown as {
          __viewer?: {
            schemaOk: boolean;
            tick: number;
            assetsSettled: boolean;
          };
        }
      ).__viewer;
      return !!v && v.schemaOk && v.tick >= need && v.assetsSettled;
    }, 100);
    expect(harnessReady).toBe(true);
  } finally {
    app.releasePacks();
    await page.close().catch(() => undefined);
    await app.close();
  }
});

test("assetsSettled is on the debug handle after fail-fast", async ({
  page,
}) => {
  const fixture = await startFixtureServer();
  let vite: ViteDevServer | undefined;
  try {
    vite = await createViteServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await vite.listen();
    const base = vite.resolvedUrls?.local[0];
    if (!base) throw new Error("no vite url");

    await page.goto(`${base}?stream=${encodeURIComponent(fixture.streamUrl)}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () => window.__viewer?.assetsSettled === true,
      undefined,
      { timeout: 15_000 },
    );

    const handle = await page.evaluate(() => {
      const v = window.__viewer as ViewerHandle;
      return {
        has: Object.prototype.hasOwnProperty.call(v, "assetsSettled")
          ? true
          : "assetsSettled" in v,
        value: v.assetsSettled,
      };
    });
    expect(handle.has).toBeTruthy();
    expect(handle.value).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    await vite?.close();
    await fixture.close();
  }
});
