/**
 * Deterministic paint settle for JSON-UI golden screenshots.
 *
 * JSON UI paints textures via CSS `background-image` / `border-image` (not
 * `<img>`), and labels use the `"Minecraft"` font stack. A fixed timeout
 * races font fallback swaps and unfinished CSS image decodes — goldens then
 * flake on text rows, HP-bar fills, and pokemon/ball icons that bind a frame
 * later than the dock chrome.
 *
 * Critical: do NOT treat "nothing pending + empty URL set" as ready. That
 * window (bind finished text, texture faces not yet emitted / mid
 * `replaceChildren`) produces text-only screenshots. Require a positive
 * chrome signal: painted image faces with real `url(...)` backgrounds.
 */
import type { Page } from "@playwright/test";

/** Window counters written by the JSON UI runtime / paint path. */
type JsonUiPaintWindow = Window & {
  __jsonUiTexturesPending?: number;
  __jsonUiPaintEpoch?: number;
  __jsonUiTextureRequested?: number;
};

/**
 * Drain fonts + CSS image decode + pending texture-info fetches, wait until
 * texture chrome has been requested AND painted, the URL set stops growing,
 * then return a screenshot that matches the previous frame (pixel-stable).
 *
 * @param page - Playwright page with a mounted JSON UI overlay.
 * @returns PNG bytes of the stable frame.
 * @throws if texture chrome never appears (avoids accepting text-only frames).
 */
export async function waitForJsonUiPaintReady(page: Page): Promise<Buffer> {
  // Positive gate: at least one texture face requested/painted, and no
  // in-flight texture-info preload. Empty pending alone is NOT enough —
  // pending is 0 before the first applyImage runs after setPhud/bind.
  await page.waitForFunction(
    () => {
      const w = window as unknown as JsonUiPaintWindow;
      const pending = w.__jsonUiTexturesPending ?? 0;
      const requested = w.__jsonUiTextureRequested ?? 0;
      const root =
        document.querySelector("#json-hud") ??
        document.querySelector(".jsonui-hud-host") ??
        document.body;
      let faces = 0;
      for (const node of root.querySelectorAll(".jsonui-image-face")) {
        if (!(node instanceof HTMLElement)) continue;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const bg = node.style.backgroundImage || cs.backgroundImage;
        const border = node.style.borderImageSource || cs.borderImageSource;
        if (
          (bg && bg !== "none" && bg.includes("url(")) ||
          (border && border !== "none" && border.includes("url("))
        ) {
          faces++;
        }
      }
      return pending <= 0 && (requested > 0 || faces > 0) && faces > 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  // Bindings can add image faces a frame after dock/text appear. Hold until
  // a NON-EMPTY URL set is unchanged across several rAFs, then decode.
  await page.evaluate(async () => {
    const root =
      document.querySelector("#json-hud") ??
      document.querySelector(".jsonui-hud-host") ??
      document.querySelector(".jsonui-root") ??
      document.body;

    const countChromeFaces = (): number => {
      let faces = 0;
      for (const node of root.querySelectorAll(".jsonui-image-face")) {
        if (!(node instanceof HTMLElement)) continue;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const bg = node.style.backgroundImage || cs.backgroundImage;
        const border = node.style.borderImageSource || cs.borderImageSource;
        if (
          (bg && bg !== "none" && bg.includes("url(")) ||
          (border && border !== "none" && border.includes("url("))
        ) {
          faces++;
        }
      }
      return faces;
    };

    const urlKey = (): string => {
      const urls = new Set<string>();
      const collect = (raw: string): void => {
        if (!raw || raw === "none") return;
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw))) {
          const u = m[2]?.trim();
          if (!u || u.startsWith("data:")) continue;
          urls.add(u);
        }
      };
      for (const node of root.querySelectorAll("*")) {
        if (node instanceof HTMLImageElement && node.src) urls.add(node.src);
        if (!(node instanceof Element)) continue;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        collect(cs.backgroundImage);
        collect(cs.borderImageSource);
        if (node instanceof HTMLElement) {
          collect(node.style.backgroundImage);
          collect(node.style.borderImageSource);
        }
      }
      return [...urls].sort().join("\n");
    };

    let last = "";
    let stable = 0;
    for (let i = 0; i < 300; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const pending =
        (window as unknown as JsonUiPaintWindow).__jsonUiTexturesPending ?? 0;
      const key = urlKey();
      const faces = countChromeFaces();
      // Empty URL set / zero faces / pending fetches → not ready (reset).
      if (!key || faces < 1 || pending > 0) {
        stable = 0;
        last = key;
        continue;
      }
      if (key === last) stable++;
      else {
        stable = 0;
        last = key;
      }
      // ~12 frames of unchanged non-empty URL set ≈ bindings finished.
      if (stable >= 12) break;
    }

    if (!last || countChromeFaces() < 1) {
      const pending =
        (window as unknown as JsonUiPaintWindow).__jsonUiTexturesPending ?? 0;
      const requested =
        (window as unknown as JsonUiPaintWindow).__jsonUiTextureRequested ?? 0;
      throw new Error(
        `jsonUi paint ready: texture chrome missing after URL settle ` +
          `(urls=${last ? last.split("\n").length : 0}, faces=${countChromeFaces()}, ` +
          `pending=${pending}, requested=${requested})`,
      );
    }

    await document.fonts.ready;
    try {
      await document.fonts.load(
        '16px "Minecraft", ui-sans-serif, system-ui, "Segoe UI", sans-serif',
      );
    } catch {
      /* ignore */
    }

    const urls = last.split("\n").filter(Boolean);
    await Promise.all(
      urls.map(
        (src) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = src;
            if (img.complete) resolve();
          }),
      ),
    );

    const imgs = [...root.querySelectorAll("img")].filter((img) => {
      const cs = getComputedStyle(img);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
    await Promise.all(
      imgs.map(async (img) => {
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          });
        }
        if (typeof img.decode === "function") {
          try {
            await img.decode();
          } catch {
            /* 404 / empty */
          }
        }
      }),
    );

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });

  let prev: Buffer | null = null;
  let prevKey = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    const key = await page.evaluate(() => {
      const root =
        document.querySelector("#json-hud") ??
        document.querySelector(".jsonui-hud-host") ??
        document.body;
      const urls = new Set<string>();
      const collect = (raw: string): void => {
        if (!raw || raw === "none") return;
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw))) {
          const u = m[2]?.trim();
          if (u && !u.startsWith("data:")) urls.add(u);
        }
      };
      for (const node of root.querySelectorAll(".jsonui-image-face, img")) {
        if (node instanceof HTMLImageElement && node.src) urls.add(node.src);
        if (!(node instanceof Element)) continue;
        const cs = getComputedStyle(node);
        collect(cs.backgroundImage);
        collect(cs.borderImageSource);
        if (node instanceof HTMLElement) {
          collect(node.style.backgroundImage);
          collect(node.style.borderImageSource);
        }
      }
      return [...urls].sort().join("\n");
    });

    const png = await page.screenshot({ type: "png", animations: "disabled" });
    // Refuse text-only frames: key must be non-empty (texture URLs present).
    if (prev && prev.equals(png) && key === prevKey && key.length > 0) {
      return png;
    }
    prev = png;
    prevKey = key;
  }
  if (!prev || prevKey.length === 0) {
    throw new Error(
      `jsonUi paint settle: no stable textured frame ` +
        `(lastUrlCount=${prevKey ? prevKey.split("\n").length : 0})`,
    );
  }
  return prev;
}
