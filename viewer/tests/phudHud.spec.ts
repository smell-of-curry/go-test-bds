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
  // Live BattleUtils joins padded fields with NBSP (U+00A0).
  const data = [type, `.${moveId}`, pp]
    .map((v) => v.padEnd(30, "_"))
    .join("\u00A0");
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
    expect(got.pingText).toContain("Current Ping");
    expect(got.pingText).not.toContain("phud.playerPing.label");
    expect(got.pingColor).toMatch(/85, 255, 85|#55ff55/);
    expect(got.banner).toContain("Buy Ranks, Crates, and more at");
    expect(got.banner).not.toContain("_");
    expect(got.currencyHostText).toContain("1.00K");
    expect(got.currencyHostText).not.toMatch(/YouTube_+/);
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
            // Live Go flatten leaves translate keys when lang is missing;
            // JSON UI builds showdown.moves.<id>.name + localize:true.
            moveLabel(
              1,
              "normal",
              "growl",
              "40/40",
              "§lshowdown.moves.growl.name",
            ),
            moveLabel(
              2,
              "water",
              "watergun",
              "25/25",
              "§lshowdown.moves.watergun.name",
            ),
            moveLabel(
              3,
              "normal",
              "pound",
              "35/35",
              "§lshowdown.moves.pound.name",
            ),
            "battleButton:bagBag",
            "battleButton:pokemonSwitch Pokémon",
            "battleButton:runRun",
            "battleButton:move_selection",
            "§0§0§1§r§l§fBulbasaur§r\n Lv.5".padEnd(50, "_") + "G0.0⠀100%%",
            "§0§a§1§r§l§fMunchlax§r\n Lv.5".padEnd(50, "_") + "G0.0⠀100%%",
          ],
          buttonImages: [
            "t__20",
            "t__20",
            "f__10",
            "t",
            "t",
            "t",
            "t:_default",
            "textures/sprites/default/bulbasaur",
            "textures/sprites/default/munchlax",
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
      const moveNames = [
        ...battle.querySelectorAll<HTMLElement>('.jsonui[data-ui-name="name"]'),
      ]
        .filter((el) => {
          if (el.style.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 4;
        })
        .map((el) => (el.textContent ?? "").trim());
      return {
        uniqueIndexes: unique.sort(),
        moveNames,
        hasGrowl: moveNames.some((t) => t === "Growl"),
        hasWater: moveNames.some((t) => /water\s*gun/i.test(t)),
        hasPound: moveNames.some((t) => t === "Pound"),
        rawLangKey: moveNames.some((t) => t.includes("showdown.moves.")),
        info: body.includes("Turn 1") && body.includes("WeatherClear"),
        longFormAbsent: !document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ),
      };
    });

    expect(got.rawLangKey).toBe(false);
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

    // Live pack: button_grid_middle has alpha:0 on the image host — children
    // (move grid) must remain opaque (run-41 white-slab / empty-moves bug).
    const alphaHost = await page.evaluate(() => {
      const middle = document.querySelector(
        '[data-jsonui-name="battle.main"] .jsonui[data-ui-name="button_grid_middle"]',
      ) as HTMLElement | null;
      const face = middle?.querySelector(
        ":scope > .jsonui-image-face",
      ) as HTMLElement | null;
      const moves = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="battle.main"] .jsonui[data-ui-name="grid_button_check_id"]',
        ),
      ].filter((el) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 8;
      });
      return {
        hostOpacity: middle?.style.opacity || "1",
        faceOpacity: face?.style.opacity || "1",
        moveOnScreen: moves.length,
      };
    });
    expect(alphaHost.hostOpacity).toBe("1");
    expect(Number(alphaHost.faceOpacity)).toBe(0);
    expect(alphaHost.moveOnScreen).toBeGreaterThanOrEqual(3);

    // Actor plates: padEnd(50)→58 normalize keeps Lv. separate from G0.0;
    // plate STACKS (not bag/run chips) must sit fully inside the viewport.
    const plates = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      ) as HTMLElement;
      const details = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="details_text"]',
        ),
      ]
        .filter((el) => {
          if (el.style.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 4;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
            left: r.left,
            right: r.right,
          };
        });
      // guiScale 2 → battle_actor_button [90,42] ≈ 180×84 CSS px.
      const plateStacks = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="opponent_actor_details_button"], .jsonui[data-ui-name="ally_actor_details_button"]',
        ),
      ]
        .filter((el) => {
          if (el.style.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 20;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width };
        });
      const whiteTinted = [
        ...battle.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ].filter((f) => {
        const r = f.getBoundingClientRect();
        if (r.width < 30 || r.height < 12) return false;
        if (r.top < 350) return false;
        const filter = f.style.filter || "";
        return filter.includes("feFlood") && filter.includes("255, 255, 255");
      });
      return {
        details: details.map((d) => d.text),
        glued: details.some(
          (d) => /Lv\.\d+G/.test(d.text) || /G0\.0/.test(d.text),
        ),
        detailCount: details.length,
        plateCount: plateStacks.length,
        plateClipped: plateStacks.some(
          (p) => p.left < -1 || p.right > window.innerWidth + 1,
        ),
        whiteTinted: whiteTinted.length,
        hasMunchlax: details.some((d) => /Munchlax/i.test(d.text)),
        hasBulba: details.some((d) => /Bulbasaur/i.test(d.text)),
      };
    });
    expect(plates.glued).toBe(false);
    expect(plates.detailCount).toBeGreaterThanOrEqual(1);
    expect(plates.hasMunchlax || plates.hasBulba).toBe(true);
    expect(plates.plateCount).toBeGreaterThanOrEqual(1);
    expect(plates.plateClipped).toBe(false);
    expect(plates.whiteTinted).toBe(0);

    // Default button faces (not hover/locked) must paint; a lone white
    // focus/White slab was the live-pack regression.
    const faces = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      ) as HTMLElement;
      const moveFaces = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="grid_button_check_id"] .jsonui-image-face',
        ),
      ].filter((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && !!f.style.backgroundImage;
      });
      // Live regression was a full-size White/focus slab per move cell.
      // Battle chrome uses tinted `white_transparency` for the bar — ignore it.
      const whiteSlabs = [
        ...battle.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ].filter((f) => {
        const bg = f.style.backgroundImage || "";
        if (
          !/textures\/ui\/White(?:\.png)?["')]?/i.test(bg) &&
          !/focus_border_white/i.test(bg)
        ) {
          return false;
        }
        const r = f.getBoundingClientRect();
        return (
          r.width > 40 &&
          r.height > 40 &&
          getComputedStyle(f).display !== "none"
        );
      });
      return { moveFaces: moveFaces.length, whiteSlabs: whiteSlabs.length };
    });
    expect(faces.moveFaces).toBeGreaterThanOrEqual(1);
    expect(faces.whiteSlabs).toBe(0);

    // move_selection host is size 100% + offset 55%/20% — ball sits to the
    // RIGHT of the move list (run-44 dump had it clamped onto Growl).
    const moveChrome = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      ) as HTMLElement;
      const ball = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="move_selection_button"]',
        ),
      ].find((el) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      });
      const moveFaces = [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="grid_button_check_id"] .jsonui[data-ui-name="button"]',
        ),
      ]
        .filter((el) => {
          if (el.style.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 20;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        });
      const ballBox = ball?.getBoundingClientRect();
      const xs = [...new Set(moveFaces.map((m) => Math.round(m.x / 40) * 40))];
      const leftCol = moveFaces.filter((m) => m.x < 450);
      const leftYs = leftCol.map((m) => m.y).sort((a, b) => a - b);
      let minLeftGap = Infinity;
      for (let i = 1; i < leftYs.length; i++) {
        minLeftGap = Math.min(minLeftGap, leftYs[i]! - leftYs[i - 1]!);
      }
      return {
        ballX: ballBox?.x ?? -1,
        ballRight: ballBox?.right ?? -1,
        moveMaxRight: moveFaces.reduce((a, m) => Math.max(a, m.right), 0),
        moveMinX: moveFaces.reduce((a, m) => Math.min(a, m.x), Infinity),
        columnBuckets: xs.length,
        leftColCount: leftCol.length,
        minLeftGap: Number.isFinite(minLeftGap) ? minLeftGap : 0,
        ballOverlapsLeftMoves:
          !!ballBox &&
          leftCol.some(
            (m) =>
              ballBox.x < m.right - 8 &&
              ballBox.right > m.x + 8 &&
              ballBox.y < m.bottom - 8 &&
              ballBox.bottom > m.y + 8,
          ),
      };
    });
    expect(moveChrome.ballX).toBeGreaterThan(600);
    expect(moveChrome.ballOverlapsLeftMoves).toBe(false);
    // Pack grid_button: left column (-19%) + right column (21.5%).
    expect(moveChrome.columnBuckets).toBeGreaterThanOrEqual(2);
    expect(moveChrome.leftColCount).toBeGreaterThanOrEqual(1);

    // Inner move cards must not overlap (stack-compensated $offset path).
    const moveCards = await page.evaluate(() => {
      const battle = document.querySelector(
        '[data-jsonui-name="battle.main"]',
      ) as HTMLElement;
      return [
        ...battle.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="grid_button_check_id"] .jsonui[data-ui-name="button"]',
        ),
      ]
        .filter((el) => {
          if (el.style.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 15;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
    });
    // Fixture paints 4 move slots; keep a soft floor in case one card is
    // clipped by scale, but require a real grid (2+×2+) with zero overlap.
    expect(moveCards.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < moveCards.length; i++) {
      for (let j = i + 1; j < moveCards.length; j++) {
        const a = moveCards[i]!;
        const b = moveCards[j]!;
        const hit =
          a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y;
        expect(hit, `move cards ${i}/${j} overlap`).toBe(false);
      }
    }

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

test("starter picker pokemon.main_panel paints the live §p§o§k§e§1 grid", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openViewer(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    const starters = [
      "§lBulbasaur§r\n§7No. 001",
      "§lCharmander§r\n§7No. 004",
      "§lSquirtle§r\n§7No. 007",
      "§lChikorita§r\n§7No. 152",
      "§lCyndaquil§r\n§7No. 155",
      "§lTotodile§r\n§7No. 158",
      "",
      "",
      "§lShiny toggle",
    ];
    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 150,
      ui: {
        form: {
          type: "menu",
          // Live BEH starter picker title flag (routes to pokemon.main_panel).
          title: "§p§o§k§e§1",
          content: "",
          buttons: starters,
          buttonImages: [
            "textures/sprites/bulbasaur",
            "textures/sprites/charmander",
            "textures/sprites/squirtle",
            "textures/sprites/chikorita",
            "textures/sprites/cyndaquil",
            "textures/sprites/totodile",
            "",
            "",
            "textures/ui/icons/sparkle",
          ],
        },
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-jsonui-name="pokemon.main_panel"]') &&
        document.querySelectorAll(
          '[data-jsonui-name="pokemon.main_panel"] [data-collection-index]',
        ).length > 0,
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate(() => {
      const form = document.querySelector(
        '[data-jsonui-name="pokemon.main_panel"]',
      )!;
      const text = form.textContent ?? "";
      const idxs = [
        ...form.querySelectorAll<HTMLElement>("[data-collection-index]"),
      ].map((el) => Number(el.dataset.collectionIndex));
      const unique = [...new Set(idxs)].sort((a, b) => a - b);
      const grid = form.querySelector(
        '.jsonui[data-ui-name="picker_panel_grid"]',
      ) as HTMLElement | null;
      const gridBox = grid?.getBoundingClientRect();
      // Live pack sets alpha:0 on button_panel (image chrome only). Container
      // opacity must stay 1 so children paint.
      const panel = form.querySelector(
        '.jsonui[data-ui-name="button_panel"]',
      ) as HTMLElement | null;
      const painted = [
        ...form.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="picker_panel_grid"] .jsonui',
        ),
      ].filter((el) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 8;
      });
      return {
        welcome: text.includes("Welcome to PokéBedrock"),
        unique,
        painted: painted.length,
        gridH: gridBox?.height ?? 0,
        panelOpacity: panel?.style.opacity || "1",
        longFormAbsent: !document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ),
      };
    });

    expect(got.welcome).toBe(true);
    expect(got.longFormAbsent).toBe(true);
    expect(got.unique).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(got.panelOpacity).toBe("1");
    expect(got.gridH).toBeGreaterThan(40);
    expect(got.painted).toBeGreaterThanOrEqual(6);

    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 2,
    } as unknown as JsonlFrame);
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-collection-index="2"].jsonui-form-hovered',
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

test("ordinary server form long_form still paints image buttons", async ({
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
      return {
        allLabels: names.every((n) => text.includes(n)),
        unique: [...new Set(idxs)].sort((a, b) => a - b),
      };
    }, starters);

    expect(got.allLabels).toBe(true);
    expect(got.unique).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
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
