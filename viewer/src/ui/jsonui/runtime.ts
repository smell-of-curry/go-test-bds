/**
 * JSON UI runtime: load pack ui files, mount the HUD, drive frames from WorldState.
 */

import { AssetClient } from "../../terrain/assetClient";
import type { WorldState } from "../../store";
import { type JsonUiAssets, type TextureInfo } from "./dom";
import { loadUiFileSet, type UiLoadClient, type UiPackInfo } from "./load";
import { buildResolver } from "./resolve";
import { createHudRenderer, DEFAULT_GUI_SCALE, type HudRenderer } from "./hud";
import { createFormRenderer, type FormRenderer } from "./forms";
import type { UiResolver } from "./types";

/** UI textures that must nineslice / UV-crop on first paint. */
const PRELOAD_TEXTURES = [
  "textures/ui/control",
  "textures/ui/dialog_background_hollow_3",
  "textures/ui/dialog_background_hollow_1",
  "textures/ui/dialog_background_hollow_2",
  "textures/ui/dialog_background_hollow_4",
  "textures/ui/button_borderless_light",
  "textures/ui/focus_border_white",
  "textures/ui/close_button_default",
  "textures/ui/phud/oak_start",
  "textures/ui/phud/oak_loop",
  "textures/ui/phud/ringing",
  "textures/ui/phud/standby",
  "textures/ui/phud/box_small",
  "textures/ui/phud/box_wide",
  // Sidebar / XP chrome — warm texture-info before first PHUD paint so
  // golden screenshots do not race createImageBitmap / .json fetches.
  "textures/ui/sidebar/dock",
  "textures/ui/sidebar/data",
  "textures/ui/sidebar/ring",
  "textures/ui/filled_progress_bar",
  "textures/ui/Black",
  "textures/ui/bg32",
] as const;

/** Options for {@link createJsonUiRuntime}. */
export interface JsonUiRuntimeOptions {
  /** Origin serving `/packs`, `/pack/{id}/{path}`, `/asset/{path}`. */
  assetBaseUrl: string;
  /** Gui scale (default 2 → half the host CSS size in gui px). */
  guiScale?: number;
  /**
   * Injectable pack client (tests / fixtures). Defaults to fetch over
   * {@link assetBaseUrl}.
   */
  client?: UiLoadClient;
  /** Host element; default creates `#json-hud` under `document.body`. */
  host?: HTMLElement;
}

/** Public runtime handle (store-subscriber compatible with old PhudHandle). */
export interface JsonUiRuntime {
  /** Root HUD host. */
  readonly root: HTMLElement;
  /** Resolves when packs are loaded and the HUD is mounted. */
  readonly ready: Promise<void>;
  /** Last frame cost in ms (0 before first frame). */
  readonly lastFrameMs: number;
  /**
   * Project store state onto the JSON UI HUD.
   *
   * @param state - Latest world state.
   */
  onFrame(state: WorldState): void;
  /** Test helper — underlying resolver once ready. */
  getResolver(): UiResolver | null;
}

/**
 * Fetch-backed {@link UiLoadClient} over the viewer's pack HTTP API.
 *
 * @param assetBaseUrl - Origin (no trailing slash).
 * @returns load client.
 */
export function createFetchUiClient(assetBaseUrl: string): UiLoadClient {
  const base = assetBaseUrl.replace(/\/$/, "");
  // AssetClient already implements getPacks + fetchPackJson + fetchPackText.
  const assets = new AssetClient(base);
  return {
    getPacks: () => assets.getPacks() as Promise<UiPackInfo[]>,
    fetchPackJson: (packId, path) => assets.fetchPackJson(packId, path),
    fetchPackText: (packId, path) => assets.fetchPackText(packId, path),
  };
}

/**
 * Create the JSON UI runtime and begin loading pack UI definitions.
 *
 * @param opts - Asset base URL and optional test client / host.
 * @returns runtime handle; call {@link JsonUiRuntime.onFrame} from the store subscriber.
 */
export function createJsonUiRuntime(opts: JsonUiRuntimeOptions): JsonUiRuntime {
  const guiScale = opts.guiScale ?? DEFAULT_GUI_SCALE;
  const client = opts.client ?? createFetchUiClient(opts.assetBaseUrl);
  const assetBase = opts.assetBaseUrl.replace(/\/$/, "");

  const host = opts.host ?? document.createElement("div");
  if (!opts.host) {
    host.id = "json-hud";
    document.body.appendChild(host);
  }
  ensureJsonHudStyles();
  host.classList.add("jsonui-hud-host");

  let resolver: UiResolver | null = null;
  let hud: HudRenderer | null = null;
  let forms: FormRenderer | null = null;
  let lastFrameMs = 0;
  let pendingState: WorldState | null = null;
  let lastFormKey = "";
  let lastHover: number | null = null;

  const textureInfoCache = new Map<string, TextureInfo>();
  const textureInfoInflight = new Map<string, Promise<void>>();
  const assetHttp = new AssetClient(assetBase || "http://127.0.0.1");
  // Golden / capture harness polls these before screenshot.
  // pending = in-flight texture-info fetches; requested/epoch bump in paint.
  const pendingWin = window as unknown as {
    __jsonUiTexturesPending?: number;
    __jsonUiPaintEpoch?: number;
    __jsonUiTextureRequested?: number;
  };
  pendingWin.__jsonUiTexturesPending = pendingWin.__jsonUiTexturesPending ?? 0;
  pendingWin.__jsonUiPaintEpoch = pendingWin.__jsonUiPaintEpoch ?? 0;
  pendingWin.__jsonUiTextureRequested =
    pendingWin.__jsonUiTextureRequested ?? 0;

  const assets: JsonUiAssets = {
    textureUrl(path: string): string {
      const withExt = /\.[a-z]{3,4}$/i.test(path) ? path : `${path}.png`;
      if (!assetBase) return withExt;
      return `${assetBase}/asset/${withExt.replace(/^\/+/, "")}`;
    },
    textureInfo(path: string): TextureInfo | undefined {
      return textureInfoCache.get(path);
    },
  };

  /**
   * Load PNG natural size + sibling `.json` nineslice into the sync cache.
   *
   * @param path - Pack texture path without extension.
   */
  async function preloadTextureInfo(path: string): Promise<void> {
    if (textureInfoCache.has(path) || !assetBase) return;
    const existing = textureInfoInflight.get(path);
    if (existing) return existing;

    pendingWin.__jsonUiTexturesPending =
      (pendingWin.__jsonUiTexturesPending ?? 0) + 1;
    const work = (async () => {
      try {
        const [meta, bmp, pngSize] = await Promise.all([
          assetHttp.fetchJson<{
            nineslice_size?: unknown;
            base_size?: unknown;
          }>(`${path}.json`),
          assetHttp.fetchImage(path),
          readPngSize(path),
        ]);
        const base = Array.isArray(meta?.base_size) ? meta!.base_size : null;
        const w = bmp?.width || pngSize?.w || (base && Number(base[0])) || 0;
        const h = bmp?.height || pngSize?.h || (base && Number(base[1])) || 0;
        if (w <= 0 && h <= 0 && meta?.nineslice_size === undefined) return;
        textureInfoCache.set(path, {
          w: w || Number(base?.[0]) || 0,
          h: h || Number(base?.[1]) || 0,
          nineslice: meta?.nineslice_size,
        });
        try {
          bmp?.close();
        } catch {
          /* ignore */
        }
      } catch {
        // Missing vanilla chrome in fixture packs is fine.
      } finally {
        pendingWin.__jsonUiTexturesPending = Math.max(
          0,
          (pendingWin.__jsonUiTexturesPending ?? 1) - 1,
        );
        textureInfoInflight.delete(path);
      }
    })();
    textureInfoInflight.set(path, work);
    return work;
  }

  /**
   * Read PNG IHDR width/height when createImageBitmap is unavailable.
   *
   * @param path - Pack texture path without extension.
   * @returns natural size, or null.
   */
  async function readPngSize(
    path: string,
  ): Promise<{ w: number; h: number } | null> {
    try {
      const buf = await assetHttp.fetchBytes(
        path.endsWith(".png") ? path : `${path}.png`,
      );
      if (!buf || buf.byteLength < 24) return null;
      const view = new DataView(buf);
      if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
        return null;
      const w = view.getUint32(16);
      const h = view.getUint32(20);
      if (w <= 0 || h <= 0) return null;
      return { w, h };
    } catch {
      return null;
    }
  }

  // HUD paints into a child layer so form host survives host.replaceChildren().
  const hudLayer = document.createElement("div");
  hudLayer.className = "jsonui-hud-layer";
  hudLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  host.appendChild(hudLayer);

  const formsHost = document.createElement("div");
  formsHost.className = "jsonui-forms-host";
  formsHost.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  host.appendChild(formsHost);

  const ready = (async () => {
    const { files, globals, lang } = await loadUiFileSet(client);
    resolver = buildResolver(files, globals);
    // Nineslice / flipbook UV need sync size lookup on first paint.
    await Promise.all(PRELOAD_TEXTURES.map((p) => preloadTextureInfo(p)));
    // Layout viewport tracks the real host size (full window). A fixed
    // 1024x576 letterbox made gui space 512x288 so the sidebar's
    // `222.22%y x 192` dock ate most of the still — live run-43 black slab.
    hud = createHudRenderer(resolver, hudLayer, {
      guiScale,
      assets,
      lang,
    });
    forms = createFormRenderer({
      resolver,
      globals,
      assets,
      lang,
      host: formsHost,
      guiScale,
    });
    if (pendingState) {
      const state = pendingState;
      pendingState = null;
      lastFrameMs = hud.onFrame(state);
      projectForm(state);
    }
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[jsonui] failed to load UI packs: ${msg}`);
    host.dataset.jsonuiError = msg;
  });

  /**
   * Show/hide/hover the engine form from state (dirty-checked).
   *
   * @param state - Latest world state.
   */
  function projectForm(state: WorldState): void {
    if (!forms) return;
    const form = state.ui?.form ?? null;
    const key = form ? `${form.title}\0${(form.buttons ?? []).join("\0")}` : "";
    if (key !== lastFormKey) {
      lastFormKey = key;
      lastHover = null;
      if (form) forms.show(form);
      else forms.hide();
    }
    if (state.formHover !== lastHover) {
      lastHover = state.formHover;
      forms.hover(state.formHover);
    }
  }

  return {
    root: host,
    ready,
    get lastFrameMs() {
      return lastFrameMs;
    },
    getResolver: () => resolver,
    onFrame(state: WorldState): void {
      if (!hud) {
        pendingState = state;
        return;
      }
      lastFrameMs = hud.onFrame(state);
      projectForm(state);
      // Occasional perf breadcrumb (once the cost spikes).
      if (lastFrameMs > 8) {
        host.dataset.jsonuiFrameMs = lastFrameMs.toFixed(2);
      }
    },
  };
}

/**
 * Install minimal host CSS once (fixed fullscreen overlay, no pointer events).
 */
function ensureJsonHudStyles(): void {
  if (document.getElementById("jsonui-hud-style")) return;
  const style = document.createElement("style");
  style.id = "jsonui-hud-style";
  style.textContent = `
#json-hud, .jsonui-hud-host {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 4;
  /* Hotbar hangs below the 5gui XP strip (offset [4,16]); clip would hide it. */
  overflow: visible;
}
/* JSON UI owns title / vitals / hotbar; keep chat/actionbar from #player-hud. */
body.jsonui-hud-active #player-hud .hud-title-wrap,
body.jsonui-hud-active #player-hud .hud-hotbar-wrap {
  display: none !important;
}
/* Forms: hide the top-right debug panel unless ?debugForms=1 cleared the class. */
body.jh-owns-forms #ui-panel {
  display: none !important;
}
`;
  document.head.appendChild(style);
}
