/**
 * Regression: realistic `&_sidebar:` payload must not explode dock geometry
 * or leave `|` pad glyphs in labels (live-capture "giant green S" bug).
 */
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { PNG } from "pngjs";
import { createServer, type ViteDevServer } from "vite";
import {
  createPushableStream,
  loadJsonlFrames,
  type JsonlFrame,
} from "./fixtureServer";
import { handleJsonUiPackRequest } from "./jsonuiPackServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const outDir = join(viewerRoot, "test-results");

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// Boots its own vite + waits for assetsSettled; under a parallel full-suite
// run the cold start alone can eat the default 60s budget.
test.setTimeout(120_000);

const EMPTY = ["null", "null", "null", "false", "empty", "null", "100"];

/**
 * @param slots - Per-slot fields.
 * @returns packed sidebar body (BEH `padEnd(120,'|')` + join).
 */
function packSidebar(slots: string[][]): string {
  return slots
    .flat()
    .map((v) => v.padEnd(120, "|"))
    .join("|");
}

/**
 * @param page - Playwright page.
 * @param appUrl - Viewer URL including stream.
 */
async function openHudOnly(page: Page, appUrl: string): Promise<void> {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const v = window.__viewer;
      return (
        !!v &&
        v.schemaOk &&
        v.tick >= 100 &&
        v.assetsSettled &&
        v.jsonUiReady === true
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.addStyleTag({
    content: `
      #c, #overlay, #crosshair, #labels, #player-hud, #loading, #waypoint-strip { display: none !important; }
      body { background: #0b0e14; }
    `,
  });
}

test("realistic sidebar payload: clean text, dock on-screen, empty clears", async ({
  page,
}) => {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello");
  const keyframe = all.find((f) => f.type === "keyframe");
  if (!hello || !keyframe) throw new Error("missing frames");
  const stream = createPushableStream([hello, keyframe]);
  const vite: ViteDevServer = await createServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("no base");
  const http: Server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/stream") {
        stream.handle(req, res);
        return;
      }
      if (handleJsonUiPackRequest(req, res)) return;
      res.writeHead(404);
      res.end("nf");
    },
  );
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const streamUrl = `http://127.0.0.1:${addr.port}/stream?bot=TestBot`;

  try {
    await openHudOnly(page, `${base}?stream=${encodeURIComponent(streamUrl)}`);

    const payload = packSidebar([
      [
        "HP: 20/20§r§f Lv. 11",
        "§fBulbasaur",
        "bulbasaur",
        "true",
        "poke",
        "default/bulbasaur",
        "37",
      ],
      [
        "HP: 11/23§r§f Lv. 5",
        "§fQuaxly",
        "quaxly",
        "false",
        "poke",
        "default/quaxly",
        "82",
      ],
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
    ]);
    stream.broadcast({
      v: 1,
      type: "phud",
      bot: "TestBot",
      tick: 148,
      token: "playerPing",
      value: "§a63",
    } as JsonlFrame);
    stream.broadcast({
      v: 1,
      type: "phud",
      bot: "TestBot",
      tick: 149,
      token: "currency",
      value:
        "Buy Ranks, Crates, and more at §spokebedrock.com/shop§r".padEnd(
          80,
          "_",
        ) + " \ue10e 1.00K",
    } as JsonlFrame);
    stream.broadcast({
      v: 1,
      type: "phud",
      bot: "TestBot",
      tick: 150,
      token: "sidebar",
      value: payload,
    } as JsonlFrame);

    await page.waitForFunction(
      () => {
        const dock = document.querySelector(
          '[data-jsonui-name="phud_sidebar.dock"]',
        );
        const ping = document.querySelector(
          '[data-jsonui-name="player_ping.main"]',
        );
        return (
          !!dock &&
          (dock.textContent ?? "").includes("Bulbasaur") &&
          !!ping &&
          getComputedStyle(ping).display !== "none"
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    const info = await page.evaluate(() => {
      const dock = document.querySelector(
        '[data-jsonui-name="phud_sidebar.dock"]',
      ) as HTMLElement;
      const main = document.querySelector(
        '[data-jsonui-name="phud_sidebar.main"]',
      ) as HTMLElement;
      const labels = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.variable_parser"].jsonui-label',
        ),
      ]
        .filter((el) => getComputedStyle(el).display !== "none")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent || "").replace(/\u00a0/g, " ").trim(),
            x: r.x,
            w: r.width,
            h: r.height,
          };
        });
      const balls = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.ball_icon"]',
        ),
      ]
        .filter((el) => getComputedStyle(el).display !== "none")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, x: r.x };
        });
      const dr = dock.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      return {
        dockText: dock.textContent ?? "",
        dock: { x: dr.x, y: dr.y, w: dr.width, h: dr.height },
        main: { x: mr.x, y: mr.y, w: mr.width, h: mr.height },
        labels,
        balls,
      };
    });

    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "sidebar-diag.json"),
      JSON.stringify(info, null, 2),
    );
    const shot = await page.screenshot({
      path: join(outDir, "sidebar-diag.png"),
      type: "png",
      animations: "disabled",
    });
    // phudGolden worker OOMs in this environment — keep the visual lock here.
    if (process.env.GOLDEN_UPDATE === "1") {
      writeFileSync(
        join(viewerRoot, "testdata", "goldens", "phud-sidebar.png"),
        shot,
      );
    }

    expect(info.dockText).toContain("Bulbasaur");
    expect(info.dockText).toContain("Quaxly");
    expect(info.dockText).not.toMatch(/\|{3,}/);
    expect(info.dockText).not.toMatch(/null\|/);

    // Dock sits on the right half; main is aspect-locked (~427 gui × scale), not viewport-wide.
    expect(info.main.w).toBeLessThan(1000);
    expect(info.main.h).toBeCloseTo(384, 0);
    expect(info.dock.x + info.dock.w).toBeGreaterThan(900);

    const bulba = info.labels.find((l) => l.text.includes("Bulbasaur"));
    expect(bulba).toBeTruthy();
    expect(bulba!.text).toMatch(/^§?f?Bulbasaur$/);
    expect(bulba!.x).toBeLessThan(1280);
    expect(bulba!.w).toBeLessThan(400);

    for (const b of info.balls) {
      expect(b.w).toBeLessThanOrEqual(72);
      expect(b.h).toBeLessThanOrEqual(72);
    }

    const img = PNG.sync.read(Buffer.from(shot));
    // Right dock band should have some non-black pixels (text/icons), but not
    // a wall of giant green glyphs (old bug: viewport-%y balls + pipe labels).
    let rightNonDark = 0;
    let rightGiantGreen = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = Math.floor(img.width * 0.55); x < img.width; x++) {
        const i = (y * img.width + x) << 2;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        const a = img.data[i + 3]!;
        if (a < 40) continue;
        if (r < 30 && g < 30 && b < 40) continue;
        rightNonDark++;
        // Giant stretched green (progress-bar / pipe debris): high G, large runs.
        if (g > 140 && g > r + 40 && g > b + 40) rightGiantGreen++;
      }
    }
    expect(rightNonDark).toBeGreaterThan(50);
    // Allow small green (ping is bottom-center; XP bar is tiny). Giant wall = fail.
    expect(rightGiantGreen).toBeLessThan(2000);

    // Empty token hides the dock.
    stream.broadcast({
      v: 1,
      type: "phud",
      bot: "TestBot",
      tick: 151,
      token: "sidebar",
      value: "",
    } as JsonlFrame);
    await page.waitForFunction(
      () => {
        const main = document.querySelector(
          '[data-jsonui-name="phud_sidebar.main"]',
        ) as HTMLElement | null;
        return !main || getComputedStyle(main).display === "none";
      },
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    stream.closeAll();
    await new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r())));
    await vite.close();
  }
});
