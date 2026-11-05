/**
 * Thin DOM emission for a laid-out JSON UI tree.
 * Layout stays in {@link ./layout}; this only paints absolutely-positioned nodes.
 */

import { formatCodesToFragment } from "../formatCodes";
import { ellipsizeMojangles, MOJANGLES_STACK } from "../mojangles";
import {
  LABEL_FONT_SIZE_GUI,
  LABEL_LINE_HEIGHT_GUI,
  collapseLangPercentEscapes,
  resolveLabelFontScale,
} from "./labelMetrics";
import { localizeLabelText } from "./load";
import type { LayoutNode } from "./layout";

export { resolveLabelFontScale } from "./labelMetrics";

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
  /** Authored design dimensions; PNGs may be higher resolution. */
  baseSize?: [number, number];
  /** True only after verifying every decoded RGBA texel is identical. */
  uniform?: boolean;
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
  root.style.fontFamily = MOJANGLES_STACK;
  root.style.color = "#fff";
  // Screen edge clips. Off-screen overflow must not grow scrollbars.
  root.style.overflow = "hidden";
  host.appendChild(root);

  // Root box is absolute in viewport space; children paint parent-relative.
  paintNode(node, root, opts, { x: 0, y: 0 }, 0);
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
    ...(fromAssets?.baseSize || fromMap?.baseSize
      ? { baseSize: fromAssets?.baseSize ?? fromMap?.baseSize }
      : {}),
    ...(fromAssets?.uniform !== undefined || fromMap?.uniform !== undefined
      ? { uniform: fromAssets?.uniform ?? fromMap?.uniform }
      : {}),
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
/**
 * `keep_ratio` defaults true. Only an explicit false stretches the texture.
 * Nineslice and tiled faces ignore this (they never call it).
 *
 * @param raw - Element `keep_ratio` prop.
 * @returns false only for `false` / `"false"` / `0`.
 */
export function imageKeepsRatio(raw: unknown): boolean {
  if (raw === false || raw === 0 || raw === "false") return false;
  return true;
}

/**
 * CSS background for an image face, in CSS pixels (pixelated scale).
 *
 * `keepRatio` aspect-fits the UV crop (or the whole texture) inside the
 * element and centers it. Crop aspect is `uv_size`, not the full PNG, when
 * a crop is set. `keepRatio: false` stretches that rect to the element.
 *
 * @param natural - Full texture pixel size.
 * @param uv - Crop origin, or null when the whole texture is shown.
 * @param uvSize - Crop size, or null.
 * @param elemCss - Element box in CSS px.
 * @param keepRatio - Aspect-fit when true.
 * @param fill - Cover the image box instead of fitting inside it.
 * @returns `background-size` and `background-position`.
 */
export function fitImageBackgroundCss(
  natural: { w: number; h: number },
  uv: [number, number] | null,
  uvSize: [number, number] | null,
  elemCss: { w: number; h: number },
  keepRatio: boolean,
  fill = false,
): { size: string; position: string } {
  const ew = Math.max(0, elemCss.w);
  const eh = Math.max(0, elemCss.h);
  const hasCrop =
    uv !== null &&
    uvSize !== null &&
    uvSize[0]! > 0 &&
    uvSize[1]! > 0 &&
    natural.w > 0 &&
    natural.h > 0;
  const cropW = hasCrop ? uvSize![0]! : Math.max(1, natural.w);
  const cropH = hasCrop ? uvSize![1]! : Math.max(1, natural.h);

  let fitW = ew;
  let fitH = eh;
  let ox = 0;
  let oy = 0;
  if (keepRatio && cropW > 0 && cropH > 0 && ew > 0 && eh > 0) {
    if (ew * cropH > eh * cropW !== fill) {
      fitH = eh;
      fitW = eh * (cropW / cropH);
    } else {
      fitW = ew;
      fitH = ew * (cropH / cropW);
    }
    fitW = Math.round(fitW);
    fitH = Math.round(fitH);
    ox = Math.round((ew - fitW) / 2);
    oy = Math.round((eh - fitH) / 2);
  }

  if (!hasCrop) {
    return {
      size: `${cssPx(fitW)} ${cssPx(fitH)}`,
      position: `${cssPx(ox)} ${cssPx(oy)}`,
    };
  }
  const [u, v] = uv!;
  const [uw, uh] = uvSize!;
  const bw = (natural.w * fitW) / uw;
  const bh = (natural.h * fitH) / uh;
  return {
    size: `${cssPx(bw)} ${cssPx(bh)}`,
    position: `${cssPx(ox + (-u * fitW) / uw)} ${cssPx(oy + (-v * fitH) / uh)}`,
  };
}

function cssPx(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return `${r}px`;
}

export function uvBackgroundCss(
  natural: { w: number; h: number },
  uv: [number, number],
  uvSize: [number, number],
  elemCss: { w: number; h: number },
): { size: string; position: string } {
  return fitImageBackgroundCss(natural, uv, uvSize, elemCss, false);
}

function paintNode(
  node: LayoutNode,
  parentEl: HTMLElement,
  opts: RenderOptions,
  parentOrigin: { x: number; y: number },
  parentLayer: number,
): void {
  // Hidden hosts drop themselves and their children.
  if (!node.visible) return;

  const abs = absolutePaintLayer(parentLayer, node.layer);
  const el = document.createElement("div");
  el.className = `jsonui jsonui-${cssType(node.element.type)}`;
  el.dataset.uiName = node.element.name;
  el.dataset.uiType = node.element.type;
  // Stable Playwright hook: "namespace.element" (e.g. sidebar.dock).
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
  // A z-index creates a stacking context that traps descendants. Containers
  // stay `auto` so a grandchild's absolute layer can paint above an uncle
  // (vanilla button label is panel+0+3+2, above button_image at panel+1).
  // Leaves and labels take the absolute layer themselves.
  const hasVisibleChild = node.children.some((c) => c.visible);
  const leafStack = !hasVisibleChild || node.element.type === "label";
  if (leafStack) el.style.zIndex = String(abs);
  el.style.overflow =
    node.element.props.clips_children === true ? "hidden" : "visible";

  // Bedrock `alpha` tints the control's own paint (image face / label glyphs).
  // It must NOT become CSS opacity on the container — packs set `alpha: 0` on
  // image hosts to hide the chrome texture while children stay fully opaque.
  // Container opacity would hide those children too.
  applyClip(el, node.element.props);

  switch (node.element.type) {
    case "image":
      applyImage(el, node, opts, abs, !leafStack);
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

  // Bedrock paints children in declaration order, `layer` low to high.
  const kids = paintChildOrder(node.children);
  for (const child of kids) {
    paintNode(child, el, opts, { x: box.x, y: box.y }, abs);
  }
  // Translucent image face paints over its own children at the same
  // effective layer (cell J: white 0.5 over red = 255,128,128). An opaque
  // parent does not — cell D's bars stay above the grey plate. A higher
  // child layer still wins via z-index.
  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  if (alpha < 1) {
    const faces: Element[] = [];
    for (const child of el.children) {
      if (child.classList.contains("jsonui-image-face")) faces.push(child);
    }
    for (const face of faces) el.appendChild(face);
  }
}

/**
 * Absolute paint layer. `layer` is an offset from the parent.
 *
 * @param parentLayer - Parent absolute layer (0 at the JSON UI root).
 * @param layer - This element's authored `layer` (default 0).
 * @returns parent + child.
 */
export function absolutePaintLayer(parentLayer: number, layer: number): number {
  return parentLayer + layer;
}

/**
 * Sibling paint order: lower `layer` first, then declaration index.
 * Later siblings with the same layer paint on top.
 *
 * @param children - Layout children in declaration order.
 * @returns sorted copy.
 */
export function paintChildOrder<T extends { layer: number }>(
  children: readonly T[],
): T[] {
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => a.child.layer - b.child.layer || a.index - b.index)
    .map((row) => row.child);
}

function applyImage(
  el: HTMLElement,
  node: LayoutNode,
  opts: RenderOptions,
  absLayer: number,
  liftFace: boolean,
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
  // Host is a stacking context on leaves. When the image has children, the
  // host stays auto and the face takes the absolute layer so those children
  // can paint above uncles.
  face.style.zIndex = liftFace ? String(absLayer) : "0";

  const tint = colorChannels(node.element.props.color);
  const info = lookupTextureInfo(texture, opts);
  if (node.element.props.tiled === true) {
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
    // CSS border-image cannot fill a center consumed by opposing slices.
    // Native solid-color plates still fill their box. Stretching a verified
    // uniform texture preserves every texel (including its alpha); patterned
    // borders keep their authored slicing. This also supports pack overrides.
    if (
      nine !== undefined &&
      nine !== null &&
      info &&
      info.uniform === true &&
      ninesliceCenterIsEmpty(info, nine)
    ) {
      face.style.backgroundImage = `url("${cssUrl(url)}")`;
      face.style.backgroundSize = "100% 100%";
      face.style.backgroundPosition = "0 0";
    } else if (nine !== undefined && nine !== null) {
      applyNineslice(face, url, nine, opts.guiScale, info, {
        w: node.box.w * opts.guiScale,
        h: node.box.h * opts.guiScale,
      });
    } else {
      face.style.backgroundImage = `url("${cssUrl(url)}")`;
      const uvSize = asIntPair(node.element.props.uv_size);
      const hasUvSize = !!(uvSize && uvSize[0]! > 0 && uvSize[1]! > 0);
      const uv = resolveImageUv(node.element.props.uv, hasUvSize);
      const keep = imageKeepsRatio(node.element.props.keep_ratio);
      const elemCss = {
        w: Math.max(0, node.box.w * opts.guiScale),
        h: Math.max(0, node.box.h * opts.guiScale),
      };
      const canCrop = !!(
        uv &&
        uvSize &&
        info &&
        info.w > 0 &&
        info.h > 0 &&
        uvSize[0]! > 0 &&
        uvSize[1]! > 0
      );
      const canFit = !!(info && info.w > 0 && info.h > 0);
      if (canCrop || (keep && canFit)) {
        const css = fitImageBackgroundCss(
          { w: info!.w, h: info!.h },
          canCrop ? uv! : null,
          canCrop ? uvSize! : null,
          elemCss,
          keep,
          node.element.props.fill === true,
        );
        face.style.backgroundSize = css.size;
        face.style.backgroundPosition = css.position;
      } else {
        face.style.backgroundSize = "100% 100%";
        face.style.backgroundPosition = "0 0";
      }
    }
  }

  // Bedrock `color` multiplies texture RGB. Alpha channel stays the texture's.
  // `[1,1,1]` is the identity matrix (no visible change).
  if (tint) face.style.filter = svgMultiplyTintFilter(tint);

  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  face.style.opacity = alpha < 1 ? String(alpha) : "1";

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
 * CSS filter that multiplies source RGB by `tint`. Alpha is unchanged.
 *
 * @param tint - Bedrock `color` channels in 0..1.
 * @returns `filter` value.
 */
function svgMultiplyTintFilter(tint: [number, number, number]): string {
  const f = (n: number): string => String(Math.round(n * 1000) / 1000);
  const [r, g, b] = tint;
  const values = `${f(r)} 0 0 0 0 0 ${f(g)} 0 0 0 0 0 ${f(b)} 0 0 0 0 0 1 0`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg">` +
    `<filter id="t" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="matrix" values="${values}"/>` +
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
  info: Pick<TextureInfo, "w" | "h" | "baseSize">,
  nine: unknown,
): boolean {
  const [left, top, right, bottom] = parseNineslice(nine);
  const w = info.baseSize?.[0] || info.w;
  const h = info.baseSize?.[1] || info.h;
  return w > 0 && h > 0 && (w <= left + right || h <= top + bottom);
}

/** Detect a genuinely uniform decoded texture; unknown/empty data is not proof. */
export function texturePixelsAreUniform(pixels: ArrayLike<number>): boolean {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return false;
  for (let i = 4; i < pixels.length; i++) {
    if (pixels[i] !== pixels[i % 4]) return false;
  }
  return true;
}

function applyNineslice(
  el: HTMLElement,
  url: string,
  nine: unknown,
  guiScale: number,
  info: TextureInfo | undefined,
  box: { w: number; h: number },
): void {
  const css = ninesliceCss(nine, guiScale, info, box);
  el.style.borderImageSource = `url("${cssUrl(url)}")`;
  el.style.borderImageSlice = css.slice;
  el.style.borderImageWidth = css.width;
  el.style.borderStyle = "solid";
  el.style.borderWidth = "0";
  // Keep a background fallback empty; border-image paints the face.
  el.style.backgroundImage = "none";
  el.style.imageRendering = "pixelated";
}

/**
 * Convert design-space slice widths to source texels and screen pixels.
 * A horizontal-only slice scales its end caps with the unsliced height
 * (and vice versa), otherwise a square icon slot turns an arrow into a
 * tall, needle-shaped head. Full nine-slices keep fixed GUI-sized corners.
 */
export function ninesliceCss(
  nine: unknown,
  guiScale: number,
  info: TextureInfo | undefined,
  box: { w: number; h: number },
): { slice: string; width: string } {
  const [left, top, right, bottom] = parseNineslice(nine);
  const bw = info?.baseSize?.[0] || info?.w || 0;
  const bh = info?.baseSize?.[1] || info?.h || 0;
  const texelX = bw > 0 ? (info?.w || bw) / bw : 1;
  const texelY = bh > 0 ? (info?.h || bh) / bh : 1;
  let sx = guiScale;
  let sy = guiScale;
  if (top === 0 && bottom === 0 && bh > 0) sx = box.h / bh;
  if (left === 0 && right === 0 && bw > 0) sy = box.w / bw;
  // CSS itself proportionally contracts opposing borders when they exceed
  // the box. Match that contraction here so the authored ratios survive.
  const cap = Math.min(
    1,
    left + right > 0 ? box.w / ((left + right) * sx) : 1,
    top + bottom > 0 ? box.h / ((top + bottom) * sy) : 1,
  );
  return {
    slice: `${top * texelY} ${right * texelX} ${bottom * texelY} ${left * texelX} fill`,
    width: `${cssPx(top * sy * cap)} ${cssPx(right * sx * cap)} ${cssPx(bottom * sy * cap)} ${cssPx(left * sx * cap)}`,
  };
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
  const text = collapseLangPercentEscapes(
    localizeLabelText(unbound, node.element.props.localize, opts.lang),
  );
  const fontScale = resolveLabelFontScale(node.element.props);
  // Probe cell I: `font_scale_factor` 2 in a 12-tall box and `font_size`
  // large in an 8-tall box draw no glyphs (the cell is shorter than the
  // 8px glyph). Default (exactly 8) and `small` (4) still draw.
  if (LABEL_FONT_SIZE_GUI * fontScale > node.box.h + 0.01) {
    return;
  }
  // Single-line boxes truncate with "...". Multi-line / max_width wrap.
  const singleLine = labelClipsWithEllipsis(
    text,
    node.box.h,
    fontScale,
    node.element.props.max_width,
  );
  const shown = singleLine
    ? ellipsizeMojangles(text, node.box.w, fontScale)
    : text;
  // Bedrock clips; it does not shrink the font to fit the box.
  const fontPx = LABEL_FONT_SIZE_GUI * opts.guiScale * fontScale;
  const linePx = LABEL_LINE_HEIGHT_GUI * opts.guiScale * fontScale;
  el.style.fontSize = `${fontPx}px`;
  el.style.lineHeight = `${linePx}px`;
  el.style.fontFamily = MOJANGLES_STACK;
  el.style.whiteSpace = "pre-wrap";
  el.style.overflowWrap = "anywhere";
  el.style.overflow = "hidden";
  const align = node.element.props.text_alignment;
  if (align === "center" || align === "left" || align === "right") {
    el.style.textAlign = align;
  }

  const color = asColor(node.element.props.color);
  if (color) el.style.color = color;

  const alpha =
    typeof node.element.props.alpha === "number" ? node.element.props.alpha : 1;
  if (alpha < 1) el.style.opacity = String(alpha);

  el.appendChild(
    formatCodesToFragment(shown, {
      color: color ?? undefined,
      guiScale: opts.guiScale * fontScale,
      shadow: node.element.props.shadow === true,
      maxWidth: singleLine ? undefined : node.box.w / fontScale,
    }),
  );
  // Block canvas ignores text-align. inline-block honors center/right
  // after the line has been ellipsized to the box.
  const canvas = el.querySelector("canvas");
  if (canvas instanceof HTMLElement) {
    canvas.style.display = "inline-block";
    canvas.style.verticalAlign = "top";
  }
}

/**
 * True when a too-wide label should end in `...` instead of wrapping.
 *
 * Skips explicit newlines and `max_width` (vanilla hover / body wrap).
 * A box tall enough for two line boxes is a wrap target.
 *
 * @param text - Display text.
 * @param boxH - Laid-out height in gui px.
 * @param fontScale - Effective font scale.
 * @param maxWidth - Element `max_width`, if any.
 * @returns whether to ellipsize.
 */
export function labelClipsWithEllipsis(
  text: string,
  boxH: number,
  fontScale: number,
  maxWidth: unknown,
): boolean {
  if (text.includes("\n")) return false;
  if (maxWidth !== undefined && maxWidth !== null && maxWidth !== "") {
    return false;
  }
  const line = LABEL_LINE_HEIGHT_GUI * (fontScale > 0 ? fontScale : 1);
  if (boxH >= line * 2 - 0.01) return false;
  return true;
}

/**
 * Read a numeric RGB tint or the black/white names used by vanilla UI.
 * @param raw - Authored color property.
 * @returns Normalized RGB channels, or null for an unresolved color.
 */
export function colorChannels(raw: unknown): [number, number, number] | null {
  // Named colors occur in vanilla UI too (for example persona_popups).
  // Some packs wrap a name in a one-item array; retain the same meaning.
  const name = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (name === "black") return [0, 0, 0];
  if (name === "white") return [1, 1, 1];
  if (!Array.isArray(raw) || raw.length < 3) return null;
  if (!raw.slice(0, 3).every((v) => Number.isFinite(Number(v)))) return null;
  const r = clamp01(Number(raw[0]));
  const g = clamp01(Number(raw[1]));
  const b = clamp01(Number(raw[2]));
  if (![r, g, b].every(Number.isFinite)) return null;
  return [r, g, b];
}

function asColor(raw: unknown): string | null {
  const rgb = colorChannels(raw);
  if (!rgb) return null;
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
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
