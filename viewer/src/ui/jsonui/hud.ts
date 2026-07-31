/**
 * HUD screen driver over the JSON UI engine: bind WorldState → pack tree,
 * layout, DOM paint, plus native-renderer stubs for vanilla vitals/hotbar.
 */

import { applyBindings } from "./bindings";
import { renderTree, type JsonUiAssets } from "./dom";
import { evalExpr, parseExpr } from "./expr";
import { layoutTree, type LayoutNode, type MeasureText } from "./layout";
import { localizeLabelText } from "./load";
import type {
  BindingSource,
  BindingValue,
  PropertyBag,
  ResolvedChild,
  ResolvedElement,
  UiResolver,
  Viewport,
} from "./types";
import type { VitalsFrame } from "../../protocol";
import type { WorldState } from "../../store";

/** PHUD control-token title (`&_sidebar:…`). */
export const PHUD_TITLE_RE = /^&_[A-Za-z]+:/;

/** Default gui scale (1280×720 capture → 640×360 gui px). */
export const DEFAULT_GUI_SCALE = 2;

/** Heart / hunger / armor / bubble icon size in gui px. */
const ICON = 9;
const HEART_COUNT = 10;
const HOTBAR_SLOTS = 9;
const HOTBAR_SLOT_W = 20;
const HOTBAR_H = 22;

const warnedRenderers = new Set<string>();

/** Options for {@link createHudRenderer}. */
export interface HudRendererOptions {
  assets: JsonUiAssets;
  guiScale?: number;
  viewportCss?: { width: number; height: number };
  measureText?: MeasureText;
  /** Merged pack lang table for `localize: true` labels. */
  lang?: Readonly<Record<string, string>>;
}

/** Handle returned by {@link createHudRenderer}. */
export interface HudRenderer {
  /** Host element (tests). */
  readonly root: HTMLElement;
  /**
   * Bind + layout + paint one frame.
   *
   * @param state - Latest world state.
   * @returns wall-clock ms spent (bind+layout+paint).
   */
  onFrame(state: WorldState): number;
  /** Last measured frame cost in ms. */
  readonly lastFrameMs: number;
}

/**
 * Reconstruct the raw title string the Bedrock client would see.
 *
 * Prefers the plain `title` lane; otherwise the most recent PHUD token write
 * tracked by the caller via {@link PhudTitleTracker}.
 *
 * @param state - World state.
 * @param lastPhudTitle - Latest `&_<token>:<value>` synthesized from the phud lane.
 * @returns title string (may be empty).
 */
export function hudTitleString(
  state: WorldState,
  lastPhudTitle: string,
): string {
  // PHUD writes land on the title channel; a stale plain `ui.title` (nametag
  // echo, leftover SetTitle) must not win and leave tip Black chrome painted.
  if (PHUD_TITLE_RE.test(lastPhudTitle)) return lastPhudTitle;
  const plain = state.ui?.title ?? "";
  if (plain) return plain;
  return lastPhudTitle;
}

/**
 * Track the chronologically latest PHUD write as a raw title string.
 * The phud map alone loses write order across tokens.
 */
export class PhudTitleTracker {
  private last = "";
  private prev = new Map<string, string>();

  /**
   * @param phud - Current phud token map.
   * @returns latest `&_<token>:<value>` (empty value → `&_<token>:` so pack
   * latches clear the matching lane).
   */
  update(phud: Map<string, string>): string {
    for (const [token, value] of phud) {
      const prev = this.prev.get(token);
      if (prev === value) continue;
      this.prev.set(token, value);
      // Always emit the token prefix — `""` alone never matches `$update_string`
      // so data_control latches would keep the previous payload forever.
      this.last = `&_${token}:${value}`;
    }
    // Drop tokens removed from the map.
    for (const token of [...this.prev.keys()]) {
      if (!phud.has(token)) this.prev.delete(token);
    }
    return this.last;
  }

  /** @returns last synthesized title. */
  get(): string {
    return this.last;
  }
}

/**
 * Build a {@link BindingSource} over WorldState + reconstructed title.
 *
 * @param state - World state.
 * @param title - Raw `#hud_title_text_string`.
 * @returns binding source for {@link applyBindings}.
 */
export function bindingSourceFromState(
  state: WorldState,
  title: string,
): BindingSource {
  const subtitle = state.ui?.subtitle ?? "";
  const vitals = state.vitals;
  const globals: Record<string, BindingValue> = {
    "#hud_title_text_string": title,
    "#hud_subtitle_text_string": subtitle,
    // Hide editor / customization chrome; show survival HUD when vitals present.
    "#reset_modal_visible": false,
    "#close_without_saving_modal_visible": false,
    "#hint_drag_visible": false,
    "#hint_deselect_visible": false,
    "#hint_saved_visible": false,
    "#status_effects_visible": false,
    "#hotbar_visible_not_centered": false,
    "#hotbar_visible_not_centered_resizable": false,
    "#hud_visible": true,
    "#hud_visible_centered": true,
    "#hud_visible_centered_gui_elements": true,
    "#hud_visible_centered_touch": false,
    "#hud_visible_not_centered": false,
    "#is_not_riding": true,
    "#is_riding": false,
    "#is_not_riding_bubbles": true,
    "#is_riding_bubbles": false,
    "#is_spectator_mode": false,
    // Unset → default-visible: touch inventory ellipses ("…"), tips, paper doll.
    "#hotbar_elipses_left_visible": false,
    "#hotbar_elipses_right_visible": false,
    "#inventory_touch_button": false,
    "#paper_doll_visible": false,
    "#player_position_visible": false,
    "#number_of_days_played_visible": false,
    "#interact_visible": false,
    "#auto_save_animation_visible": false,
    "#tooltip_visible": false,
    "#left_tips_visible": false,
    "#emote_tips_visible": false,
    "#scoreboard_sidebar_visible": false,
    "#layout_customization_main_panel_visible": false,
    "#layout_customization_sub_panel_visible": false,
    "#scale_option_visible": false,
    "#opacity_option_visible": false,
    "#apply_to_all_option_visible": false,
    "#creative_horse_hearts": false,
    "#survival_horse_hearts": false,
    "#horse_hearts_touch": false,
    "#level_number_visible": false,
    "#hotbar_with_xp_bar": false,
    "#hotbar_no_xp_bar": false,
    "#hotbar_with_locator_bar": false,
  };

  if (vitals) {
    Object.assign(globals, vitalsGlobals(vitals));
  } else {
    globals["#show_survival_ui"] = false;
    globals["#hotbar_visible"] = false;
    globals["#is_armor_visible"] = false;
  }

  // Seed PHUD token props from the map so a busy title lane (sidebar) cannot
  // starve loadingScreen / phone / etc. when data_control latches lag.
  for (const [token, value] of state.phud) {
    const prop = phudTokenProp(token);
    if (prop) globals[prop] = value;
  }

  return {
    global(name: string): BindingValue | undefined {
      if (name in globals) return globals[name];
      const hashed = name.startsWith("#") ? name : `#${name}`;
      if (hashed in globals) return globals[hashed];
      return undefined;
    },
  };
}

/**
 * Map a PHUD token name to the property `phud.elements` bindings write.
 *
 * @param token - Token from the phud SSE lane (`sidebar`, `loadingScreen`, …).
 * @returns `#prop` name, or null when unmapped.
 */
function phudTokenProp(token: string): string | null {
  switch (token) {
    case "currency":
      return "#level_number";
    case "battleWait":
      return "#battleLog";
    case "playerPing":
      return "#player_ping_text";
    case "phone":
    case "sidebar":
    case "loadingScreen":
    case "evolutionWait":
      return `#${token}`;
    default:
      return null;
  }
}

/**
 * @param v - Vitals frame.
 * @returns global binding map for survival HUD.
 */
function vitalsGlobals(v: VitalsFrame): Record<string, BindingValue> {
  const airMax = (v.maxAir ?? 0) > 0 ? (v.maxAir as number) : 300;
  return {
    "#show_survival_ui": true,
    "#hotbar_visible": true,
    "#hud_visible_centered": true,
    "#is_armor_visible": (v.armor ?? 0) > 0,
    "#exp_progress": v.xpProgress,
    "#level_number": String(v.xpLevel),
    // Vanilla: level glyph only when xpLevel > 0.
    "#level_number_visible": v.xpLevel > 0,
    // Survival desktop: XP strip only when the player has XP to show.
    "#hotbar_with_xp_bar": v.xpLevel > 0 || v.xpProgress > 0,
    "#hotbar_no_xp_bar": !(v.xpLevel > 0 || v.xpProgress > 0),
    "#hotbar_with_locator_bar": false,
    "#player_health": v.health,
    "#player_max_health": v.maxHealth,
    "#hunger": v.food,
    "#player_armor": v.armor ?? 0,
    "#player_air": v.air ?? airMax,
    "#player_max_air": airMax,
    // Bubbles only when submerged (air below max).
    "#is_not_riding_bubbles": airBubblesVisible(v),
    "#is_riding_bubbles": false,
  };
}

/**
 * Heart / hunger icon counts for a 0–20 stat (10 icons).
 *
 * @param value - Current points (0–20).
 * @returns full / half / empty icon counts.
 */
export function heartIcons(value: number): {
  full: number;
  half: number;
  empty: number;
} {
  const clamped = Math.max(0, Math.min(20, Math.floor(value)));
  const full = Math.floor(clamped / 2);
  const half = clamped % 2;
  const empty = HEART_COUNT - full - half;
  return { full, half, empty };
}

/**
 * Mount a HUD renderer against a resolved pack set.
 *
 * @param resolver - Pack UI resolver.
 * @param host - DOM host (usually `#json-hud`).
 * @param opts - Assets / scale.
 * @returns renderer handle.
 */
export function createHudRenderer(
  resolver: UiResolver,
  host: HTMLElement,
  opts: HudRendererOptions,
): HudRenderer {
  const guiScale = opts.guiScale ?? DEFAULT_GUI_SCALE;
  const lang = opts.lang;
  const measureText =
    opts.measureText ??
    ((text: string, fontScale: number) => {
      const plain = stripSection(text);
      const lines = plain.length ? plain.split("\n") : [""];
      let maxLen = 1;
      for (const line of lines) maxLen = Math.max(maxLen, line.length);
      return {
        w: Math.max(1, maxLen * 6 * fontScale),
        h: Math.max(1, lines.length) * 9 * fontScale,
      };
    });

  const propStore = new Map<string, PropertyBag>();
  const titleTracker = new PhudTitleTracker();
  let lastFrameMs = 0;
  let lastPaintKey = "";

  // Resolve once; re-bind props each frame.
  const baseRoot = buildHudRoot(resolver);

  const handle: HudRenderer = {
    root: host,
    get lastFrameMs() {
      return lastFrameMs;
    },
    onFrame(state: WorldState): number {
      const t0 = performance.now();
      const title = hudTitleString(state, titleTracker.update(state.phud));
      const source = bindingSourceFromState(state, title);
      const idIndex = new Map<string, PropertyBag>();

      const bound = bindTree(
        baseRoot,
        "root_panel",
        source,
        propStore,
        idIndex,
        state.vitals,
        lang,
        state.phud,
      );
      applyTitleQuirk(bound, title);
      applyPhudElementTokens(bound, state.phud);
      applyEmptyChromeQuirks(bound);

      // Dirty check: skip layout/paint when bound props + vitals unchanged.
      const paintKey = boundPaintKey(bound, title, state.vitals);
      if (paintKey === lastPaintKey && host.childElementCount > 0) {
        lastFrameMs = performance.now() - t0;
        return lastFrameMs;
      }
      lastPaintKey = paintKey;

      const cssW =
        opts.viewportCss?.width ??
        (host.clientWidth > 0 ? host.clientWidth : 1280);
      const cssH =
        opts.viewportCss?.height ??
        (host.clientHeight > 0 ? host.clientHeight : 720);
      const viewport: Viewport = {
        width: cssW / guiScale,
        height: cssH / guiScale,
      };
      const layout = layoutTree(bound, viewport, { measureText });

      host.replaceChildren();
      const paintRoot = renderTree(layout, host, {
        guiScale,
        assets: opts.assets,
        lang,
        warn: (type) => {
          if (warnedRenderers.has(`type:${type}`)) return;
          warnedRenderers.add(`type:${type}`);
          console.warn(`[jsonui] unknown control type: ${type}`);
        },
      });
      paintNativeRenderers(
        layout,
        paintRoot,
        opts.assets,
        guiScale,
        state.vitals,
      );

      lastFrameMs = performance.now() - t0;
      return lastFrameMs;
    },
  };
  return handle;
}

/**
 * Fingerprint bound props that affect paint (skip layout when stable).
 *
 * @param el - Bound root.
 * @param title - Title string.
 * @param vitals - Vitals or null.
 * @returns stable key.
 */
function boundPaintKey(
  el: ResolvedElement,
  title: string,
  vitals: VitalsFrame | null,
): string {
  const parts: string[] = [title];
  if (vitals) {
    parts.push(
      String(vitals.health),
      String(vitals.food),
      String(vitals.armor),
      String(vitals.air),
      String(vitals.xpProgress),
      String(vitals.xpLevel),
      String(vitals.selectedSlot),
    );
  } else {
    parts.push("novitals");
  }
  walkBoundProps(el, parts);
  return parts.join("\0");
}

/**
 * @param el - Bound element.
 * @param parts - Accumulator.
 */
function walkBoundProps(el: ResolvedElement, parts: string[]): void {
  const p = el.props;
  for (const k of [
    "visible",
    "text",
    "texture",
    "sidebar",
    "phone",
    "battleLog",
    "preserved_text",
    "clip_ratio",
    "var",
  ]) {
    if (k in p) parts.push(`${el.name}.${k}=${String(p[k])}`);
  }
  for (const c of el.controls) walkBoundProps(c.element, parts);
}

/**
 * Build a pruned HUD root from `root_panel` children we actually paint.
 *
 * Full vanilla `root_panel` includes editor/customization chrome (~1s/frame).
 * Keep: PokeBedrock `phud`, survival vitals strip, desktop hotbar host, title.
 *
 * @param resolver - UI resolver.
 * @returns root element.
 */
function buildHudRoot(resolver: UiResolver): ResolvedElement {
  const root = resolver.resolve("hud", "root_panel");
  // Keep the tree small: full root_panel is ~1s/frame of customization chrome.
  const want = new Set(["phud", "centered_gui_elements_at_bottom_middle"]);

  const controls: ResolvedChild[] = [];
  if (root) {
    for (const c of root.controls) {
      if (!want.has(c.id)) continue;
      controls.push({
        id: c.id,
        element: applyPathKeyOverrides(
          resolver,
          "hud",
          pathJoin("root_panel", c.id),
          c.element,
          c.id,
        ),
      });
    }
  }

  // Factory `hud_title_text_area` never expands — inject the real title tree.
  let title = resolver.resolve("hud", "hud_title_text");
  if (title) {
    title = applyPathKeyOverrides(resolver, "hud", "hud_title_text", title);
    controls.push({ id: "hud_title_text", element: title });
  }

  // Fallback: resolve phud directly when root_panel mods didn't land.
  if (!controls.some((c) => c.id === "phud")) {
    const phud = resolver.resolve("phud", "main");
    if (phud) controls.push({ id: "phud", element: phud });
  }

  // Pack: `root_panel/chat_stack` insert_after `player_position` → player_ping.
  // Pruned HUD drops the full chat stack; mount a slim top-left stack so ping
  // inherits authored flow. Do NOT force tip `bottom_middle` — those anchors
  // belong to the label row *inside* playerPing.json, not the host.
  if (!controls.some((c) => c.id === "chat_stack" || c.id === "player_ping")) {
    const ping = resolver.resolve("player_ping", "main");
    if (ping) {
      const el = applyPathKeyOverrides(resolver, "player_ping", "main", ping);
      controls.push({
        id: "chat_stack",
        element: {
          type: "stack_panel",
          name: "chat_stack",
          namespace: "hud",
          props: {
            orientation: "vertical",
            size: ["40%", "100%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          },
          bindings: [],
          controls: [{ id: "player_ping", element: el }],
        },
      });
    }
  }

  return {
    type: "panel",
    name: "root_panel",
    namespace: "hud",
    props: { size: ["100%", "100%"] },
    bindings: [],
    controls,
  };
}

/**
 * Merge path-key element defs (`hud_title_text/title_frame/title`) onto nested controls.
 *
 * @param resolver - Resolver holding path-key defs.
 * @param ns - Namespace.
 * @param path - Current path prefix.
 * @param el - Element to clone/merge.
 * @param selfId - Instance id at this path segment (for child paths).
 * @returns element with path overrides applied recursively.
 */
function applyPathKeyOverrides(
  resolver: UiResolver,
  ns: string,
  path: string,
  el: ResolvedElement,
  selfId?: string,
): ResolvedElement {
  const override = resolver.resolve(ns, path);
  let props = el.props;
  let bindings = el.bindings;
  if (override && override !== el) {
    props = { ...el.props, ...override.props };
    if (override.bindings.length) {
      bindings = [...el.bindings, ...override.bindings];
    }
  }

  const controls = el.controls.map((c) => {
    const childPath = pathJoin(path, c.id);
    return {
      id: c.id,
      element: applyPathKeyOverrides(resolver, ns, childPath, c.element, c.id),
    };
  });

  void selfId;
  return { ...el, props, bindings, controls };
}

/**
 * @param a - Path prefix.
 * @param b - Segment.
 * @returns joined path key.
 */
function pathJoin(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}

/**
 * Bind one element instance + children; latch props across frames.
 *
 * @param el - Resolved element.
 * @param path - Instance path.
 * @param source - Global bindings.
 * @param store - Previous-frame props by path.
 * @param idIndex - Control-id → props for sibling lookups this frame.
 * @param vitals - Optional vitals for native renderer size overrides.
 * @returns element with bound props + bound children.
 */
function bindTree(
  el: ResolvedElement,
  path: string,
  source: BindingSource,
  store: Map<string, PropertyBag>,
  idIndex: Map<string, PropertyBag>,
  vitals: VitalsFrame | null,
  lang?: Readonly<Record<string, string>>,
  phud?: Map<string, string>,
): ResolvedElement {
  const prev = store.get(path) ?? {};
  const out: PropertyBag = { ...el.props };

  // Seed latched props from previous frame before evaluating view bindings.
  // Do NOT carry resolved `text`/`texture` — those start as `#ref` templates
  // on `el.props` and must be re-resolved via applyPropertyRefs each frame
  // after view bindings refresh `#var` / `#string`. Seeding "" from an earlier
  // empty PHUD frame permanently blocks re-resolution.
  // Same trap for view-binding targets: makeScope prefers `out` over
  // source_control_name sibling lookup, so a seeded empty `#player_ping_text`
  // (etc.) hides the fresh sibling value and leaves `#visible` false.
  const viewTargets = new Set<string>();
  for (const b of el.bindings) {
    if ((b.binding_type as string | undefined) !== "view") continue;
    const t = b.target_property_name;
    if (typeof t !== "string") continue;
    viewTargets.add(t.startsWith("#") ? t.slice(1) : t);
  }
  for (const [k, v] of Object.entries(prev)) {
    if (k.startsWith("$")) continue;
    if (k === "text" || k === "texture") continue;
    if (viewTargets.has(k)) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    }
  }

  const parentLookup = (name: string): BindingValue | undefined => {
    const fromOut = readBound(out, name);
    if (fromOut !== undefined) return fromOut;
    const fromPrev = readBound(prev, name);
    if (fromPrev !== undefined) return fromPrev;
    return undefined;
  };

  applyElementBindings(el, source, out, idIndex, parentLookup);
  applyPropertyRefs(out);
  // Translate before layout so 100%c label hosts size to the localized string.
  if (typeof out.text === "string" && !out.text.startsWith("#")) {
    out.text = localizeLabelText(
      out.text,
      out.localize ?? el.props.localize,
      lang,
    );
  }
  // Empty party slots still bind ball texture `…/balls/empty` — hide that icon
  // so only occupied plates paint (matches real client empty = invisible).
  // `paintNode` still walks visible children when the host is hidden so a
  // missing ball does not swallow `pokemon_icon`.
  if (el.name === "ball_icon") {
    const ball = out.ball_type;
    if (ball === "empty" || ball === "null" || ball === "") out.visible = false;
  }
  // Pack phone.main has no empty-token gate — only child $conditions hide
  // icons. When the live map has `&_phone:`, hide/show the 64×64 host with it
  // (always assign — seeding prev.visible=false would stick across setPhud).
  if (
    el.namespace === "phud_phone" &&
    el.name === "main" &&
    phud?.has("phone")
  ) {
    out.visible = Boolean(phud.get("phone"));
  }
  applyRendererSizing(el, out, vitals);
  applyHotbarHangPin(el, out, vitals);
  applyVisibilityChangedLatch(el, out, source, prev, phud);
  // Prefer live phud map on the elements panel before children bind, so
  // loadingScreen/phone see tokens even when title-lane latches lag. Clear
  // absent overlay tokens so a bad sibling latch cannot keep dirt painted.
  if (el.name === "elements" && el.namespace === "phud") {
    // Pack omits size; Bedrock fills the parent. Our `default` size is content
    // AABB + center anchors → live dump (193,92) 894×536 inset ("squished HUD").
    out.size = ["100%", "100%"];
    if (phud) {
      for (const token of [
        "phone",
        "sidebar",
        "loadingScreen",
        "evolutionWait",
        "battleWait",
        "playerPing",
      ] as const) {
        const prop = phudTokenProp(token);
        if (!prop) continue;
        const key = prop.startsWith("#") ? prop.slice(1) : prop;
        // Keep "" on clear — `(not (#token = ''))` needs the empty string present.
        if (phud.has(token)) out[key] = phud.get(token)!;
        else delete out[key];
      }
      if (phud.has("currency")) out.level_number = phud.get("currency")!;
    }
  }
  // Hotbar grid uses grid_item_template; HUD seeds dimensions. Form grids
  // (starter picker) expand via collections.expandCollections.
  // Size the host and inject one full-width hotbar_renderer stub instead.
  if (el.name === "hotbar_grid" && vitals) {
    out.size = [HOTBAR_SLOT_W * HOTBAR_SLOTS + 2, HOTBAR_H];
    out.grid_dimensions = [1, 1];
  }
  // Pack keeps XP hosts at 5gui and nests hotbar under empty→full→nub→horse
  // →dash (layer≥1 stacking contexts). Chromium clips that overflow — grow the
  // chain to fit the bar. Keep centered_gui bottom-flush (do NOT nudge it up;
  // that left an ~86css gap under the hotbar in live dumps). Inner hosts stay
  // top_middle inside the grown exp panel so tall bottom_middle boxes do not
  // eat the heart row. Hotbar pins to the host floor via applyHotbarHangPin.
  if (vitals) {
    const hang = 5 + 16 + HOTBAR_H;
    if (el.name === "exp_progress_bar_and_hotbar") {
      const w =
        Array.isArray(out.size) && typeof out.size[0] === "number"
          ? out.size[0]
          : HOTBAR_SLOT_W * HOTBAR_SLOTS + 10;
      out.size = [w, hang];
      out.anchor_from = "bottom_middle";
      out.anchor_to = "bottom_middle";
      // Authored `$xp_control_offset` defaults to [0,-13]; zero keeps the bar
      // on the screen floor (real client hotbar is edge-flush).
      out.offset = [0, 0];
    }
    if (
      el.name === "resizing_xp_bar_with_hotbar" ||
      el.name === "empty_progress_bar" ||
      el.name === "full_progress_bar" ||
      el.name === "progress_bar_nub" ||
      el.name === "resizing_hotbar_no_xp_bar"
    ) {
      const w =
        Array.isArray(out.size) && typeof out.size[0] === "number"
          ? out.size[0]
          : HOTBAR_SLOT_W * HOTBAR_SLOTS + 10;
      out.size = [w, hang];
      out.anchor_from = "top_middle";
      out.anchor_to = "top_middle";
    }
  }
  // Hide the thin XP textures when there is nothing to show.
  if (
    vitals &&
    (el.name === "empty_progress_bar" ||
      el.name === "full_progress_bar" ||
      el.name === "progress_bar_nub")
  ) {
    if (!(vitals.xpLevel > 0 || vitals.xpProgress > 0)) out.visible = false;
  }

  store.set(path, { ...out });
  // Index by leaf id for source_control_name lookups.
  const leaf = path.includes("/")
    ? path.slice(path.lastIndexOf("/") + 1)
    : path;
  idIndex.set(leaf, out);
  idIndex.set(el.name, out);

  const controls: ResolvedChild[] = el.controls.map((c) => ({
    id: c.id,
    element: bindTree(
      c.element,
      `${path}/${c.id}`,
      source,
      store,
      idIndex,
      vitals,
      lang,
      phud,
    ),
  }));

  if (
    el.name === "hotbar_grid" &&
    vitals &&
    !controls.some((c) => c.element.props.renderer === "hotbar_renderer")
  ) {
    const stub = makeHotbarRendererStub();
    controls.push({
      id: "hotbar_renderer",
      element: bindTree(
        stub,
        `${path}/hotbar_renderer`,
        source,
        store,
        idIndex,
        vitals,
        lang,
        phud,
      ),
    });
  }

  // Cheap dirty: always rebuild bound tree (props are new objects); paint is the cost.
  return {
    type: el.type,
    name: el.name,
    namespace: el.namespace,
    props: out,
    bindings: el.bindings,
    controls,
  };
}

/**
 * Synthetic `hotbar_renderer` host for the empty pack grid (no collection
 * expansion). Native paint fills all nine slots into this one control.
 *
 * @returns unbound stub element.
 */
function makeHotbarRendererStub(): ResolvedElement {
  return {
    type: "custom",
    name: "hotbar_renderer",
    namespace: "hud",
    props: {
      renderer: "hotbar_renderer",
      size: [HOTBAR_SLOT_W * HOTBAR_SLOTS + 2, HOTBAR_H],
      layer: 1,
    },
    bindings: [],
    controls: [],
  };
}

/**
 * Apply bindings, honouring `source_control_name` via the id index.
 *
 * @param el - Element.
 * @param source - Globals.
 * @param out - Mutable props.
 * @param idIndex - Sibling / cousin props by id.
 * @param parentLookup - Self/prev fallback.
 */
function applyElementBindings(
  el: ResolvedElement,
  source: BindingSource,
  out: PropertyBag,
  idIndex: Map<string, PropertyBag>,
  parentLookup: (name: string) => BindingValue | undefined,
): void {
  if (!el.bindings.length) return;

  // Apply in author order. Sibling-scoped bindings must run before view
  // exprs that read the copied props (e.g. #sidebar → #visible).
  for (const b of el.bindings) {
    const ctrl =
      typeof b.source_control_name === "string" ? b.source_control_name : "";
    const sib = ctrl ? idIndex.get(ctrl) : undefined;
    applyBindings({ ...el, bindings: [b] }, source, out, {
      lookup: (name) => {
        if (sib) {
          const v = readBound(sib, name);
          if (v !== undefined) return v;
        }
        return parentLookup(name);
      },
    });
  }
}

/**
 * Latch `#preserved_text` when the title matches `$update_string`.
 * Honours `binding_condition: visibility_changed` (skipped in applyBindings).
 * Also mirrors the live phud map so a token stays latched while another
 * token owns the title channel (sidebar flooding).
 *
 * @param el - Element (may carry `$update_string`).
 * @param out - Bound props.
 * @param source - Globals.
 * @param prev - Previous frame props.
 * @param phud - Live PHUD token map.
 */
function applyVisibilityChangedLatch(
  el: ResolvedElement,
  out: PropertyBag,
  source: BindingSource,
  prev: PropertyBag,
  phud?: Map<string, string>,
): void {
  const update =
    typeof el.props.$update_string === "string"
      ? el.props.$update_string
      : typeof out.$update_string === "string"
        ? (out.$update_string as string)
        : "";
  if (!update) return;

  const title = String(source.global("#hud_title_text_string") ?? "");
  const hadVisibilityChanged = el.bindings.some(
    (b) =>
      b.binding_condition === "visibility_changed" &&
      b.binding_name_override === "#preserved_text",
  );
  if (!hadVisibilityChanged) return;

  const token =
    update.startsWith("&_") && update.endsWith(":") ? update.slice(2, -1) : "";

  if (title.includes(update)) {
    out.preserved_text = title;
  } else if (token && phud?.has(token)) {
    // Empty string is a deliberate clear (`setPhudToken(..., '')`) — do not
    // latch `&_loadingScreen:` alone or the card stays "visible" with no text.
    const value = phud.get(token) ?? "";
    if (value) out.preserved_text = `${update}${value}`;
    else delete out.preserved_text;
  } else if (token && phud && !phud.has(token)) {
    // Token dropped from the map — clear the latch (do not keep prev sidebar
    // / title junk that would keep loadingScreen dirt painted).
    delete out.preserved_text;
  } else if (typeof prev.preserved_text === "string") {
    out.preserved_text = prev.preserved_text;
  } else {
    delete out.preserved_text;
  }
}

/**
 * Write PHUD token values onto the `elements` panel so child widgets
 * (`loadingScreen`, `phone`, …) see them even when sibling data_control
 * latches are empty on the first frame.
 *
 * @param root - Bound HUD tree.
 * @param phud - Live PHUD map.
 */
function applyPhudElementTokens(
  root: ResolvedElement,
  phud: Map<string, string>,
): void {
  const walk = (el: ResolvedElement): void => {
    if (el.name === "elements" && el.namespace === "phud") {
      for (const [token, value] of phud) {
        const prop = phudTokenProp(token);
        if (!prop) continue;
        const key = prop.startsWith("#") ? prop.slice(1) : prop;
        el.props[key] = value;
      }
    }
    for (const c of el.controls) walk(c.element);
  };
  walk(root);
}

/**
 * Hide tip chrome that the pack always mounts but the real client collapses
 * when its bound label is empty (quest-only `&_currency:` → no coin chip).
 *
 * @param root - Bound HUD tree.
 */
function applyEmptyChromeQuirks(root: ResolvedElement): void {
  const walk = (el: ResolvedElement): void => {
    if (el.namespace === "phud_currency" && el.name === "currency") {
      let labelText = "";
      for (const c of el.controls) {
        if (c.element.type !== "label") continue;
        const t = c.element.props.text;
        if (typeof t === "string") labelText = t;
      }
      if (!labelText.trim()) el.props.visible = false;
    }
    for (const c of el.controls) walk(c.element);
  };
  walk(root);
}

/**
 * Resolve `text` / `texture` values that are `#property` refs or `(…)` exprs.
 *
 * @param out - Bound props.
 */
function applyPropertyRefs(out: PropertyBag): void {
  for (const key of ["text", "texture"] as const) {
    const v = out[key];
    if (typeof v !== "string") continue;
    if (v.startsWith("#")) {
      const ref = v.slice(1);
      const got = out[ref] ?? out[v];
      if (
        typeof got === "string" ||
        typeof got === "number" ||
        typeof got === "boolean"
      ) {
        out[key] = typeof got === "string" ? got : String(got);
      }
      continue;
    }
    // Pack textures like `('textures/ui/phud/' + $name)` stay as exprs until
    // bind time — evaluate so a missing texture path is a real 404, not a
    // literal `(` URL that paints a broken framed box.
    const trimmed = v.trim();
    if (!trimmed.startsWith("(") && !trimmed.includes(" + ")) continue;
    try {
      const got = evalExpr(parseExpr(trimmed), {
        binding: (name) => readBound(out, name),
        variable: (name) => {
          const raw = out[`$${name}`] ?? out[name];
          return raw;
        },
      });
      if (typeof got === "string") out[key] = got;
      else if (typeof got === "number" || typeof got === "boolean") {
        out[key] = String(got);
      }
    } catch {
      // Leave unresolved — paint path treats non-texture strings as empty.
      out[key] = "";
    }
  }
}

/**
 * Give native renderer controls a real layout size (pack uses [1,1] stubs).
 *
 * @param el - Element.
 * @param out - Props to mutate.
 * @param vitals - Vitals (hide when absent).
 */
function applyRendererSizing(
  el: ResolvedElement,
  out: PropertyBag,
  vitals: VitalsFrame | null,
): void {
  const renderer =
    typeof el.props.renderer === "string"
      ? el.props.renderer
      : typeof out.renderer === "string"
        ? (out.renderer as string)
        : "";
  if (!renderer) return;

  switch (renderer) {
    case "heart_renderer":
    case "hunger_renderer":
    case "horse_heart_renderer":
      out.size = [ICON * HEART_COUNT, ICON];
      if (!vitals) out.visible = false;
      break;
    case "armor_renderer":
      out.size = [ICON * HEART_COUNT, ICON];
      // `undefined <= 0` is false — missing armor must hide (empty icons look
      // like a red/white row next to hearts).
      if (!vitals || !((vitals.armor ?? 0) > 0)) out.visible = false;
      break;
    case "bubbles_renderer": {
      out.size = [ICON * HEART_COUNT, ICON];
      // Pack (pokebedrock hud_screen) binds bubbles to `#is_not_riding`, which
      // stays true on land — native Bedrock still only paints when air < max.
      if (!vitals || !airBubblesVisible(vitals)) out.visible = false;
      break;
    }
    case "hotbar_renderer":
      out.size = [HOTBAR_SLOT_W * HOTBAR_SLOTS + 2, HOTBAR_H];
      if (!vitals) out.visible = false;
      break;
    case "horse_jump_renderer":
    case "dash_renderer":
      // Pack size is ["100%c", 5]; hotbar hangs via offset [4, 16]. Chromium
      // clips that overflow inside the layer:7 stacking context — grow the
      // host downward (top_middle) so the bar stays inside this box. Do NOT
      // keep bottom_middle + tall size (that pulled hearts onto the hotbar).
      if (vitals) {
        out.size = [HOTBAR_SLOT_W * HOTBAR_SLOTS + 10, 5 + 16 + HOTBAR_H];
        out.anchor_from = "top_middle";
        out.anchor_to = "top_middle";
      }
      break;
    default:
      break;
  }
}

/**
 * Pin the hotbar to the floor of the expanded XP/dash host.
 *
 * Pack uses default center anchors + offset [4,16] against a 5gui strip; after
 * we grow that host, center-anchoring parks the bar past the box bottom where
 * Chromium clips it. Floor-pin keeps the bar edge-flush with the screen.
 *
 * @param el - Element.
 * @param out - Props to mutate.
 * @param vitals - Vitals (skip when absent).
 */
function applyHotbarHangPin(
  el: ResolvedElement,
  out: PropertyBag,
  vitals: VitalsFrame | null,
): void {
  if (!vitals || el.name !== "hotbar_chooser") return;
  out.anchor_from = "bottom_middle";
  out.anchor_to = "bottom_middle";
  out.offset = [4, 0];
}

/**
 * Force-hide vanilla title/subtitle when title is a PHUD control token.
 *
 * Pack expression uses `%.1s` (off-by-one vs `'&_'`); real client still hides.
 * Keep pack bindings intact so a fixed pack can take over; this is the safety net.
 *
 * @param root - Bound tree.
 * @param title - Raw title string.
 */
export function applyTitleQuirk(root: ResolvedElement, title: string): void {
  // PHUD tokens: pack's `%.1s = '&_'` never matches (1 vs 2 chars) → chrome leaks.
  // Empty title: pb hud_title_text is sized 100%×100% so tip backgrounds become
  // giant translucent black rectangles mid-screen.
  if (!title || PHUD_TITLE_RE.test(title)) hideTitleSubtree(root);
}

/**
 * @param el - Tree node.
 */
function hideTitleSubtree(el: ResolvedElement): void {
  const n = el.name;
  if (
    n === "hud_title_text" ||
    n === "title_frame" ||
    n === "title_background" ||
    n === "title" ||
    n === "subtitle_frame" ||
    n === "subtitle" ||
    n === "subtitle_background" ||
    n.endsWith("title_background") ||
    n.endsWith("subtitle_background")
  ) {
    el.props.visible = false;
    el.props.alpha = 0;
  }
  for (const c of el.controls) hideTitleSubtree(c.element);
}

/**
 * True when the air-bubble row should paint (submerged / air below max).
 *
 * Missing/`undefined` air fields hide (omit ≠ full tank). `air <= 0` also
 * hides: BDS often reports AirSupply=0 on land, and empty-bubble textures
 * still paint a full blue row.
 *
 * @param v - Vitals frame.
 * @returns whether bubbles are visible.
 */
export function airBubblesVisible(v: VitalsFrame): boolean {
  if (v.air === undefined || v.air === null) return false;
  if (v.maxAir === undefined || v.maxAir === null) return false;
  const maxAir = Number(v.maxAir);
  const air = Number(v.air);
  if (!Number.isFinite(air) || !Number.isFinite(maxAir) || maxAir <= 0)
    return false;
  // Fully empty tank on the wire is treated as "not submerged" — drowning at
  // exactly 0 is rare in captures; land AirSupply=0 is common.
  if (air <= 0) return false;
  return air < maxAir;
}

/**
 * Paint native-renderer stubs into already-positioned DOM nodes.
 *
 * @param layout - Layout tree.
 * @param paintRoot - DOM root from {@link renderTree}.
 * @param assets - Texture URL helper.
 * @param guiScale - Gui scale.
 * @param vitals - Vitals or null.
 */
function paintNativeRenderers(
  layout: LayoutNode,
  paintRoot: HTMLElement,
  assets: JsonUiAssets,
  guiScale: number,
  vitals: VitalsFrame | null,
): void {
  // Group by element.name — DOM nodes stamp data-ui-name from that field.
  // Honour ancestor visibility: layout does not AND parent.visible into children,
  // so hidden XP-bar / locator branches would otherwise still paint stubs.
  const byName = new Map<string, LayoutNode[]>();
  walkLayoutVisible(layout, true, (node, effectiveVisible) => {
    if (!effectiveVisible) return;
    if (typeof node.element.props.renderer !== "string") return;
    const list = byName.get(node.element.name) ?? [];
    list.push(node);
    byName.set(node.element.name, list);
  });

  for (const [name, nodes] of byName) {
    // Skip DOM under display:none ancestors (parent visible=false); index
    // must align with the effectively-visible layout list above.
    const els = [
      ...paintRoot.querySelectorAll<HTMLElement>(
        `.jsonui[data-ui-name="${cssEscape(name)}"]`,
      ),
    ].filter((el) => !hasDisplayNoneAncestor(el));
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const el = els[i];
      if (!el) continue;
      const renderer = String(node.element.props.renderer);
      paintOneRenderer(el, renderer, assets, guiScale, vitals);
    }
  }
}

/**
 * @param el - DOM node.
 * @returns true when `el` or an ancestor has `display: none`.
 */
function hasDisplayNoneAncestor(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.style.display === "none") return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * @param el - Target DOM node.
 * @param renderer - Native renderer id.
 * @param assets - Texture URLs.
 * @param guiScale - Scale.
 * @param vitals - Vitals or null.
 */
function paintOneRenderer(
  el: HTMLElement,
  renderer: string,
  assets: JsonUiAssets,
  guiScale: number,
  vitals: VitalsFrame | null,
): void {
  switch (renderer) {
    case "heart_renderer":
      paintIconRow(
        el,
        heartIcons(vitals?.health ?? 0),
        {
          full: "textures/ui/heart",
          half: "textures/ui/heart_half",
          empty: "textures/ui/heart_background",
        },
        assets,
        guiScale,
        false,
      );
      break;
    case "hunger_renderer":
      paintIconRow(
        el,
        heartIcons(vitals?.food ?? 0),
        {
          full: "textures/ui/hunger_full",
          half: "textures/ui/hunger_half",
          // Bedrock ships hunger_background (no hunger_empty) — empty 404s as
          // red/white missing-texture squares above the hotbar.
          empty: "textures/ui/hunger_background",
        },
        assets,
        guiScale,
        true,
      );
      break;
    case "armor_renderer": {
      const armorPts = vitals?.armor ?? 0;
      if (!vitals || !(armorPts > 0)) {
        el.style.display = "none";
        return;
      }
      paintIconRow(
        el,
        heartIcons(armorPts),
        {
          full: "textures/ui/armor_full",
          half: "textures/ui/armor_half",
          empty: "textures/ui/armor_empty",
        },
        assets,
        guiScale,
        false,
      );
      break;
    }
    case "bubbles_renderer": {
      if (!vitals || !airBubblesVisible(vitals)) {
        el.style.display = "none";
        return;
      }
      const maxAir = (vitals.maxAir ?? 0) > 0 ? (vitals.maxAir as number) : 300;
      const air = Number(vitals.air);
      const pts = Math.round((air / maxAir) * 20);
      paintIconRow(
        el,
        heartIcons(pts),
        {
          full: "textures/ui/bubble",
          half: "textures/ui/bubble_pop_1",
          empty: "textures/ui/bubble",
        },
        assets,
        guiScale,
        true,
      );
      break;
    }
    case "hotbar_renderer":
      paintHotbar(el, vitals, assets, guiScale);
      break;
    case "selected_hotbar_slot":
      break;
    // XP/hotbar stack hosts: vanilla nests hotbar_chooser under these. Keep as
    // transparent layout shells — hiding them collapses the whole survival strip.
    case "horse_jump_renderer":
    case "dash_renderer":
    case "locator_bar":
      break;
    default:
      if (!warnedRenderers.has(renderer)) {
        warnedRenderers.add(renderer);
        console.warn(`[jsonui] unknown renderer (hidden): ${renderer}`);
      }
      el.style.display = "none";
      break;
  }
}

/**
 * @param host - Container.
 * @param icons - full/half/empty counts.
 * @param textures - Pack texture paths.
 * @param assets - URL helper.
 * @param guiScale - Scale.
 * @param rtl - Right-to-left (hunger/bubbles).
 */
function paintIconRow(
  host: HTMLElement,
  icons: { full: number; half: number; empty: number },
  textures: { full: string; half: string; empty: string },
  assets: JsonUiAssets,
  guiScale: number,
  rtl: boolean,
): void {
  host.replaceChildren();
  host.style.display = "flex";
  host.style.flexDirection = rtl ? "row-reverse" : "row";
  host.style.alignItems = "center";
  host.style.imageRendering = "pixelated";

  const px = ICON * guiScale;
  const add = (tex: string, n: number): void => {
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.style.width = `${px}px`;
      d.style.height = `${px}px`;
      d.style.backgroundImage = `url("${assets.textureUrl(tex)}")`;
      d.style.backgroundSize = "100% 100%";
      d.style.flex = "0 0 auto";
      host.appendChild(d);
    }
  };
  add(textures.full, icons.full);
  add(textures.half, icons.half);
  add(textures.empty, icons.empty);
}

/**
 * Hotbar stub: slot frames + count badges.
 * Item icons: punt without ItemIconResolver wired (needs async atlas).
 *
 * @param host - Container.
 * @param vitals - Vitals with hotbar.
 * @param assets - URL helper.
 * @param guiScale - Scale.
 */
function paintHotbar(
  host: HTMLElement,
  vitals: VitalsFrame | null,
  assets: JsonUiAssets,
  guiScale: number,
): void {
  host.replaceChildren();
  host.style.display = "flex";
  host.style.flexDirection = "row";
  host.style.alignItems = "flex-end";
  host.style.imageRendering = "pixelated";
  host.style.gap = "0";

  const selected = vitals?.selectedSlot ?? 0;
  const slots = vitals?.hotbar ?? Array(HOTBAR_SLOTS).fill(null);

  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const slot = document.createElement("div");
    const w = HOTBAR_SLOT_W * guiScale;
    const h = HOTBAR_H * guiScale;
    slot.style.width = `${w}px`;
    slot.style.height = `${h}px`;
    slot.style.position = "relative";
    slot.style.boxSizing = "border-box";
    // CSS chrome first — pack textures 404 in fixtures / sit near-black on dark
    // world shots; keep a readable frame regardless of texture availability.
    slot.style.backgroundColor = "#2a2a2a";
    slot.style.border = `${Math.max(1, guiScale)}px solid #8a8a8a`;
    slot.style.backgroundImage = `url("${assets.textureUrl(`textures/ui/hotbar_${i}`)}")`;
    slot.style.backgroundSize = "100% 100%";
    slot.style.backgroundRepeat = "no-repeat";
    if (i === selected) {
      slot.style.borderColor = "#ffffff";
      slot.style.boxShadow = `inset 0 0 0 ${guiScale}px #000`;
      slot.dataset.selected = "1";
    }
    const stack = slots[i];
    if (stack && stack.count > 1) {
      const badge = document.createElement("div");
      badge.className = "jsonui-hotbar-count";
      badge.textContent = String(stack.count);
      badge.style.position = "absolute";
      badge.style.right = "1px";
      badge.style.bottom = "1px";
      badge.style.fontSize = `${8 * guiScale}px`;
      badge.style.lineHeight = "1";
      badge.style.color = "#fff";
      badge.style.textShadow = "1px 1px 0 #000";
      badge.style.pointerEvents = "none";
      slot.appendChild(badge);
    }
    // ponytail: item icons need ItemIconResolver + atlas; slot frame + count only.
    host.appendChild(slot);
  }
}

/**
 * @param node - Layout node.
 * @param ancestorVisible - Whether every ancestor is visible.
 * @param visit - Visitor with effective (ancestor-ANDed) visibility.
 */
function walkLayoutVisible(
  node: LayoutNode,
  ancestorVisible: boolean,
  visit: (n: LayoutNode, effectiveVisible: boolean) => void,
): void {
  const effective = ancestorVisible && node.visible;
  visit(node, effective);
  for (const child of node.children) walkLayoutVisible(child, effective, visit);
}

/**
 * @param props - Property bag.
 * @param name - Name without `#`.
 * @returns bound scalar or undefined.
 */
function readBound(props: PropertyBag, name: string): BindingValue | undefined {
  const v = props[name] ?? props[`#${name}`];
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  return undefined;
}

/**
 * @param s - Possibly section-coded text.
 * @returns stripped text.
 */
function stripSection(s: string): string {
  return s.replace(/§./g, "");
}

/**
 * @param s - Attribute value.
 * @returns CSS.escape polyfill.
 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Reset renderer warn cache (tests). */
export function resetHudWarnCache(): void {
  warnedRenderers.clear();
}
