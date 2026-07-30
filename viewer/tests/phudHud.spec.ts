/**
 * DOM integration tests for the pack-driven JSON UI HUD: phud lanes →
 * sidebar / ping / currency, form lane → battle screen + long_form modal,
 * formHover → hover class, battleWait + subtitle → battle_wait, waypoint
 * marks → standalone locator strip. Same pushable-SSE harness as hud.spec,
 * plus testdata/jsonui packs on the stream origin.
 */
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
import { handleJsonUiPackRequest } from "./jsonuiPackServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

/** Battle title flag (forms.ts FORM_FLAG_ROUTES → battle.main). */
const BATTLE_FLAG = "§b§a§t§l§e";

interface Harness {
  base: string;
  streamUrl: string;
  broadcast: (frame: JsonlFrame) => void;
  close: () => Promise<void>;
}

/**
 * Vite app + pushable SSE fixture + JSON UI pack HTTP on the stream origin.
 *
 * @returns live URLs and a broadcast handle.
 */
async function startHarness(): Promise<Harness> {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello");
  const keyframe = all.find((f) => f.type === "keyframe");
  if (!hello || !keyframe) throw new Error("testdata missing hello/keyframe");

  const stream = createPushableStream([hello, keyframe]);
  const vite: ViteDevServer = await createServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("vite has no local URL");

  const http: Server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/stream") {
        stream.handle(req, res);
        return;
      }
      if (handleJsonUiPackRequest(req, res)) return;
      res.writeHead(404);
      res.end("not found");
    },
  );
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
      await Promise.race([
        new Promise<void>((resolve, reject) =>
          http.close((err) => (err ? reject(err) : resolve())),
        ),
        new Promise<void>((r) => setTimeout(r, 2_000)),
      ]).catch(() => undefined);
      await Promise.race([
        vite.close(),
        new Promise<void>((r) => setTimeout(r, 2_000)),
      ]).catch(() => undefined);
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
}

/**
 * @param token - PHUD token.
 * @param value - Token value.
 * @param tick - Frame tick.
 * @returns a phud event-lane frame.
 */
function phudFrame(token: string, value: string, tick = 150): JsonlFrame {
  return {
    v: 1,
    type: "phud",
    bot: "TestBot",
    tick,
    token,
    value,
  } as JsonlFrame;
}

const EMPTY_SLOT = ["null", "null", "null", "false", "empty", "null", "100"];

/**
 * @param slots - Per-slot 7-field arrays (feeder shape).
 * @returns the packed sidebar payload.
 */
function packSidebar(slots: string[][]): string {
  return slots
    .flat()
    .map((v) => v.padEnd(120, "|"))
    .join("|");
}

/**
 * @param slot - Move slot 1–4.
 * @param type - Lowercase type name.
 * @param moveId - Showdown move id.
 * @param pp - `pp/maxpp`.
 * @param display - Display text after the encoding.
 * @returns a battle move button label.
 */
function moveLabel(
  slot: number,
  type: string,
  moveId: string,
  pp: string,
  display: string,
): string {
  const data = [type, `.${moveId}`, pp].map((v) => v.padEnd(30, "_")).join(" ");
  return `b:${slot}_${data}${display}`;
}

test("phud lanes render ping, banner+currency and the sidebar", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    h.broadcast(phudFrame("playerPing", "§a63"));
    h.broadcast(
      phudFrame(
        "currency",
        "Buy Ranks, Crates, and more at §spokebedrock.com/shop§r".padEnd(
          80,
          "_",
        ) + " \ue10e 1.00K",
      ),
    );
    h.broadcast(
      phudFrame(
        "sidebar",
        packSidebar([
          [
            "HP: 20/20§r§f Lv. 11",
            "§fBulbasaur",
            "bulbasaur",
            "true",
            "poke",
            "default/bulbasaur",
            "37",
          ],
          EMPTY_SLOT,
          EMPTY_SLOT,
          EMPTY_SLOT,
          EMPTY_SLOT,
          EMPTY_SLOT,
        ]),
      ),
    );

    await page.waitForFunction(
      () => {
        const dock = document.querySelector(
          '[data-jsonui-name="phud_sidebar.dock"]',
        );
        const ping = document.querySelector(
          '[data-jsonui-name="player_ping.main"]',
        );
        if (!dock || !ping) return false;
        const pingVisible = getComputedStyle(ping).display !== "none";
        return pingVisible && (dock.textContent ?? "").includes("Bulbasaur");
      },
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate(() => {
      const docks = document.querySelectorAll(
        '[data-jsonui-name="phud_sidebar.dock"]',
      );
      const ping = document.querySelector<HTMLElement>(
        '[data-jsonui-name="player_ping.main"]',
      );
      const currencyRoot = document.querySelector<HTMLElement>(
        '[data-jsonui-name="phud_currency.main"]',
      );
      const quest = document.querySelector(
        '[data-jsonui-name="phud_currency.quest"]',
      );
      const currency = document.querySelector(
        '[data-jsonui-name="phud_currency.currency"]',
      );
      // §a green lands on a format-code <span>, not the label's own color prop.
      const valueLabel = ping?.querySelector(
        '[data-jsonui-name="player_ping.value_text"]',
      ) as HTMLElement | null;
      const valueSpan = valueLabel?.querySelector("span") as HTMLElement | null;
      return {
        dockCount: docks.length,
        dockText: docks[0]?.textContent ?? "",
        pingText: ping?.textContent ?? "",
        pingColor: (
          valueSpan?.style.color ||
          valueLabel?.style.color ||
          ""
        ).toLowerCase(),
        banner: quest?.textContent ?? "",
        currency: currency?.textContent ?? "",
        currencyHostText: currencyRoot?.textContent ?? "",
        noRawTitle: ![...document.querySelectorAll(".jsonui")].some((el) =>
          /^&_[A-Za-z]+:/.test((el.textContent ?? "").trim()),
        ),
      };
    });

    expect(got.dockCount).toBe(1);
    expect(got.dockText).toContain("Bulbasaur");
    expect(got.dockText).toMatch(/Lv\.?\s*11|HP:\s*20\/20/);
    expect(got.pingText).toContain("63");
    // localize:true leaves the lang key in the fixture engine.
    expect(got.pingText).toMatch(/phud\.playerPing\.label|Current Ping/);
    expect(got.pingColor).toMatch(/85, 255, 85|#55ff55/);
    expect(got.banner).toContain("Buy Ranks, Crates, and more at");
    expect(got.currencyHostText).toContain("1.00K");
    expect(got.noRawTitle).toBe(true);

    // Clearing a token hides its element (visible:false → display:none).
    h.broadcast(phudFrame("playerPing", "", 160));
    await page.waitForFunction(
      () => {
        const ping = document.querySelector<HTMLElement>(
          '[data-jsonui-name="player_ping.main"]',
        );
        return !ping || getComputedStyle(ping).display === "none";
      },
      undefined,
      { timeout: 15_000 },
    );
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]).catch(() => undefined);
  }
});

test("battle form renders the bottom battle bar and hover follows formHover", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 150,
      ui: {
        form: {
          type: "menu",
          title: `${BATTLE_FLAG}§s§m`,
          content: "Turn 1\n\nNo Turn Timer\n\nWeatherClear\n\nNo Terrain",
          buttons: [
            moveLabel(1, "normal", "growl", "40/40", "§lGrowl§r\ndesc"),
            moveLabel(2, "water", "watergun", "25/25", "§lWater Gun§r\ndesc"),
            moveLabel(3, "normal", "pound", "35/35", "§lPound§r\ndesc"),
            "battleButton:bagBag",
            "battleButton:pokemonSwitch Pokémon",
            "battleButton:runRun",
            "battleButton:move_selection",
          ],
          buttonImages: [
            "t__20",
            "t__20",
            "f__10",
            "t",
            "t",
            "t",
            "t:_default",
          ],
        },
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-jsonui-name="battle.main"]') &&
        document.querySelectorAll("[data-collection-index]").length > 0,
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      )!;
      const idxs = [
        ...battle.querySelectorAll<HTMLElement>("[data-collection-index]"),
      ].map((el) => el.dataset.collectionIndex);
      const unique = [...new Set(idxs)];
      const body = battle.textContent ?? "";
      return {
        uniqueIndexes: unique.sort(),
        hasGrowl: /growl/i.test(body),
        hasWater: /water\s*gun|watergun/i.test(body),
        hasPound: /pound/i.test(body),
        info: body.includes("Turn 1") && body.includes("WeatherClear"),
        longFormAbsent: !document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ),
      };
    });

    expect(got.hasGrowl).toBe(true);
    expect(got.hasWater).toBe(true);
    expect(got.hasPound).toBe(true);
    expect(got.info).toBe(true);
    expect(got.uniqueIndexes).toEqual(
      expect.arrayContaining(["0", "1", "2", "3", "4", "5", "6"]),
    );

    // Bottom bar: action buttons on-screen; tinted faces must not paint a
    // solid white/colored slab when textures 404.
    const bar = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      ) as HTMLElement;
      const menu = battle.querySelector(
        '.jsonui[data-ui-name="battle_menu"]',
      ) as HTMLElement | null;
      // First bag_button in DOM is often a hidden factory sibling —
      // pick a painted instance (display not none, non-zero box).
      const bag = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="bag_button"]',
        ),
      ].find((el) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const moves = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="grid_button_check_id"]',
        ),
      ].filter((el) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const faces = [
        ...battle.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ];
      const solidFace = faces.some((f) => {
        const bg = f.style.backgroundColor;
        return (
          !!bg &&
          bg !== "transparent" &&
          bg !== "rgba(0, 0, 0, 0)" &&
          !f.style.backgroundImage &&
          !f.style.filter
        );
      });
      const menuBox = menu?.getBoundingClientRect();
      const bagBox = bag?.getBoundingClientRect();
      return {
        moveVisible: moves.length,
        bagOnScreen:
          !!bagBox &&
          bagBox.width > 0 &&
          bagBox.height > 0 &&
          bagBox.bottom > 0 &&
          bagBox.top < window.innerHeight,
        menuH: menuBox?.height ?? 0,
        solidFace,
      };
    });
    expect(bar.moveVisible).toBeGreaterThanOrEqual(3);
    expect(bar.bagOnScreen).toBe(true);
    expect(bar.menuH).toBeGreaterThan(40);
    expect(bar.solidFace).toBe(false);

    // Hover the second move button (index 1 on the form).
    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 1,
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-collection-index="1"].jsonui-form-hovered',
        ),
      undefined,
      { timeout: 15_000 },
    );

    // Closing the form clears the battle screen.
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 160,
      ui: {},
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () => !document.querySelector('[data-jsonui-name="battle.main"]'),
      undefined,
      { timeout: 15_000 },
    );
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]).catch(() => undefined);
  }
});

test("ordinary server form renders the centered vanilla modal with icons", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 150,
      ui: {
        form: {
          type: "menu",
          title: "Bag Menu",
          content: "",
          buttons: ["HP/PP Restore", "Poké Balls", "Back"],
          buttonImages: [
            "textures/items/potion",
            "textures/items/pokeball",
            "",
          ],
        },
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-jsonui-name="server_form.long_form"]'),
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate(() => {
      const form = document.querySelector(
        '[data-jsonui-name="server_form.long_form"]',
      )!;
      const text = form.textContent ?? "";
      const images = [
        ...form.querySelectorAll<HTMLElement>(
          ".jsonui-image, .jsonui-image-face",
        ),
      ].filter((el) =>
        (el.style.backgroundImage || "").includes("textures/items"),
      );
      return {
        title: text.includes("Bag Menu"),
        buttons:
          text.includes("HP/PP Restore") &&
          text.includes("Poké Balls") &&
          text.includes("Back"),
        iconCount: images.length,
        debugPanelSuppressed:
          document.body.classList.contains("jh-owns-forms") &&
          getComputedStyle(document.getElementById("ui-panel")!).display ===
            "none",
      };
    });

    expect(got.title).toBe(true);
    expect(got.buttons).toBe(true);
    expect(got.iconCount).toBeGreaterThanOrEqual(2);
    expect(got.debugPanelSuppressed).toBe(true);

    // Hover the middle row.
    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 1,
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-collection-index="1"].jsonui-form-hovered',
        ),
      undefined,
      { timeout: 15_000 },
    );
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]).catch(() => undefined);
  }
});

test("starter picker long_form paints all image buttons inside the scroll body", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    const starters = [
      "Bulbasaur",
      "Ivysaur",
      "Venusaur",
      "Charmander",
      "Charmeleon",
      "Charizard",
      "Squirtle",
      "Wartortle",
      "Blastoise",
    ];
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 150,
      ui: {
        form: {
          type: "menu",
          title: "Choose Your Starter!",
          content: "Pick a Pokemon to begin your journey.",
          buttons: starters,
          buttonImages: starters.map(() => "textures/items/poke_ball"),
        },
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ) &&
        (
          document.querySelector('[data-jsonui-name="server_form.long_form"]')
            ?.textContent ?? ""
        ).includes("Bulbasaur"),
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate((names: string[]) => {
      const form = document.querySelector(
        '[data-jsonui-name="server_form.long_form"]',
      )!;
      const text = form.textContent ?? "";
      const idxs = [
        ...form.querySelectorAll<HTMLElement>("[data-collection-index]"),
      ].map((el) => Number(el.dataset.collectionIndex));
      const unique = [...new Set(idxs)].sort((a, b) => a - b);
      // Scroll viewport must not collapse to a zero-width sliver.
      const viewport = form.querySelector(
        '.jsonui[data-ui-name="scrolling_view_port"]',
      ) as HTMLElement | null;
      const vw = viewport?.getBoundingClientRect().width ?? 0;
      return {
        allLabels: names.every((n) => text.includes(n)),
        unique,
        viewportW: vw,
      };
    }, starters);

    expect(got.allLabels).toBe(true);
    expect(got.unique).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(got.viewportW).toBeGreaterThan(120);

    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 3,
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-collection-index="3"].jsonui-form-hovered',
        ),
      undefined,
      { timeout: 15_000 },
    );
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]).catch(() => undefined);
  }
});

test("battleWait renders the log panel; waypoint marks drive the locator strip", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    h.broadcast(
      phudFrame(
        "battleWait",
        "Smell of curry sent out Quaxly!\nA Bulbasaur appeared!\n== Turn: 1 ==\nBulbasaur Used §lTackle§r!",
      ),
    );
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 151,
      ui: {
        subtitle: "Turn 1\nSunny",
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () => {
        const bw = document.querySelector<HTMLElement>(
          '[data-jsonui-name="phud_battleWait.main"]',
        );
        if (!bw || getComputedStyle(bw).display === "none") return false;
        return (bw.textContent ?? "").includes("== Turn: 1 ==");
      },
      undefined,
      { timeout: 15_000 },
    );
    const battleWait = await page.evaluate(() => {
      const bw = document.querySelector(
        '[data-jsonui-name="phud_battleWait.main"]',
      )!;
      const text = bw.textContent ?? "";
      return {
        hasLog: text.includes("Smell of curry sent out Quaxly!"),
        hasTurn: text.includes("== Turn: 1 =="),
        hasSubtitle: text.includes("Sunny") || text.includes("Turn 1"),
      };
    });
    expect(battleWait.hasLog).toBe(true);
    expect(battleWait.hasTurn).toBe(true);
    expect(battleWait.hasSubtitle).toBe(true);

    // Waypoint strip: appears with distance + label, clears on "clear".
    h.broadcast({
      v: 1,
      type: "mark",
      bot: "TestBot",
      tick: 160,
      phase: "waypoint",
      message: "18.5,65,8.5|PokeCenter",
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLElement>('[data-jh="waypoint"]')?.hidden,
      undefined,
      { timeout: 15_000 },
    );
    const wp = await page.evaluate(() => ({
      text:
        document.querySelector('[data-jh="waypoint"] .jh-waypoint-text')
          ?.textContent ?? "",
      hasArrow: !!document.querySelector(
        '[data-jh="waypoint"] .jh-waypoint-arrow',
      ),
      captionVisible: document
        .getElementById("caption")!
        .classList.contains("visible"),
      underStrip: !!document.getElementById("waypoint-strip"),
    }));
    // Fixture actor stands at [8.5, 65, 8.5] → 10 blocks along +X.
    expect(wp.text).toBe("10m · PokeCenter");
    expect(wp.hasArrow).toBe(true);
    expect(wp.underStrip).toBe(true);
    // A waypoint mark must not hijack the run-lifecycle caption band.
    expect(wp.captionVisible).toBe(false);

    h.broadcast({
      v: 1,
      type: "mark",
      bot: "TestBot",
      tick: 170,
      phase: "waypoint",
      message: "clear",
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('[data-jh="waypoint"]')?.hidden,
      undefined,
      { timeout: 15_000 },
    );
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]).catch(() => undefined);
  }
});
