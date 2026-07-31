/**
 * Visual goldens for the pack-driven JSON UI HUD: sidebar + top bar + ping
 * (and battle / form screens), rendered from fixture stream frames onto a
 * solid background (canvas hidden — the world render has its own goldens;
 * these lock the DOM overlay's layout).
 *
 * Packs come from testdata/jsonui; chrome resolves from the live extract +
 * vanilla baseline. Sidebar *sprite* PNGs are forced 404 so species faces
 * stay deterministic; ball textures ARE served (live RES `…/balls/poke.png`)
 * and the golden asserts the icon paints. Capture still waits for fonts +
 * URL-set plateau + CSS decode (jsonUiPaintReady).
 * Same env knobs as golden.spec (GOLDEN_UPDATE=1 / GOLDEN_SOFT=1).
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
import { assertGolden } from "./goldenCompare";
import { ensureBaseline } from "./ensureBaseline";
import { ensureLiveExtract } from "./ensureLiveExtract";
import { waitForJsonUiPaintReady } from "./jsonUiPaintReady";
import { handleJsonUiPackRequest } from "./jsonuiPackServer";
import {
  BEH_EMPTY_SLOT,
  behOccupiedSlot,
  packBehSidebar,
} from "./fixtures/behSidebar";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const goldensDir = join(viewerRoot, "testdata", "goldens");
const resultsDir = join(viewerRoot, "test-results", "phud-golden");

const VIEWPORT = { width: 1280, height: 720 } as const;
const BATTLE_FLAG = "§b§a§t§l§e";

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });
// Each golden boots its own vite + stream; serialise to keep startup timing
// (and therefore text rasterisation) stable on the CI runner.
test.describe.configure({ mode: "serial" });

interface Harness {
  base: string;
  streamUrl: string;
  broadcast: (frame: JsonlFrame) => void;
  close: () => Promise<void>;
}

/**
 * Vite app + pushable SSE fixture + JSON UI packs on the stream origin.
 *
 * @returns live URLs and a broadcast handle.
 */
async function startHarness(): Promise<Harness> {
  // Dock / plate / banner chrome PNGs are served from the gitignored extract;
  // vanilla ui chips (Black, hp bars) resolve from the baseline cache.
  ensureLiveExtract();
  ensureBaseline();
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
      // Live extract has 3k+ sprites; binding them a frame late flakes goldens.
      // 404 keeps species faces empty; ball textures stay servable (asserted).
      if (url.pathname.startsWith("/asset/")) {
        const rel = decodeURIComponent(
          url.pathname.slice("/asset/".length),
        ).replace(/\\/g, "/");
        if (rel.startsWith("textures/sprites/")) {
          res.writeHead(404, { "access-control-allow-origin": "*" });
          res.end("golden: omit sprites");
          return;
        }
      }
      if (handleJsonUiPackRequest(req, res)) return;
      res.writeHead(404);
      res.end("not found");
    },
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");

  return {
    base,
    streamUrl: `http://127.0.0.1:${addr.port}/stream?bot=TestBot`,
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
 * Open the viewer and hide everything except the JSON HUD overlay.
 *
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
  // Solid background: the WebGL canvas, diagnostics and vanilla HUD have
  // their own coverage; goldens here lock ONLY the JSON-UI overlay.
  await page.addStyleTag({
    content: `
      #c, #overlay, #crosshair, #labels, #player-hud, #loading, #waypoint-strip { display: none !important; }
      body { background: #0b0e14; }
    `,
  });
}

/**
 * @param token - PHUD token.
 * @param value - Token value.
 * @returns a phud event-lane frame.
 */
function phudFrame(token: string, value: string): JsonlFrame {
  return {
    v: 1,
    type: "phud",
    bot: "TestBot",
    tick: 150,
    token,
    value,
  } as JsonlFrame;
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

/**
 * Screenshot the page and compare against a named golden.
 *
 * @param page - Playwright page.
 * @param name - Golden name (file `phud-<name>.png`).
 */
async function shoot(page: Page, name: string): Promise<void> {
  // Fonts + CSS background decode + pending texture-info + two identical
  // frames. Fixed 150ms raced font fallback and unfinished HP-bar textures.
  const png = await waitForJsonUiPaintReady(page);
  expect(png.length).toBeGreaterThan(5_000);
  assertGolden({
    name: `phud-${name}`,
    goldenPath: join(goldensDir, `phud-${name}.png`),
    resultsDir,
    actual: png,
  });
}

/**
 * Tear down stream/vite before the page — `page.close` can hang after a
 * heavy JSON-UI form DOM while the SSE socket is still open.
 *
 * @param page - Playwright page.
 * @param h - Live harness.
 */
async function closeHarness(page: Page, h: Harness): Promise<void> {
  await h.close().catch(() => undefined);
  await Promise.race([
    page.close(),
    new Promise<void>((r) => setTimeout(r, 3_000)),
  ]).catch(() => undefined);
}

test("golden: sidebar + top bar + ping", async ({ page }) => {
  const h = await startHarness();
  try {
    await openHudOnly(
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
        packBehSidebar([
          behOccupiedSlot({
            stats: "HP: 20/20§r§f Lv. 11",
            nickname: "Bulbasaur",
            species: "bulbasaur",
            active: true,
            ballType: "poke",
            icon: "default/bulbasaur",
            clipPercent: "37",
          }),
          behOccupiedSlot({
            // BEH sidebar.ts: health<=0 → `§7Fainted` + `§r§f Lv. N`
            stats: "§7Fainted§r§f Lv. 5",
            nickname: "Quaxly",
            species: "quaxly",
            active: false,
            ballType: "poke",
            icon: "default/quaxly",
            // clip 100 → #clip_ratio 1 → fully hidden (empty) bar
            clipPercent: "100",
          }),
          behOccupiedSlot({
            stats: "???",
            nickname: "???",
            species: "egg",
            active: false,
            ballType: "poke",
            icon: "default/egg",
            clipPercent: "100",
          }),
          [...BEH_EMPTY_SLOT],
          [...BEH_EMPTY_SLOT],
          [...BEH_EMPTY_SLOT],
        ]),
      ),
    );

    await page.waitForFunction(
      () => {
        const dock = document.querySelector(
          '[data-jsonui-name="phud_sidebar.dock"]',
        );
        const ping = document.querySelector<HTMLElement>(
          '[data-jsonui-name="player_ping.main"]',
        );
        return (
          !!dock &&
          !!ping &&
          getComputedStyle(ping).display !== "none" &&
          (dock.textContent ?? "").includes("Bulbasaur") &&
          (dock.textContent ?? "").includes("Fainted")
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    const geom = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const host = el as HTMLElement;
        const r = host.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          clip: host.style.clipPath || "",
        };
      };
      const plates = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-jsonui-name="phud_sidebar.variable_parser"]',
        ),
      ].filter((el) => {
        if (el.dataset.uiType !== "image") return false;
        if (getComputedStyle(el).display === "none") return false;
        const face = el.querySelector(
          ".jsonui-image-face",
        ) as HTMLElement | null;
        return (face?.style.backgroundImage ?? "").includes("sidebar/data");
      });
      const fills = [
        ...document.querySelectorAll<HTMLElement>(".jsonui"),
      ].filter(
        (el) =>
          el.dataset.uiName === "xp_bar_fill" &&
          getComputedStyle(el).display !== "none",
      );
      const rings = [
        ...document.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ]
        .filter((face) =>
          (face.style.backgroundImage ?? "").includes("sidebar/ring"),
        )
        .map((face) => face.closest(".jsonui") as HTMLElement | null)
        .filter((el): el is HTMLElement => !!el);
      const wrappers = [
        ...document.querySelectorAll<HTMLElement>(".jsonui"),
      ].filter(
        (el) =>
          el.dataset.uiName === "pokemon_icon_wrapper" &&
          getComputedStyle(el).display !== "none" &&
          el.getBoundingClientRect().width > 0,
      );
      const ping = document.querySelector<HTMLElement>(
        '[data-jsonui-name="player_ping.main"]',
      );
      return {
        plate: box(plates[0] ?? null),
        fill0: box(fills[0] ?? null),
        fill1: box(fills[1] ?? null),
        ring: box(rings[0] ?? null),
        wrapper0: box(wrappers[0] ?? null),
        ping: ping?.textContent ?? "",
      };
    });

    expect(geom.plate).not.toBeNull();
    expect(geom.fill0).not.toBeNull();
    expect(geom.fill1).not.toBeNull();
    expect(geom.fill0!.x).toBeGreaterThanOrEqual(geom.plate!.x - 0.5);
    expect(geom.fill0!.x + geom.fill0!.w).toBeLessThanOrEqual(
      geom.plate!.x + geom.plate!.w + 0.5,
    );
    expect(geom.fill1!.clip).toContain("inset(100%)");
    expect(geom.ring).not.toBeNull();
    expect(geom.wrapper0).not.toBeNull();
    expect(geom.wrapper0!.x).toBeLessThanOrEqual(geom.plate!.x + 4);
    expect(geom.ring!.x).toBeLessThanOrEqual(geom.plate!.x + 4);
    expect(geom.ping).toMatch(/Current Ping:\s/);

    const ballFace = await page.evaluate(() => {
      const faces = [
        ...document.querySelectorAll<HTMLElement>(".jsonui-image-face"),
      ];
      const ball = faces.find((f) =>
        (f.style.backgroundImage ?? "").includes("/sidebar/balls/poke"),
      );
      if (!ball) return { bg: "", w: 0, h: 0 };
      const r = ball.getBoundingClientRect();
      return {
        bg: ball.style.backgroundImage ?? "",
        w: r.width,
        h: r.height,
      };
    });
    expect(ballFace.bg).toMatch(/sidebar\/balls\/poke\.png/);
    expect(ballFace.w).toBeGreaterThan(8);
    expect(ballFace.h).toBeGreaterThan(8);

    await shoot(page, "sidebar");
  } finally {
    await closeHarness(page, h);
  }
});

test("golden: battle bar", async ({ page }) => {
  const h = await startHarness();
  try {
    await openHudOnly(
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
            "t__20",
            "t",
            "t",
            "t",
            "t:_default",
          ],
        },
      },
    } as unknown as JsonlFrame);
    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 1,
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-jsonui-name="battle.main"]') &&
        !!document.querySelector(
          '[data-collection-index="1"].jsonui-form-hovered',
        ),
      undefined,
      { timeout: 15_000 },
    );
    await shoot(page, "battle-bar");
  } finally {
    await closeHarness(page, h);
  }
});

test("golden: centered form modal", async ({ page }) => {
  const h = await startHarness();
  try {
    await openHudOnly(
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
    h.broadcast({
      v: 1,
      type: "formHover",
      bot: "TestBot",
      tick: 155,
      index: 0,
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ) &&
        !!document.querySelector(
          '[data-collection-index="0"].jsonui-form-hovered',
        ),
      undefined,
      { timeout: 15_000 },
    );
    await shoot(page, "form-modal");
  } finally {
    await closeHarness(page, h);
  }
});

test("welcome ActionForm: body, button label, close X, form above nametag", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await openHudOnly(
      page,
      `${h.base}?stream=${encodeURIComponent(h.streamUrl)}`,
    );

    // Fake world nametag layer (real client uses WebGL sprites; HTML stand-in
    // for z-order). Forms host must sit above it.
    await page.evaluate(() => {
      const tag = document.createElement("div");
      tag.id = "probe-nametag";
      tag.textContent = "TestBot";
      tag.style.cssText =
        "position:absolute;left:50%;top:45%;z-index:10;background:#000;color:#fff;padding:2px 6px;";
      document.body.appendChild(tag);
    });

    h.broadcast({
      v: 1,
      type: "delta",
      bot: "TestBot",
      tick: 150,
      ui: {
        form: {
          type: "action",
          title: "Welcome to PokeBedrock",
          content:
            "It looks like you are new to the server.\nOpen this book for a quick tour of the basics before you head out.",
          buttons: ["Continue"],
          buttonImages: ["textures/ui/book_notebook_icon"],
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
        ).includes("Continue"),
      undefined,
      { timeout: 15_000 },
    );

    const got = await page.evaluate(() => {
      const form = document.querySelector(
        '[data-jsonui-name="server_form.long_form"]',
      ) as HTMLElement;
      const formBox = form.getBoundingClientRect();
      const body = [
        ...form.querySelectorAll<HTMLElement>(
          '.jsonui[data-ui-name="main_label"]',
        ),
      ].find((el) => (el.textContent ?? "").includes("new to the server"));
      const title = form.querySelector(
        '.jsonui[data-ui-name="standard_title_label"]',
      ) as HTMLElement | null;
      const continueLabel = [
        ...form.querySelectorAll<HTMLElement>(".jsonui-label"),
      ].find((el) => (el.textContent ?? "").trim() === "Continue");
      const closeBtn = form.querySelector(
        '.jsonui[data-ui-name="close_button"]',
      ) as HTMLElement | null;
      const buttonContent = form.querySelector(
        '.jsonui[data-ui-name="button_content"]',
      ) as HTMLElement | null;
      const buttonImage = form.querySelector(
        '.jsonui[data-ui-name="button_image"]',
      ) as HTMLElement | null;
      const scrim = document.querySelector(
        '[data-jsonui-name="jsonui.form_scrim"]',
      ) as HTMLElement | null;
      const formsHost = document.querySelector(
        ".jsonui-forms-host",
      ) as HTMLElement | null;
      const nametag = document.getElementById("probe-nametag");
      const closeBox = closeBtn?.getBoundingClientRect();
      const bodyBox = body?.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      const contBox = continueLabel?.getBoundingClientRect();
      const hud = document.querySelector(
        "#json-hud, .jsonui-hud-host",
      ) as HTMLElement | null;
      const hostZ = Number(getComputedStyle(hud ?? formsHost!).zIndex || "0");
      const tagZ = Number(nametag ? getComputedStyle(nametag).zIndex : "0");
      return {
        hasBody: !!body,
        bodyBelowTitle:
          !!bodyBox && !!titleBox && bodyBox.top >= titleBox.bottom - 1,
        continueVisible: !!contBox && contBox.width > 4 && contBox.height > 4,
        continueInButton:
          !!contBox &&
          !!buttonContent &&
          (() => {
            const b = buttonContent.getBoundingClientRect();
            return (
              contBox.left >= b.left - 2 &&
              contBox.right <= b.right + 2 &&
              contBox.top >= b.top - 2 &&
              contBox.bottom <= b.bottom + 2
            );
          })(),
        contentAboveChrome:
          !!buttonContent &&
          !!buttonImage &&
          Number(buttonContent.style.zIndex || "0") >
            Number(buttonImage.style.zIndex || "0"),
        closeTopRight:
          !!closeBox &&
          closeBox.right >= formBox.right - 40 &&
          closeBox.top <= formBox.top + 40,
        hasScrim: !!scrim,
        formHostAboveNametag: hostZ > tagZ,
      };
    });

    expect(got.hasBody).toBe(true);
    expect(got.bodyBelowTitle).toBe(true);
    expect(got.continueVisible).toBe(true);
    expect(got.continueInButton).toBe(true);
    expect(got.contentAboveChrome).toBe(true);
    expect(got.closeTopRight).toBe(true);
    expect(got.hasScrim).toBe(true);
    expect(got.formHostAboveNametag).toBe(true);
  } finally {
    await closeHarness(page, h);
  }
});
