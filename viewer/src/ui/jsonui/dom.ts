/**
 * Thin DOM emission for a laid-out JSON UI tree.
 * Layout stays in {@link ./layout}; this only paints absolutely-positioned nodes.
 */

import { formatCodesToFragment } from "../formatCodes";
import { localizeLabelText } from "./load";
import type { LayoutNode } from "./layout";

/** Maps a pack-relative texture path to a fetchable URL. */
export interface JsonUiAssets {
  /**
   * @param path - Pack path like `"textures/ui/White"` (no extension).
   * @returns URL (e.g. `/asset/textures/ui/White.png`).
   */
  textureUrl(path: string): string;
}

/** Natural pixel size of a texture, keyed by pack path (no extension). */
export type TextureSizeMap = Readonly<Record<string, { w: number; h: number }>>;

/** Options for {@link renderTree}. */
export interface RenderOptions {
  /** Multiplier from gui pixels → CSS pixels (e.g. 2 or 3). */
  guiScale: number;
  assets: JsonUiAssets;
  /** Optional natural sizes for UV background math. */
  textureSizes?: TextureSizeMap;
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

/** Reset the per-type warn set (tests). */
export function resetJsonUiWarnCache(): void {
  warnedTypes.clear();
}

function paintNode(
  node: LayoutNode,
  parentEl: HTMLElement,
  opts: RenderOptions,
  parentOrigin: { x: number; y: number },
): void {
  // Drop invisible subtrees (battle factory expands every button template;
  // hidden bag/move slots must not flood the DOM with 404 image faces).
  if (!node.visible) return;

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
  el.style.zIndex = String(node.layer);
  el.style.overflow =
    node.element.props.clips_children === true ? "hidden" : "visible";

  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  if (alpha < 1) el.style.opacity = String(alpha);

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
  const kids = [...node.children].sort((a, b) => a.layer - b.layer);
  for (const child of kids) {
    paintNode(child, el, opts, { x: box.x, y: box.y });
  }
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
  const nine = node.element.props.nineslice_size;
  if (nine !== undefined && nine !== null) {
    applyNineslice(face, url, nine, opts.guiScale);
  } else {
    face.style.backgroundImage = `url("${cssUrl(url)}")`;
    const uv = asIntPair(node.element.props.uv);
    const uvSize = asIntPair(node.element.props.uv_size);
    const natural = opts.textureSizes?.[texture];
    if (uv && uvSize && natural && uvSize[0]! > 0 && uvSize[1]! > 0) {
      const ew = Math.max(0, node.box.w * opts.guiScale);
      const eh = Math.max(0, node.box.h * opts.guiScale);
      const [u, v] = uv;
      const [uw, uh] = uvSize;
      const bw = (natural.w * ew) / uw!;
      const bh = (natural.h * eh) / uh!;
      face.style.backgroundSize = `${bw}px ${bh}px`;
      face.style.backgroundPosition = `${(-u! * ew) / uw!}px ${(-v! * eh) / uh!}px`;
    } else {
      face.style.backgroundSize = "100% 100%";
      face.style.backgroundPosition = "0 0";
    }
  }

  // Colorable whites (battle white_transparency): replace RGB with tint,
  // keep texture alpha. 404 background → nothing to filter → transparent.
  if (tint) face.style.filter = svgTintFilter(tint);

  el.appendChild(face);
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
  const ratio =
    typeof ratioRaw === "number"
      ? ratioRaw
      : typeof ratioRaw === "string"
        ? Number(ratioRaw)
        : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const hidden = Math.min(1, Math.max(0, ratio));
  const visible = 1 - hidden;
  if (visible <= 0) {
    el.style.clipPath = "inset(100%)";
    return;
  }
  if (visible >= 1) return;

  const dir =
    typeof props.clip_direction === "string"
      ? props.clip_direction.toLowerCase()
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
  const fontScale =
    typeof node.element.props.font_scale_factor === "number"
      ? node.element.props.font_scale_factor
      : 1;
  const basePx = 8 * opts.guiScale * fontScale;
  el.style.fontSize = `${basePx}px`;
  el.style.lineHeight = "1.2";
  el.style.whiteSpace = "pre";
  el.style.overflow = "hidden";

  const color = asColor(node.element.props.color);
  if (color) el.style.color = color;

  if (node.element.props.shadow === true) {
    el.style.textShadow = `${opts.guiScale}px ${opts.guiScale}px 0 #000`;
  }

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
