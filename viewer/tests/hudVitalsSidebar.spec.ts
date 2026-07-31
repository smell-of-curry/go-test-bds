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
      // active_icon@variable_parser stamps name `variable_parser`, not
      // `active_icon` — find rings by texture path.
      const rings = [
        ...document.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ].filter((face) => {
        const bg = face.style.backgroundImage ?? "";
        if (!bg.includes("sidebar/ring")) return false;
        const host = face.closest(".jsonui") as HTMLElement | null;
        if (!host) return false;
        return getComputedStyle(host).display !== "none";
      });
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
      const ringHost = rings[0]?.closest(".jsonui") as HTMLElement | null;
      const ringBox = ringHost?.getBoundingClientRect();
      const nameEl = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].find((el) => (el.textContent ?? "").includes("Bulbasaur"));
      const nr = nameEl?.getBoundingClientRect();
      return {
        plateCount: dataPlates.length,
        ballCount: balls.length,
        ringCount: rings.length,
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
        ringRight: ringBox ? ringBox.x + ringBox.width : 0,
        nameText: nameEl?.textContent ?? "",
      };
    });

    expect(info.dockText).toContain("Bulbasaur");
    expect(info.dockText).not.toMatch(/\|{3,}/);
    expect(info.plateCount).toBe(1);
    expect(info.ballCount).toBe(1);
    // Empty slots send active="false"; only the selected occupied slot rings.
    expect(info.ringCount).toBe(1);
    expect(info.bubbleCount).toBe(0);
    expect(info.armorCount).toBe(0);
    expect(info.xpCount).toBe(0);
    expect(info.titleBgCount).toBe(0);
    expect(info.nameText).toContain("Bulbasaur");
    expect(info.hostWidth).toBeGreaterThan(100);
    expect(info.plateLeft).toBeGreaterThan(0);
    // Opaque data.png pad (~x29–227 of 245) must sit inside the host with a
    // small margin — flush-cut at hostRight means dock offset math still wrong.
    expect(info.plateRight).toBeLessThanOrEqual(info.hostRight - 4);
    expect(info.nameRight).toBeLessThanOrEqual(info.hostRight - 4);
    expect(info.ringRight ?? 0).toBeLessThanOrEqual(info.hostRight - 2);

    const hunger = await page.evaluate(() => {
      const host = document.querySelector(
        '.jsonui[data-ui-name="hunger_renderer"]',
      ) as HTMLElement | null;
      if (!host || getComputedStyle(host).display === "none")
        return { count: 0, urls: [] as string[] };
      const urls = [...host.querySelectorAll<HTMLElement>(":scope > div")].map(
        (d) => d.style.backgroundImage,
      );
      return { count: urls.length, urls };
    });
    expect(hunger.count).toBeGreaterThan(0);
    expect(hunger.urls.every((u) => u.includes("hunger_"))).toBe(true);
    expect(hunger.urls.some((u) => u.includes("hunger_empty"))).toBe(false);
    expect(
      hunger.urls.some(
        (u) => u.includes("hunger_full") || u.includes("hunger_half"),
      ),
    ).toBe(true);

    // Sidebar-only: loadingScreen dirt must stay hidden.
    const loadingHidden = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-jsonui-name="phud_loadingScreen.main"]',
      ) as HTMLElement | null;
      if (!el) return true;
      return getComputedStyle(el).display === "none";
    });
    expect(loadingHidden).toBe(true);

    // Live run-43: player_ping.main Black.png bloated to ~608×580 via broken
    // %c AABB (origin padding). Tip must hug the label row.
    await page.evaluate(() => {
      (
        window as unknown as {
          __jsonUi: {
            setHud: (
              phud: Record<string, string>,
              v: {
                v: 1;
                type: "vitals";
                bot: string;
                tick: number;
                health: number;
                maxHealth: number;
                food: number;
                air: number;
                maxAir: number;
                xpLevel: number;
                xpProgress: number;
                selectedSlot: number;
                hotbar: null[];
              },
            ) => void;
          };
        }
      ).__jsonUi.setHud(
        { playerPing: "§a0" },
        {
          v: 1,
          type: "vitals",
          bot: "TestBot",
          tick: 4,
          health: 20,
          maxHealth: 20,
          food: 18,
          air: 300,
          maxAir: 300,
          xpLevel: 0,
          xpProgress: 0,
          selectedSlot: 0,
          hotbar: Array.from({ length: 9 }, () => null),
        },
      );
    });
    const pingBox = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-jsonui-name="player_ping.main"]',
      ) as HTMLElement | null;
      if (!el || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, y: r.y, bottom: r.bottom };
    });
    expect(pingBox).not.toBeNull();
    expect(pingBox!.h).toBeLessThan(40);
    expect(pingBox!.w).toBeLessThan(280);
    // Pack mounts ping under chat_stack (top_left), not tip bottom_middle.
    const hostBox = await page.evaluate(() => {
      const host = document.getElementById("host");
      return {
        w: host?.clientWidth ?? 1280,
        h: host?.clientHeight ?? 720,
      };
    });
    expect(pingBox!.y).toBeLessThan(hostBox.h * 0.25);
    expect(pingBox!.x).toBeLessThan(hostBox.w * 0.25);

    // Live land glitch: AirSupply=0 must not paint a bubble row.
    await page.evaluate(() => {
      (
        window as unknown as {
          __jsonUi: {
            setHud: (
              phud: Record<string, string>,
              v: {
                v: 1;
                type: "vitals";
                bot: string;
                tick: number;
                health: number;
                maxHealth: number;
                food: number;
                air: number;
                maxAir: number;
                armor?: number;
                xpLevel: number;
                xpProgress: number;
                selectedSlot: number;
                hotbar: null[];
              },
            ) => void;
          };
        }
      ).__jsonUi.setHud(
        {},
        {
          v: 1,
          type: "vitals",
          bot: "TestBot",
          tick: 3,
          health: 20,
          maxHealth: 20,
          food: 18,
          air: 0,
          maxAir: 300,
          xpLevel: 0,
          xpProgress: 0,
          selectedSlot: 0,
          hotbar: Array.from({ length: 9 }, () => null),
        },
      );
    });
    const afterAir0 = await page.evaluate(() => {
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
      const titleBg = [
        ...document.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="title_background"], .jsonui[data-ui-name="subtitle_background"]',
        ),
      ].filter((el) => getComputedStyle(el).display !== "none");
      return {
        bubbleCount: bubbles.length,
        armorCount: armor.length,
        titleBgCount: titleBg.length,
      };
    });
    expect(afterAir0.bubbleCount).toBe(0);
    expect(afterAir0.armorCount).toBe(0);
    expect(afterAir0.titleBgCount).toBe(0);

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

test("loadingScreen PHUD paints TUTORIAL COMPLETE over sidebar", async ({
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
    const sidebar = [
      [
        "HP: 20/20§r§f Lv. 5",
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

    // BEH PlayerTutorial.celebrateCompletion setLoadingScreen payload.
    const loadingScreen =
      "§l§6TUTORIAL COMPLETE!\n\n§eWelcome to Season 5 of Pokébedrock!";

    await page.evaluate(
      ({ sidebar, loadingScreen, vitals }) => {
        (
          window as unknown as {
            __jsonUi: {
              setHud: (phud: Record<string, string>, v: typeof vitals) => void;
            };
          }
        ).__jsonUi.setHud({ sidebar, loadingScreen }, vitals);
      },
      {
        sidebar,
        loadingScreen,
        vitals: {
          v: 1 as const,
          type: "vitals" as const,
          bot: "TestBot",
          tick: 2,
          health: 20,
          maxHealth: 20,
          food: 20,
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
          document.querySelector('[data-jsonui-name="phud_loadingScreen.main"]')
            ?.textContent ?? ""
        ).includes("TUTORIAL COMPLETE"),
      undefined,
      { timeout: 15_000 },
    );

    const card = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-jsonui-name="phud_loadingScreen.main"]',
      ) as HTMLElement | null;
      if (!el) return { visible: false, text: "", w: 0, h: 0 };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        visible: cs.display !== "none" && cs.visibility !== "hidden",
        text: el.textContent ?? "",
        w: r.width,
        h: r.height,
      };
    });
    expect(card.visible).toBe(true);
    expect(card.text).toContain("TUTORIAL COMPLETE");
    expect(card.text).toContain("Welcome to Season 5");
    expect(card.w).toBeGreaterThan(400);
    expect(card.h).toBeGreaterThan(200);

    // Second line must actually paint (not clipped by single-line label box).
    const welcomeVisible = await page.evaluate(() => {
      const label = document.querySelector(
        '[data-jsonui-name="phud_loadingScreen.main"] .jsonui[data-ui-type="label"]',
      ) as HTMLElement | null;
      if (!label) return false;
      const r = label.getBoundingClientRect();
      return r.height >= 36 && (label.textContent ?? "").includes("Welcome");
    });
    expect(welcomeVisible).toBe(true);
  } finally {
    await harness.close();
  }
});

test("hearts sit above hotbar; quest-only currency hides coin chip", async ({
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
    const sidebar = [
      [
        "HP: 20/20§r§f Lv. 5",
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

    // Quest banner only — no currency half after the 80-char pad.
    const currency = "Go see Professor Oak at the lab".padEnd(80, "_");

    await page.evaluate(
      ({ sidebar, currency, vitals }) => {
        (
          window as unknown as {
            __jsonUi: {
              setHud: (phud: Record<string, string>, v: typeof vitals) => void;
            };
          }
        ).__jsonUi.setHud(
          { sidebar, currency, playerPing: "§a0", phone: "" },
          vitals,
        );
      },
      {
        sidebar,
        currency,
        vitals: {
          v: 1 as const,
          type: "vitals" as const,
          bot: "TestBot",
          tick: 3,
          health: 16,
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
        !!document.querySelector('[data-jsonui-name="hud.heart_renderer"]') &&
        !!document.querySelector('[data-jsonui-name="hud.hotbar_panel"]'),
      undefined,
      { timeout: 15_000 },
    );

    const layout = await page.evaluate(() => {
      const heart = document.querySelector(
        '[data-jsonui-name="hud.heart_renderer"]',
      ) as HTMLElement | null;
      const hotbar = document.querySelector(
        '[data-jsonui-name="hud.hotbar_panel"]',
      ) as HTMLElement | null;
      const currency = document.querySelector(
        '[data-jsonui-name="phud_currency.currency"]',
      ) as HTMLElement | null;
      const quest = document.querySelector(
        '[data-jsonui-name="phud_currency.quest"]',
      ) as HTMLElement | null;
      const phone = document.querySelector(
        '[data-jsonui-name="phud_phone.main"]',
      ) as HTMLElement | null;
      const plates = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].filter((el) => {
        const bg = getComputedStyle(el as HTMLElement).backgroundImage;
        return bg.includes("sidebar/data");
      });
      const rings = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].filter((el) => {
        const bg = getComputedStyle(el as HTMLElement).backgroundImage;
        return bg.includes("sidebar/ring");
      });
      // data.png / ring.png are on image faces inside variable_parser hosts.
      const dataFaces = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.variable_parser"] .jsonui-image-face',
        ),
      ].filter((el) =>
        (el as HTMLElement).style.backgroundImage.includes("sidebar/data"),
      );
      const ringFaces = [
        ...document.querySelectorAll(
          '[data-jsonui-name="phud_sidebar.variable_parser"] .jsonui-image-face, [data-jsonui-name="phud_sidebar.pokemon_selected_indicator"] .jsonui-image-face',
        ),
      ].filter((el) =>
        (el as HTMLElement).style.backgroundImage.includes("sidebar/ring"),
      );
      const hr = heart?.getBoundingClientRect();
      const hb = hotbar?.getBoundingClientRect();
      return {
        heartBottom: hr?.bottom ?? 0,
        hotbarTop: hb?.top ?? 0,
        currencyHidden:
          !currency || getComputedStyle(currency).display === "none",
        questText: quest?.textContent ?? "",
        phoneHidden: !phone || getComputedStyle(phone).display === "none",
        dataPlateCount: dataFaces.length || plates.length,
        ringCount: ringFaces.length || rings.length,
      };
    });

    expect(layout.heartBottom).toBeGreaterThan(0);
    expect(layout.hotbarTop).toBeGreaterThan(0);
    // Hearts row ends above the hotbar (run-44 had them on the same y).
    expect(layout.heartBottom).toBeLessThanOrEqual(layout.hotbarTop + 2);
    expect(layout.currencyHidden).toBe(true);
    expect(layout.questText).toContain("Professor Oak");
    expect(layout.phoneHidden).toBe(true);
    // Authored: empty slots keep row height + dock, but no plate/ring paint.
    expect(layout.dataPlateCount).toBe(1);
    expect(layout.ringCount).toBe(1);
  } finally {
    await harness.close();
  }
});

test("HUD placement: full root, hotbar floor, top chips, ping top-left", async ({
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
    const sidebar = [
      [
        "HP: 20/20§r§f Lv. 5",
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
    const currency = "Go see Professor Oak at the lab".padEnd(80, "_");

    await page.evaluate(
      ({ sidebar, currency, vitals }) => {
        (
          window as unknown as {
            __jsonUi: {
              setHud: (phud: Record<string, string>, v: typeof vitals) => void;
            };
          }
        ).__jsonUi.setHud(
          { sidebar, currency, playerPing: "§a0", phone: "" },
          vitals,
        );
      },
      {
        sidebar,
        currency,
        vitals: {
          v: 1 as const,
          type: "vitals" as const,
          bot: "TestBot",
          tick: 3,
          health: 16,
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
        !!document.querySelector('[data-jsonui-name="hud.hotbar_panel"]') &&
        !!document.querySelector('[data-jsonui-name="phud_currency.quest"]') &&
        !!document.querySelector('[data-jsonui-name="player_ping.main"]'),
      undefined,
      { timeout: 15_000 },
    );

    const place = await page.evaluate(() => {
      const host = document.getElementById("host")!;
      const hostH = host.clientHeight;
      const hostW = host.clientWidth;
      const rect = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el || getComputedStyle(el).display === "none") return null;
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        return {
          x: r.left - hr.left,
          y: r.top - hr.top,
          w: r.width,
          h: r.height,
          bottom: r.bottom - hr.top,
        };
      };
      return {
        hostW,
        hostH,
        elements: rect('[data-jsonui-name="phud.elements"]'),
        hotbar: rect('[data-jsonui-name="hud.hotbar_panel"]'),
        quest: rect('[data-jsonui-name="phud_currency.quest"]'),
        ping: rect('[data-jsonui-name="player_ping.main"]'),
      };
    });

    expect(place.elements).not.toBeNull();
    // Full-bleed positioning context (live bug: ~894×536 inset at y≈92).
    expect(place.elements!.x).toBeLessThanOrEqual(1);
    expect(place.elements!.y).toBeLessThanOrEqual(1);
    expect(place.elements!.w).toBeGreaterThanOrEqual(place.hostW - 2);
    expect(place.elements!.h).toBeGreaterThanOrEqual(place.hostH - 2);

    expect(place.hotbar).not.toBeNull();
    // Hotbar floor-flush (live bug: bottom ~622 on 720 → ~98px gap).
    expect(place.hotbar!.bottom).toBeGreaterThanOrEqual(place.hostH - 4);
    expect(place.hotbar!.bottom).toBeLessThanOrEqual(place.hostH + 2);

    expect(place.quest).not.toBeNull();
    // Quest chip hugs top (authored top_middle + offset [0,8] gui → ~16css).
    expect(place.quest!.y).toBeLessThan(40);

    expect(place.ping).not.toBeNull();
    expect(place.ping!.x).toBeLessThan(place.hostW * 0.25);
    expect(place.ping!.y).toBeLessThan(place.hostH * 0.25);
    // Must not sit inside the hotbar strip.
    expect(place.ping!.y).toBeLessThan(place.hotbar!.y - 20);
  } finally {
    await harness.close();
  }
});
