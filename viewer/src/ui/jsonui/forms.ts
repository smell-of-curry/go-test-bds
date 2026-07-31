/**
 * Server-form routing + JSON UI rendering for ActionForm / ModalForm.
 *
 * Title-flag table mirrors `pokebedrock/server_form.json` → `ng_long_form`.
 * Unroutable / missing screens fall back to a plain panel (caller may also
 * keep `?debugForms=1` for the top-right debug UI).
 */

import {
  formButtonsCollection,
  prepareCollectionTree,
  type CollectionMap,
} from "./collections.js";
import {
  renderTree,
  type JsonUiAssets,
  type TextureInfoMap,
} from "./dom.js";
import { layoutTree, type MeasureText } from "./layout.js";
import type {
  BindingSource,
  BindingValue,
  PropertyBag,
  ResolvedElement,
  UiResolver,
  Viewport,
} from "./types.js";

/** Wire form snapshot (matches `protocol.UI.form`). */
export interface FormSnapshot {
  type: string;
  title: string;
  content: string;
  buttons: string[];
  buttonImages?: string[];
}

/** Flag → screen id (namespace.name). Order = match priority (first wins). */
export const FORM_FLAG_ROUTES: ReadonlyArray<{
  flag: string;
  screen: string;
}> = [
  { flag: "§b§a§t§l§e", screen: "battle.main" },
  { flag: "§p§o§k§e", screen: "pokemon.main_panel" },
  { flag: "§d§e§d§e§t§k", screen: "pokedex.pokemon_details" },
  { flag: "§d§e§k§x", screen: "pokedex.main_grid" },
  { flag: "§p§c", screen: "pc.main" },
  { flag: "§c§h§e§s§t", screen: "chest_ui.chest_panel" },
  { flag: "§s§e§a§r§c", screen: "search_server_form.long_form" },
  { flag: "§1§r", screen: "rotom_phone_first.blackbarbar_first" },
  { flag: "§2§r", screen: "rotom_phone_second.blackbarbar_second" },
  { flag: "§3§r", screen: "rotom_phone_third.blackbarbar_third" },
];

export interface FormRoute {
  /** `"battle.main"` style. */
  screen: string;
  namespace: string;
  name: string;
  /** Matched invisible flag, or "" for vanilla long/custom form. */
  flag: string;
  kind: "flag" | "long_form" | "custom_form";
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
 * Battle / PC / … flags win over plain titles. `type === "custom"` (or
 * `"modal"`) → vanilla custom_form; otherwise vanilla long_form.
 *
 * @param form - Form snapshot.
 * @returns route descriptor.
 */
export function routeForm(form: FormSnapshot): FormRoute {
  const title = form.title ?? "";
  for (const { flag, screen } of FORM_FLAG_ROUTES) {
    if (title.includes(flag)) {
      const [namespace, name] = splitScreen(screen);
      return { screen, namespace, name, flag, kind: "flag" };
    }
  }
  const t = (form.type ?? "").toLowerCase();
  if (t === "custom" || t === "modal" || t === "modal_form") {
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
  const globals: Record<string, BindingValue> = {
    "#title_text": form.title ?? "",
    "#form_text": form.content ?? "",
    "#form_button_length": buttons.length,
    "#form_button_contents": buttons.length,
    "#submit_text": "Submit",
    "#submit_button_visible": true,
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
    collections: { form_buttons: items },
    globals,
  };
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
): { tree: ResolvedElement; route: FormRoute } | null {
  const route = routeForm(form);
  const root = resolver.resolve(route.namespace, route.name);
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
  return { tree, route };
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
    ((text: string, fontScale: number) => ({
      w: Math.max(1, text.length * 6 * fontScale),
      h: 9 * fontScale,
    }));

  let lastTree: ResolvedElement | null = null;
  let lastRoute: FormRoute | null = null;
  let hoverIndex: number | null = null;
  let engineRoot: HTMLElement | null = null;
  let plainRoot: HTMLElement | null = null;

  const host = deps.host;
  host.style.position = host.style.position || "absolute";
  host.style.inset = host.style.inset || "0";
  host.style.pointerEvents = "none";

  function clear(): void {
    host.replaceChildren();
    engineRoot = null;
    plainRoot = null;
    lastTree = null;
    lastRoute = null;
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
    lastRoute = routeForm(form);
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
    // Dialogue / vanilla long_form only — battle + other flag screens keep
    // their own layout (another agent owns that path).
    const routed = routeForm(form);
    const dialogue =
      routed.kind === "long_form" || routed.kind === "custom_form";
    const prepared = prepareFormTree(
      deps.resolver,
      dialogue ? normalizeDialogueForm(form) : form,
      deps.globals ?? {},
    );
    if (!prepared) return false;
    clear();
    lastTree = prepared.tree;
    lastRoute = prepared.route;

    const viewport: Viewport = deps.viewport ?? {
      width: Math.max(320, host.clientWidth / guiScale || 640),
      height: Math.max(180, host.clientHeight / guiScale || 360),
    };
    const layout = layoutTree(prepared.tree, viewport, { measureText });
    engineRoot = renderTree(layout, host, {
      guiScale,
      assets: deps.assets,
      lang: deps.lang,
      textureInfo: deps.textureInfo,
    });
    tagCollectionIndices(layout, engineRoot);
    applyHover();
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
      if (!showEngine(form)) showPlain(form);
    },
    hover(index: number | null): void {
      hoverIndex = index;
      applyHover();
    },
    hide(): void {
      clear();
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
    const kids = [...n.children].sort((a, b) => a.layer - b.layer);
    for (const k of kids) walk(k);
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
