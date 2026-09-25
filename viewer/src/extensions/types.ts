/**
 * Viewer extension contract.
 *
 * A consumer points the bot at a directory (`--viewer-extensions` /
 * `GOTESTBDS_VIEWER_EXTENSIONS`). The hub serves that directory at
 * `/extensions/` and advertises it from `GET /viewer.json`. The viewer loads
 * `manifest.json` and each ES module listed in `modules`.
 *
 * Resource-pack JSON UI (`ui/*.json` from the server pack stack) is already
 * generic and needs no extension. Use a module for overlays and bind quirks
 * the pack's JSON cannot express.
 *
 * @example manifest.json
 * ```json
 * { "modules": ["./overlay.mjs"] }
 * ```
 *
 * @example overlay.mjs
 * ```js
 * export const viewerExtension = {
 *   preloadTextures: ["textures/ui/widgets/badge"],
 *   onBind(ctx) {
 *     if (ctx.namespace === "widgets" && ctx.name === "badge") {
 *       ctx.props.visible = Boolean(ctx.tokens.badge);
 *     }
 *   },
 *   mount(host, api) {
 *     const el = document.createElement("div");
 *     host.appendChild(el);
 *     api.onFrame((frame) => {
 *       el.textContent = frame.actionBar;
 *     });
 *   },
 * };
 * ```
 */

import type { VitalsFrame } from "../protocol";

/**
 * One frame of presentation state handed to an overlay.
 *
 * Party / custom sidebar text is not a separate scoreboard lane. Packs that
 * smuggle it through the title channel expose the latest value on `tokens`
 * (token name → raw string, prefix already stripped).
 */
export interface ViewerOverlayFrame {
  /** Plain title lane (already filtered of control tokens by the hub). */
  title: string;
  subtitle: string;
  actionBar: string;
  /**
   * Latest control-token map from the `titleToken` stream event.
   * Empty object when no prefix is configured or the server sends none.
   */
  tokens: Readonly<Record<string, string>>;
  form: {
    type: string;
    title: string;
    content: string;
    buttons: string[];
    buttonImages?: string[];
  } | null;
  /** Bot the stream is following, or null before the first keyframe. */
  bot: {
    name: string;
    position: [number, number, number];
    dimension: number;
  } | null;
  vitals: VitalsFrame | null;
}

/** Bound element an `onBind` hook may mutate. `props` is the painter input. */
export interface ViewerBindContext {
  name: string;
  namespace: string;
  type: string;
  /** Mutable. Writes here affect layout and paint this frame. */
  props: Record<string, unknown>;
  /** Authored element props, including `$variables`. Not mutated by the engine. */
  authored: Readonly<Record<string, unknown>>;
  /** Raw `bindings` array from the JSON UI element, if any. */
  bindings: readonly Record<string, unknown>[];
  title: string;
  subtitle: string;
  actionBar: string;
  tokens: Readonly<Record<string, string>>;
  form: ViewerOverlayFrame["form"];
  bot: ViewerOverlayFrame["bot"];
  vitals: VitalsFrame | null;
}

/** Node passed to {@link ViewerExtensionModule.afterTree}. */
export interface ViewerBoundNode {
  name: string;
  namespace: string;
  type: string;
  props: Record<string, unknown>;
  controls: { id: string; element: ViewerBoundNode }[];
}

/** Arguments for {@link ViewerExtensionModule.resolveTitle}. */
export interface ViewerTitleInput {
  title: string;
  subtitle: string;
  actionBar: string;
  tokens: Readonly<Record<string, string>>;
}

/** Extra `root_panel` screen the HUD should mount. */
export interface HudScreenMount {
  /** Child id on `hud.root_panel`, or the id used when mounting a fallback. */
  id: string;
  /** Resolve this screen when `id` is not already a `root_panel` child. */
  namespace?: string;
  /** Element name inside {@link namespace}. */
  name?: string;
  /**
   * Wrap the fallback in a top-left vertical stack (`chat_stack`).
   * Used for a slim ping host the pruned root would otherwise drop.
   */
  wrapStack?: boolean;
}

/**
 * Pack layout corrections the generic engine applies by namespace + name.
 * Absent rules change nothing.
 */
export interface LayoutQuirkRules {
  /** Treat omitted size as content and default anchors as left_middle. */
  iconHosts?: ReadonlyArray<{ namespace: string; name: string }>;
  /**
   * Right-anchored elements whose width is capped to a fraction of the
   * viewport, then inset from the parent's right edge.
   */
  capRight?: ReadonlyArray<{
    namespace: string;
    name: string;
    /** Max width as a fraction of viewport width (0.25 = 25%). */
    maxWidthRatio: number;
    /** Inset = max(minInset, width * insetRatio). */
    insetRatio: number;
    minInset: number;
  }>;
  /**
   * Right-anchored elements whose paint box clips at the parent while
   * children keep the full authored box.
   */
  clipDock?: ReadonlyArray<{ namespace: string; name: string }>;
}

/** Still gate the capture harness consults when `noSettle` is set. */
export interface ViewerCaptureGate {
  /** Case-insensitive substring of the capture label that arms the gate. */
  labelIncludes: string;
  /**
   * @param tokens - Live title-token map.
   * @param root - Document (or host) to query for painted text.
   * @returns true when the still is safe to shoot.
   */
  ready(tokens: Readonly<Record<string, string>>, root: ParentNode): boolean;
}

/**
 * Object an extension module exports as `viewerExtension` (or as default).
 */
export interface ViewerExtensionModule {
  /**
   * Reserved. Pack-specific title and chrome behaviour belongs in the hooks
   * below. The engine does not ship a second copy of those quirks.
   */
  replaceBuiltins?: boolean;
  /** Extra HUD screens to keep or mount. Default: survival vitals + title only. */
  hudScreens?: readonly HudScreenMount[];
  /** Namespace/name layout corrections. Default: none. */
  layoutRules?: LayoutQuirkRules;
  /**
   * Milliseconds to hold a token after an empty clear, keyed by token name.
   */
  titleTokenClearDelayMs?: Readonly<Record<string, number>>;
  /** Capture still gates. */
  captureGates?: readonly ViewerCaptureGate[];
  /**
   * Invisible title-flag → `namespace.name` screen. First match wins.
   * Packs that route ActionForms this way supply the table here.
   */
  formRoutes?: ReadonlyArray<{ flag: string; screen: string }>;
  /** Pack texture paths without extension, warmed before the first paint. */
  preloadTextures?: readonly string[];
  /**
   * Raw `#hud_title_text_string` the JSON UI bindings should see.
   * Only the first module that defines this is called.
   *
   * @param input - Plain lanes plus the token map.
   * @returns title string (may be empty).
   */
  resolveTitle?(input: ViewerTitleInput): string;
  /**
   * Extra `#globals` written before bind. All modules are called.
   *
   * @param tokens - Latest token map.
   * @param set - `set("#prop", value)`.
   */
  seedGlobals?(
    tokens: Readonly<Record<string, string>>,
    set: (key: string, value: string) => void,
  ): void;
  /**
   * Per-element hook after the generic bind (and after built-in quirks,
   * unless {@link replaceBuiltins} is set). All modules are called.
   *
   * @param ctx - Element and frame slice. Mutate `ctx.props`.
   */
  onBind?(ctx: ViewerBindContext): void;
  /**
   * Called once the HUD tree is bound, before layout. All modules are called.
   *
   * @param ctx - Root plus the title and token map used for this frame.
   */
  afterTree?(ctx: {
    root: ViewerBoundNode;
    title: string;
    tokens: Readonly<Record<string, string>>;
  }): void;
  /**
   * Optional DOM overlay. Called once after the JSON UI host exists.
   *
   * @param host - `#json-hud` element.
   * @param api - Frame subscription.
   */
  mount?(host: HTMLElement, api: ViewerExtensionApi): void | Promise<void>;
}

/** API passed to {@link ViewerExtensionModule.mount}. */
export interface ViewerExtensionApi {
  /**
   * @param fn - Called after each world frame is projected onto JSON UI.
   * @returns unsubscribe.
   */
  onFrame(fn: (frame: ViewerOverlayFrame) => void): () => void;
}

/**
 * Hooks the JSON UI HUD actually calls. Produced by merging loaded modules.
 */
export interface ViewerHudExtension {
  replaceBuiltins: boolean;
  formRoutes: ReadonlyArray<{ flag: string; screen: string }>;
  preloadTextures: readonly string[];
  hudScreens: readonly HudScreenMount[];
  layoutRules: LayoutQuirkRules;
  titleTokenClearDelayMs: Readonly<Record<string, number>>;
  captureGates: readonly ViewerCaptureGate[];
  resolveTitle?: ViewerExtensionModule["resolveTitle"];
  seedGlobals?: ViewerExtensionModule["seedGlobals"];
  onBind?: ViewerExtensionModule["onBind"];
  afterTree?: ViewerExtensionModule["afterTree"];
}
