import { expect, test, type Page } from "@playwright/test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import {
  createPushableStream,
  loadJsonlFrames,
  type JsonlFrame,
} from "./fixtureServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

interface Harness {
  base: string;
  streamUrl: string;
  broadcast: (frame: JsonlFrame) => void;
  close: () => Promise<void>;
}

/**
 * Vite app + pushable SSE fixture (same shape the capture test uses).
 *
 * @returns live URLs and a broadcast handle.
 */
async function startHarness(bootstrap?: JsonlFrame[]): Promise<Harness> {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello");
  const keyframe = all.find((f) => f.type === "keyframe");
  if (!hello || !keyframe) throw new Error("testdata missing hello/keyframe");

  const stream = createPushableStream(bootstrap ?? [hello, keyframe]);
  const vite: ViteDevServer = await createServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("vite has no local URL");

  const http: Server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/stream") {
      stream.handle(req, res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const streamUrl = `http://127.0.0.1:${addr.port}/stream?bot=TestBot`;

  return {
    base,
    streamUrl,
    broadcast: (frame) => stream.broadcast(frame),
    close: async () => {
      stream.closeAll();
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
      await vite.close();
    },
  };
}

/**
 * @param page - Playwright page.
 * @param appUrl - Viewer URL including stream + camera.
 */
async function openViewer(page: Page, appUrl: string): Promise<void> {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      return !!v && v.schemaOk && v.tick >= 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => window.__viewer?.flush());
  await page.waitForFunction(() => window.__viewer?.settled === true);
}

test("follow camera frames the actor from behind and above", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}&camera=follow`;
    await openViewer(page, appUrl);

    const got = await page.evaluate(() => {
      const v = window.__viewer!;
      const d = v.diag();
      return {
        mode: v.cameraMode,
        cam: d.cam,
        actorEye: d.actorEye,
      };
    });

    expect(got.mode).toBe("follow");
    expect(got.actorEye).not.toBeNull();
    const [eyeX, eyeY, eyeZ] = got.actorEye!;
    const [camX, camY, camZ] = got.cam;
    // Fixture actor: pos [8.5,65,8.5], rot yaw 180 (faces −Z). Follow sits
    // behind (+Z) and above the feet.
    expect(camY).toBeGreaterThan(eyeY);
    expect(camZ).toBeGreaterThan(eyeZ);
    // Camera should not sit on the eye (that would be first-person).
    const dist = Math.hypot(camX - eyeX, camY - eyeY, camZ - eyeZ);
    expect(dist).toBeGreaterThan(2);
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("caption band shows a failing test's assertion message", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    h.broadcast({
      v: 1,
      type: "mark",
      bot: "TestBot",
      tick: 150,
      phase: "testEnd",
      runId: "run-rec",
      suite: "machines",
      test: "places a crate",
      status: "failed",
      message: "expected pokeb:crate, got minecraft:air",
      elapsedMs: 3412,
    });

    await page.waitForFunction(
      () => (window.__viewer?.captionText ?? "").includes("pokeb:crate"),
      undefined,
      { timeout: 10_000 },
    );

    const text = await page.evaluate(() => window.__viewer!.captionText);
    expect(text).toContain("machines");
    expect(text).toContain("places a crate");
    expect(text).toMatch(/3\.4s|3412ms/);
    expect(text).toContain("FAILED");
    expect(text).toContain("expected pokeb:crate, got minecraft:air");

    const failed = await page.evaluate(() =>
      document.getElementById("caption")?.classList.contains("failed"),
    );
    expect(failed).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("block highlights appear on delta and expire after fade", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    // Keyframe has no dirty blocks; push a layer-0 change.
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 110,
      blocks: [
        {
          pos: [2, 65, 2],
          layer: 0,
          block: { name: "minecraft:dirt", states: {}, rid: 3 },
        },
      ],
    });

    await page.waitForFunction(
      () => (window.__viewer?.highlightCount ?? 0) > 0,
      undefined,
      { timeout: 10_000 },
    );
    const live = await page.evaluate(() => window.__viewer!.highlightCount);
    expect(live).toBeGreaterThan(0);

    await page.evaluate(() => {
      const now = performance.now();
      window.__viewer!.tickHighlights(now + 2000);
    });
    const after = await page.evaluate(() => window.__viewer!.highlightCount);
    expect(after).toBe(0);
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("open UI panel renders form title and buttons from snapshot", async ({
  page,
}) => {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello")!;
  const keyframe = {
    ...(all.find((f) => f.type === "keyframe") as JsonlFrame),
    ui: {
      form: {
        type: "menu",
        title: "PC",
        content: "Select a box",
        buttons: ["Slot 1", "Slot 2"],
      },
    },
  };

  const h = await startHarness([hello, keyframe]);
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    const panel = await page.evaluate(() => {
      const el = document.getElementById("ui-panel");
      return {
        visible: el?.classList.contains("visible") ?? false,
        text: el?.textContent ?? "",
      };
    });
    expect(panel.visible).toBe(true);
    expect(panel.text).toContain("PC");
    expect(panel.text).toContain("Slot 1");
    expect(panel.text).toContain("Select a box");
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});
