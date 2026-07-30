/**
 * Live-capture regressions: empty sidebar plates, fat XP bars, air bubbles,
 * armor row, and title tip backgrounds.
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
 * @returns fixture-pack harness.
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
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("vite has no local URL");

  return {
    pageUrl: new URL(
      `tests/fixtures/jsonuiHud.html?packs=${encodeURIComponent(packsOrigin)}`,
      base,
    ).href,
    close: async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) =>
        packHttp.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

test("empty slots hidden; air/armor/xp gated; no fat green XP", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const harness = await startHarness();
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.dataset.ready === "1", {
      timeout: 60_000,
    });

    const EMPTY = ["null", "null", "null", "false", "empty", "null", "100"];
    const pad = (s: string) => s.padEnd(120, "|");
    const payload = [
      [
        "HP: 20/20§r§f Lv. 11",
        "§fBulbasaur",
        "bulbasaur",
        "true",
        "poke",
        "default/bulbasaur",
        "37",
      ],
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
    ]
      .flat()
      .map(pad)
      .join("|");

    await page.evaluate(
      ({ sidebar, vitals }) => {
        (
          window as unknown as {
            __jsonUi: {
              setHud: (phud: Record<string, string>, v: typeof vitals) => void;
            };
          }
        ).__jsonUi.setHud({ sidebar }, vitals);
      },
      {
        sidebar: payload,
        vitals: {
          v: 1 as const,
          type: "vitals" as const,
          bot: "TestBot",
          tick: 2,
          health: 20,
          maxHealth: 20,
          food: 18,
          air: 300,
          maxAir: 300,
          armor: 0,
          xpLevel: 0,
          xpProgress: 0,
          selectedSlot: 0,
          hotbar: Array.from({ length: 9 }, () => null),
        },
      },
    );

    await page.waitForFunction(
      () =>
        (
          document.querySelector('[data-jsonui-name="phud_sidebar.dock"]')
            ?.textContent ?? ""
        ).includes("Bulbasaur"),
      undefined,
      { timeout: 15_000 },
    );

    const info = await page.evaluate(() => {
      const dataPlates = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].filter((el) => {
        if (el.dataset.uiType !== "image") return false;
        if (getComputedStyle(el).display === "none") return false;
        const face = el.querySelector(
          ".jsonui-image-face",
        ) as HTMLElement | null;
        const bg = face?.style.backgroundImage ?? "";
        return bg.includes("sidebar/data");
      });
      const balls = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="phud_sidebar.ball_icon"]',
        ),
      ].filter((el) => getComputedStyle(el).display !== "none");
      const bubbles = [
        ...document.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="bubbles_renderer"]',
        ),
      ].filter((el) => {
        if (getComputedStyle(el).display === "none") return false;
        return el.childElementCount > 0;
      });
      const armor = [
        ...document.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="armor_renderer"]',
        ),
      ].filter((el) => {
        if (getComputedStyle(el).display === "none") return false;
        return el.childElementCount > 0;
      });
      const xp = [
        ...document.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="empty_progress_bar"], .jsonui[data-ui-name="full_progress_bar"]',
        ),
      ].filter((el) => getComputedStyle(el).display !== "none");
      const titleBg = [
        ...document.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="title_background"], .jsonui[data-ui-name="subtitle_background"]',
        ),
      ].filter((el) => getComputedStyle(el).display !== "none");
      const dock = document.querySelector(
        '[data-jsonui-name="phud_sidebar.dock"]',
      ) as HTMLElement | null;
      const host = document.querySelector(
        ".jsonui-hud-host, #json-hud, #host",
      ) as HTMLElement | null;
      const hr = host?.getBoundingClientRect();
      // Dock may pad past the right edge (+47%); occupied plate + name must
      // stay inside the HUD host (right-anchor clamp keeps content on-screen).
      const plate = dataPlates[0]?.getBoundingClientRect();
      const nameEl = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].find((el) => (el.textContent ?? "").includes("Bulbasaur"));
      const nr = nameEl?.getBoundingClientRect();
      return {
        plateCount: dataPlates.length,
        ballCount: balls.length,
        bubbleCount: bubbles.length,
        armorCount: armor.length,
        xpCount: xp.length,
        titleBgCount: titleBg.length,
        dockText: dock?.textContent ?? "",
        hostRight: hr ? hr.x + hr.width : 0,
        hostWidth: hr?.width ?? 0,
        plateRight: plate ? plate.x + plate.width : 0,
        plateLeft: plate?.x ?? 0,
        nameRight: nr ? nr.x + nr.width : 0,
        nameText: nameEl?.textContent ?? "",
      };
    });

    expect(info.dockText).toContain("Bulbasaur");
    expect(info.dockText).not.toMatch(/\|{3,}/);
    expect(info.plateCount).toBe(1);
    expect(info.ballCount).toBe(1);
    expect(info.bubbleCount).toBe(0);
    expect(info.armorCount).toBe(0);
    expect(info.xpCount).toBe(0);
    expect(info.titleBgCount).toBe(0);
    expect(info.nameText).toContain("Bulbasaur");
    expect(info.hostWidth).toBeGreaterThan(100);
    expect(info.plateLeft).toBeGreaterThan(0);
    expect(info.plateRight).toBeLessThanOrEqual(info.hostRight + 1);
    expect(info.nameRight).toBeLessThanOrEqual(info.hostRight + 1);

    const png = await page.screenshot({
      type: "png",
      animations: "disabled",
    });
    const img = PNG.sync.read(Buffer.from(png));
    let fatGreen = 0;
    const y0 = Math.floor(img.height * 0.7);
    const y1 = Math.floor(img.height * 0.92);
    const x0 = Math.floor(img.width * 0.25);
    const x1 = Math.floor(img.width * 0.75);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) << 2;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        const a = img.data[i + 3]!;
        if (a < 200) continue;
        if (g > 140 && g > r + 40 && g > b + 40) fatGreen++;
      }
    }
    expect(fatGreen).toBeLessThan(800);
  } finally {
    await harness.close();
  }
});
