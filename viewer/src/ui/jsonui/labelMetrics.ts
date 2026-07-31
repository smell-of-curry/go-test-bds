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
