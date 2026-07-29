/**
 * Visual goldens for the JSON-UI-faithful PokeBedrock HUD: sidebar + top bar,
 * battle bar, and the centered vanilla form, rendered from fixture stream
 * frames onto a solid background (canvas hidden — the world render has its
 * own goldens; these lock the DOM overlay's layout).
 *
 * No pack is served, so every texture falls back to its flat colour — that is
 * the deterministic contract. Same env knobs as golden.spec
 * (GOLDEN_UPDATE=1 / GOLDEN_SOFT=1).
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

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const goldensDir = join(viewerRoot, "testdata", "goldens");
const resultsDir = join(viewerRoot, "test-results", "phud-golden");

const VIEWPORT = { width: 1280, height: 720 } as const;

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

  return {
    base,
    streamUrl: `http://127.0.0.1:${addr.port}/stream?bot=TestBot`,
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
      return !!v && v.schemaOk && v.tick >= 100 && v.assetsSettled;
    },
    undefined,
    { timeout: 30_000 },
  );
  // Solid background: the WebGL canvas, diagnostics and vanilla HUD have
  // their own coverage; goldens here lock ONLY the JSON-UI overlay.
  await page.addStyleTag({
    content: `
      #c, #overlay, #crosshair, #labels, #player-hud, #loading { display: none !important; }
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

const EMPTY_SLOT = ["null", "null", "null", "false", "empty", "null", "100"];

/**
 * @param slots - Per-slot 7-field arrays.
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

/**
 * Screenshot the page and compare against a named golden.
 *
 * @param page - Playwright page.
 * @param name - Golden name (file `phud-<name>.png`).
 */
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(150); // one settle paint
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  expect(png.length).toBeGreaterThan(5_000);
  assertGolden({
    name: `phud-${name}`,
    goldenPath: join(goldensDir, `phud-${name}.png`),
    resultsDir,
    actual: png,
  });
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
          [
            "HP: 11/23§r§f Lv. 5",
            "§fQuaxly",
            "quaxly",
            "false",
            "poke",
            "default/quaxly",
            "82",
          ],
          ["???", "§f???", "egg", "false", "poke", "default/egg", "100"],
          EMPTY_SLOT,
          EMPTY_SLOT,
          EMPTY_SLOT,
        ]),
      ),
    );

    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLElement>('[data-jh="sidebar"]')?.hidden &&
        !document.querySelector<HTMLElement>('[data-jh="ping"]')?.hidden &&
        !document.querySelector<HTMLElement>('[data-jh="topbar"]')?.hidden,
      undefined,
      { timeout: 10_000 },
    );
    await shoot(page, "sidebar");
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
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
        !document.querySelector<HTMLElement>('[data-jh="battlebar"]')?.hidden &&
        !!document.querySelector('[data-jh="battlebar"] .jh-move.hovered'),
      undefined,
      { timeout: 10_000 },
    );
    await shoot(page, "battle-bar");
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
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
        !document.querySelector<HTMLElement>('[data-jh="form"]')?.hidden &&
        !!document.querySelector('[data-jh="form"] .jh-form-button.hovered'),
      undefined,
      { timeout: 10_000 },
    );
    await shoot(page, "form-modal");
  } finally {
    await page.close().catch(() => undefined);
    await h.close();
  }
});
