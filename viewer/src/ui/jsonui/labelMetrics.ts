/**
 * Shared label font metrics for layout measure and DOM paint.
 * Bedrock default glyph cell is 8gui; line box is 9gui — both paths must agree.
 */

/** Gui px for label `font-size` at scale factor 1. */
export const LABEL_FONT_SIZE_GUI = 8;

/** Gui px per text line (`measureText` height and CSS `line-height`). */
export const LABEL_LINE_HEIGHT_GUI = 9;

/**
 * Resolve effective font scale from `font_scale_factor` × `font_size` enum.
 *
 * @param props - Label props (may include factor / size).
 * @returns multiplier applied to {@link LABEL_FONT_SIZE_GUI}.
 */
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

/**
 * Collapse Bedrock lang `%%` → literal `%` for label display text.
 *
 * Scoped to finished label strings (not binding exprs with `%.Ns` tokens).
 * Matches Go `substituteLang` escape handling.
 *
 * @param text - Label text that may contain `%%`.
 * @returns text with paired percent escapes collapsed.
 */
export function collapseLangPercentEscapes(text: string): string {
  if (!text.includes("%%")) return text;
  return text.replace(/%%/g, "%");
}

/** Fitted CSS font-size / line-height for a laid-out label box. */
export interface LabelPaintMetrics {
  fontPx: number;
  linePx: number;
}

/**
 * Fit CSS label font/line into a laid-out box.
 *
 * Bedrock bitmap glyphs sit in an 8/9 line box; the viewer's CSS font paints
 * taller ink (ascent+descent often &gt; line-height). Shrink font so ink plus
 * text-shadow fit inside the box; for short single-line boxes set line-height
 * to the full box so the strut centers the glyphs away from the clip edge.
 *
 * @param args - Design font/line, box height, shadow budget, ink measurement.
 * @returns paint font-size and line-height in CSS px.
 */
export function fitLabelPaintMetrics(args: {
  fontPx: number;
  linePx: number;
  boxH: number;
  shadowPx: number;
  multiline: boolean;
  inkHeight: number;
}): LabelPaintMetrics {
  let { fontPx, linePx } = args;
  const { boxH, shadowPx, multiline, inkHeight } = args;
  if (!(boxH > 0) || !(fontPx > 0)) return { fontPx, linePx };

  const usable = Math.max(1, boxH - Math.max(0, shadowPx));
  // Shrink when measured ink (or design line) exceeds the shadow-budgeted box.
  if (inkHeight > usable && inkHeight > 0) fontPx *= usable / inkHeight;
  else if (linePx > usable) fontPx *= usable / linePx;

  // Tight single-line box (battle HP, tip chips): design line ≈ box height.
  // Top-aligned short line-height leaves glyphs overflowing the clip edge
  // (CSS Minecraft ink taller than the 8/9 strut). Fill the box so the
  // strut centers glyphs inside overflow:hidden.
  const tight = !multiline && linePx >= boxH * 0.8;
  linePx = tight ? boxH : Math.min(linePx, boxH);
  return { fontPx, linePx };
}
