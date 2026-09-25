/**
 * Load viewer extension modules from the hub's `/viewer.json` advertisement.
 */

import type {
  LayoutQuirkRules,
  ViewerExtensionModule,
  ViewerHudExtension,
  ViewerOverlayFrame,
} from "./types";

/** What {@link loadViewerExtensions} returns. `hud` is null when nothing loaded. */
export interface LoadedViewerExtensions {
  hud: ViewerHudExtension | null;
  /**
   * Call each module's `mount`, if any.
   *
   * @param host - Overlay parent (the JSON UI host).
   * @param api - Frame subscription shared with the runtime.
   */
  mountAll(
    host: HTMLElement,
    api: {
      onFrame(fn: (frame: ViewerOverlayFrame) => void): () => void;
    },
  ): Promise<void>;
}

/** Fetch + dynamic-import seam so tests can load modules without a browser. */
export interface LoadViewerExtensionsOptions {
  /**
   * @param url - Absolute module URL.
   * @returns the module namespace.
   */
  importModule?(url: string): Promise<Record<string, unknown>>;
  /** @param url - Absolute URL. */
  fetch?: typeof fetch;
}

const emptyLoaded: LoadedViewerExtensions = {
  hud: null,
  mountAll: async () => undefined,
};

/**
 * Merge module exports into the hooks the HUD calls.
 *
 * `replaceBuiltins` is true if any module sets it. `resolveTitle` is the
 * first module that defines one. Other hooks run every module, in order.
 *
 * @param modules - Loaded extension objects (empty entries already dropped).
 * @returns merged hooks, or null when `modules` is empty.
 */
export function mergeViewerExtensions(
  modules: readonly ViewerExtensionModule[],
): ViewerHudExtension | null {
  if (modules.length === 0) return null;
  const resolveTitle = modules.find((m) => m.resolveTitle)?.resolveTitle;
  const layoutRules: LayoutQuirkRules = {
    iconHosts: modules.flatMap((m) => m.layoutRules?.iconHosts ?? []),
    capRight: modules.flatMap((m) => m.layoutRules?.capRight ?? []),
    clipDock: modules.flatMap((m) => m.layoutRules?.clipDock ?? []),
    maxWidth: modules.flatMap((m) => m.layoutRules?.maxWidth ?? []),
    layoutHiddenChildren: modules.flatMap(
      (m) => m.layoutRules?.layoutHiddenChildren ?? [],
    ),
    stackFactoryChildNames: modules.flatMap(
      (m) => m.layoutRules?.stackFactoryChildNames ?? [],
    ),
    clampToViewport: modules.flatMap(
      (m) => m.layoutRules?.clampToViewport ?? [],
    ),
  };
  const titleTokenClearDelayMs: Record<string, number> = {};
  for (const m of modules) {
    Object.assign(titleTokenClearDelayMs, m.titleTokenClearDelayMs);
  }
  return {
    replaceBuiltins: modules.some((m) => m.replaceBuiltins === true),
    formRoutes: modules.flatMap((m) => (m.formRoutes ? [...m.formRoutes] : [])),
    preloadTextures: modules.flatMap((m) =>
      m.preloadTextures ? [...m.preloadTextures] : [],
    ),
    hudScreens: modules.flatMap((m) => (m.hudScreens ? [...m.hudScreens] : [])),
    layoutRules,
    titleTokenClearDelayMs,
    captureGates: modules.flatMap((m) =>
      m.captureGates ? [...m.captureGates] : [],
    ),
    resolveTitle,
    seedGlobals(tokens, set) {
      for (const m of modules) m.seedGlobals?.(tokens, set);
    },
    onBind(ctx) {
      for (const m of modules) m.onBind?.(ctx);
    },
    afterTree(ctx) {
      for (const m of modules) m.afterTree?.(ctx);
    },
  };
}

/**
 * Read `GET /viewer.json` on the stream origin and import its modules.
 *
 * A missing endpoint, empty `extensions` field, or bad manifest leaves the
 * built-in HUD path in place (returns `hud: null`). Never throws.
 *
 * @param assetBaseUrl - Origin serving `/viewer.json` and `/extensions/`.
 * @param options - Optional fetch / import seams.
 * @returns loaded modules. `hud` is null when there is nothing to apply.
 */
export async function loadViewerExtensions(
  assetBaseUrl: string,
  options?: LoadViewerExtensionsOptions,
): Promise<LoadedViewerExtensions> {
  const base = assetBaseUrl.replace(/\/$/, "");
  if (!base) return emptyLoaded;
  const doFetch = options?.fetch ?? fetch;
  const doImport = options?.importModule ?? defaultImportModule;

  let root = "";
  try {
    const res = await doFetch(`${base}/viewer.json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return emptyLoaded;
    const cfg = (await res.json()) as { extensions?: unknown };
    if (typeof cfg.extensions === "string") root = cfg.extensions;
  } catch {
    return emptyLoaded;
  }
  if (!root) return emptyLoaded;

  const rootUrl = new URL(root.endsWith("/") ? root : `${root}/`, `${base}/`);
  let moduleUrls: string[] = [];
  try {
    const res = await doFetch(new URL("manifest.json", rootUrl), {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return emptyLoaded;
    const manifest = (await res.json()) as { modules?: unknown };
    if (!Array.isArray(manifest.modules)) return emptyLoaded;
    moduleUrls = manifest.modules.filter(
      (m): m is string => typeof m === "string" && m.length > 0,
    );
  } catch {
    return emptyLoaded;
  }
  if (moduleUrls.length === 0) return emptyLoaded;

  const modules: ViewerExtensionModule[] = [];
  for (const rel of moduleUrls) {
    try {
      const url = new URL(rel, rootUrl);
      const ns = await doImport(url.href);
      const ext = extensionFromNamespace(ns);
      if (ext) modules.push(ext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[viewer] extension ${rel} failed to load: ${msg}`);
    }
  }
  const hud = mergeViewerExtensions(modules);
  return {
    hud,
    mountAll: async (host, api) => {
      for (const mod of modules) {
        if (!mod.mount) continue;
        await mod.mount(host, api);
      }
    },
  };
}

/**
 * @param url - Absolute module URL.
 * @returns module namespace.
 */
async function defaultImportModule(
  url: string,
): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

/**
 * @param ns - Module namespace.
 * @returns the extension object, or null when the module exports none.
 */
function extensionFromNamespace(
  ns: Record<string, unknown>,
): ViewerExtensionModule | null {
  const named = ns.viewerExtension;
  if (named && typeof named === "object") return named as ViewerExtensionModule;
  const def = ns.default;
  if (def && typeof def === "object") return def as ViewerExtensionModule;
  return null;
}
