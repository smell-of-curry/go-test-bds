/**
 * ActionForm hollow-center fill + stacking vs body nametag overlays.
 *
 * Pack `dialog_background_hollow_3` paints `textures/ui/control` at alpha 0.8
 * in the center hole. Without that fill (and with `#json-hud` stuck at z-index
 * 4), a bright world + body nametag read as brighter *inside* the dialog than
 * under the scrim — and nametags can paint over the form.
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
import { ensureBaseline } from "./ensureBaseline";
import { ensureLiveExtract } from "./ensureLiveExtract";
import { waitForJsonUiPaintReady } from "./jsonUiPaintReady";
import { handleJsonUiPackRequest } from "./jsonuiPackServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const VIEWPORT = { width: 1280, height: 720 } as const;

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

interface Harness {
  base: string;
  streamUrl: string;
  broadcast: (frame: JsonlFrame) => void;
  close: () => Promise<void>;
}

/**
 * @returns vite + SSE harness with JSON UI packs.
 */
async function startHarness(): Promise<Harness> {
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

test("ActionForm hollow fill dims center; form stacks above body nametag", async ({
  page,
}: {
  page: Page;
}) => {
  const h = await startHarness();
  try {
    await page.goto(`${h.base}?stream=${encodeURIComponent(h.streamUrl)}`, {
      waitUntil: "domcontentloaded",
    });
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

    // Bright "world" + a body-level nametag that would beat `#json-hud` (z=4)
    // if the form host forgot to raise the HUD root.
    await page.addStyleTag({
      content: `
        #c, #overlay, #crosshair, #labels, #player-hud, #loading, #waypoint-strip { display: none !important; }
        body { background: #3cff3c !important; }
      `,
    });
    await page.evaluate(() => {
      const tag = document.createElement("div");
      tag.id = "probe-nametag";
      tag.textContent = "TestBot";
      tag.style.cssText =
        "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);" +
        "z-index:10;background:#ff0;color:#000;padding:8px 16px;font:20px sans-serif;";
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
            "It looks like you are new to the server.\nOpen this book for a quick tour.",
          buttons: ["Continue"],
          buttonImages: ["textures/ui/phud/oak_start"],
        },
      },
    } as unknown as JsonlFrame);

    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-jsonui-name="server_form.long_form"]',
        ) && !!document.querySelector('[data-jsonui-name="jsonui.form_scrim"]'),
      undefined,
      { timeout: 15_000 },
    );
    await waitForJsonUiPaintReady(page);

    const info = await page.evaluate(() => {
      const form = document.querySelector(
        '[data-jsonui-name="server_form.long_form"]',
      ) as HTMLElement;
      const hollow = form.querySelector(
        '[data-jsonui-name="common.dialog_background_hollow_3"]',
      ) as HTMLElement | null;
      const control = hollow?.querySelector(
        '[data-jsonui-name="common.control"], .jsonui[data-ui-name="control"]',
      ) as HTMLElement | null;
      const controlFace = control?.querySelector(
        ":scope > .jsonui-image-face",
      ) as HTMLElement | null;
      const title =
        ([...form.querySelectorAll(".jsonui-label")].find((el) =>
          (el.textContent ?? "").includes("Welcome"),
        ) as HTMLElement | undefined) ??
        (form.querySelector(".jsonui-label") as HTMLElement | null);
      const scrim = document.querySelector(
        '[data-jsonui-name="jsonui.form_scrim"]',
      ) as HTMLElement | null;
      const formsHost = document.querySelector(
        ".jsonui-forms-host",
      ) as HTMLElement | null;
      const hud = document.querySelector(
        "#json-hud, .jsonui-hud-host",
      ) as HTMLElement | null;
      const nametag = document.getElementById("probe-nametag");
      const formBox = form.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      // Sample deep in the hollow (below title / buttons).
      const inside = {
        x: formBox.left + formBox.width * 0.5,
        y: formBox.top + formBox.height * 0.78,
      };
      // Light title-band backing (live pack) — sample near the title glyph.
      const titleBand = titleBox
        ? {
            x: titleBox.left + titleBox.width * 0.5,
            y: titleBox.top + Math.min(6, titleBox.height * 0.35),
          }
        : {
            x: formBox.left + formBox.width * 0.5,
            y: formBox.top + 18,
          };
      const outside = {
        x: 40,
        y: 40,
      };
      // elementsFromPoint skips pointer-events:none (entire JSON UI host) —
      // stacking proof is CSS z-index on `#json-hud` vs the body nametag.
      const hudZ = Number(getComputedStyle(hud!).zIndex || "0");
      const tagZ = Number(getComputedStyle(nametag!).zIndex || "0");
      const tagBox = nametag!.getBoundingClientRect();
      return {
        controlOpacity: controlFace
          ? Number(getComputedStyle(controlFace).opacity)
          : -1,
        controlHasBg:
          !!controlFace &&
          (controlFace.style.backgroundImage.includes("control") ||
            getComputedStyle(controlFace).backgroundImage.includes("control") ||
            controlFace.style.borderImageSource.includes("control")),
        controlZ: control ? Number(getComputedStyle(control).zIndex || "0") : 0,
        hollowIsolation: hollow ? getComputedStyle(hollow).isolation : "auto",
        controlBox: control
          ? {
              w: control.getBoundingClientRect().width,
              h: control.getBoundingClientRect().height,
            }
          : null,
        hasScrim: !!scrim,
        hudZ,
        tagZ,
        formOpen: hud?.dataset.formOpen === "1",
        isolation: getComputedStyle(formsHost!).isolation,
        tagOverlapsForm:
          tagBox.left < formBox.right &&
          tagBox.right > formBox.left &&
          tagBox.top < formBox.bottom &&
          tagBox.bottom > formBox.top,
        sample: {
          inside,
          outside,
          titleBand,
          formBox: {
            x: formBox.x,
            y: formBox.y,
            w: formBox.width,
            h: formBox.height,
          },
          tagCenter: {
            x: tagBox.left + tagBox.width / 2,
            y: tagBox.top + tagBox.height / 2,
          },
        },
      };
    });

    expect(info.hasScrim).toBe(true);
    expect(info.controlBox && info.controlBox.w > 100).toBe(true);
    expect(info.controlOpacity).toBeGreaterThan(0.5);
    expect(info.controlOpacity).toBeLessThanOrEqual(1);
    expect(info.controlHasBg || info.controlOpacity === 0.8).toBe(true);
    // Pack layer -1 kept; parent isolate keeps fill under title/frame chrome.
    expect(info.controlZ).toBeLessThan(0);
    expect(info.hollowIsolation).toBe("isolate");
    expect(info.formOpen).toBe(true);
    expect(info.tagOverlapsForm).toBe(true);
    // Body nametag at z=10 must sit under raised HUD root (not nested host z).
    expect(info.hudZ).toBeGreaterThanOrEqual(info.tagZ);

    // Textured ActionForm button: icon gutter paints ON the button (not under
    // the opaque fill), non-empty face, inside button bounds.
    const iconInfo = await page.evaluate(() => {
      const form = document.querySelector(
        '[data-jsonui-name="server_form.long_form"]',
      ) as HTMLElement;
      const btn = form.querySelector(
        '.jsonui[data-ui-name="form_button"], .jsonui[data-ui-name="light_text_button"]',
      ) as HTMLElement | null;
      const panel = form.querySelector(
        '.jsonui[data-ui-name="panel_name"]',
      ) as HTMLElement | null;
      const face = panel?.querySelector(
        ":scope .jsonui-image-face",
      ) as HTMLElement | null;
      const btnBox = btn?.getBoundingClientRect();
      const faceBox = face?.getBoundingClientRect();
      const bg =
        face?.style.backgroundImage ||
        (face ? getComputedStyle(face).backgroundImage : "");
      return {
        hasFace: !!face,
        bg,
        faceW: faceBox?.width ?? 0,
        faceH: faceBox?.height ?? 0,
        inButton:
          !!btnBox &&
          !!faceBox &&
          faceBox.width > 4 &&
          faceBox.height > 4 &&
          faceBox.left >= btnBox.left - 2 &&
          faceBox.right <= btnBox.right + 2 &&
          faceBox.top >= btnBox.top - 2 &&
          faceBox.bottom <= btnBox.bottom + 2,
        panelZ: panel ? Number(getComputedStyle(panel).zIndex || "0") : -1,
        btnZ: btn ? Number(getComputedStyle(btn).zIndex || "0") : -1,
      };
    });
    expect(iconInfo.hasFace).toBe(true);
    expect(iconInfo.bg).toMatch(/oak_start/);
    expect(iconInfo.faceW).toBeGreaterThan(8);
    expect(iconInfo.faceH).toBeGreaterThan(8);
    expect(iconInfo.inButton).toBe(true);
    expect(iconInfo.panelZ).toBeGreaterThan(iconInfo.btnZ);

    // Pixel proof: bright lime world under scrim outside; hollow center must
    // not read brighter (full-bright world punch-through).
    const shot = await page.screenshot({ type: "png" });
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(Buffer.from(shot));
    const lum = (x: number, y: number): number => {
      const i = (Math.round(y) * png.width + Math.round(x)) * 4;
      return png.data[i]! + png.data[i + 1]! + png.data[i + 2]!;
    };
    const insideL = lum(info.sample.inside.x, info.sample.inside.y);
    const outsideL = lum(info.sample.outside.x, info.sample.outside.y);
    const titleL = lum(info.sample.titleBand.x, info.sample.titleBand.y);
    // Outside is scrim over lime; inside is scrim + control@0.8 — never brighter.
    expect(insideL).toBeLessThanOrEqual(outsideL + 15);
    // And not near full-bright lime (~180+ per channel).
    expect(insideL).toBeLessThan(400);
    // Title band stays light chrome; control fill must not darken it.
    expect(titleL).toBeGreaterThan(insideL + 40);
    // Yellow nametag (#ff0) must not paint over the dialog interior.
    const tagPx = (() => {
      const x = Math.round(info.sample.tagCenter.x);
      const y = Math.round(info.sample.tagCenter.y);
      const i = (y * png.width + x) * 4;
      return {
        r: png.data[i]!,
        g: png.data[i + 1]!,
        b: png.data[i + 2]!,
      };
    })();
    expect(tagPx.r > 200 && tagPx.g > 200 && tagPx.b < 80).toBe(false);
  } finally {
    await h.close().catch(() => undefined);
    await Promise.race([
      page.close(),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]).catch(() => undefined);
  }
});
