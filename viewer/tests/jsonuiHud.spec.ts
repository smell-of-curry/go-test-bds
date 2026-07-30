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
import { PNG } from "pngjs";
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

/**
 * Sum CSS-pixel area of painted phone chrome that is display-visible.
 * Counts image/panel nodes under the phone host whose visibility binding did
 * not collapse them (background frame, oak dim, icons).
 *
 * @param page - Playwright page.
 * @returns total visible area in CSS px².
 */
async function phonePaintedArea(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const names = new Set([
      "phone_background",
      "oak_talk_bg",
      "oak_talk",
      "ringing",
      "standby",
      "start",
      "loop",
      "icon",
    ]);
    let area = 0;
    for (const el of document.querySelectorAll<HTMLElement>(".jsonui")) {
      const name = el.dataset.uiName ?? "";
      if (!names.has(name)) continue;
      if (el.style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Opacity 0 (pre-anim oak dim) still counts as layout but not paint —
      // treat as zero painted area.
      const opacity = Number(el.style.opacity || "1");
      if (opacity <= 0) continue;
      area += r.width * r.height;
    }
    return area;
  });
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
      // Pipe pad must be stripped — leftover ||||||| was the live "giant glyph" bug.
      expect(bodyText).not.toMatch(/\|{3,}/);

      const geom = await page.evaluate(() => {
        const dock = document.querySelector(
          '[data-jsonui-name="phud_sidebar.dock"]',
        ) as HTMLElement | null;
        const main = document.querySelector(
          '[data-jsonui-name="phud_sidebar.main"]',
        ) as HTMLElement | null;
        const labels = [
          ...document.querySelectorAll(
            '[data-jsonui-name="phud_sidebar.variable_parser"].jsonui-label',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: el.textContent ?? "",
            w: r.width,
            h: r.height,
            x: r.x,
          };
        });
        const balls = [
          ...document.querySelectorAll(
            '[data-jsonui-name="phud_sidebar.ball_icon"]',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height };
        });
        return {
          dock: dock
            ? {
                w: dock.getBoundingClientRect().width,
                h: dock.getBoundingClientRect().height,
                x: dock.getBoundingClientRect().x,
              }
            : null,
          main: main
            ? {
                w: main.getBoundingClientRect().width,
                h: main.getBoundingClientRect().height,
              }
            : null,
          labels,
          balls,
        };
      });
      // main authored ["222.22%y", 192] but live-capped at 40% viewport width
      // (capture stills were ~67% dock slab otherwise). h stays 192gui×scale.
      expect(geom.main).not.toBeNull();
      expect(geom.main!.h).toBeCloseTo(384, 0);
      expect(geom.main!.w).toBeLessThanOrEqual(1024 * 0.35 + 2);
      expect(geom.main!.w).toBeGreaterThan(250);
      // Ball icons ["100%y","100%"] of 32-tall row → ~64×64 CSS, not viewport-tall.
      for (const b of geom.balls) {
        expect(b.h).toBeLessThanOrEqual(72);
        expect(b.w).toBeLessThanOrEqual(72);
      }
      // Visible name/stats labels: short text, on-screen, not 1000px-wide pipe runs.
      const nameLabel = geom.labels.find((l) => l.text.includes("TestBot"));
      expect(nameLabel).toBeTruthy();
      expect(nameLabel!.text).toMatch(/^TestBot$/);
      expect(nameLabel!.x).toBeLessThan(1024);
      expect(nameLabel!.w).toBeLessThan(400);

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

  test("phone chrome hidden when &_phone: never set", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      // Title stream is only &_sidebar:… — no phone token ever written.
      const area = await phonePaintedArea(page);
      expect(area).toBe(0);

      // Explicit: phone_background must not default-show from a broken $condition.
      const bg = page.locator('.jsonui[data-ui-name="phone_background"]');
      const bgCount = await bg.count();
      for (let i = 0; i < bgCount; i++) {
        await expect(bg.nth(i)).toBeHidden();
      }
    } finally {
      await harness.close();
    }
  });

  test("phone shows for &_phone:loop then clears on &_phone:", async ({
    page,
  }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      expect(await phonePaintedArea(page)).toBe(0);

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "loop" });
      });
      // oak_talk panel gates on ((%.4s * #value) = 'loop') — must appear.
      await expect(
        page.locator('.jsonui[data-ui-name="oak_talk"]').first(),
      ).toBeVisible();

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "" });
      });
      expect(await phonePaintedArea(page)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test("phone &_phone:oak_start then clear collapses chrome", async ({
    page,
  }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "oak_start" });
      });
      // oak_start is not ring/standby/loop — pack conditions hide all chrome.
      // Still assert no phone_background leak from the broken $condition typo.
      expect(await phonePaintedArea(page)).toBe(0);

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "" });
      });
      expect(await phonePaintedArea(page)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test("phone ring shows background then clears", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "ring" });
      });
      await expect(
        page.locator('.jsonui[data-ui-name="phone_background"]').first(),
      ).toBeVisible();
      expect(await phonePaintedArea(page)).toBeGreaterThan(0);

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "" });
      });
      expect(await phonePaintedArea(page)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test("vitals: no ellipses debris, no level-0 glyph, hotbar chrome", async ({
    page,
  }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      await page.evaluate(() => {
        const hotbar = Array.from({ length: 9 }, (_, i) =>
          i === 0
            ? { typeId: "minecraft:cobblestone", count: 64 }
            : i === 1
              ? { typeId: "minecraft:dirt", count: 1 }
              : null,
        );
        (
          window as unknown as {
            __jsonUi: {
              setVitals: (v: {
                v: number;
                type: "vitals";
                bot: string;
                tick: number;
                health: number;
                maxHealth: number;
                food: number;
                air: number;
                maxAir: number;
                armor: number;
                xpLevel: number;
                xpProgress: number;
                selectedSlot: number;
                hotbar: Array<{ typeId: string; count: number } | null>;
              }) => void;
            };
          }
        ).__jsonUi.setVitals({
          v: 1,
          type: "vitals",
          bot: "TestBot",
          tick: 2,
          health: 20,
          maxHealth: 20,
          food: 18,
          air: 300,
          maxAir: 300,
          armor: 0,
          xpLevel: 0,
          xpProgress: 0.4,
          selectedSlot: 0,
          hotbar,
        });
      });

      await page.waitForFunction(
        () =>
          !!document.querySelector(
            '.jsonui[data-ui-name="hotbar_renderer"] > div',
          ),
        undefined,
        { timeout: 10_000 },
      );

      const levelLabel = page.locator(
        '.jsonui[data-ui-name="progress_text_label"]',
      );
      const levelCount = await levelLabel.count();
      for (let i = 0; i < levelCount; i++) {
        await expect(levelLabel.nth(i)).toBeHidden();
      }

      const slotCount = await page
        .locator('.jsonui[data-ui-name="hotbar_renderer"] > div')
        .count();
      expect(slotCount).toBe(9);

      const selected = page.locator(
        '.jsonui[data-ui-name="hotbar_renderer"] > div[data-selected="1"]',
      );
      await expect(selected).toHaveCount(1);

      const badge = page.locator(
        '.jsonui[data-ui-name="hotbar_renderer"] .jsonui-hotbar-count',
      );
      await expect(badge).toHaveText("64");

      const barBox = await page
        .locator('.jsonui[data-ui-name="hotbar_renderer"]:has(> div)')
        .first()
        .boundingBox();
      expect(barBox).toBeTruthy();
      expect(barBox!.width).toBeGreaterThan(100);
      expect(barBox!.height).toBeGreaterThan(20);

      // Corner debris was hotbar_elipses_* (slot chrome + green "…" glyphs)
      // flanking the hotbar. Sample left/right of the painted bar.
      const png = await page.screenshot({
        type: "png",
        animations: "disabled",
      });
      const img = PNG.sync.read(Buffer.from(png));
      const y0 = Math.max(0, Math.floor(barBox!.y) - 4);
      const y1 = Math.min(
        img.height - 1,
        Math.ceil(barBox!.y + barBox!.height) + 4,
      );
      const greenHits = countBrightGreenInBands(img, [
        {
          x0: Math.max(0, Math.floor(barBox!.x) - 80),
          x1: Math.max(0, Math.floor(barBox!.x) - 8),
          y0,
          y1,
        },
        {
          x0: Math.min(img.width - 1, Math.ceil(barBox!.x + barBox!.width) + 8),
          x1: Math.min(
            img.width - 1,
            Math.ceil(barBox!.x + barBox!.width) + 80,
          ),
          y0,
          y1,
        },
      ]);
      expect(greenHits).toBe(0);

      // Hotbar chrome must be brighter than the near-black page bg.
      const bar = sampleLumaBand(img, {
        x0: Math.floor(barBox!.x),
        x1: Math.ceil(barBox!.x + barBox!.width),
        y0: Math.floor(barBox!.y),
        y1: Math.ceil(barBox!.y + barBox!.height),
      });
      expect(bar.max).toBeGreaterThan(40);
      expect(bar.nonDark).toBeGreaterThan(80);
    } finally {
      await harness.close();
    }
  });
});

/**
 * Count near-pure green pixels (ellipses / XP glyph debris) in rectangles.
 *
 * @param img - Decoded PNG.
 * @param bands - Inclusive pixel bands.
 * @returns matching pixel count.
 */
function countBrightGreenInBands(
  img: PNG,
  bands: Array<{ x0: number; x1: number; y0: number; y1: number }>,
): number {
  let n = 0;
  for (const b of bands) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = (y * img.width + x) << 2;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const bl = img.data[i + 2]!;
        const a = img.data[i + 3]!;
        if (a < 40) continue;
        // XP / ellipses glyph green ≈ high G, low R/B.
        if (g > 140 && g > r + 40 && g > bl + 40) n++;
      }
    }
  }
  return n;
}

/**
 * Sample luma stats in a band (hotbar chrome visibility).
 *
 * @param img - Decoded PNG.
 * @param band - Inclusive pixel band.
 * @returns max luma and count of non-near-black pixels.
 */
function sampleLumaBand(
  img: PNG,
  band: { x0: number; x1: number; y0: number; y1: number },
): { max: number; nonDark: number } {
  let max = 0;
  let nonDark = 0;
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = band.x0; x <= band.x1; x++) {
      const i = (y * img.width + x) << 2;
      const a = img.data[i + 3]!;
      if (a < 40) continue;
      const luma =
        img.data[i]! * 0.2126 +
        img.data[i + 1]! * 0.7152 +
        img.data[i + 2]! * 0.0722;
      if (luma > max) max = luma;
      if (luma > 35) nonDark++;
    }
  }
  return { max, nonDark };
}
