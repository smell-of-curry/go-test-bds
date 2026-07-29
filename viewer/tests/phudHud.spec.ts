/**
 * DOM integration tests for the JSON-UI-faithful PokeBedrock HUD: raw phud
 * lane → sidebar / ping / currency banner / battle log, form lane → centered
 * vanilla modal and battle bar, formHover lane → hover affordance, waypoint
 * marks → locator strip. Same pushable-SSE harness as hud.spec.
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

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

interface Harness {
  base: string;
  streamUrl: string;
  broadcast: (frame: JsonlFrame) => void;
  close: () => Promise<void>;
}

/**
 * Vite app + pushable SSE fixture.
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
      () =>
        !document.querySelector<HTMLElement>('[data-jh="sidebar"]')?.hidden &&
        !document.querySelector<HTMLElement>('[data-jh="ping"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );

    const got = await page.evaluate(() => {
      const q = (sel: string): HTMLElement | null =>
        document.querySelector<HTMLElement>(sel);
      const slots = [...document.querySelectorAll("#json-hud .jh-slot")];
      const first = slots[0]!;
      return {
        ping: q('[data-jh="ping"]')?.textContent ?? "",
        pingColor:
          q('[data-jh="ping"] span:last-child')?.style.color.toLowerCase() ??
          "",
        banner: q('[data-jh="banner"]')?.textContent ?? "",
        currency: q('[data-jh="currency"]')?.textContent ?? "",
        currencyGlyphs: document.querySelectorAll(
          '[data-jh="currency"] .jh-glyph',
        ).length,
        slotCount: slots.length,
        firstName: first.querySelector(".jh-slot-name")?.textContent ?? "",
        firstStats: first.querySelector(".jh-slot-stats")?.textContent ?? "",
        firstSelected: first.classList.contains("selected"),
        // clip 37 = hidden fraction → 63% visible.
        firstXp:
          first.querySelector<HTMLElement>(".jh-slot-xp-fill")?.style.width ??
          "",
        emptyPlates: slots.slice(1).filter((s) => s.querySelector(".jh-plate"))
          .length,
      };
    });

    expect(got.ping).toContain("Current Ping:");
    expect(got.ping).toContain("63");
    expect(got.pingColor).toMatch(/85, 255, 85|#55ff55/);
    expect(got.banner).toContain("Buy Ranks, Crates, and more at");
    expect(got.currency).toContain("1.00K");
    expect(got.currencyGlyphs).toBe(1);
    expect(got.slotCount).toBe(6);
    expect(got.firstName).toContain("Bulbasaur");
    expect(got.firstStats).toContain("HP: 20/20");
    expect(got.firstSelected).toBe(true);
    expect(got.firstXp).toBe("63%");
    expect(got.emptyPlates).toBe(0);

    // Clearing a token hides its element.
    h.broadcast(phudFrame("playerPing", "", 160));
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('[data-jh="ping"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
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
          title: "",
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
        !document.querySelector<HTMLElement>('[data-jh="battlebar"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );

    const got = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-jh="battlebar"]')!;
      return {
        formHidden:
          document.querySelector<HTMLElement>('[data-jh="form"]')!.hidden,
        moves: [...bar.querySelectorAll(".jh-move")].map((m) => ({
          name: m.querySelector(".jh-move-plate")?.textContent ?? "",
          pp: m.querySelector(".jh-move-pp-text")?.textContent ?? "",
          fill:
            m.querySelector<HTMLElement>(".jh-move-pp-fill")?.style.width ?? "",
          disabled: m.classList.contains("disabled"),
        })),
        tabs: [...bar.querySelectorAll(".jh-battle-tab")].map(
          (t) => (t as HTMLElement).dataset.kind,
        ),
        hasBall: !!bar.querySelector(".jh-battle-ball"),
        info: [...bar.querySelectorAll(".jh-battle-info-line")].map(
          (l) => l.textContent,
        ),
      };
    });

    expect(got.formHidden).toBe(true);
    expect(got.moves.map((m) => m.name)).toEqual([
      "Growl",
      "Water Gun",
      "Pound",
    ]);
    expect(got.moves[0]?.pp).toBe("40/40");
    expect(got.moves[0]?.fill).toBe("100%");
    expect(got.moves[2]?.disabled).toBe(true);
    expect(got.moves[2]?.fill).toBe("50%");
    expect(got.tabs).toEqual(["bag", "pokemon", "run"]);
    expect(got.hasBall).toBe(true);
    expect(got.info).toEqual([
      "Turn 1",
      "No Turn Timer",
      "WeatherClear",
      "No Terrain",
    ]);

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
        document
          .querySelectorAll('[data-jh="battlebar"] .jh-move')[1]
          ?.classList.contains("hovered"),
      undefined,
      { timeout: 10_000 },
    );

    // Closing the form hides the bar and drops the hover.
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 160,
      ui: {},
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>('[data-jh="battlebar"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
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
      () => !document.querySelector<HTMLElement>('[data-jh="form"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );

    const got = await page.evaluate(() => {
      const form = document.querySelector<HTMLElement>('[data-jh="form"]')!;
      return {
        title: form.querySelector(".jh-form-title")?.textContent ?? "",
        buttons: [...form.querySelectorAll(".jh-form-button")].map(
          (b) => b.textContent,
        ),
        icons: [...form.querySelectorAll(".jh-form-row-icon")].map((i) =>
          (i as HTMLElement).style.backgroundImage.includes("textures/items"),
        ),
        debugPanelSuppressed:
          document.body.classList.contains("jh-owns-forms") &&
          getComputedStyle(document.getElementById("ui-panel")!).display ===
            "none",
      };
    });

    expect(got.title).toContain("Bag Menu");
    expect(got.buttons).toEqual(["HP/PP Restore", "Poké Balls", "Back"]);
    expect(got.icons).toEqual([true, true]);
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
        document
          .querySelectorAll('[data-jh="form"] .jh-form-button')[1]
          ?.classList.contains("hovered"),
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
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
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLElement>('[data-jh="battlelog"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll(".jh-battlelog-line")].map(
        (l) => l.textContent,
      ),
    );
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("== Turn: 1 ==");

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
      { timeout: 10_000 },
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
    }));
    // Fixture actor stands at [8.5, 65, 8.5] → 10 blocks along +X.
    expect(wp.text).toBe("10m · PokeCenter");
    expect(wp.hasArrow).toBe(true);
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
      { timeout: 10_000 },
    );
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});
