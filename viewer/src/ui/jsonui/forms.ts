/**
 * Server-form routing + JSON UI rendering for ActionForm / ModalForm.
 *
 * Title flags come from a viewer extension (`formRoutes`). Unroutable
 * titles fall back to vanilla long/custom form (caller may also
 * keep `?debugForms=1` for the top-right debug UI).
 */

import {
  formButtonsCollection,
  prepareCollectionTree,
  type CollectionItem,
  type CollectionMap,
} from "./collections.js";
import {
  paintChildOrder,
  renderTree,
  type JsonUiAssets,
  type TextureInfoMap,
} from "./dom.js";
import { measureMojangles } from "../mojangles.js";
import { mountFormTooltip } from "./tooltip";
import {
  LABEL_LINE_HEIGHT_GUI,
  collapseLangPercentEscapes,
} from "./labelMetrics.js";
import {
  layoutTree,
  type LayoutNode,
  type LayoutOptions,
  type MeasureText,
} from "./layout.js";
import type {
  BindingSource,
  BindingValue,
  PropertyBag,
  ResolvedElement,
  UiResolver,
  Viewport,
} from "./types.js";

/** Axis-aligned box for a laid-out battle move card. */
export interface BattleMoveRect {
  /** Wire prefix `b:1_` … `b:4_`. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Wire form snapshot (matches `protocol.UI.form`). */
export interface FormSnapshot {
  type: string;
  title: string;
  content: string;
  buttons: string[];
  buttonImages?: string[];
}

/** Title flag → `namespace.name` screen. Supplied by a viewer extension. */
export interface FormFlagRoute {
  flag: string;
  screen: string;
}

export interface FormRoute {
  /** `"battle.main"` style. */
  screen: string;
  namespace: string;
  name: string;
  /** Matched invisible flag, or "" for vanilla long/custom form. */
  flag: string;
  kind: "flag" | "long_form" | "custom_form" | "modal";
}

export interface FormRendererDeps {
  resolver: UiResolver;
  globals?: PropertyBag;
  assets: JsonUiAssets;
  host: HTMLElement;
  /** Gui scale for DOM emission (default 2). */
  guiScale?: number;
  viewport?: Viewport;
  measureText?: MeasureText;
  /** Merged pack lang table for `localize: true` labels. */
  lang?: Readonly<Record<string, string>>;
  /** Title-flag routes from a viewer extension. Empty uses vanilla forms only. */
  formRoutes?: readonly FormFlagRoute[];
  /** Pack layout corrections. Forms use the same rules as the HUD. */
  layoutRules?: LayoutOptions["rules"];
  /**
   * Texture size + nineslice map for dialogue chrome / portraits.
   * Prefer `assets.textureInfo`; this is a test/fixture override.
   */
  textureInfo?: TextureInfoMap;
}

export interface FormRenderer {
  show(form: FormSnapshot): void;
  hover(index: number | null): void;
  hide(): void;
  /** Last prepared tree (tests). */
  readonly lastTree: ResolvedElement | null;
  /** Last routed screen id (tests). */
  readonly lastRoute: FormRoute | null;
}

/**
 * Extract the title-flag route for a form snapshot.
 *
 * Title flags win over plain titles. Custom input forms use custom_form;
 * two-button messages use the vanilla popup dialog template.
 *
 * @param form - Form snapshot.
 * @returns route descriptor.
 */
export function routeForm(
  form: FormSnapshot,
  routes: readonly FormFlagRoute[] = [],
): FormRoute {
  const title = form.title ?? "";
  for (const { flag, screen } of routes) {
    if (title.includes(flag)) {
      const [namespace, name] = splitScreen(screen);
      return { screen, namespace, name, flag, kind: "flag" };
    }
  }
  const t = (form.type ?? "").toLowerCase();
  if (t === "modal" || t === "modal_form") {
    return {
      screen: "popup_dialog.modal_dialog_popup",
      namespace: "popup_dialog",
      name: "modal_dialog_popup",
      flag: "",
      kind: "modal",
    };
  }
  if (t === "custom") {
    return {
      screen: "server_form.custom_form",
      namespace: "server_form",
      name: "custom_form",
      flag: "",
      kind: "custom_form",
    };
  }
  return {
    screen: "server_form.long_form",
    namespace: "server_form",
    name: "long_form",
    flag: "",
    kind: "long_form",
  };
}

/**
 * Build the global BindingSource + form_buttons collection for a snapshot.
 *
 * @param form - Form snapshot.
 * @returns source + collections.
 */
export function formBindingState(form: FormSnapshot): {
  source: BindingSource;
  collections: CollectionMap;
  globals: Record<string, BindingValue>;
} {
  const buttons = form.buttons ?? [];
  const items = formButtonsCollection(buttons, form.buttonImages);
  const custom =
    form.type === "custom" ? customFormCollection(form.content) : [];
  const globals: Record<string, BindingValue> = {
    "#title_text": form.title ?? "",
    "#form_text": form.content ?? "",
    "#form_button_length": buttons.length,
    "#form_button_contents": buttons.length,
    "#submit_text": "Submit",
    "#submit_button_visible": true,
    "#custom_form_length": custom.length,
    "#modal_title_text": form.title ?? "",
    "#modal_label_text": form.content ?? "",
    "#modal_left_button_text": buttons[0] ?? "",
    "#modal_rightcancel_button_text": buttons[1] ?? "",
  };
  const source: BindingSource = {
    global(name: string): BindingValue | undefined {
      if (name in globals) return globals[name];
      const hashed = name.startsWith("#") ? name : `#${name}`;
      if (hashed in globals) return globals[hashed];
      const bare = name.startsWith("#") ? name.slice(1) : name;
      return globals[bare];
    },
  };
  return {
    source,
    collections: { form_buttons: items, custom_form: custom },
    globals,
  };
}

/**
 * Project recorded custom-form fields onto vanilla collection bindings.
 * Malformed recordings must not silently turn into an empty Submit screen.
 *
 * @param content - Serialized custom-form field array from the recorder.
 * @returns Per-field bindings, preserving the original field index.
 */
export function customFormCollection(content: string): CollectionItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("recorded custom-form content is not valid JSON");
  }
  if (!Array.isArray(parsed))
    throw new Error("recorded custom-form content must be an array");
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`recorded custom-form field ${index} is not an object`);
    const field = value as Record<string, unknown>;
    const type = String(field.type ?? "label");
    if (!["label", "header", "divider", "toggle", "dropdown"].includes(type)) {
      throw new Error(
        `recorded custom-form field type ${type} is not supported`,
      );
    }
    const text = typeof field.text === "string" ? field.text : "";
    const options = Array.isArray(field.options)
      ? field.options.map(String)
      : [];
    const selected = Math.max(0, Math.floor(Number(field.default) || 0));
    const enabled = field.enabled !== false;
    return {
      "#factory_control_id": type,
      "#collection_index": index,
      "#custom_text": text,
      "#custom_tooltip_text":
        typeof field.tooltip === "string" ? field.tooltip : "",
      "#custom_toggle_state": field.default === true,
      "#custom_toggle_enabled": enabled,
      "#dropdown_option_text": options[selected] ?? options[0] ?? "",
      // Playback has no dropdown expansion event: display its recorded/default
      // selection, leaving the unopened option list uninstantiated.
      "#custom_dropdown_length": 0,
    };
  });
}

/**
 * Resolve + expand + bind a form into a ResolvedElement tree (no DOM).
 *
 * @param resolver - UI resolver.
 * @param form - Form snapshot.
 * @param extraGlobals - Optional pack `$variables` / extra `#` bindings.
 * @returns bound tree + route, or null when the screen is missing.
 */
export function prepareFormTree(
  resolver: UiResolver,
  form: FormSnapshot,
  extraGlobals: PropertyBag = {},
  routes: readonly FormFlagRoute[] = [],
): { tree: ResolvedElement; route: FormRoute } | null {
  const route = routeForm(form, routes);
  const root = resolver.resolve(
    route.namespace,
    route.name,
    route.kind === "modal" ? { $two_buttons_visible: true } : undefined,
  );
  if (!root) return null;
  const { source, collections } = formBindingState(form);
  const merged: BindingSource = {
    global(name: string): BindingValue | undefined {
      const fromForm = source.global(name);
      if (fromForm !== undefined) return fromForm;
      const hashed = name.startsWith("#") ? name : `#${name}`;
      const v = extraGlobals[hashed] ?? extraGlobals[name];
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        return v;
      }
      return undefined;
    },
  };
  const tree = prepareCollectionTree(root, resolver, merged, collections);
  if (
    route.kind === "long_form" ||
    route.kind === "custom_form" ||
    route.kind === "modal"
  ) {
    patchDialogueChrome(tree);
  }
  return { tree, route };
}

/**
 * Select a form button's authored default/hover/locked face. Collection indices
 * live on factory roots, so carry them through nested panels to each button.
 * Bindings have already run; neutralizing the active face's state markers lets
 * the generic layout retain it instead of its idle-only fallback suppression.
 */
export function selectFormButtonStates(
  tree: ResolvedElement,
  hoverIndex: number | null,
): ResolvedElement {
  const states = ["default", "hover", "pressed", "locked"] as const;
  function walk(
    node: ResolvedElement,
    inheritedIndex: number | null,
    activeFace = false,
  ): ResolvedElement {
    const index =
      typeof node.props.collection_index === "number"
        ? node.props.collection_index
        : inheritedIndex;
    const props = { ...node.props };
    if (activeFace)
      for (const state of states) props[`$${state}_state`] = false;
    if (
      node.type !== "button" &&
      node.type !== "toggle" &&
      node.type !== "dropdown"
    ) {
      return {
        ...node,
        props,
        controls: node.controls.map((child) => ({
          ...child,
          element: walk(child.element, index, activeFace),
        })),
      };
    }
    const toggle = node.type === "toggle" || node.type === "dropdown";
    const ownStates: readonly string[] = toggle
      ? [
          "checked",
          "unchecked",
          "checked_hover",
          "unchecked_hover",
          "checked_locked",
          "unchecked_locked",
          "checked_locked_hover",
          "unchecked_locked_hover",
        ]
      : states;
    const faceState = (
      id: string,
      element: ResolvedElement,
    ): string | undefined =>
      ownStates.find((state) => {
        const control = node.props[`${state}_control`];
        return (
          (typeof control === "string" && control !== "" && id === control) ||
          element.props[`$${state}_state`] === true
        );
      });
    const interaction =
      node.props.enabled === false
        ? "locked"
        : index !== null && index === hoverIndex
          ? "hover"
          : "default";
    const checked =
      (node.props.toggle_state ?? node.props.toggle_default_state) === true
        ? "checked"
        : "unchecked";
    const wanted = toggle
      ? checked + (interaction === "default" ? "" : `_${interaction}`)
      : interaction;
    const fallback = toggle ? checked : "default";
    const selected = node.controls.some(
      (child) => faceState(child.id, child.element) === wanted,
    )
      ? wanted
      : fallback;
    return {
      ...node,
      props,
      controls: node.controls.map((child) => {
        const state = faceState(child.id, child.element);
        const element = walk(
          child.element,
          index,
          state ? state === selected : activeFace,
        );
        if (state && state !== selected) element.props.visible = false;
        return { ...child, element };
      }),
    };
  }
  return walk(tree, null);
}

/**
 * Fix dialogue chrome that vanilla authors leave underspecified for our layout.
 *
 * - `close_button_holder` has no anchors/size → layout defaults to a centered
 *   21×21 box, so the close X floats mid-panel instead of the dialog corner.
 * - `panel_indent` offset 23 leaves the body under the hollow title band.
 *
 * @param tree - Bound long_form / custom_form tree (mutated in place).
 */
export function patchDialogueChrome(tree: ResolvedElement): void {
  const walk = (el: ResolvedElement): void => {
    if (el.name === "close_button_holder") {
      // Match form_fitting `common_close_button_holder`: fill + top-right so
      // child `close_button` top_right lands on the dialog corner.
      if (el.props.anchor_from == null) el.props.anchor_from = "top_right";
      if (el.props.anchor_to == null) el.props.anchor_to = "top_right";
      if (el.props.size == null) el.props.size = ["100%", "100%"];
    }
    if (el.name === "panel_indent") {
      const off = el.props.offset;
      if (Array.isArray(off) && off.length >= 2 && Number(off[1]) === 23) {
        el.props.offset = [off[0], 28];
        const sz = el.props.size;
        if (Array.isArray(sz) && sz[1] === "100% - 31px") {
          el.props.size = [sz[0], "100% - 36px"];
        }
      }
    }
    for (const c of el.controls) walk(c.element);
  };
  walk(tree);
}

/**
 * Collect laid-out nodes whose `form_button_text` starts with `b:1_`…`b:4_`.
 * Prefer a visible child named `button` for the measured box.
 *
 * @param root - Layout root from {@link layoutTree}.
 * @returns one rect per visible `b:1_`…`b:4_` card, sorted by id.
 */
export function collectBattleMoveRects(root: LayoutNode): BattleMoveRect[] {
  const found: BattleMoveRect[] = [];
  (function walk(n: LayoutNode): void {
    if (!n.visible) return;
    const text = n.element.props.form_button_text;
    if (typeof text === "string" && /^b:[1-4]_/.test(text)) {
      const card = n.children.find(
        (c) => c.visible && c.element.name === "button",
      );
      const box = card?.box ?? n.box;
      found.push({
        id: text.slice(0, 4),
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
      });
    }
    for (const c of n.children) walk(c);
  })(root);
  const byId = new Map<string, BattleMoveRect>();
  for (const r of found) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param a - First rect.
 * @param b - Second rect.
 * @returns true when the open boxes overlap.
 */
export function rectsIntersect(a: BattleMoveRect, b: BattleMoveRect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * @param rects - Move card boxes.
 * @returns pairs of ids whose rects intersect.
 */
export function intersectingBattleMovePairs(
  rects: readonly BattleMoveRect[],
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (rectsIntersect(a, b)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

/**
 * Create a form renderer that paints into `deps.host`.
 *
 * @param deps - Resolver, assets, host element.
 * @returns show / hover / hide API.
 */
export function createFormRenderer(deps: FormRendererDeps): FormRenderer {
  const guiScale = deps.guiScale ?? 2;
  const measureText =
    deps.measureText ??
    ((text: string, fontScale: number) => {
      const plain = collapseLangPercentEscapes(text.replace(/[§&]./g, ""));
      const moj = measureMojangles(plain, fontScale);
      if (moj) return moj;
      const lines = plain.length ? plain.split("\n") : [""];
      let maxLen = 1;
      for (const line of lines) maxLen = Math.max(maxLen, line.length);
      return {
        w: Math.max(1, maxLen * 6 * fontScale + 1),
        h: Math.max(1, lines.length) * LABEL_LINE_HEIGHT_GUI * fontScale,
      };
    });

  let lastTree: ResolvedElement | null = null;
  let lastRoute: FormRoute | null = null;
  let hoverIndex: number | null = null;
  let currentForm: FormSnapshot | null = null;
  let engineRoot: HTMLElement | null = null;
  let plainRoot: HTMLElement | null = null;
  let clearTooltip = (): void => {};

  const host = deps.host;
  host.style.position = host.style.position || "absolute";
  host.style.inset = host.style.inset || "0";
  host.style.pointerEvents = "none";
  // Isolate so transparent dialog holes composite over the scrim sibling
  // (not punch through to the WebGL canvas / body nametag overlays).
  host.style.isolation = host.style.isolation || "isolate";
  // Nested z-index alone cannot beat body-level nametag divs — `#json-hud`
  // defaults to z-index:4; raise that root while a dialogue is open.
  host.style.zIndex = host.style.zIndex || "50";

  /** `#json-hud` / `.jsonui-hud-host` that contains this forms host. */
  const hudRoot =
    (host.closest("#json-hud, .jsonui-hud-host") as HTMLElement | null) ?? null;
  let hudZBeforeForm: string | null = null;

  function setHudFormStacking(open: boolean): void {
    if (!hudRoot) return;
    if (open) {
      if (hudZBeforeForm === null) hudZBeforeForm = hudRoot.style.zIndex;
      hudRoot.style.zIndex = "50";
      hudRoot.dataset.formOpen = "1";
    } else {
      if (hudZBeforeForm !== null) {
        hudRoot.style.zIndex = hudZBeforeForm;
        hudZBeforeForm = null;
      } else {
        hudRoot.style.zIndex = "";
      }
      delete hudRoot.dataset.formOpen;
    }
  }

  function clear(): void {
    clearTooltip();
    clearTooltip = (): void => {};
    host.replaceChildren();
    engineRoot = null;
    plainRoot = null;
    lastTree = null;
    lastRoute = null;
    setHudFormStacking(false);
  }

  /**
   * Opaque modal backdrop behind dialogue content (hollow panel centers are
   * transparent — world nametag sprites otherwise show through the hole).
   */
  function mountFormScrim(): void {
    setHudFormStacking(true);
    const scrim = document.createElement("div");
    scrim.className = "jsonui-form-scrim";
    scrim.dataset.jsonuiName = "jsonui.form_scrim";
    scrim.style.cssText =
      "position:absolute;inset:0;background:rgba(0,0,0,0.55);z-index:0;pointer-events:none;";
    host.appendChild(scrim);
  }

  function applyHover(): void {
    const root = engineRoot ?? plainRoot;
    if (!root) return;
    root
      .querySelectorAll(".jsonui-form-hovered, .jh-form-button.hovered")
      .forEach((n) => {
        n.classList.remove("jsonui-form-hovered", "hovered");
      });
    if (hoverIndex === null) return;
    if (engineRoot) {
      engineRoot
        .querySelectorAll(`[data-collection-index="${hoverIndex}"]`)
        .forEach((n) => n.classList.add("jsonui-form-hovered"));
    }
    if (plainRoot) {
      plainRoot
        .querySelectorAll(`[data-form-btn="${hoverIndex}"]`)
        .forEach((n) => n.classList.add("hovered"));
    }
  }

  function showPlain(form: FormSnapshot): void {
    clear();
    lastRoute = routeForm(form, deps.formRoutes);
    const wrap = document.createElement("div");
    wrap.className = "jh-form jsonui-form-fallback";
    wrap.hidden = false;
    const title = document.createElement("div");
    title.className = "jh-form-title";
    title.textContent = stripSectionCodes(form.title);
    wrap.appendChild(title);
    if (form.content.trim()) {
      const body = document.createElement("div");
      body.className = "jh-form-content";
      body.textContent = form.content;
      wrap.appendChild(body);
    }
    const buttons = form.buttons ?? [];
    buttons.forEach((label, i) => {
      const btn = document.createElement("div");
      btn.className = "jh-form-button";
      btn.dataset.formBtn = String(i);
      btn.textContent = stripSectionCodes(label);
      wrap.appendChild(btn);
    });
    host.appendChild(wrap);
    plainRoot = wrap;
    applyHover();
  }

  function showEngine(form: FormSnapshot): boolean {
    // Vanilla long/custom forms get dialogue chrome. Flag-routed screens
    // keep the pack layout.
    const routed = routeForm(form, deps.formRoutes);
    const dialogue = routed.kind !== "flag";
    const prepared = prepareFormTree(
      deps.resolver,
      dialogue ? normalizeDialogueForm(form) : form,
      deps.globals ?? {},
      deps.formRoutes,
    );
    if (!prepared) return false;
    clear();
    lastTree = selectFormButtonStates(prepared.tree, hoverIndex);
    lastRoute = prepared.route;

    const viewport: Viewport = deps.viewport ?? {
      width: Math.max(320, host.clientWidth / guiScale || 640),
      height: Math.max(180, host.clientHeight / guiScale || 360),
    };
    const layout = layoutTree(lastTree, viewport, {
      measureText,
      rules: deps.layoutRules,
    });
    if (dialogue) mountFormScrim();
    engineRoot = renderTree(layout, host, {
      guiScale,
      assets: deps.assets,
      lang: deps.lang,
      textureInfo: deps.textureInfo,
    });
    if (dialogue) {
      engineRoot.style.zIndex = "1";
      engineRoot.dataset.formLayer = "top";
    }
    tagCollectionIndices(layout, engineRoot);
    applyHover();
    if (hoverIndex !== null) {
      clearTooltip = mountFormTooltip(
        host,
        layout,
        guiScale,
        measureText,
        deps.lang,
      );
    }
    return true;
  }

  return {
    get lastTree() {
      return lastTree;
    },
    get lastRoute() {
      return lastRoute;
    },
    show(form: FormSnapshot): void {
      currentForm = form;
      hoverIndex = null;
      if (!showEngine(form)) showPlain(form);
    },
    hover(index: number | null): void {
      if (hoverIndex === index) return;
      hoverIndex = index;
      if (engineRoot && currentForm) showEngine(currentForm);
      else applyHover();
    },
    hide(): void {
      clear();
      currentForm = null;
      hoverIndex = null;
    },
  };
}

/**
 * Soft-normalize dialogue ActionForm / ModalForm snapshots before layout.
 * Collapses runaway whitespace so title/body regions don't read as one blob.
 *
 * @param form - Raw form snapshot.
 * @returns shallow-cloned snapshot for the dialogue path.
 */
function normalizeDialogueForm(form: FormSnapshot): FormSnapshot {
  return {
    ...form,
    title: (form.title ?? "").replace(/\s+/g, " ").trim(),
    content: (form.content ?? "").replace(/[ \t]+\n/g, "\n").trim(),
  };
}

/**
 * @param screen - `"ns.name"`.
 * @returns namespace + name parts.
 */
function splitScreen(screen: string): [string, string] {
  const dot = screen.indexOf(".");
  if (dot < 0) return ["", screen];
  return [screen.slice(0, dot), screen.slice(dot + 1)];
}

/**
 * Strip `§x` format codes for plain-panel fallback labels.
 *
 * @param s - Raw title / button text.
 * @returns visible text.
 */
function stripSectionCodes(s: string): string {
  return s.replace(/§./g, "");
}

/**
 * Walk layout + DOM in paint order and set `data-collection-index` from props.
 *
 * @param node - Layout root.
 * @param domRoot - DOM root from {@link renderTree}.
 */
function tagCollectionIndices(
  node: import("./layout.js").LayoutNode,
  domRoot: HTMLElement,
): void {
  // renderTree paints depth-first; collect layout nodes in the same order as
  // `.jsonui` elements under domRoot.
  const order: import("./layout.js").LayoutNode[] = [];
  (function walk(n: import("./layout.js").LayoutNode): void {
    // Must match paintNode: invisible subtrees are not emitted.
    if (!n.visible) return;
    order.push(n);
    for (const k of paintChildOrder(n.children)) walk(k);
  })(node);

  const els = domRoot.querySelectorAll<HTMLElement>(".jsonui");
  const n = Math.min(order.length, els.length);
  for (let i = 0; i < n; i++) {
    const idx = order[i]!.element.props.collection_index;
    if (typeof idx === "number") {
      els[i]!.dataset.collectionIndex = String(idx);
    }
  }
}
