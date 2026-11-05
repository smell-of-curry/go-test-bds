import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";

/**
 * Present at the current virtual instant, waiting for asynchronous assets.
 * Cinematics retain the canvas fast path; HUD output composites the viewport
 * so JSON forms, pack extensions and player HUD are included in the PNG.
 * No browser timer is advanced while settling a frame.
 *
 * @param page - Paused film page.
 * @param hud - Include DOM game UI.
 * @param timeoutMs - Wall-clock deadline for readiness and stable pixels.
 * @returns PNG base64.
 */
export async function presentFilmFrame(
  page: Page,
  hud = false,
  timeoutMs = 120_000,
): Promise<string> {
  let deadline = Date.now() + timeoutMs;
  let prev = "";
  let lastStatus = "assets not ready";
  let presents = 0;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(
      () => window.__viewer?.pendingModelLoads ?? 0,
    );
    if (pending > 0) {
      lastStatus = `${pending} model loads pending`;
      prev = "";
      await delay(40);
      continue;
    }
    // present() applies the current frame, drains meshes and hides diagnostic
    // chrome. It deliberately keeps #json-hud and its real forms under --hud.
    const canvas = await page.evaluate(() => window.__film?.present() ?? "");
    if (!canvas) throw new Error("film present returned empty");
    // The first present synchronously drains the recorded terrain. Dense
    // takes may spend minutes meshing; that is not an unsettled output pixel.
    // Preserve the bounded asset wait above, then give the completed first
    // draw its own readiness/pixel-settling window (as the old canvas path did).
    if (presents === 0) deadline = Date.now() + timeoutMs;
    presents++;
    if (!hud) {
      if (canvas === prev) return canvas;
      prev = canvas;
      // Preserve the existing fast-path settling budget and behavior.
      if (presents >= 10) {
        console.error(
          "film: frame did not settle in 10 presents; using the last read",
        );
        return prev;
      }
      await delay(40);
      continue;
    }
    const status = await page.evaluate(hudReadiness);
    if (status.error) throw new Error(`film HUD: ${status.error}`);
    if (!status.ready && !status.paintable) {
      lastStatus = status.note;
      prev = "";
      await delay(40);
      continue;
    }
    const png = (
      await page.screenshot({
        type: "png",
        // Viewport is exactly the requested video resolution. A scrolling
        // extension must not silently grow the output dimensions.
        fullPage: false,
        caret: "hide",
        timeout: Math.max(1, deadline - Date.now()),
      })
    ).toString("base64");
    // A newly introduced CSS image may need a browser paint before its load
    // completes. Discard that preliminary raster; only ready frames can win
    // the consecutive-pixel gate below.
    if (!status.ready) {
      lastStatus = status.note;
      prev = "";
      await delay(40);
      continue;
    }
    if (png === prev) return png;
    prev = png;
    lastStatus = "DOM pixels are still changing at the paused film instant";
    await delay(40);
  }
  throw new Error(
    `film ${hud ? "HUD " : ""}frame did not settle: ${lastStatus}`,
  );
}

/** Runs inside the browser; image/font promises never depend on virtual time. */
function hudReadiness(): {
  ready: boolean;
  paintable?: boolean;
  note: string;
  error?: string;
} {
  const w = window as unknown as {
    __viewer?: { jsonUiReady?: boolean };
    __mojanglesReady?: boolean;
    __mojanglesLoaded?: boolean;
    __bedrockBitmapFontLoaded?: boolean;
    __jsonUiTexturesPending?: number;
    __filmHudImages?: Map<
      string,
      { ready: boolean; error: boolean; image: HTMLImageElement }
    >;
  };
  const error = document.querySelector<HTMLElement>("[data-jsonui-error]")
    ?.dataset.jsonuiError;
  if (error) return { ready: false, note: "", error };
  if (!w.__mojanglesReady) return { ready: false, note: "Mojangles loading" };
  if (!w.__mojanglesLoaded) {
    return {
      ready: false,
      note: "",
      error:
        "Mojangles unavailable; supply --font-dir or a mirrored /font/Mojangles.ttf",
    };
  }
  if (w.__bedrockBitmapFontLoaded === false) {
    return {
      ready: false,
      note: "",
      error:
        "Native default8.png unavailable; supply the installed-client bitmap in --font-dir or a pack font/default8.png",
    };
  }
  if (!w.__viewer?.jsonUiReady)
    return { ready: false, note: "JSON UI loading" };
  if (document.querySelector(".jsonui-form-fallback")) {
    return {
      ready: false,
      note: "",
      error:
        "form JSON UI definition unavailable; supply the recorded pack stack and viewer extensions",
    };
  }
  if ((w.__jsonUiTexturesPending ?? 0) > 0)
    return { ready: false, note: "JSON UI textures loading" };
  if (document.fonts.status !== "loaded")
    return { ready: false, note: "DOM fonts loading" };

  const images = (w.__filmHudImages ??= new Map());
  const urls = new Set<string>();
  for (const node of document.body.querySelectorAll("*")) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      !node.getClientRects().length
    )
      continue;
    // Keep this function self-contained when TS runners serialize it into
    // Chromium (named nested arrows can introduce an external __name helper).
    for (const value of [style.backgroundImage, style.borderImageSource]) {
      for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
        if (match[2]) urls.add(match[2]);
      }
    }
    if (node instanceof HTMLImageElement && node.currentSrc)
      urls.add(node.currentSrc);
  }
  let pendingImage = "";
  for (const src of urls) {
    let state = images.get(src);
    if (!state) {
      const image = new Image();
      state = { ready: false, error: false, image };
      images.set(src, state);
      const entry = state;
      image.onload = () => {
        entry.ready = true;
      };
      image.onerror = () => {
        entry.error = true;
      };
      image.src = src;
      // decode() can wait for a rendering opportunity that a paused film
      // page never schedules. Loaded dimensions are available without rAF;
      // page.screenshot forces rasterization, then pixel equality gates it.
      if (image.complete) {
        entry.ready = image.naturalWidth > 0;
        entry.error = !entry.ready;
      }
    }
    if (state.image.complete) {
      state.ready = state.image.naturalWidth > 0;
      state.error = !state.ready;
    }
    if (state.error)
      return {
        ready: false,
        note: "",
        error: `UI texture failed to decode: ${src}`,
      };
    if (!state.ready) pendingImage = src;
  }
  if (pendingImage)
    return {
      ready: false,
      paintable: true,
      note: `UI texture loading: ${pendingImage}`,
    };
  return { ready: true, note: "ready" };
}
