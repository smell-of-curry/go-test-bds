import { formatCodesToFragment } from "../formatCodes";
import { mojanglesLoaded, MOJANGLES_STACK } from "../mojangles";
import type { LayoutNode, MeasureText } from "./layout";
import { localizeLabelText } from "./load";
import { LABEL_FONT_SIZE_GUI, LABEL_LINE_HEIGHT_GUI } from "./labelMetrics";

/** Wrap authored tooltip text to the viewport, retaining Minecraft format codes. */
export function wrapTooltipText(
  text: string,
  width: number,
  measure: MeasureText,
): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    // Keep format-code pairs intact; they have no measured width.
    const tokens = paragraph.match(/§.|[^§]/gu) ?? [];
    for (const token of tokens) {
      if (line && measure(line + token, 1).w > width) {
        lines.push(line);
        line = "";
      }
      line += token;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Paint a selected form's generic `hover_text_renderer` from its bound text.
 * The protocol records an index, not historical cursor coordinates: absent a
 * pointer move, playback anchors to that button. Native tooltip chrome and
 * exact cursor placement require a matched client reference.
 *
 * @returns cleanup for the overlay and its temporary pointer listener.
 */
export function mountFormTooltip(
  host: HTMLElement,
  layout: LayoutNode,
  guiScale: number,
  measure: MeasureText,
  lang?: Readonly<Record<string, string>>,
): () => void {
  let hit: { node: LayoutNode; anchor: LayoutNode } | null = null;
  function find(node: LayoutNode, button: LayoutNode | null): void {
    if (!node.visible || hit) return;
    if (node.element.type === "button") button = node;
    if (
      node.element.type === "custom" &&
      node.element.props.renderer === "hover_text_renderer" &&
      typeof node.element.props.hover_text === "string" &&
      node.element.props.hover_text.trim()
    ) {
      hit = { node, anchor: button ?? node };
      return;
    }
    for (const child of node.children) find(child, button);
  }
  find(layout, null);
  if (!hit) return () => {};
  const { node, anchor } = hit as { node: LayoutNode; anchor: LayoutNode };
  const doc = host.ownerDocument;
  const win = doc.defaultView!;
  const text = localizeLabelText(
    String(node.element.props.hover_text),
    node.element.props.localize,
    lang,
  );
  const padding = 3 * guiScale;
  const maxWidth = Math.max(
    1,
    Math.min(320, (win.innerWidth - 16 - 2 * padding) / guiScale),
  );
  const wrapped = mojanglesLoaded()
    ? text
    : wrapTooltipText(text, maxWidth, measure);
  const lines = wrapped.split("\n");
  let width =
    Math.max(1, ...lines.map((line) => measure(line, 1).w)) * guiScale;
  let height = lines.length * LABEL_LINE_HEIGHT_GUI * guiScale;
  const fragment = formatCodesToFragment(wrapped, {
    guiScale,
    shadow: true,
    maxWidth: maxWidth - 1,
  });
  const canvas = fragment.querySelector("canvas");
  if (canvas) {
    // Bold glyphs and authored formatting affect real width. Use the same
    // styled raster for both wrapping and the tooltip's background bounds.
    width = Number.parseFloat(canvas.style.width);
    height = Number.parseFloat(canvas.style.height);
  }
  const tooltip = doc.createElement("div");
  tooltip.className = "jsonui-hover-tooltip";
  tooltip.dataset.anchorMode = "recorded-button";
  tooltip.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;background:rgba(16,0,16,.94);border:1px solid #503060;padding:${padding}px;width:${width}px;height:${height}px;box-sizing:content-box;color:white;font-family:${MOJANGLES_STACK};font-size:${LABEL_FONT_SIZE_GUI * guiScale}px;line-height:${LABEL_LINE_HEIGHT_GUI * guiScale}px;white-space:pre;`;
  tooltip.appendChild(fragment);
  host.appendChild(tooltip);
  const fullWidth = width + padding * 2 + 2;
  const fullHeight = height + padding * 2 + 2;
  function place(x: number, y: number): void {
    const offset = 8 * guiScale;
    const left =
      x + offset + fullWidth > win.innerWidth - 4
        ? x - offset - fullWidth
        : x + offset;
    tooltip.style.left = `${Math.max(4, Math.min(left, win.innerWidth - fullWidth - 4))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(y - offset, win.innerHeight - fullHeight - 4))}px`;
  }
  const rect = host.getBoundingClientRect();
  place(
    rect.left + (anchor.box.x + anchor.box.w / 2) * guiScale,
    rect.top + (anchor.box.y + anchor.box.h / 2) * guiScale,
  );
  const onPointer = (event: PointerEvent): void => {
    tooltip.dataset.anchorMode = "pointer";
    place(event.clientX, event.clientY);
  };
  doc.addEventListener("pointermove", onPointer);
  return () => {
    doc.removeEventListener("pointermove", onPointer);
    tooltip.remove();
  };
}
