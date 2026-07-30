/**
 * Pure Bedrock JSON UI layout math. No DOM.
 *
 * Size/anchor semantics follow
 * https://wiki.bedrock.dev/json-ui/json-ui-documentation with one deliberate
 * simplification: `%x` / `%y` resolve against the viewport (task contract),
 * not the element’s own width/height.
 */

import type {
  LayoutBox,
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
  const visible = el.props.visible !== false;
  const layer = asInt(el.props.layer, 0);
  const ignored = el.props.ignored === true;

  if (ignored) {
    return {
      element: el,
      box: { x: parentBox.x, y: parentBox.y, w: 0, h: 0 },
      children: [],
      layer,
      visible: false,
    };
  }

  if (el.type === "stack_panel") {
    return layoutStack(el, parentBox, viewport, opts, fill, visible, layer);
  }
  if (el.type === "grid") {
    return layoutGrid(el, parentBox, viewport, opts, visible, layer);
  }

  return layoutAnchored(el, parentBox, viewport, opts, fill, visible, layer);
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

  // Final pass: place children along the stack.
  const outChildren: LayoutNode[] = [];
  // Include invisible controls at their natural anchored position with no flow cost.
  const visibleIds = new Set(childEls.map((c) => c.id));
  let cursor = 0;

  for (const c of el.controls) {
    if (c.element.props.ignored === true) continue;
    if (c.element.props.visible === false) {
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
  // Grid size like a normal panel first (no child-dependent probe for cell math).
  const sizeSpec = readSizePair(el.props.size);
  const minSpec = readSizePair(el.props.min_size);
  const maxSpec = readSizePair(el.props.max_size);
  const wParsed = parseSize(sizeSpec[0]);
  const hParsed = parseSize(sizeSpec[1]);

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
  let gridSize = resolveSizePair(wParsed, hParsed, env, el, opts);
  gridSize = clampSize(gridSize, minSpec, maxSpec, {
    ...env,
    selfW: gridSize.w,
    selfH: gridSize.h,
  });

  const offset = resolveOffset(el.props.offset, gridSize, parentBox, viewport);
  const pos = positionWithAnchors(
    parentBox,
    gridSize,
    readAnchor(el.props.anchor_from, "center"),
    readAnchor(el.props.anchor_to, "center"),
    offset,
  );
  const selfBox: LayoutBox = {
    x: pos.x,
    y: pos.y,
    w: gridSize.w,
    h: gridSize.h,
  };

  const dims = asNumberPair(el.props.grid_dimensions, [1, 1]) ?? [1, 1];
  const cols = Math.max(1, Math.floor(dims[0]));
  const rows = Math.max(1, Math.floor(dims[1]));
  const cellW = selfBox.w / cols;
  const cellH = selfBox.h / rows;

  const items = el.controls.filter((c) => c.element.props.ignored !== true);
  const children: LayoutNode[] = [];

  for (let i = 0; i < items.length; i++) {
    const c = items[i]!;
    const gp = asNumberPair(c.element.props.grid_position, null);
    const col = gp ? Math.floor(gp[1]!) : i % cols; // grid_position is [row, column]
    const row = gp ? Math.floor(gp[0]!) : Math.floor(i / cols);
    if (row >= rows || col >= cols) continue;

    const cell: LayoutBox = {
      x: selfBox.x + col * cellW,
      y: selfBox.y + row * cellH,
      w: cellW,
      h: cellH,
    };
    children.push(
      layoutElement(c.element, cell, viewport, opts, {
        remainingW: cellW,
        remainingH: cellH,
      }),
    );
  }

  // ponytail: grid_item_template synthesis needs collection data + resolver — cells from controls only.
  return {
    element: el,
    box: selfBox,
    children,
    layer,
    visible,
  };
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
    if (c.element.props.ignored === true) continue;
    if (c.element.props.visible === false) {
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

  // %c = total width/height of children bounding box (relative to content parent origin).
  // When children were laid out in a 0-origin contentParent, prefer sum-of-extents from 0.
  const childrenW = any ? Math.max(0, maxX - Math.min(0, minX)) : 0;
  const childrenH = any ? Math.max(0, maxY - Math.min(0, minY)) : 0;

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
    if (c.element.props.ignored === true) continue;
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
      c.element.props.ignored !== true && c.element.props.visible !== false,
  );
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

  // default → 100% parent (already). For labels with both default and no useful parent
  // (0), fall back to intrinsic text size.
  if (intrinsic && el.type === "label") {
    if (wParsed.isDefault && (e.parentW === 0 || !Number.isFinite(w)))
      w = intrinsic.w;
    if (hParsed.isDefault && (e.parentH === 0 || !Number.isFinite(h)))
      h = intrinsic.h;
  }

  // If width is %y-of-viewport (or height %x), already handled in eval.
  // Re-eval once opposite self known for any needsSelf (element-cross) — we map %x/%y to viewport, so no-op.

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
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: true,
      eval: (env, axis) => (axis === "w" ? env.parentW : env.parentH),
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

  // Arithmetic: "100% - 8px", "75% + 12px"
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

  let m = /^([0-9.]+)px$/i.exec(t);
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

  m = /^([0-9.]+)%cm$/i.exec(t);
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

  m = /^([0-9.]+)%c$/i.exec(t);
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

  m = /^([0-9.]+)%sm$/i.exec(t);
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

  m = /^([0-9.]+)%x$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      // Task: viewport-relative. Wiki would use element width.
      eval: (env) => n * env.viewportW,
    };
  }

  m = /^([0-9.]+)%y$/i.exec(t);
  if (m) {
    const n = Number(m[1]) / 100;
    return {
      needsChildren: false,
      needsSelf: false,
      isFill: false,
      isDefault: false,
      eval: (env) => n * env.viewportH,
    };
  }

  m = /^([0-9.]+)%$/i.exec(t);
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

  m = /^([0-9.]+)$/i.exec(t);
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
