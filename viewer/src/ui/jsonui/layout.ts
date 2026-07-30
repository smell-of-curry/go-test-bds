/**
 * Pure Bedrock JSON UI layout math. No DOM.
 *
 * Size/anchor semantics follow
 * https://wiki.bedrock.dev/json-ui/json-ui-documentation:
 * `%` → parent axis, `%x` → this element's width, `%y` → this element's height
 * (e.g. sidebar `["222.22%y", 192]` and ball icons `["100%y", "100%"]`).
 */

import { evalExpr, parseExpr } from "./expr.js";
import type {
  LayoutBox,
  PropertyBag,
  ResolvedChild,
  ResolvedElement,
  Viewport,
} from "./types";

/** Measured text extents in gui pixels. */
export interface TextMetrics {
  w: number;
  h: number;
}

/**
 * Callback that sizes label text without touching the DOM.
 *
 * @param text - Raw label text (may include `§` codes; caller may strip).
 * @param fontScale - `font_scale_factor` (default 1).
 * @returns width/height in gui pixels.
 */
export type MeasureText = (text: string, fontScale: number) => TextMetrics;

/** One laid-out element instance. */
export interface LayoutNode {
  element: ResolvedElement;
  box: LayoutBox;
  children: LayoutNode[];
  /** Sibling z-order from `layer` (default 0). */
  layer: number;
  /** False when `visible: false`; node kept for tree fidelity. */
  visible: boolean;
}

/** Options for {@link layoutTree}. */
export interface LayoutOptions {
  measureText: MeasureText;
}

type Anchor =
  | "top_left"
  | "top_middle"
  | "top_right"
  | "left_middle"
  | "center"
  | "right_middle"
  | "bottom_left"
  | "bottom_middle"
  | "bottom_right";

type Axis = "w" | "h";

interface SizeEnv {
  parentW: number;
  parentH: number;
  selfW: number;
  selfH: number;
  childrenW: number;
  childrenH: number;
  maxChildW: number;
  maxChildH: number;
  viewportW: number;
  viewportH: number;
  remainingW: number;
  remainingH: number;
}

interface ParsedSize {
  /** Dependent on children totals / max. */
  needsChildren: boolean;
  /** Dependent on self opposite axis. */
  needsSelf: boolean;
  isFill: boolean;
  isDefault: boolean;
  eval(env: SizeEnv, axis: Axis): number;
}

const ANCHORS: Record<Anchor, { x: number; y: number }> = {
  top_left: { x: 0, y: 0 },
  top_middle: { x: 0.5, y: 0 },
  top_right: { x: 1, y: 0 },
  left_middle: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right_middle: { x: 1, y: 0.5 },
  bottom_left: { x: 0, y: 1 },
  bottom_middle: { x: 0.5, y: 1 },
  bottom_right: { x: 1, y: 1 },
};

/**
 * Lay out a resolved element tree against a viewport.
 *
 * @param el - Root resolved element (usually a screen).
 * @param viewport - Layout space in gui pixels.
 * @param opts - Pure helpers (text measurement).
 * @returns rooted layout tree with absolute gui-pixel boxes.
 */
export function layoutTree(
  el: ResolvedElement,
  viewport: Viewport,
  opts: LayoutOptions,
): LayoutNode {
  const parentBox: LayoutBox = {
    x: 0,
    y: 0,
    w: viewport.width,
    h: viewport.height,
  };
  return layoutElement(el, parentBox, viewport, opts, {
    remainingW: viewport.width,
    remainingH: viewport.height,
  });
}

function layoutElement(
  el: ResolvedElement,
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  fill: { remainingW: number; remainingH: number },
): LayoutNode {
  const visible = coerceVisible(el.props.visible);
  const layer = asInt(el.props.layer, 0);

  if (isIgnored(el.props)) {
    return {
      element: el,
      box: { x: parentBox.x, y: parentBox.y, w: 0, h: 0 },
      children: [],
      layer,
      visible: false,
    };
  }

  // Invisible factory siblings (battle bag/move slots) — stub only. Full
  // layout of hidden trees made battle.main multi-second on the golden path.
  if (!visible) {
    return {
      element: el,
      box: { x: parentBox.x, y: parentBox.y, w: 0, h: 0 },
      children: [],
      layer,
      visible: false,
    };
  }

  // scroll_view: paint content statically clipped (no scroll interaction).
  // Drop scrollbar chrome so `fill` viewport gets full width — track/%c
  // siblings otherwise collapse the pane to a sliver.
  if (el.type === "scroll_view") {
    const forced: ResolvedElement = {
      ...stripScrollChrome(el),
      props: { ...el.props, clips_children: true },
    };
    return layoutAnchored(
      forced,
      parentBox,
      viewport,
      opts,
      fill,
      visible,
      layer,
    );
  }

  if (el.type === "stack_panel") {
    // Collection hosts sized to the parent (100%, not %c) overlay factory
    // children — battle move/action buttons share one grid origin.
    if (el.props.factory && el.props.collection_name) {
      const hSpec = parseSize(readSizePair(el.props.size)[1]);
      if (!hSpec.needsChildren && !hSpec.isDefault) {
        return layoutFactoryOverlay(
          el,
          parentBox,
          viewport,
          opts,
          fill,
          visible,
          layer,
        );
      }
    }
    return layoutStack(el, parentBox, viewport, opts, fill, visible, layer);
  }
  if (el.type === "grid") {
    return layoutGrid(el, parentBox, viewport, opts, visible, layer);
  }

  return layoutAnchored(el, parentBox, viewport, opts, fill, visible, layer);
}

/**
 * Mark scrollbar track/box controls ignored under a scroll_view.
 *
 * @param el - scroll_view element.
 * @returns shallow-cloned tree with bar chrome ignored.
 */
function stripScrollChrome(el: ResolvedElement): ResolvedElement {
  return {
    ...el,
    controls: el.controls.map((c) => {
      const name = `${c.id} ${c.element.name}`.toLowerCase();
      if (name.includes("bar_and_track") || name.includes("scroll_bar")) {
        return {
          ...c,
          element: {
            ...c.element,
            props: { ...c.element.props, ignored: true },
          },
        };
      }
      return {
        ...c,
        element: stripScrollChrome(c.element),
      };
    }),
  };
}

/**
 * Resolve `ignored` (bool or `$touch` / `(not $touch)`-style expr).
 *
 * @param props - Element props (may carry `$variables`).
 * @returns true when the control must be dropped from layout.
 */
function isIgnored(props: PropertyBag): boolean {
  // common_buttons stacks default/hover/pressed/locked panels. Without a real
  // pointer-state machine, drop only the non-default faces (hover/locked were
  // painting white focus_border_white / White slabs over the battle grid).
  // Do NOT key off `$default_state === false` — parents declare
  // `$default_state|default: false` before the child sets `$default_state: true`.
  if (
    props.$hover_state === true ||
    props.$pressed_state === true ||
    props.$locked_state === true
  ) {
    return true;
  }

  const raw = props.ignored;
  if (raw === true) return true;
  if (raw === false || raw === undefined || raw === null) return false;
  if (typeof raw !== "string") return false;
  const src = raw.trim();
  if (!src) return false;
  try {
    const value = evalExpr(parseExpr(src.startsWith("(") ? src : `(${src})`), {
      binding: () => undefined,
      variable: (name) => {
        const v = props[`$${name}`] ?? props[name];
        if (v !== undefined) return v;
        // common_buttons images use `(not $button_image_visible)` / border
        // with `|default: true` on the parent panel; if the flag never landed
        // on this child, treat missing as visible (real client default).
        if (name === "button_image_visible" || name === "border_visible") {
          return true;
        }
        return undefined;
      },
    });
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return value !== "";
  } catch {
    // Unresolved expr — keep the control (mouse path wins over a hard drop).
    return false;
  }
}

function layoutAnchored(
  el: ResolvedElement,
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  fill: { remainingW: number; remainingH: number },
  visible: boolean,
  layer: number,
): LayoutNode {
  const sizeSpec = readSizePair(el.props.size);
  const minSpec = readSizePair(el.props.min_size);
  const maxSpec = readSizePair(el.props.max_size);
  const wParsed = parseSize(sizeSpec[0]);
  const hParsed = parseSize(sizeSpec[1]);

  const needsChildPass = wParsed.needsChildren || hParsed.needsChildren;
  let childrenW = 0;
  let childrenH = 0;
  let maxChildW = 0;
  let maxChildH = 0;
  let childNodes: LayoutNode[] = [];

  // Tentative self size for child pass (parent % / viewport / px / fill).
  let tentative = resolveSizePair(
    wParsed,
    hParsed,
    {
      parentW: parentBox.w,
      parentH: parentBox.h,
      selfW: 0,
      selfH: 0,
      childrenW: 0,
      childrenH: 0,
      maxChildW: 0,
      maxChildH: 0,
      viewportW: viewport.width,
      viewportH: viewport.height,
      remainingW: fill.remainingW,
      remainingH: fill.remainingH,
    },
    el,
    opts,
  );

  // Only probe children when self size depends on them (%c / default).
  // Measuring on every panel (then layoutControls again) is exponential in
  // depth — long_form (~400 nodes) was ~50s before this gate.
  if (needsChildPass) {
    const contentParent: LayoutBox = {
      x: 0,
      y: 0,
      w: Math.max(tentative.w, 0),
      h: Math.max(tentative.h, 0),
    };
    // When parent size is %c, give children an unconstrained parent for intrinsic measure.
    if (wParsed.needsChildren) contentParent.w = parentBox.w;
    if (hParsed.needsChildren) contentParent.h = parentBox.h;

    const measured = measureChildren(el, contentParent, viewport, opts);
    childrenW = measured.childrenW;
    childrenH = measured.childrenH;
    maxChildW = measured.maxChildW;
    maxChildH = measured.maxChildH;
    childNodes = measured.nodes;
  }

  let boxSize = resolveSizePair(
    wParsed,
    hParsed,
    {
      parentW: parentBox.w,
      parentH: parentBox.h,
      selfW: tentative.w,
      selfH: tentative.h,
      childrenW,
      childrenH,
      maxChildW,
      maxChildH,
      viewportW: viewport.width,
      viewportH: viewport.height,
      remainingW: fill.remainingW,
      remainingH: fill.remainingH,
    },
    el,
    opts,
  );

  // Second pass for %x/%y that need the opposite self axis.
  boxSize = resolveSizePair(
    wParsed,
    hParsed,
    {
      parentW: parentBox.w,
      parentH: parentBox.h,
      selfW: boxSize.w,
      selfH: boxSize.h,
      childrenW,
      childrenH,
      maxChildW,
      maxChildH,
      viewportW: viewport.width,
      viewportH: viewport.height,
      remainingW: fill.remainingW,
      remainingH: fill.remainingH,
    },
    el,
    opts,
  );

  boxSize = clampSize(boxSize, minSpec, maxSpec, {
    parentW: parentBox.w,
    parentH: parentBox.h,
    selfW: boxSize.w,
    selfH: boxSize.h,
    childrenW,
    childrenH,
    maxChildW,
    maxChildH,
    viewportW: viewport.width,
    viewportH: viewport.height,
    remainingW: fill.remainingW,
    remainingH: fill.remainingH,
  });

  const offset = resolveOffset(el.props.offset, boxSize, parentBox, viewport);
  const pos = positionWithAnchors(
    parentBox,
    boxSize,
    readAnchor(el.props.anchor_from, "center"),
    readAnchor(el.props.anchor_to, "center"),
    offset,
  );

  const selfBox: LayoutBox = { x: pos.x, y: pos.y, w: boxSize.w, h: boxSize.h };
  const anchorFrom = readAnchor(el.props.anchor_from, "center");
  clampHorizontalInParent(selfBox, parentBox, anchorFrom);
  clampBattleActorPlateToViewport(selfBox, el, viewport);

  // Sidebar main is authored `["222.22%y", 192]` ≈ 427gui on every screen.
  // At capture's 640gui width that is ~67% and the clipped dock.png slab
  // paints a tall black wall. Cap at 40% of the viewport (≈ large-monitor
  // Bedrock proportions) and keep right alignment.
  if (
    el.namespace === "phud_sidebar" &&
    el.name === "main" &&
    ANCHORS[anchorFrom].x >= 0.999
  ) {
    const maxW = viewport.width * 0.35;
    if (selfBox.w > maxW + 1) {
      selfBox.w = maxW;
      selfBox.x = parentBox.x + parentBox.w - selfBox.w;
    }
    // Dock `offset: ["47%",0]` + selected ring hang past main; leave a few
    // gui-px so the plate/ring are not shaved by the viewport edge.
    const inset = Math.min(10, viewport.width * 0.015);
    const parentRight = parentBox.x + parentBox.w;
    if (selfBox.x + selfBox.w > parentRight - inset) {
      selfBox.x = parentRight - inset - selfBox.w;
    }
    clampHorizontalInParent(selfBox, parentBox, anchorFrom);
  }

  // Sidebar dock: right-anchored + `offset: ["47%",0]` hangs past main so the
  // transparent left pad of dock.png sits off-screen. Clip the box to the
  // on-screen slice (plates/ring layout here) and right-align an oversized
  // background so the visible strip shows the opaque art — width-only clip
  // without bg-align stretched the left pad across the plate.
  if (ANCHORS[anchorFrom].x >= 0.999) {
    const parentRight = parentBox.x + parentBox.w;
    const overflow = selfBox.x + selfBox.w - parentRight;
    if (overflow > 1) {
      const fullW = selfBox.w;
      selfBox.w = Math.max(0, parentRight - selfBox.x);
      if (selfBox.w > 0) {
        el.props.$viewer_bg_align = "right";
        el.props.$viewer_bg_scale_x = fullW / selfBox.w;
      }
    }
  }

  // Re-layout children into final absolute parent box when we have controls.
  if (el.controls.length > 0) {
    childNodes = layoutControls(el.controls, selfBox, viewport, opts);
  }

  return {
    element: el,
    box: selfBox,
    children: childNodes,
    layer,
    visible,
  };
}

function layoutStack(
  el: ResolvedElement,
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  fill: { remainingW: number; remainingH: number },
  visible: boolean,
  layer: number,
): LayoutNode {
  const orientation =
    el.props.orientation === "horizontal" ? "horizontal" : "vertical";
  const sizeSpec = readSizePair(el.props.size);
  const minSpec = readSizePair(el.props.min_size);
  const maxSpec = readSizePair(el.props.max_size);
  const wParsed = parseSize(sizeSpec[0]);
  const hParsed = parseSize(sizeSpec[1]);

  // First measure non-fill children against a tentative parent.
  const tentativeParent: LayoutBox = {
    x: 0,
    y: 0,
    w: parentBox.w,
    h: parentBox.h,
  };
  const env0: SizeEnv = {
    parentW: parentBox.w,
    parentH: parentBox.h,
    selfW: 0,
    selfH: 0,
    childrenW: 0,
    childrenH: 0,
    maxChildW: 0,
    maxChildH: 0,
    viewportW: viewport.width,
    viewportH: viewport.height,
    remainingW: fill.remainingW,
    remainingH: fill.remainingH,
  };
  const tent = resolveSizePair(wParsed, hParsed, env0, el, opts);
  if (!wParsed.needsChildren) tentativeParent.w = Math.max(tent.w, 0);
  if (!hParsed.needsChildren) tentativeParent.h = Math.max(tent.h, 0);

  const childEls = visibleControls(el.controls);
  const childParsed = childEls.map((c) => {
    const sz = readSizePair(c.element.props.size);
    return {
      child: c,
      w: parseSize(sz[0]),
      h: parseSize(sz[1]),
    };
  });

  // Measure intrinsic (non-fill main-axis) children.
  type Measured = {
    child: ResolvedChild;
    wParsed: ParsedSize;
    hParsed: ParsedSize;
    node: LayoutNode;
    mainFill: boolean;
  };
  const measured: Measured[] = [];
  let usedMain = 0;
  let maxCross = 0;

  for (const { child, w, h } of childParsed) {
    const mainFill = orientation === "vertical" ? h.isFill : w.isFill;
    const crossFill = orientation === "vertical" ? w.isFill : h.isFill;

    // For fill on main axis, measure with 0 remaining so fill→0 during probe.
    const probeFill = {
      remainingW:
        orientation === "horizontal" && w.isFill ? 0 : tentativeParent.w,
      remainingH:
        orientation === "vertical" && h.isFill ? 0 : tentativeParent.h,
    };
    // Cross-axis fill uses full stack cross size.
    if (crossFill) {
      if (orientation === "vertical") probeFill.remainingW = tentativeParent.w;
      else probeFill.remainingH = tentativeParent.h;
    }

    const node = layoutElement(
      child.element,
      tentativeParent,
      viewport,
      opts,
      probeFill,
    );
    // Re-parent coords later; for now use size only.
    if (!mainFill) {
      usedMain += orientation === "vertical" ? node.box.h : node.box.w;
    }
    maxCross = Math.max(
      maxCross,
      orientation === "vertical" ? node.box.w : node.box.h,
    );
    measured.push({
      child,
      wParsed: w,
      hParsed: h,
      node,
      mainFill,
    });
  }

  const fillCount = measured.filter((m) => m.mainFill).length;
  const childrenW =
    orientation === "vertical"
      ? maxCross
      : measured.reduce((s, m) => s + (m.mainFill ? 0 : m.node.box.w), 0);
  const childrenH =
    orientation === "horizontal"
      ? maxCross
      : measured.reduce((s, m) => s + (m.mainFill ? 0 : m.node.box.h), 0);
  const maxChildW = Math.max(0, ...measured.map((m) => m.node.box.w), 0);
  const maxChildH = Math.max(0, ...measured.map((m) => m.node.box.h), 0);

  let stackSize = resolveSizePair(
    wParsed,
    hParsed,
    {
      ...env0,
      childrenW:
        orientation === "horizontal"
          ? childrenW +
            (fillCount > 0 ? 0 : 0) /* fill added after stack size known */
          : childrenW,
      childrenH,
      maxChildW,
      maxChildH,
    },
    el,
    opts,
  );

  // If stack main axis is %c and there are fill children, %c is sum of non-fill only
  // (fill needs a definite parent). Prefer explicit parent/% size for fill stacks.
  stackSize = clampSize(stackSize, minSpec, maxSpec, {
    ...env0,
    selfW: stackSize.w,
    selfH: stackSize.h,
    childrenW,
    childrenH,
    maxChildW,
    maxChildH,
  });

  const mainSize = orientation === "vertical" ? stackSize.h : stackSize.w;
  const remainMain = Math.max(0, mainSize - usedMain);
  const perFill = fillCount > 0 ? remainMain / fillCount : 0;

  const offset = resolveOffset(el.props.offset, stackSize, parentBox, viewport);
  const pos = positionWithAnchors(
    parentBox,
    stackSize,
    readAnchor(el.props.anchor_from, "center"),
    readAnchor(el.props.anchor_to, "center"),
    offset,
  );
  const selfBox: LayoutBox = {
    x: pos.x,
    y: pos.y,
    w: stackSize.w,
    h: stackSize.h,
  };
  {
    const anchorFrom = readAnchor(el.props.anchor_from, "center");
    clipRightOverflow(selfBox, parentBox, anchorFrom);
    clampHorizontalInParent(selfBox, parentBox, anchorFrom);
    clampBattleActorPlateToViewport(selfBox, el, viewport);
  }

  // Final pass: place children along the stack.
  const outChildren: LayoutNode[] = [];
  // Include invisible controls at their natural anchored position with no flow cost.
  const visibleIds = new Set(childEls.map((c) => c.id));
  let cursor = 0;

  for (const c of el.controls) {
    if (isIgnored(c.element.props)) continue;
    if (!coerceVisible(c.element.props.visible)) {
      const node = layoutElement(c.element, selfBox, viewport, opts, {
        remainingW: selfBox.w,
        remainingH: selfBox.h,
      });
      outChildren.push(node);
      continue;
    }
    if (!visibleIds.has(c.id)) continue;

    const m = measured.find((x) => x.child.id === c.id);
    if (!m) continue;

    const slot: LayoutBox = {
      x: selfBox.x,
      y: selfBox.y,
      w: selfBox.w,
      h: selfBox.h,
    };
    const childFill = {
      remainingW: selfBox.w,
      remainingH: selfBox.h,
    };

    if (orientation === "vertical") {
      const h = m.mainFill ? perFill : m.node.box.h;
      slot.y = selfBox.y + cursor;
      slot.h = h;
      childFill.remainingH = h;
      childFill.remainingW = selfBox.w;
      cursor += h;
    } else {
      const w = m.mainFill ? perFill : m.node.box.w;
      slot.x = selfBox.x + cursor;
      slot.w = w;
      childFill.remainingW = w;
      childFill.remainingH = selfBox.h;
      cursor += w;
    }

    // Stack children: top_left→top_left within their slot (Bedrock stack flow).
    const stacked = layoutElementInSlot(
      c.element,
      slot,
      viewport,
      opts,
      childFill,
      /* forceTopLeft */ true,
    );
    outChildren.push(stacked);
  }

  return {
    element: el,
    box: selfBox,
    children: outChildren,
    layer,
    visible,
  };
}

/**
 * Lay out a factory collection host as overlapping children (panel-like).
 *
 * @param el - stack_panel with factory + collection_name.
 * @param parentBox - Parent box.
 * @param viewport - Viewport.
 * @param opts - Layout options.
 * @param fill - Remaining fill space.
 * @param visible - Host visibility.
 * @param layer - Host layer.
 * @returns layout node.
 */
function layoutFactoryOverlay(
  el: ResolvedElement,
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  fill: { remainingW: number; remainingH: number },
  visible: boolean,
  layer: number,
): LayoutNode {
  const sizeSpec = readSizePair(el.props.size);
  const wParsed = parseSize(sizeSpec[0]);
  const hParsed = parseSize(sizeSpec[1]);
  const boxSize = resolveSizePair(
    wParsed,
    hParsed,
    {
      parentW: parentBox.w,
      parentH: parentBox.h,
      selfW: 0,
      selfH: 0,
      childrenW: 0,
      childrenH: 0,
      maxChildW: 0,
      maxChildH: 0,
      viewportW: viewport.width,
      viewportH: viewport.height,
      remainingW: fill.remainingW,
      remainingH: fill.remainingH,
    },
    el,
    opts,
  );
  const offset = resolveOffset(el.props.offset, boxSize, parentBox, viewport);
  const pos = positionWithAnchors(
    parentBox,
    boxSize,
    readAnchor(el.props.anchor_from, "center"),
    readAnchor(el.props.anchor_to, "center"),
    offset,
  );
  const selfBox: LayoutBox = {
    x: pos.x,
    y: pos.y,
    w: boxSize.w,
    h: boxSize.h,
  };
  {
    const anchorFrom = readAnchor(el.props.anchor_from, "center");
    clipRightOverflow(selfBox, parentBox, anchorFrom);
    clampHorizontalInParent(selfBox, parentBox, anchorFrom);
    clampBattleActorPlateToViewport(selfBox, el, viewport);
  }
  const children = layoutControls(el.controls, selfBox, viewport, opts);
  return { element: el, box: selfBox, children, layer, visible };
}

/** Like layoutElement but optionally forces top_left anchors (stack slots). */
function layoutElementInSlot(
  el: ResolvedElement,
  slot: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  fill: { remainingW: number; remainingH: number },
  forceTopLeft: boolean,
): LayoutNode {
  if (!forceTopLeft || el.type === "stack_panel" || el.type === "grid") {
    return layoutElement(el, slot, viewport, opts, fill);
  }
  // Clone props with forced anchors for the stack slot pass.
  const forced: ResolvedElement = {
    ...el,
    props: {
      ...el.props,
      anchor_from: "top_left",
      anchor_to: "top_left",
      // Offset still applies within the slot.
    },
  };
  return layoutElement(forced, slot, viewport, opts, fill);
}

function layoutGrid(
  el: ResolvedElement,
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
  visible: boolean,
  layer: number,
): LayoutNode {
  const sizeSpec = readSizePair(el.props.size);
  const minSpec = readSizePair(el.props.min_size);
  const maxSpec = readSizePair(el.props.max_size);
  const wParsed = parseSize(sizeSpec[0]);
  const hParsed = parseSize(sizeSpec[1]);
  const contentSizedH = hParsed.needsChildren || hParsed.isDefault;

  const dims = asNumberPair(el.props.grid_dimensions, [1, 1]) ?? [1, 1];
  const cols = Math.max(1, Math.floor(dims[0]));
  const rows = Math.max(1, Math.floor(dims[1]));

  const env: SizeEnv = {
    parentW: parentBox.w,
    parentH: parentBox.h,
    selfW: 0,
    selfH: 0,
    childrenW: 0,
    childrenH: 0,
    maxChildW: 0,
    maxChildH: 0,
    viewportW: viewport.width,
    viewportH: viewport.height,
    remainingW: parentBox.w,
    remainingH: parentBox.h,
  };

  // Width: prefer parent %; if width itself is %c, fall back to parent width.
  const gridW = finite(
    wParsed.needsChildren ? parentBox.w : wParsed.eval(env, "w"),
  );
  const cellW = gridW / cols;

  const items = el.controls.filter((c) => !isIgnored(c.element.props));

  // Height: `100%c` grids (starter picker) size to rows × item height.
  // Probe the first item in a tall cell; scale item `%` as grid-relative.
  let cellH = 0;
  if (contentSizedH) {
    const probeEl = items[0]
      ? scaleGridItemPercents(items[0].element, cols, rows)
      : undefined;
    if (probeEl) {
      const probe = layoutElement(
        probeEl,
        { x: 0, y: 0, w: cellW, h: 1000 },
        viewport,
        opts,
        { remainingW: cellW, remainingH: 1000 },
      );
      cellH = Math.max(1, probe.box.h);
    } else {
      cellH = 1;
    }
  }

  let gridH = contentSizedH
    ? cellH * rows
    : finite(hParsed.eval({ ...env, selfW: gridW }, "h"));
  if (!contentSizedH) cellH = gridH / rows;

  const gridSize = clampSize({ w: gridW, h: gridH }, minSpec, maxSpec, {
    ...env,
    selfW: gridW,
    selfH: gridH,
    childrenW: gridW,
    childrenH: gridH,
  });
  const finalCellW = gridSize.w / cols;
  const finalCellH = contentSizedH ? cellH : gridSize.h / rows;
  const finalGridH = contentSizedH ? finalCellH * rows : gridSize.h;
  const finalSize = { w: gridSize.w, h: finalGridH };

  const offset = resolveOffset(el.props.offset, finalSize, parentBox, viewport);
  const pos = positionWithAnchors(
    parentBox,
    finalSize,
    readAnchor(el.props.anchor_from, "center"),
    readAnchor(el.props.anchor_to, "center"),
    offset,
  );
  const selfBox: LayoutBox = {
    x: pos.x,
    y: pos.y,
    w: finalSize.w,
    h: finalSize.h,
  };
  {
    const anchorFrom = readAnchor(el.props.anchor_from, "center");
    clipRightOverflow(selfBox, parentBox, anchorFrom);
    clampHorizontalInParent(selfBox, parentBox, anchorFrom);
  }

  const children: LayoutNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i]!;
    const gp = asNumberPair(c.element.props.grid_position, null);
    const col = gp ? Math.floor(gp[1]!) : i % cols; // grid_position is [row, column]
    const row = gp ? Math.floor(gp[0]!) : Math.floor(i / cols);
    if (row >= rows || col >= cols) continue;

    const cell: LayoutBox = {
      x: selfBox.x + col * finalCellW,
      y: selfBox.y + row * finalCellH,
      w: finalCellW,
      h: finalCellH,
    };
    children.push(
      layoutElement(
        scaleGridItemPercents(c.element, cols, rows),
        cell,
        viewport,
        opts,
        {
          remainingW: finalCellW,
          remainingH: finalCellH,
        },
      ),
    );
  }

  return {
    element: el,
    box: selfBox,
    children,
    layer,
    visible,
  };
}

/**
 * Grid item `%` sizes are authored relative to the grid (e.g. starter
 * `pokemon.button` width `15%` with 6 columns), but cells are the layout
 * parent. Scale plain `%` specs by cols/rows so `15%` → `90%` of a cell.
 *
 * @param item - Grid child element.
 * @param cols - Column count.
 * @param rows - Row count.
 * @returns shallow clone with scaled size/offset percent axes when needed.
 */
function scaleGridItemPercents(
  item: ResolvedElement,
  cols: number,
  rows: number,
): ResolvedElement {
  const size = item.props.size;
  if (!Array.isArray(size) || size.length < 2) return item;
  const w = scalePlainPercent(size[0], cols);
  const h = scalePlainPercent(size[1], rows);
  if (w === size[0] && h === size[1]) return item;
  return {
    ...item,
    props: { ...item.props, size: [w, h] },
  };
}

/**
 * Multiply a plain `N%` size by `factor` (grid dimension). Leaves px / %c / fill.
 *
 * Only scales when `N * factor ≤ ~100` — i.e. the authoring looks like a
 * grid-relative column share (`15%` × 6 cols). `100%` cell-fill stays put
 * (`100 * cols` would exceed 100).
 *
 * @param spec - Size axis value.
 * @param factor - Columns (width) or rows (height).
 * @returns scaled spec or original.
 */
function scalePlainPercent(spec: unknown, factor: number): unknown {
  if (typeof spec !== "string" || factor <= 0) return spec;
  const m = /^(-?[0-9.]+)%$/.exec(spec.trim());
  if (!m) return spec;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return spec;
  // Cell-relative fill (`100%`) must not become `100% * cols`.
  if (n * factor > 100 + 1) return spec;
  return `${n * factor}%`;
}

function measureChildren(
  el: ResolvedElement,
  contentParent: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
): {
  nodes: LayoutNode[];
  childrenW: number;
  childrenH: number;
  maxChildW: number;
  maxChildH: number;
} {
  const nodes: LayoutNode[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxChildW = 0;
  let maxChildH = 0;
  let any = false;

  for (const c of el.controls) {
    if (isIgnored(c.element.props)) continue;
    if (!coerceVisible(c.element.props.visible)) {
      // Still produce a node later in final pass; skip content contribution.
      continue;
    }
    const node = layoutElement(c.element, contentParent, viewport, opts, {
      remainingW: contentParent.w,
      remainingH: contentParent.h,
    });
    nodes.push(node);
    any = true;
    maxChildW = Math.max(maxChildW, node.box.w);
    maxChildH = Math.max(maxChildH, node.box.h);
    minX = Math.min(minX, node.box.x);
    minY = Math.min(minY, node.box.y);
    maxX = Math.max(maxX, node.box.x + node.box.w);
    maxY = Math.max(maxY, node.box.y + node.box.h);
  }

  // %c = axis-aligned bounding box of children (not "from origin"). Including
  // the origin (`min(0,min)`) bloated bottom/right-anchored tips like
  // `player_ping.main` (Black.png) to ~full HUD — live run-43 center black box.
  const childrenW = any ? Math.max(0, maxX - minX) : 0;
  const childrenH = any ? Math.max(0, maxY - minY) : 0;

  return { nodes, childrenW, childrenH, maxChildW, maxChildH };
}

function layoutControls(
  controls: ResolvedChild[],
  parentBox: LayoutBox,
  viewport: Viewport,
  opts: LayoutOptions,
): LayoutNode[] {
  const out: LayoutNode[] = [];
  for (const c of controls) {
    if (isIgnored(c.element.props)) continue;
    out.push(
      layoutElement(c.element, parentBox, viewport, opts, {
        remainingW: parentBox.w,
        remainingH: parentBox.h,
      }),
    );
  }
  return out;
}

function visibleControls(controls: ResolvedChild[]): ResolvedChild[] {
  return controls.filter(
    (c) =>
      !isIgnored(c.element.props) && coerceVisible(c.element.props.visible),
  );
}

/**
 * Coerce a `#visible` / `visible` prop to a boolean.
 *
 * Pack bindings often write the string `"true"` / `"false"` (sidebar selected
 * flag) — those must not stay truthy as non-empty strings.
 *
 * @param v - Raw property value.
 * @returns false only for explicit falsy forms; undefined defaults to visible.
 */
function coerceVisible(v: unknown): boolean {
  if (v === false || v === 0 || v === "false" || v === "null" || v === "")
    return false;
  return true;
}

function resolveSizePair(
  wParsed: ParsedSize,
  hParsed: ParsedSize,
  env: SizeEnv,
  el: ResolvedElement,
  opts: LayoutOptions,
): { w: number; h: number } {
  // Labels with default/content sizing: inject intrinsic text metrics into children*.
  const intrinsic = labelIntrinsic(el, opts);
  const e: SizeEnv = { ...env };
  if (intrinsic) {
    if (wParsed.needsChildren && e.childrenW === 0) e.childrenW = intrinsic.w;
    if (hParsed.needsChildren && e.childrenH === 0) e.childrenH = intrinsic.h;
    if (wParsed.needsChildren && e.maxChildW === 0) e.maxChildW = intrinsic.w;
    if (hParsed.needsChildren && e.maxChildH === 0) e.maxChildH = intrinsic.h;
  }

  let w = wParsed.eval(e, "w");
  let h = hParsed.eval(e, "h");

  // Labels: `default` means text metrics, never parent %.
  if (intrinsic && el.type === "label") {
    if (wParsed.isDefault) w = intrinsic.w;
    if (hParsed.isDefault) h = intrinsic.h;
  }

  return { w: finite(w), h: finite(h) };
}

function labelIntrinsic(
  el: ResolvedElement,
  opts: LayoutOptions,
): TextMetrics | null {
  if (el.type !== "label") return null;
  const text = typeof el.props.text === "string" ? el.props.text : "";
  const fontScale =
    typeof el.props.font_scale_factor === "number"
      ? el.props.font_scale_factor
      : 1;
  // Strip § codes for measurement width.
  const plain = text.replace(/[§&]./g, "");
  return opts.measureText(plain, fontScale);
}

function clampSize(
  size: { w: number; h: number },
  minSpec: [unknown, unknown],
  maxSpec: [unknown, unknown],
  env: SizeEnv,
): { w: number; h: number } {
  let { w, h } = size;
  const minW = parseSize(minSpec[0]);
  const minH = parseSize(minSpec[1]);
  const maxW = parseSize(maxSpec[0]);
  const maxH = parseSize(maxSpec[1]);

  if (!minW.isDefault) w = Math.max(w, minW.eval(env, "w"));
  if (!minH.isDefault) h = Math.max(h, minH.eval(env, "h"));
  if (!maxW.isDefault) w = Math.min(w, maxW.eval(env, "w"));
  if (!maxH.isDefault) h = Math.min(h, maxH.eval(env, "h"));
  return { w: finite(w), h: finite(h) };
}

function positionWithAnchors(
  parent: LayoutBox,
  size: { w: number; h: number },
  anchorFrom: Anchor,
  anchorTo: Anchor,
  offset: { x: number; y: number },
): { x: number; y: number } {
  const from = ANCHORS[anchorFrom];
  const to = ANCHORS[anchorTo];
  const parentAx = parent.x + parent.w * from.x;
  const parentAy = parent.y + parent.h * from.y;
  const selfAx = size.w * to.x;
  const selfAy = size.h * to.y;
  return {
    x: parentAx - selfAx + offset.x,
    y: parentAy - selfAy + offset.y,
  };
}

/**
 * Clip a right-anchored box that hangs past the parent (sidebar dock `+47%`).
 * Keep the left edge (offset stays meaningful) and shrink width so the right
 * edge meets the parent — flushing left painted the full stretched dock as a
 * black slab.
 *
 * @param box - Positioned box (mutated in place when clipped).
 * @param parent - Parent layout box.
 * @param anchorFrom - Element `anchor_from`.
 */
function clipRightOverflow(
  box: LayoutBox,
  parent: LayoutBox,
  anchorFrom: Anchor,
): void {
  if (ANCHORS[anchorFrom].x < 0.999) return;
  const parentRight = parent.x + parent.w;
  if (box.x + box.w <= parentRight) return;
  box.w = Math.max(0, parentRight - box.x);
}

/**
 * Shift a non-right-anchored box back inside its parent when more than half
 * of it hangs off. Small intentional overhangs (bag/run `-50%` of a 40px
 * chip) stay put — actor plates are clamped separately via
 * {@link clampBattleActorPlateToViewport}.
 *
 * @param box - Positioned box (mutated in place when clamped).
 * @param parent - Parent layout box.
 * @param anchorFrom - Element `anchor_from`.
 */
function clampHorizontalInParent(
  box: LayoutBox,
  parent: LayoutBox,
  anchorFrom: Anchor,
): void {
  if (ANCHORS[anchorFrom].x >= 0.999) return;
  if (box.w <= 0 || box.w > parent.w) return;
  const parentRight = parent.x + parent.w;
  if (box.x < parent.x && parent.x - box.x > box.w * 0.5) {
    box.x = parent.x;
  }
  if (
    box.x + box.w > parentRight &&
    box.x + box.w - parentRight > box.w * 0.5
  ) {
    box.x = parentRight - box.w;
  }
}

/**
 * Keep battle name-plates fully on-screen. Pack `opponent/ally_actor_details_button`
 * uses offset ±50% inside the edge 25% columns; that hangs ~half the plate past
 * the viewport in our layout (real client keeps both plates + HP arcs visible).
 * Do NOT use this for bag/run chips — those overhangs are intentional.
 *
 * @param box - Positioned box (mutated when clamped).
 * @param el - Element being laid out.
 * @param viewport - Form viewport in gui pixels.
 */
function clampBattleActorPlateToViewport(
  box: LayoutBox,
  el: ResolvedElement,
  viewport: Viewport,
): void {
  const name = el.name;
  const isPlateStack =
    name === "opponent_actor_details_button" ||
    name === "ally_actor_details_button";
  const size = el.props.size;
  const isPlateButton = Array.isArray(size) && size[0] === 90 && size[1] === 42;
  if (!isPlateStack && !isPlateButton) return;
  if (box.w <= 0 || box.w > viewport.width) return;
  if (box.x < 0) box.x = 0;
  if (box.x + box.w > viewport.width) box.x = viewport.width - box.w;
}

function resolveOffset(
  raw: unknown,
  self: { w: number; h: number },
  parent: LayoutBox,
  viewport: Viewport,
): { x: number; y: number } {
  const pair = asUnknownPair(raw, [0, 0]);
  const env: SizeEnv = {
    parentW: parent.w,
    parentH: parent.h,
    selfW: self.w,
    selfH: self.h,
    childrenW: 0,
    childrenH: 0,
    maxChildW: 0,
    maxChildH: 0,
    viewportW: viewport.width,
    viewportH: viewport.height,
    remainingW: parent.w,
    remainingH: parent.h,
  };
  return {
    x: parseSize(pair[0]).eval(env, "w"),
    y: parseSize(pair[1]).eval(env, "h"),
  };
}

function readSizePair(raw: unknown): [unknown, unknown] {
  return asUnknownPair(raw, ["default", "default"]);
}

function readAnchor(raw: unknown, fallback: Anchor): Anchor {
  if (typeof raw === "string" && raw in ANCHORS) return raw as Anchor;
  return fallback;
}

function parseSize(raw: unknown): ParsedSize {
  if (raw === undefined || raw === null || raw === "default") {
    // Content-sized when children exist; else parent (empty panels keep fill).
    return {
      needsChildren: true,
      needsSelf: false,
      isFill: false,
      isDefault: true,
      eval: (env, axis) => {
        const content = axis === "w" ? env.childrenW : env.childrenH;
        if (content > 0) return content;
        return axis === "w" ? env.parentW : env.parentH;
      },
    };
  }
  if (raw === "fill") {
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: true,
      isDefault: false,
      eval: (env, axis) => (axis === "w" ? env.remainingW : env.remainingH),
    };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: () => raw,
    };
  }
  if (typeof raw !== "string") {
    return parseSize("default");
  }

  const s = raw.trim();
  if (s === "default") return parseSize("default");
  if (s === "fill") return parseSize("fill");

  // Arithmetic: "100% - 8px", "75% + 12px" (not bare "-13%")
  if (/[+-]/.test(s.slice(1)) && /%|px|\d/.test(s)) {
    return parseArithmetic(s);
  }

  return parseSizeAtom(s);
}

function parseArithmetic(s: string): ParsedSize {
  // Split on + / - that are operators (not leading sign).
  const tokens: { op: "+" | "-"; atom: string }[] = [];
  const re = /([+-])?\s*([0-9.]+(?:px|%c(?:m)?|%sm|%[xy]|%)?|default|fill)/gi;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(s))) {
    const op = (m[1] as "+" | "-" | undefined) ?? "+";
    const atom = m[2]!;
    if (first && !m[1]) {
      tokens.push({ op: "+", atom });
    } else {
      tokens.push({ op: first && !m[1] ? "+" : op, atom });
    }
    first = false;
  }
  if (tokens.length === 0) return parseSizeAtom(s);

  const atoms = tokens.map((t) => parseSizeAtom(t.atom));
  return {
    needsChildren: atoms.some((a) => a.needsChildren),
    needsSelf: atoms.some((a) => a.needsSelf),
    isFill: atoms.some((a) => a.isFill),
    isDefault: false,
    eval: (env, axis) => {
      let acc = 0;
      for (let i = 0; i < tokens.length; i++) {
        const v = atoms[i]!.eval(env, axis);
        acc = tokens[i]!.op === "-" ? acc - v : acc + v;
      }
      return acc;
    },
  };
}

function parseSizeAtom(s: string): ParsedSize {
  const t = s.trim();
  if (t === "default") return parseSize("default");
  if (t === "fill") return parseSize("fill");

  // Leading `-` required for battle offsets ("-45.5%", "-13%").
  let m = /^(-?[0-9.]+)px$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: () => n,
    };
  }

  m = /^(-?[0-9.]+)%cm$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: true,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: (env, axis) => n * (axis === "w" ? env.maxChildW : env.maxChildH),
    };
  }

  m = /^(-?[0-9.]+)%c$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: true,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: (env, axis) => n * (axis === "w" ? env.childrenW : env.childrenH),
    };
  }

  m = /^(-?[0-9.]+)%sm$/i.exec(t);
  if (m) {
    // Sibling max — not tracked; treat as 0 (punted).
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: () => 0,
    };
  }

  m = /^(-?[0-9.]+)%x$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: false,
      needsSelf: true,
      isFill: false,
      isDefault: false,
      // Percent of this element's own width (resolved on the second pass).
      eval: (env) => n * env.selfW,
    };
  }

  m = /^(-?[0-9.]+)%y$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: false,
      needsSelf: true,
      isFill: false,
      isDefault: false,
      // Percent of this element's own height (resolved on the second pass).
      eval: (env) => n * env.selfH,
    };
  }

  m = /^(-?[0-9.]+)%$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: (env, axis) => n * (axis === "w" ? env.parentW : env.parentH),
    };
  }

  m = /^(-?[0-9.]+)$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: () => n,
    };
  }

  return parseSize("default");
}

function asInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function asUnknownPair(
  raw: unknown,
  fallback: [unknown, unknown],
): [unknown, unknown] {
  if (Array.isArray(raw) && raw.length >= 2) return [raw[0], raw[1]];
  if (typeof raw === "number" || typeof raw === "string") return [raw, raw];
  return fallback;
}

function asNumberPair(
  raw: unknown,
  fallback: [number, number] | null,
): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return fallback;
  const a = Number(raw[0]);
  const b = Number(raw[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback;
  return [a, b];
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}
