/**
 * Deterministic paint settle for JSON-UI golden screenshots.
 *
 * JSON UI paints textures via CSS `background-image` / `border-image` (not
 * `<img>`), and labels use the `"Minecraft"` font stack. A fixed timeout
 * races font fallback swaps and unfinished CSS image decodes — goldens then
 * flake on text rows, HP-bar fills, and pokemon/ball icons that bind a frame
 * later than the dock chrome.
 */
import type { Page } from "@playwright/test";

/**
 * Drain fonts + CSS image decode + pending texture-info fetches, wait until
 * the set of painted texture URLs stops growing, then return a screenshot
 * that matches the previous frame (pixel-stable).
 *
 * @param page - Playwright page with a mounted JSON UI overlay.
 * @returns PNG bytes of the stable frame.
 */
export async function waitForJsonUiPaintReady(page: Page): Promise<Buffer> {
  // Runtime may still be fetching texture-json nineslice / PNG size after a
  // PHUD/form bind; drain that before sampling CSS backgrounds.
  await page.waitForFunction(
    () => {
      const n = (window as unknown as { __jsonUiTexturesPending?: number })
        .__jsonUiTexturesPending;
      return n === undefined || n <= 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  // Bindings can add image faces a frame after dock/text appear. Hold until
  // the URL set is unchanged across several rAFs, then decode those URLs.
  await page.evaluate(async () => {
    const root =
      document.querySelector("#json-hud") ??
      document.querySelector(".jsonui-hud-host") ??
      document.querySelector(".jsonui-root") ??
      document.body;

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
    for (let i = 0; i < 180; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const key = urlKey();
      if (key && key === last) stable++;
      else {
        stable = 0;
        last = key;
      }
      // ~12 frames of unchanged URL set ≈ bindings finished adding faces.
      if (stable >= 12) break;
    }

    await document.fonts.ready;
    try {
      await document.fonts.load(
        '16px "Minecraft", ui-sans-serif, system-ui, "Segoe UI", sans-serif',
      );
    } catch {
      /* ignore */
    }

    const urls = last ? last.split("\n").filter(Boolean) : [];
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
    if (prev && prev.equals(png) && key === prevKey && key.length > 0) {
      return png;
    }
    prev = png;
    prevKey = key;
  }
  if (!prev) throw new Error("jsonUi paint settle produced no screenshot");
  return prev;
}
