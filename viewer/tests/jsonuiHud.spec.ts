/**
 * Playwright: mount JSON UI runtime against testdata/jsonui fixtures.
 * Asserts one sidebar dock, party name/level text, no centered &_ title.
 */
import { expect, test } from "@playwright/test";
import { createServer as createHttpServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { ensureLiveExtract } from "./ensureLiveExtract";
import { handleJsonUiPackRequest } from "./jsonuiPackServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

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
  // Phone flipbook / PHUD chrome textures live in the gitignored extract.
  ensureLiveExtract();
  const packHttp: Server = createHttpServer((req, res) => {
    if (handleJsonUiPackRequest(req, res)) return;
    res.writeHead(404);
    res.end("not found");
  });

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
      // Fixture #host is fixed 1280×720 (layout uses host CSS, not page viewport).
      await page.setViewportSize({ width: 1280, height: 720 });
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
      // main authored ["222.22%y", 192] but live-capped ~25% viewport width
      // so data.png `80%` plates stay sane. h stays 192gui×scale.
      expect(geom.main).not.toBeNull();
      expect(geom.main!.h).toBeCloseTo(384, 0);
      // 0.25 × 640gui × scale2 → 320 CSS on the 1280 host.
      expect(geom.main!.w).toBeLessThanOrEqual(1280 * 0.25 + 2);
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
      expect(nameLabel!.x).toBeGreaterThan(700);
      expect(nameLabel!.x).toBeLessThan(1280);
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

  test("phone oak flipbook crops one frame (not whole strip)", async ({
    page,
  }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      await page.evaluate(() => {
        (
          window as unknown as {
            __jsonUi: { setPhud: (p: Record<string, string>) => void };
          }
        ).__jsonUi.setPhud({ phone: "loop" });
      });
      await expect(
        page.locator('.jsonui[data-ui-name="oak_talk"]').first(),
      ).toBeVisible();

      // oak_loop is 512x64 (8x64 frames). Cropped frame → background-size
      // wider than the element (not `100% 100%` whole-strip stretch).
      const paint = await page.evaluate(() => {
        const faces = [
          ...document.querySelectorAll<HTMLElement>(
            '.jsonui[data-ui-name="oak_icon"] .jsonui-image-face',
          ),
        ];
        return faces.map((face) => ({
          size: face.style.backgroundSize,
          position: face.style.backgroundPosition,
          image: face.style.backgroundImage,
        }));
      });
      const cropped = paint.filter(
        (p) =>
          p.image.includes("oak_") &&
          p.size !== "" &&
          p.size !== "100% 100%" &&
          !p.size.endsWith("%"),
      );
      expect(
        cropped.length,
        `expected UV-cropped oak face, got ${JSON.stringify(paint)}`,
      ).toBeGreaterThan(0);
      const [bw, bh] = cropped[0]!.size.split(/\s+/).map((s) => parseFloat(s));
      expect(bw).toBeGreaterThan(bh!);

      const layout = await page.evaluate(() => {
        const host = document.querySelector(
          '[data-jsonui-name="phud_phone.main"]',
        );
        const bg = document.querySelector(
          '.jsonui[data-ui-name="oak_talk_bg"]',
        );
        const icons = [
          ...document.querySelectorAll('.jsonui[data-ui-name="oak_icon"]'),
        ];
        const faceOf = (el) => el?.querySelector(".jsonui-image-face");
        const faceOpacity = (face) =>
          !face
            ? "missing"
            : face.style.opacity === ""
              ? "1"
              : face.style.opacity;
        const byTex = (frag) =>
          icons.find((el) =>
            (faceOf(el)?.style.backgroundImage ?? "").includes(frag),
          ) ?? null;
        const start = byTex("oak_start");
        const loop = byTex("oak_loop");
        const hr = host?.getBoundingClientRect();
        return {
          hostW: hr?.width ?? 0,
          hostH: hr?.height ?? 0,
          hostLeft: hr?.left ?? -1,
          bgOpacity: faceOpacity(faceOf(bg)),
          loopOpacity: faceOpacity(faceOf(loop)),
          startHidden:
            !start ||
            getComputedStyle(start).display === "none" ||
            faceOpacity(faceOf(start)) === "0",
          loopImage: faceOf(loop)?.style.backgroundImage ?? "",
        };
      });
      expect(layout.hostW).toBeGreaterThanOrEqual(60);
      expect(layout.hostW).toBeLessThanOrEqual(140);
      expect(layout.hostH).toBeGreaterThanOrEqual(60);
      expect(layout.hostH).toBeLessThanOrEqual(140);
      expect(layout.hostLeft).toBeLessThan(120);
      expect(Number(layout.bgOpacity)).toBeGreaterThan(0.9);
      expect(Number(layout.loopOpacity)).toBeGreaterThan(0.9);
      expect(layout.loopImage).toContain("oak_loop");
      expect(layout.startHidden).toBe(true);
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

      await page.waitForFunction(
        () =>
          document.querySelector(
            '.jsonui[data-ui-name="hunger_renderer"] > div',
          ) !== null,
        undefined,
        { timeout: 10_000 },
      );

      const vitalsGeom = await page.evaluate(() => {
        const heart = document.querySelector(
          '.jsonui[data-ui-name="heart_renderer"]',
        ) as HTMLElement | null;
        const hunger = document.querySelector(
          '.jsonui[data-ui-name="hunger_renderer"]',
        ) as HTMLElement | null;
        const hotbar = document.querySelector(
          '.jsonui[data-ui-name="hotbar_renderer"]',
        ) as HTMLElement | null;
        const hr = heart?.getBoundingClientRect();
        const hg = hunger?.getBoundingClientRect();
        const hb = hotbar?.getBoundingClientRect();
        return {
          heartLeft: hr?.left ?? 0,
          hungerRight: hg?.right ?? 0,
          hotbarLeft: hb?.left ?? 0,
          hotbarRight: hb?.right ?? 0,
          hungerBox: hg
            ? { x: hg.left, y: hg.top, w: hg.width, h: hg.height }
            : null,
        };
      });
      expect(vitalsGeom.hungerBox).not.toBeNull();
      expect(
        Math.abs(vitalsGeom.heartLeft - vitalsGeom.hotbarLeft),
      ).toBeLessThan(12);
      expect(
        Math.abs(vitalsGeom.hungerRight - vitalsGeom.hotbarRight),
      ).toBeLessThan(12);

      const vitalsPng = PNG.sync.read(
        Buffer.from(
          await page.screenshot({ type: "png", animations: "disabled" }),
        ),
      );
      const hb = vitalsGeom.hungerBox!;
      const hungerPx = sampleHungerVitals(vitalsPng, {
        x0: Math.floor(hb.x),
        x1: Math.ceil(hb.x + hb.w),
        y0: Math.floor(hb.y),
        y1: Math.ceil(hb.y + hb.h),
      });
      expect(hungerPx.darkPlate).toBeGreaterThan(0);

      const hungerLayers = await page.evaluate(() => {
        const host = document.querySelector(
          '.jsonui[data-ui-name="hunger_renderer"]',
        ) as HTMLElement | null;
        if (!host) return { drumstick: 0 };
        const imgs = [
          ...host.querySelectorAll<HTMLElement>(":scope > div > div"),
        ].map((el) => el.style.backgroundImage);
        const drumstick = imgs.filter(
          (u) => u.includes("hunger_full") || u.includes("hunger_half"),
        ).length;
        return { drumstick };
      });
      expect(hungerLayers.drumstick).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test("quest banner + title tip size to text (no black tail)", async ({
    page,
  }) => {
    const harness = await startHarness();
    try {
      await page.setViewportSize({ width: 1024, height: 576 });
      await page.goto(harness.pageUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.dataset.ready === "1", {
        timeout: 60_000,
      });

      const currency = "Go see Professor Oak at the lab".padEnd(80, "_");
      await page.evaluate(
        ({ currency }) => {
          (
            window as unknown as {
              __jsonUi: {
                setHud: (
                  phud: Record<string, string>,
                  vitals: {
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
                    hotbar: null[];
                  },
                  title?: string | null,
                  seedSidebar?: boolean,
                ) => void;
              };
            }
          ).__jsonUi.setHud(
            { currency },
            {
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
              xpProgress: 0,
              selectedSlot: 0,
              hotbar: Array.from({ length: 9 }, () => null),
            },
            "Battle Marla",
            false,
          );
        },
        { currency },
      );

      await page.waitForFunction(
        () =>
          !!document.querySelector('[data-jsonui-name="phud_currency.quest"]'),
        undefined,
        { timeout: 15_000 },
      );

      const layout = await page.evaluate(() => {
        const quest = document.querySelector(
          '[data-jsonui-name="phud_currency.quest"]',
        ) as HTMLElement | null;
        const questLabel = quest?.querySelector(
          ".jsonui-label",
        ) as HTMLElement | null;
        const currencyEl = document.querySelector(
          '[data-jsonui-name="phud_currency.currency"]',
        ) as HTMLElement | null;
        const titleLabel = (document.querySelector(
          '[data-jsonui-name="hud.title"]',
        ) ??
          document.querySelector(
            '[data-jsonui-name="hud.title_background"] .jsonui-label',
          )) as HTMLElement | null;
        const titleBg = (document.querySelector(
          '[data-jsonui-name="hud.title_background"]',
        ) ?? titleLabel?.closest(".jsonui")) as HTMLElement | null;
        const qr = quest?.getBoundingClientRect();
        const lr = questLabel?.getBoundingClientRect();
        const tr = titleBg?.getBoundingClientRect();
        const tl = titleLabel?.getBoundingClientRect();
        return {
          questW: qr?.width ?? 0,
          labelW: lr?.width ?? 0,
          currencyMounted:
            !!currencyEl && getComputedStyle(currencyEl).display !== "none",
          titleW: tr?.width ?? 0,
          titleLabelW: tl?.width ?? 0,
          titleText: (
            titleLabel?.textContent ??
            titleBg?.innerText ??
            ""
          ).trim(),
        };
      });

      expect(layout.currencyMounted).toBe(false);
      expect(layout.questW).toBeGreaterThan(0);
      const questPad = layout.questW - layout.labelW;
      expect(questPad).toBeGreaterThanOrEqual(8);
      expect(questPad).toBeLessThanOrEqual(28);
      expect(layout.titleText).toContain("Battle Marla");
      if (layout.titleW > 0 && layout.titleLabelW > 0) {
        const titlePad = layout.titleW - layout.titleLabelW;
        expect(titlePad).toBeGreaterThanOrEqual(8);
        expect(titlePad).toBeLessThanOrEqual(28);
      }
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

/**
 * Sample hunger row pixels for plate + drumstick layers.
 *
 * @param img - Decoded PNG.
 * @param band - Inclusive pixel band.
 * @returns dark plate and brown drumstick hit counts.
 */
function sampleHungerVitals(
  img: PNG,
  band: { x0: number; x1: number; y0: number; y1: number },
): { darkPlate: number; brownDrumstick: number } {
  let darkPlate = 0;
  let brownDrumstick = 0;
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = band.x0; x <= band.x1; x++) {
      const i = (y * img.width + x) << 2;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      const a = img.data[i + 3]!;
      if (a < 40) continue;
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (luma >= 25 && luma <= 90 && Math.abs(r - g) < 25) darkPlate++;
      if (r > 45 && g > 28 && b < 50 && r >= g - 5 && g > b + 5)
        brownDrumstick++;
    }
  }
  return { darkPlate, brownDrumstick };
}
