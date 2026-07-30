/**
 * Playwright: mount JSON UI runtime against testdata/jsonui fixtures.
 * Asserts one sidebar dock, party name/level text, no centered &_ title.
 */
import { expect, test } from "@playwright/test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const fixturesRoot = join(viewerRoot, "testdata", "jsonui");

interface Harness {
  pageUrl: string;
  close: () => Promise<void>;
}

/**
 * Serve fixture packs at /packs + /pack/{id}/{path} and a Vite app page.
 *
 * @returns page URL + close.
 */
async function startHarness(): Promise<Harness> {
  const packHttp: Server = createHttpServer((req, res) => {
    void handlePack(req, res);
  });

  async function handlePack(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname === "/packs") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { id: "vanilla", priority: 0 },
          { id: "pokebedrock", priority: 1 },
        ]),
      );
      return;
    }
    const packMatch = /^\/pack\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (packMatch) {
      const packId = decodeURIComponent(packMatch[1]!);
      let rel = decodeURIComponent(packMatch[2]!);
      if (rel.toLowerCase().startsWith("ui/")) rel = rel.slice(3);
      const abs = join(fixturesRoot, packId, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404, cors);
        res.end("missing");
        return;
      }
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(readFileSync(abs));
      return;
    }
    if (url.pathname.startsWith("/asset/")) {
      // No textures in fixture tree for most paths — 404 is fine (empty icons).
      res.writeHead(404, cors);
      res.end("no asset");
      return;
    }
    res.writeHead(404, cors);
    res.end("not found");
  }

  await new Promise<void>((resolve) =>
    packHttp.listen(0, "127.0.0.1", resolve),
  );
  const packAddr = packHttp.address();
  if (!packAddr || typeof packAddr === "string")
    throw new Error("no pack addr");
  const packsOrigin = `http://127.0.0.1:${packAddr.port}`;

  const vite: ViteDevServer = await createViteServer({
    root: viewerRoot,
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("vite has no local URL");

  const pageUrl = new URL(
    `tests/fixtures/jsonuiHud.html?packs=${encodeURIComponent(packsOrigin)}`,
    base,
  ).href;

  return {
    pageUrl,
    close: async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) =>
        packHttp.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

test.describe("jsonui HUD fixtures", () => {
  test("one dock, party text, no centered &_ title", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      const docks = page.locator('.jsonui[data-ui-name="dock"]');
      await expect(docks).toHaveCount(1);

      const bodyText = await page.locator("#host").innerText();
      expect(bodyText).toContain("TestBot");
      expect(bodyText).toMatch(/Lv\.?\s*5|HP:\s*20\/20/);

      // Centered title must not show the raw control token.
      const titleLabels = page.locator(
        '.jsonui[data-ui-name="title"], .jsonui[data-ui-name="hud_title_text"]',
      );
      const count = await titleLabels.count();
      for (let i = 0; i < count; i++) {
        const el = titleLabels.nth(i);
        const visible = await el.isVisible();
        if (!visible) continue;
        const text = await el.innerText();
        expect(text).not.toMatch(/^&_[A-Za-z]+:/);
      }

      // Whole host must not paint a centered &_sidebar title string.
      expect(bodyText).not.toMatch(/&_sidebar:/);

      const frameMs = Number(
        await page.evaluate(() => document.body.dataset.frameMs ?? "0"),
      );
      // First fixture frame is cold (full bind+layout+paint). Soft ceiling —
      // live 10–20 Hz path dirty-skips unchanged trees.
      expect(frameMs).toBeGreaterThan(0);
      expect(frameMs).toBeLessThan(2000);
    } finally {
      await harness.close();
    }
  });
});
