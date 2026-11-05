/**
 * JSON UI runtime: load pack ui files, mount the HUD, drive frames from WorldState.
 */

import {
  loadViewerExtensions,
  type LoadedViewerExtensions,
} from "../../extensions/load";
import type {
  ViewerHudExtension,
  ViewerOverlayFrame,
} from "../../extensions/types";
import { ensureMojangles } from "../mojangles";
import { AssetClient } from "../../terrain/assetClient";
import type { WorldState } from "../../store";
import {
  ninesliceCenterIsEmpty,
  texturePixelsAreUniform,
  type JsonUiAssets,
  type TextureInfo,
} from "./dom";
import { loadUiFileSet, type UiLoadClient, type UiPackInfo } from "./load";
import { buildResolver } from "./resolve";
import {
  createHudRenderer,
  DEFAULT_GUI_SCALE,
  type HudClientSettings,
  type HudRenderer,
} from "./hud";
import { createFormRenderer, type FormRenderer } from "./forms";
import type { UiResolver } from "./types";

/** Vanilla chrome that must nineslice / UV-crop on first paint. */
const PRELOAD_TEXTURES = [
  "textures/ui/control",
  "textures/ui/dialog_background_hollow_3",
  "textures/ui/dialog_background_hollow_1",
  "textures/ui/dialog_background_hollow_2",
  "textures/ui/dialog_background_hollow_4",
  "textures/ui/button_borderless_light",
  "textures/ui/focus_border_white",
  "textures/ui/close_button_default",
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
  /** Native client preferences absent from server packets. */
  clientSettings?: Partial<HudClientSettings>;
  /**
   * Injectable pack client (tests / fixtures). Defaults to fetch over
   * {@link assetBaseUrl}.
   */
  client?: UiLoadClient;
  /** Host element; default creates `#json-hud` under `document.body`. */
  host?: HTMLElement;
  /**
   * Pre-loaded extension hooks. When omitted, the runtime fetches
   * `/viewer.json` on {@link assetBaseUrl}. Null skips that fetch.
   */
  extension?: ViewerHudExtension | null;
  /** When true, do not fetch `/viewer.json` (tests that inject `extension`). */
  skipExtensionFetch?: boolean;
  /**
   * Called once extension modules have loaded (or immediately when none).
   *
   * @param loaded - Merged extension, or null when nothing loaded.
   */
  onExtensions?(loaded: ViewerHudExtension | null): void;
  /** Publish the same merged language table used by pack labels/forms. */
  onLanguage?(lang: Readonly<Record<string, string>>): void;
}

/** Public runtime handle (store subscriber). */
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
  let latestState: WorldState | null = null;
  let lastFormKey = "";
  let lastHover: number | null = null;

  const textureInfoCache = new Map<string, TextureInfo>();
  const textureInfoInflight = new Map<string, Promise<void>>();
  const textureInfoAttempted = new Set<string>();
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
      // Encode each segment (hub `GET /asset/{path...}` + NormalizePath).
      const rel = withExt
        .replace(/^\/+/, "")
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return `${assetBase}/asset/${rel}`;
    },
    textureInfo(path: string): TextureInfo | undefined {
      // Pack forms can bind arbitrary icons and button faces, beyond the
      // startup chrome list. Their natural dimensions/nineslices affect paint.
      // Repaint after loading without advancing the paused film clock.
      if (assetBase && !textureInfoAttempted.has(path)) {
        void preloadTextureInfo(path).then(() => {
          // A form can request dozens of new faces together. Rebuilding its
          // full collection tree after every response starves later responses
          // and capture readiness; the last response publishes the batch.
          if (!hud || !latestState || pendingWin.__jsonUiTexturesPending !== 0)
            return;
          lastFormKey = "";
          lastFrameMs = hud.onFrame(latestState);
          projectForm(latestState);
        });
      }
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
    if (textureInfoAttempted.has(path)) return;
    textureInfoAttempted.add(path);

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
        const info: TextureInfo = {
          w: w || Number(base?.[0]) || 0,
          h: h || Number(base?.[1]) || 0,
          nineslice: meta?.nineslice_size,
          ...(base && Number(base[0]) > 0 && Number(base[1]) > 0
            ? {
                baseSize: [Number(base[0]), Number(base[1])] as [
                  number,
                  number,
                ],
              }
            : {}),
        };
        // Check tiny plates (also used with element-level nineslices) and
        // larger textures whose metadata exhausts the center. A patterned
        // border must not become a stretched solid-color plate.
        if (
          bmp &&
          ((bmp.width <= 16 && bmp.height <= 16) ||
            (info.nineslice !== undefined &&
              ninesliceCenterIsEmpty(info, info.nineslice)))
        ) {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const context = canvas.getContext("2d", {
              willReadFrequently: true,
            });
            if (context) {
              context.drawImage(bmp, 0, 0);
              info.uniform = texturePixelsAreUniform(
                context.getImageData(0, 0, bmp.width, bmp.height).data,
              );
            }
          } catch {
            // Keep dimensions/slices when a browser cannot inspect pixels.
            // Unknown uniformity must not opt into the solid-plate path.
          }
        }
        textureInfoCache.set(path, info);
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
  // HUD control layers are local to their screen. They must never escape
  // above an open server form (for example a high-layer battle log panel).
  hudLayer.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:0;";
  host.appendChild(hudLayer);

  const formsHost = document.createElement("div");
  formsHost.className = "jsonui-forms-host";
  formsHost.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  host.appendChild(formsHost);

  const frameListeners: Array<(frame: ViewerOverlayFrame) => void> = [];
  let extension: ViewerHudExtension | null = opts.extension ?? null;

  /**
   * @param state - Latest world state.
   */
  function emitOverlay(state: WorldState): void {
    if (frameListeners.length === 0) return;
    const frame = overlayFrameFromState(state);
    for (const fn of frameListeners) fn(frame);
  }

  const ready = (async () => {
    // Outlines must exist before the first layout so wrapping matches paint.
    await ensureMojangles(assetBase);
    if (opts.extension === undefined && !opts.skipExtensionFetch && assetBase) {
      const loaded: LoadedViewerExtensions =
        await loadViewerExtensions(assetBase);
      extension = loaded.hud;
      await loaded.mountAll(host, {
        onFrame(fn) {
          frameListeners.push(fn);
          return () => {
            const i = frameListeners.indexOf(fn);
            if (i >= 0) frameListeners.splice(i, 1);
          };
        },
      });
    }
    opts.onExtensions?.(extension);
    const { files, globals, lang } = await loadUiFileSet(client);
    opts.onLanguage?.(lang);
    // Nineslice / flipbook UV need sync size lookup on first paint.
    const preload = [
      ...PRELOAD_TEXTURES,
      ...(extension?.preloadTextures ?? []),
    ];
    await Promise.all(preload.map((p) => preloadTextureInfo(p)));
    // The public resolver also signals jsonUiReady. Publish it only after
    // preloads, then mount/apply the first state in the same JS turn.
    resolver = buildResolver(files, globals);
    // Layout viewport tracks the real host size (full window). A fixed
    // 1024x576 letterbox made gui space 512x288 so the sidebar's
    // `222.22%y x 192` dock ate most of the still — live run-43 black slab.
    hud = createHudRenderer(resolver, hudLayer, {
      guiScale,
      clientSettings: opts.clientSettings,
      assets,
      lang,
      extension,
    });
    forms = createFormRenderer({
      resolver,
      globals,
      assets,
      lang,
      host: formsHost,
      guiScale,
      formRoutes: extension?.formRoutes,
      layoutRules: extension?.layoutRules,
    });
    if (pendingState) {
      const state = pendingState;
      pendingState = null;
      lastFrameMs = hud.onFrame(state);
      projectForm(state);
      emitOverlay(state);
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
    // Content, button icons and form type may change without any label change
    // (for example a new turn or page of an inventory form).
    const key = form ? JSON.stringify(form) : "";
    if (key !== lastFormKey) {
      lastHover = null;
      try {
        if (form) forms.show(form);
        else forms.hide();
      } catch (err) {
        host.dataset.jsonuiError =
          err instanceof Error ? err.message : String(err);
        throw err;
      }
      delete host.dataset.jsonuiError;
      lastFormKey = key;
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
      latestState = state;
      if (!hud) {
        pendingState = state;
        return;
      }
      lastFrameMs = hud.onFrame(state);
      projectForm(state);
      emitOverlay(state);
      // Occasional perf breadcrumb (once the cost spikes).
      if (lastFrameMs > 8) {
        host.dataset.jsonuiFrameMs = lastFrameMs.toFixed(2);
      }
    },
  };
}

/**
 * Projection of world state onto the extension frame.
 *
 * @param state - Latest world state.
 * @returns the snapshot an overlay module receives.
 */
function overlayFrameFromState(state: WorldState): ViewerOverlayFrame {
  const form = state.ui?.form;
  return {
    title: state.ui?.title ?? "",
    subtitle: state.ui?.subtitle ?? "",
    actionBar: state.ui?.actionBar ?? "",
    tokens: Object.fromEntries(state.titleTokens),
    form: form
      ? {
          type: form.type,
          title: form.title,
          content: form.content,
          buttons: form.buttons,
          buttonImages: form.buttonImages,
        }
      : null,
    bot: state.actor
      ? {
          name: state.actor.name || state.bot,
          position: state.actor.pos,
          dimension: state.actor.dimension,
        }
      : null,
    vitals: state.vitals,
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
