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
 * Vite app + pushable SSE fixture (same shape as recording.spec).
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
 * @param appUrl - Viewer URL including stream.
 */
async function openViewer(page: Page, appUrl: string): Promise<void> {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      return !!v && v.schemaOk && v.tick >= 100 && v.assetsSettled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => window.__viewer?.flush());
  await page.waitForFunction(() => window.__viewer?.settled === true);
}

test("chat event renders coloured line in player HUD", async ({ page }) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    h.broadcast({
      v: 1,
      type: "chat",
      bot: "TestBot",
      tick: 120,
      text: "§aWelcome to the arena",
    } as JsonlFrame);

    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#player-hud .hud-chat-line")].some(
          (el) => (el.textContent ?? "").includes("Welcome to the arena"),
        ),
      undefined,
      { timeout: 10_000 },
    );

    const got = await page.evaluate(() => {
      const lines = [
        ...document.querySelectorAll("#player-hud .hud-chat-line"),
      ];
      const line = lines.find((el) =>
        (el.textContent ?? "").includes("Welcome to the arena"),
      );
      const span = line?.querySelector("span");
      return {
        text: line?.textContent ?? "",
        color: span ? (span as HTMLElement).style.color : "",
      };
    });
    expect(got.text).toContain("Welcome to the arena");
    expect(got.color.toLowerCase()).toMatch(
      /55ff55|#55ff55|rgb\(85,\s*255,\s*85\)/,
    );
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("title event shows title and action bar", async ({ page }) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    h.broadcast({
      v: 1,
      type: "title",
      bot: "TestBot",
      tick: 130,
      title: "§lLevel Up!",
      subtitle: "Charizard",
      actionBar: "Press F",
      fadeInTicks: 0,
      stayTicks: 200,
      fadeOutTicks: 0,
    } as JsonlFrame);

    await page.waitForFunction(
      () => {
        const t = document.querySelector("#player-hud [data-hud='title']");
        return (t?.textContent ?? "").includes("Level Up");
      },
      undefined,
      { timeout: 10_000 },
    );

    const got = await page.evaluate(() => ({
      title: document.querySelector("#player-hud [data-hud='title']")
        ?.textContent,
      subtitle: document.querySelector("#player-hud [data-hud='subtitle']")
        ?.textContent,
      action: document.querySelector("#player-hud [data-hud='actionbar']")
        ?.textContent,
    }));
    expect(got.title).toContain("Level Up");
    expect(got.subtitle).toContain("Charizard");
    expect(got.action).toContain("Press F");
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("hotbar and health render from actor on keyframe", async ({ page }) => {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello")!;
  const base = all.find((f) => f.type === "keyframe") as JsonlFrame;
  const keyframe = {
    ...base,
    actor: {
      ...(base.actor as Record<string, unknown>),
      health: 16,
      maxHealth: 20,
      food: 18,
      heldSlot: 2,
      hotbar: [
        { name: "minecraft:dirt", count: 32 },
        null,
        { name: "minecraft:diamond_sword", count: 1 },
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    },
  };

  const h = await startHarness([hello, keyframe]);
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    const got = await page.evaluate(() => {
      const slots = [...document.querySelectorAll("#player-hud .hud-slot")].map(
        (el) => ({
          selected: el.classList.contains("selected"),
          text: el.textContent ?? "",
        }),
      );
      return {
        hearts: document.querySelector("#player-hud [data-hud='hearts']")
          ?.textContent,
        food: document.querySelector("#player-hud [data-hud='food']")
          ?.textContent,
        slots,
      };
    });

    expect(got.hearts).toMatch(/HP 8\/10/);
    expect(got.food).toMatch(/Food 9/);
    expect(got.slots).toHaveLength(9);
    expect(got.slots[2]?.selected).toBe(true);
    expect(got.slots[0]?.text).toMatch(/dirt/i);
    expect(got.slots[0]?.text).toContain("32");
    expect(got.slots[2]?.text).toMatch(/diamond sword/i);
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});

test("block change spawns a break particle burst", async ({ page }) => {
  const h = await startHarness();
  try {
    const appUrl = `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`;
    await openViewer(page, appUrl);

    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 140,
      blocks: [
        {
          pos: [2, 65, 2],
          layer: 0,
          block: { name: "minecraft:air", states: {}, rid: 0 },
        },
      ],
    });

    await page.waitForFunction(
      () => (window.__viewer?.hudBurstCount ?? 0) > 0,
      undefined,
      { timeout: 10_000 },
    );
    const n = await page.evaluate(() => window.__viewer!.hudBurstCount);
    expect(n).toBeGreaterThan(0);
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});
