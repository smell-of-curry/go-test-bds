/**
 * Thin DOM emission for a laid-out JSON UI tree.
 * Layout stays in {@link ./layout}; this only paints absolutely-positioned nodes.
 */

import { formatCodesToFragment } from "../formatCodes";
import { localizeLabelText } from "./load";
import type { LayoutNode } from "./layout";

/** Natural pixel size + optional texture-json nineslice for a pack texture. */
export interface TextureInfo {
  /** Pixel width of the PNG. */
  w: number;
  /** Pixel height of the PNG. */
  h: number;
  /**
   * Bedrock `textures/.../*.json` `nineslice_size` (number, `[x,y]`, or
   * `[left,top,right,bottom]`). Applied when the UI element omits its own.
   */
  nineslice?: unknown;
}

/** Natural pixel size of a texture, keyed by pack path (no extension). */
export type TextureSizeMap = Readonly<Record<string, { w: number; h: number }>>;

/** Texture info map (size + optional nineslice), keyed by pack path. */
export type TextureInfoMap = Readonly<Record<string, TextureInfo>>;

/** Maps a pack-relative texture path to a fetchable URL. */
export interface JsonUiAssets {
  /**
   * @param path - Pack path like `"textures/ui/White"` (no extension).
   * @returns URL (e.g. `/asset/textures/ui/White.png`).
   */
  textureUrl(path: string): string;
  /**
   * Optional sync lookup for natural size + texture-json nineslice.
   * Flipbook UV crop and tiny chrome (2x2 `control.png`) need this.
   *
   * @param path - Pack path without extension.
   * @returns size/nineslice, or undefined when unknown.
   */
  textureInfo?(path: string): TextureInfo | undefined;
}

/** Options for {@link renderTree}. */
export interface RenderOptions {
  /** Multiplier from gui pixels → CSS pixels (e.g. 2 or 3). */
  guiScale: number;
  assets: JsonUiAssets;
  /** Optional natural sizes for UV background math (legacy; prefer assets.textureInfo). */
  textureSizes?: TextureSizeMap;
  /** Optional size + nineslice map (merged under assets.textureInfo when both set). */
  textureInfo?: TextureInfoMap;
  /** Merged pack lang table for `localize: true` labels. */
  lang?: Readonly<Record<string, string>>;
  /**
   * Called once per unknown control `type`.
   *
   * @param type - Unrecognized element type string.
   */
  warn?: (type: string) => void;
}

const warnedTypes = new Set<string>();

/**
 * Render a layout tree into `host` as absolutely-positioned divs.
 *
 * @param node - Root layout node (gui-pixel boxes).
 * @param host - Container; existing children are left alone (appends a root).
 * @param opts - Scale, assets, optional texture sizes / warn hook.
 * @returns the root element appended under `host`.
 */
export function renderTree(
  node: LayoutNode,
  host: HTMLElement,
  opts: RenderOptions,
): HTMLElement {
  // Paint-ready gate: sync epoch + reset requested count BEFORE faces emit so
  // "pending==0 && requested==0" cannot look ready mid-rebuild.
  const paintWin = window as unknown as {
    __jsonUiPaintEpoch?: number;
    __jsonUiTextureRequested?: number;
  };
  paintWin.__jsonUiPaintEpoch = (paintWin.__jsonUiPaintEpoch ?? 0) + 1;
  paintWin.__jsonUiTextureRequested = 0;

  const root = document.createElement("div");
  root.className = "jsonui-root";
  root.style.position = "absolute";
  root.style.left = "0";
  root.style.top = "0";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.pointerEvents = "none";
  root.style.fontFamily =
    '"Minecraft", ui-sans-serif, system-ui, "Segoe UI", sans-serif';
  root.style.color = "#fff";
  root.style.textShadow = "1px 1px 0 #000";
  host.appendChild(root);

  // Root box is absolute in viewport space; children paint parent-relative.
  paintNode(node, root, opts, { x: 0, y: 0 });
  return root;
}

/**
 * Sync bump for golden/capture gates: a texture-backed face was created.
 * Must run before any async decode/fetch for that face.
 *
 * Call from native renderer paths that set `backgroundImage` without
 * {@link applyImage}.
 */
export function noteTextureFaceRequested(): void {
  const w = window as unknown as { __jsonUiTextureRequested?: number };
  w.__jsonUiTextureRequested = (w.__jsonUiTextureRequested ?? 0) + 1;
}

/** Reset the per-type warn set (tests). */
export function resetJsonUiWarnCache(): void {
  warnedTypes.clear();
}

/**
 * Resolve UV origin for an image face.
 *
 * Flipbook anim refs (`@ns.anim__…`) stay as strings after resolve — treat as
 * frame 0 (`[0,0]`). Objects with `initial_uv` (inlined flip_book) use that.
 *
 * @param rawUv - Element `uv` prop.
 * @param hasUvSize - Whether `uv_size` resolved to a positive pair.
 * @returns `[u,v]` pixel origin, or null when UV cropping should not run.
 */
export function resolveImageUv(
  rawUv: unknown,
  hasUvSize: boolean,
): [number, number] | null {
  const pair = asIntPair(rawUv);
  if (pair) return pair;
  if (rawUv && typeof rawUv === "object" && !Array.isArray(rawUv)) {
    const initial = asIntPair((rawUv as { initial_uv?: unknown }).initial_uv);
    if (initial) return initial;
  }
  // Unresolved `@ns.flipbook` string (or missing uv) + uv_size → first frame.
  if (hasUvSize) return [0, 0];
  return null;
}

/**
 * Pick texture info for a pack path from opts + assets.
 *
 * @param texture - Pack path without extension.
 * @param opts - Render options.
 * @returns info or undefined.
 */
export function lookupTextureInfo(
  texture: string,
  opts: Pick<RenderOptions, "assets" | "textureSizes" | "textureInfo">,
): TextureInfo | undefined {
  const fromAssets = opts.assets.textureInfo?.(texture);
  const fromMap = opts.textureInfo?.[texture];
  const sizeOnly = opts.textureSizes?.[texture];
  if (!fromAssets && !fromMap && !sizeOnly) return undefined;
  return {
    w: fromAssets?.w ?? fromMap?.w ?? sizeOnly?.w ?? 0,
    h: fromAssets?.h ?? fromMap?.h ?? sizeOnly?.h ?? 0,
    nineslice: fromAssets?.nineslice ?? fromMap?.nineslice,
  };
}

/**
 * Compute CSS background-size / background-position for a UV crop.
 *
 * @param natural - Full texture pixel size.
 * @param uv - Top-left of the source rect.
 * @param uvSize - Source rect size (one flipbook frame).
 * @param elemCss - Painted element size in CSS px.
 * @returns size + position CSS pixel values.
 */
export function uvBackgroundCss(
  natural: { w: number; h: number },
  uv: [number, number],
  uvSize: [number, number],
  elemCss: { w: number; h: number },
): { size: string; position: string } {
  const [u, v] = uv;
  const [uw, uh] = uvSize;
  const ew = Math.max(0, elemCss.w);
  const eh = Math.max(0, elemCss.h);
  const bw = (natural.w * ew) / uw;
  const bh = (natural.h * eh) / uh;
  return {
    size: `${bw}px ${bh}px`,
    position: `${(-u * ew) / uw}px ${(-v * eh) / uh}px`,
  };
}

function paintNode(
  node: LayoutNode,
  parentEl: HTMLElement,
  opts: RenderOptions,
  parentOrigin: { x: number; y: number },
): void {
  // Invisible hosts usually drop the subtree (battle factory / empty slots).
  // Exception: sidebar `ball_icon` wraps `pokemon_icon` — keep the mon head
  // when the empty-ball host is hidden.
  if (!node.visible) {
    if (node.element.name === "ball_icon") {
      const kids = [...node.children]
        .filter((c) => c.visible)
        .sort((a, b) => a.layer - b.layer);
      for (const child of kids) {
        paintNode(child, parentEl, opts, parentOrigin);
      }
    }
    return;
  }

  const el = document.createElement("div");
  el.className = `jsonui jsonui-${cssType(node.element.type)}`;
  el.dataset.uiName = node.element.name;
  el.dataset.uiType = node.element.type;
  // Stable Playwright hook: "namespace.element" (e.g. phud_sidebar.dock).
  if (node.element.namespace) {
    el.dataset.jsonuiName = `${node.element.namespace}.${node.element.name}`;
  }

  const s = opts.guiScale;
  const { box } = node;
  el.style.position = "absolute";
  el.style.left = `${(box.x - parentOrigin.x) * s}px`;
  el.style.top = `${(box.y - parentOrigin.y) * s}px`;
  el.style.width = `${Math.max(0, box.w * s)}px`;
  el.style.height = `${Math.max(0, box.h * s)}px`;
  el.style.boxSizing = "border-box";
  // `new_ui_button_panel` authors button_image at layer 1 and button_content at
  // 0 — Bedrock still paints the label on top of the chrome. CSS z-index from
  // raw `layer` would hide the label under the opaque button face.
  el.style.zIndex = String(paintLayerZIndex(node.element.name, node.layer));
  el.style.overflow =
    node.element.props.clips_children === true ? "hidden" : "visible";

  // Bedrock `alpha` tints the control's own paint (image face / label glyphs).
  // It must NOT become CSS opacity on the container — packs set `alpha: 0` on
  // image hosts (`pokemon.button_panel`, `battle.button_grid_middle`) to hide
  // the chrome texture while children stay fully opaque. Container opacity
  // would wipe the starter grid / move buttons (run-41 live regressions).
  applyClip(el, node.element.props);

  switch (node.element.type) {
    case "image":
      applyImage(el, node, opts);
      break;
    case "label":
      applyLabel(el, node, opts);
      break;
    case "panel":
    case "stack_panel":
    case "screen":
    case "input_panel":
      // positioned container only
      break;
    case "grid":
      break;
    default:
      // transparent container; warn once per type
      if (opts.warn && !warnedTypes.has(node.element.type)) {
        warnedTypes.add(node.element.type);
        opts.warn(node.element.type);
      }
      break;
  }

  parentEl.appendChild(el);

  // Paint siblings in layer order for stable stacking within this parent.
  const kids = [...node.children].sort(
    (a, b) => paintSiblingRank(a) - paintSiblingRank(b),
  );
  for (const child of kids) {
    paintNode(child, el, opts, { x: box.x, y: box.y });
  }
}

/**
 * CSS z-index for a laid-out control. Button chrome stays under label content.
 *
 * @param name - Resolved element name.
 * @param layer - Pack `layer` value.
 * @returns z-index used on the DOM node.
 */
export function paintLayerZIndex(name: string, layer: number): number {
  if (name === "button_content") return Math.max(layer, 2);
  if (name === "button_image") return Math.min(layer, 1);
  // Hollow dialog `control` uses pack layer -1; CSS z-index < 0 under a
  // composited parent often drops that fill. Clamp only that control.
  if (name === "control" && layer < 0) return 0;
  return layer;
}

/**
 * Sibling paint order rank (lower first). Button chrome before label content.
 *
 * @param node - Layout child.
 * @returns sort key.
 */
function paintSiblingRank(node: LayoutNode): number {
  const name = node.element.name;
  if (name === "button_image") return -1000 + node.layer;
  if (name === "button_content") return 1000 + node.layer;
  return node.layer;
}

function applyImage(
  el: HTMLElement,
  node: LayoutNode,
  opts: RenderOptions,
): void {
  const texture =
    typeof node.element.props.texture === "string"
      ? node.element.props.texture
      : "";
  // Unresolved expr / empty / bogus pack tokens (`t__20`, `t:_default`) —
  // paint nothing. Never fill a white/colored box for a missing texture.
  // CSS `background-image` 404s stay transparent; do not probe with async
  // Image() (that races golden screenshots).
  if (!texture || texture.startsWith("(") || texture.startsWith("$")) return;
  if (!looksLikeTexturePath(texture)) return;

  const url = opts.assets.textureUrl(texture);
  // Sync before CSS url is assigned — paint-ready must see requested > 0
  // even if the browser has not decoded the image yet.
  noteTextureFaceRequested();
  // Face layer so tint filters never recolor nested controls.
  const face = document.createElement("div");
  face.className = "jsonui-image-face";
  face.style.position = "absolute";
  face.style.inset = "0";
  face.style.pointerEvents = "none";
  face.style.imageRendering = "pixelated";
  face.style.backgroundRepeat = "no-repeat";
  face.style.backgroundColor = "transparent";
  face.style.zIndex = "0";

  const tint = asColor(node.element.props.color);
  const info = lookupTextureInfo(texture, opts);
  // Sidebar dock: prefer native 61×405 aspect over texture-json nineslice /
  // stretch — nineslice was filling the wide clipped box into a fat black slab.
  if (node.element.props.$viewer_dock_natural === true) {
    face.style.backgroundImage = `url("${cssUrl(url)}")`;
    const eh = Math.max(0, node.box.h * opts.guiScale);
    const tw = eh * (61 / 405);
    face.style.backgroundSize = `${tw}px ${eh}px`;
    face.style.backgroundPosition = "right center";
    face.style.backgroundRepeat = "no-repeat";
  } else if (node.element.props.tiled === true) {
    // Pack loadingScreen uses common.dirt_background (tiled bg32). Black
    // underlay covers the world if the tile texture 404s.
    el.style.backgroundColor = "#000";
    face.style.backgroundImage = `url("${cssUrl(url)}")`;
    face.style.backgroundRepeat = "repeat";
    const scaleRaw = node.element.props.tiled_scale;
    const sx =
      Array.isArray(scaleRaw) && Number.isFinite(Number(scaleRaw[0]))
        ? Number(scaleRaw[0])
        : 1;
    const sy =
      Array.isArray(scaleRaw) && Number.isFinite(Number(scaleRaw[1]))
        ? Number(scaleRaw[1])
        : sx;
    const tw = Math.max(1, (info?.w || 32) * opts.guiScale * sx);
    const th = Math.max(1, (info?.h || 32) * opts.guiScale * sy);
    face.style.backgroundSize = `${tw}px ${th}px`;
    face.style.backgroundPosition = "0 0";
  } else {
    // Element nineslice wins; else texture-json nineslice (control.png is 2x2
    // with nineslice_size:1 — stretching without it = giant white blob).
    const nine =
      node.element.props.nineslice_size !== undefined &&
      node.element.props.nineslice_size !== null
        ? node.element.props.nineslice_size
        : info?.nineslice;
    // 2×2 `textures/ui/control` + nineslice_size:1 has a 0×0 source center —
    // CSS border-image `fill` paints nothing in the middle. Real Bedrock
    // stretches that texel as the dialog hollow dim fill (alpha 0.8). Scope
    // to `control` only — other empty-center nineslices must keep borders.
    if (
      nine !== undefined &&
      nine !== null &&
      info &&
      info.w > 0 &&
      info.h > 0 &&
      /(?:^|\/)control$/i.test(texture.replace(/\\/g, "/")) &&
      ninesliceCenterIsEmpty(info, nine)
    ) {
      face.style.backgroundImage = `url("${cssUrl(url)}")`;
      face.style.backgroundSize = "100% 100%";
      face.style.backgroundPosition = "0 0";
    } else if (nine !== undefined && nine !== null) {
      applyNineslice(face, url, nine, opts.guiScale);
    } else {
      face.style.backgroundImage = `url("${cssUrl(url)}")`;
      const uvSize = asIntPair(node.element.props.uv_size);
      const hasUvSize = !!(uvSize && uvSize[0]! > 0 && uvSize[1]! > 0);
      const uv = resolveImageUv(node.element.props.uv, hasUvSize);
      if (
        uv &&
        uvSize &&
        info &&
        info.w > 0 &&
        info.h > 0 &&
        uvSize[0]! > 0 &&
        uvSize[1]! > 0
      ) {
        const css = uvBackgroundCss({ w: info.w, h: info.h }, uv, uvSize, {
          w: Math.max(0, node.box.w * opts.guiScale),
          h: Math.max(0, node.box.h * opts.guiScale),
        });
        face.style.backgroundSize = css.size;
        face.style.backgroundPosition = css.position;
      } else if (
        node.element.props.$viewer_bg_align === "left" ||
        node.element.props.$viewer_bg_align === "right"
      ) {
        // Clipped overflow image: paint as if still full-width. Prefer left —
        // right-align showed only the opaque end of textures with a left pad.
        const scale = Number(node.element.props.$viewer_bg_scale_x) || 1;
        const align =
          node.element.props.$viewer_bg_align === "right" ? "right" : "left";
        face.style.backgroundSize = `${scale * 100}% 100%`;
        face.style.backgroundPosition = `${align} center`;
      } else {
        face.style.backgroundSize = "100% 100%";
        face.style.backgroundPosition = "0 0";
      }
    }
  }

  // Colorable whites (battle white_transparency): replace RGB with tint,
  // keep texture alpha. 404 background → nothing to filter → transparent.
  // Skip identity white `[1,1,1]` — common_buttons sets that as "no tint";
  // applying feFlood white turns moveSelection / plates into solid white
  // slabs (run-42 mid-left battle chrome).
  if (tint && !isIdentityWhiteTint(node.element.props.color)) {
    face.style.filter = svgTintFilter(tint);
  }

  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  face.style.opacity = alpha < 1 ? String(alpha) : "1";

  el.appendChild(face);
}

/**
 * True when `color` is Bedrock's "untinted" white (`[1,1,1]` / `[1,1,1,1]`).
 *
 * @param raw - Element `color` prop.
 * @returns whether tinting should be skipped.
 */
function isIdentityWhiteTint(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length < 3) return false;
  const r = Number(raw[0]);
  const g = Number(raw[1]);
  const b = Number(raw[2]);
  if (![r, g, b].every(Number.isFinite)) return false;
  return r >= 0.999 && g >= 0.999 && b >= 0.999;
}

/**
 * True when `texture` looks like a pack path, not a form buttonImages token.
 *
 * @param texture - Raw texture property.
 * @returns whether to attempt a /asset fetch.
 */
function looksLikeTexturePath(texture: string): boolean {
  if (texture.includes("/") || texture.includes("\\")) return true;
  if (texture.startsWith("textures")) return true;
  return false;
}

/**
 * Build a CSS `filter: url(...)` that paints `tint` through the source alpha.
 *
 * @param tint - CSS `rgb(r, g, b)` color.
 * @returns filter value.
 */
function svgTintFilter(tint: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg">` +
    `<filter id="t" color-interpolation-filters="sRGB">` +
    `<feFlood flood-color="${tint}" result="f"/>` +
    `<feComposite in="f" in2="SourceAlpha" operator="in"/>` +
    `</filter></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}#t")`;
}

/**
 * True when nineslice borders consume the whole texture (no center texels).
 *
 * @param info - Natural texture size.
 * @param nine - Pack / texture-json nineslice.
 * @returns whether border-image fill would paint an empty center.
 */
export function ninesliceCenterIsEmpty(
  info: { w: number; h: number },
  nine: unknown,
): boolean {
  const [left, top, right, bottom] = parseNineslice(nine);
  return info.w <= left + right || info.h <= top + bottom;
}

function applyNineslice(
  el: HTMLElement,
  url: string,
  nine: unknown,
  guiScale: number,
): void {
  const [left, top, right, bottom] = parseNineslice(nine);
  el.style.borderImageSource = `url("${cssUrl(url)}")`;
  el.style.borderImageSlice = `${top} ${right} ${bottom} ${left} fill`;
  el.style.borderImageWidth = `${top * guiScale}px ${right * guiScale}px ${bottom * guiScale}px ${left * guiScale}px`;
  el.style.borderStyle = "solid";
  el.style.borderWidth = "0";
  // Keep a background fallback empty; border-image paints the face.
  el.style.backgroundImage = "none";
  el.style.imageRendering = "pixelated";
}

function parseNineslice(nine: unknown): [number, number, number, number] {
  if (typeof nine === "number" && Number.isFinite(nine)) {
    return [nine, nine, nine, nine];
  }
  if (Array.isArray(nine)) {
    if (nine.length >= 4) {
      return [
        Number(nine[0]) || 0,
        Number(nine[1]) || 0,
        Number(nine[2]) || 0,
        Number(nine[3]) || 0,
      ];
    }
    if (nine.length === 2) {
      const x = Number(nine[0]) || 0;
      const y = Number(nine[1]) || 0;
      return [x, y, x, y];
    }
    if (nine.length === 1) {
      const n = Number(nine[0]) || 0;
      return [n, n, n, n];
    }
  }
  return [0, 0, 0, 0];
}

/**
 * Apply Bedrock `clip_ratio` / `clip_direction` as a CSS clip-path.
 *
 * `clip_ratio` is the HIDDEN fraction (visible = 1 − ratio). Used by sidebar
 * XP bars (`filled_progress_bar` + `clip_direction: "left"`).
 *
 * @param el - Painted element.
 * @param props - Element property bag.
 */
function applyClip(
  el: HTMLElement,
  props: LayoutNode["element"]["props"],
): void {
  const ratioRaw = props.clip_ratio;
  const hasDirection =
    typeof props.clip_direction === "string" && props.clip_direction.length > 0;
  // `Number("")` is 0 — treat empty/invalid #clip_ratio as fully hidden when
  // the pack authored a clip_direction (fainted / empty-slot bars).
  if (
    ratioRaw === "" ||
    ratioRaw === null ||
    ratioRaw === undefined ||
    (typeof ratioRaw === "string" && ratioRaw.trim() === "")
  ) {
    if (hasDirection) el.style.clipPath = "inset(100%)";
    return;
  }
  const ratio =
    typeof ratioRaw === "number"
      ? ratioRaw
      : typeof ratioRaw === "string"
        ? Number(ratioRaw)
        : NaN;
  if (!Number.isFinite(ratio)) {
    if (hasDirection) el.style.clipPath = "inset(100%)";
    return;
  }
  if (ratio <= 0) return;
  const hidden = Math.min(1, Math.max(0, ratio));
  const visible = 1 - hidden;
  if (visible <= 0) {
    el.style.clipPath = "inset(100%)";
    return;
  }
  if (visible >= 1) return;

  const dir = hasDirection
    ? String(props.clip_direction).toLowerCase()
    : "left";
  // inset(top right bottom left) — hide the trailing side along clip_direction.
  switch (dir) {
    case "right":
      el.style.clipPath = `inset(0 ${hidden * 100}% 0 0)`;
      break;
    case "up":
    case "top":
      el.style.clipPath = `inset(0 0 ${hidden * 100}% 0)`;
      break;
    case "down":
    case "bottom":
      el.style.clipPath = `inset(${hidden * 100}% 0 0 0)`;
      break;
    case "left":
    default:
      // Hide from the right: bar empties right→left as clip_ratio rises.
      el.style.clipPath = `inset(0 ${hidden * 100}% 0 0)`;
      break;
  }
}

export function resolveLabelFontScale(props: {
  font_scale_factor?: unknown;
  font_size?: unknown;
}): number {
  const raw = props.font_scale_factor;
  const fromFactor =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  const factor = Number.isFinite(fromFactor) ? fromFactor : 1;
  const sizeKey =
    typeof props.font_size === "string" ? props.font_size.toLowerCase() : "";
  const sizeScale =
    ({ small: 0.75, normal: 1, large: 1.25 } as Record<string, number>)[
      sizeKey
    ] ?? 1;
  return factor * sizeScale;
}

function applyLabel(
  el: HTMLElement,
  node: LayoutNode,
  opts: RenderOptions,
): void {
  const raw =
    typeof node.element.props.text === "string" ? node.element.props.text : "";
  // A leading `#` at paint time is an unresolved binding name (resolved
  // bindings overwrite `text` with the final string). The real client renders
  // an unbound label empty, never the literal binding name.
  const unbound = raw.startsWith("#") ? "" : raw;
  const text = localizeLabelText(
    unbound,
    node.element.props.localize,
    opts.lang,
  );
  const fontScale = resolveLabelFontScale(node.element.props);
  const basePx = 8 * opts.guiScale * fontScale;
  el.style.fontSize = `${basePx}px`;
  el.style.lineHeight = `${Math.ceil(basePx * 1.125)}px`;
  el.style.whiteSpace = "pre-wrap";
  el.style.overflowWrap = "anywhere";
  // Dialogue body (`main_label`) sits under a hollow title band; keep glyphs
  // visible when the measured box is a hair short (avoid first-line clip).
  el.style.overflow = node.element.name === "main_label" ? "visible" : "hidden";
  const align = node.element.props.text_alignment;
  if (align === "center" || align === "left" || align === "right") {
    el.style.textAlign = align;
  }

  const color = asColor(node.element.props.color);
  if (color) el.style.color = color;

  if (node.element.props.shadow === true) {
    el.style.textShadow = `${opts.guiScale}px ${opts.guiScale}px 0 #000`;
  }

  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  if (alpha < 1) el.style.opacity = String(alpha);

  el.appendChild(formatCodesToFragment(text));
}

function asColor(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const r = clamp01(Number(raw[0]));
  const g = clamp01(Number(raw[1]));
  const b = clamp01(Number(raw[2]));
  if (![r, g, b].every(Number.isFinite)) return null;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function asIntPair(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const a = Number(raw[0]);
  const b = Number(raw[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function cssType(type: string): string {
  return type.replace(/[^a-z0-9_-]+/gi, "_");
}

function cssUrl(url: string): string {
  return url.replace(/\\/g, "/").replace(/"/g, '\\"');
}
