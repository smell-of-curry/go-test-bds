/**
 * Minecraft `§` legacy format codes → coloured runs.
 * Unknown codes are stripped. Obfuscated `§k` is stripped.
 * When Mojangles outlines are loaded, the fragment is a pixel canvas
 * (shadow at +1 design pixel, colour × 0.25) instead of CSS text.
 */

import {
  mojanglesLoaded,
  renderMojanglesCanvas,
  type PaintRun,
} from "./mojangles";

const COLOR: Record<string, string> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff",
  g: "#ddd605", // Minecoin gold.
  // Bedrock material formatting, not Java underline/strikethrough. Material
  // RGBs follow bedrock-samples v1.26.50.4 ui/_global_variables.json; code
  // meanings follow Microsoft's creator/reference/content/rawmessagejson.
  h: "#d9ccb8", // Quartz.
  i: "#a9b4b7", // Iron.
  j: "#8f727d", // Netherite.
  m: "#ee222c", // Redstone.
  n: "#c87363", // Copper.
  p: "#ffbf1e", // Gold.
  q: "#13a045", // Emerald.
  s: "#5fecff", // Diamond.
  t: "#577bff", // Lapis.
  u: "#b66cdd", // Amethyst.
};

export interface FormatSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/**
 * Parse a legacy-formatted string into style segments.
 *
 * @param input - Raw text that may contain `§` codes.
 * @returns ordered segments with resolved styles.
 */
export function parseFormatCodes(input: string): FormatSegment[] {
  const out: FormatSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;
  let buf = "";

  const flush = (): void => {
    if (!buf) return;
    out.push({ text: buf, color, bold, italic, underline, strike });
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if ((ch === "§" || ch === "&") && i + 1 < input.length) {
      const code = input[i + 1]!.toLowerCase();
      i++;
      flush();
      if (COLOR[code]) {
        color = COLOR[code];
        continue;
      }
      switch (code) {
        case "l":
          bold = true;
          break;
        case "o":
          italic = true;
          break;
        case "r":
          color = undefined;
          bold = false;
          italic = false;
          underline = false;
          strike = false;
          break;
        default:
          // strip unknown (incl. obfuscated `k`)
          break;
      }
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Keep pack private-use glyphs (drawn from `font/glyph_XX.png`) and drop
 * other PUA code points so a missing page does not paint tofu.
 *
 * @param input - Raw text that may contain PUA glyphs.
 * @returns text with unknown PUA removed. U+E108/E109/E10A stay as themselves.
 */
export function mapMinecraftGlyphs(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    // Male / female / shiny pages ship in resource packs; the atlas draws them.
    if (code === 0xe108 || code === 0xe109 || code === 0xe10a) {
      out += ch;
      continue;
    }
    if (code >= 0xe000 && code <= 0xf8ff) continue;
    out += ch;
  }
  return out;
}

/** Options for {@link formatCodesToFragment}. */
export interface FormatPaint {
  /** Base label color, overridden by explicit legacy format codes. */
  color?: string;
  /** Design pixel → CSS pixel. Default 2 (Bedrock GUI scale 2). */
  guiScale?: number;
  /** Bedrock shadow: +1 design pixel, colour × 0.25. */
  shadow?: boolean;
  /** Wrap width in design pixels before GUI scaling. */
  maxWidth?: number;
}

/**
 * Render format-coded text. Mojangles, when loaded, becomes one pixel canvas;
 * otherwise coloured spans on the fallback stack.
 *
 * @param input - Raw text that may contain `§` codes.
 * @param paint - Scale and shadow, including the fallback spans.
 * @returns a DocumentFragment ready to append.
 */
export function formatCodesToFragment(
  input: string,
  paint?: FormatPaint,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const mapped = mapMinecraftGlyphs(input);
  const segs = parseFormatCodes(mapped);
  if (mojanglesLoaded()) {
    const runs: PaintRun[] = segs
      .filter((s) => s.text)
      .map((s) => ({
        text: s.text,
        color: s.color ?? paint?.color,
        bold: s.bold,
        italic: s.italic,
      }));
    const canvas = renderMojanglesCanvas(runs, {
      guiScale: paint?.guiScale ?? 2,
      shadow: paint?.shadow ?? false,
      maxWidth: paint?.maxWidth,
    });
    if (canvas) {
      // Canvas has no text node. Hidden spans keep the string and § colour
      // for queries (tests, a11y) without painting a second font.
      frag.appendChild(canvas);
      for (const seg of segs) {
        if (!seg.text) continue;
        const span = document.createElement("span");
        span.hidden = true;
        if (seg.color) span.style.color = seg.color;
        span.textContent = seg.text;
        frag.appendChild(span);
      }
      return frag;
    }
  }
  for (const seg of segs) {
    if (!seg.text) continue;
    const span = document.createElement("span");
    if (seg.color) span.style.color = seg.color;
    if (paint?.shadow) {
      const offset = paint.guiScale ?? 2;
      const color = seg.color ?? paint.color ?? "#ffffff";
      span.style.textShadow = `${offset}px ${offset}px 0 color-mix(in srgb, ${color} 25%, black)`;
    }
    if (seg.bold) span.style.fontWeight = "700";
    if (seg.italic) span.style.fontStyle = "italic";
    if (seg.underline || seg.strike) {
      const deco = [
        seg.underline ? "underline" : "",
        seg.strike ? "line-through" : "",
      ]
        .filter(Boolean)
        .join(" ");
      span.style.textDecoration = deco;
    }
    span.textContent = seg.text;
    frag.appendChild(span);
  }
  return frag;
}

/**
 * Strip all format codes, leaving plain text.
 *
 * @param input - Raw text that may contain `§` codes.
 * @returns plain text with codes removed.
 */
export function stripFormatCodes(input: string): string {
  return parseFormatCodes(input)
    .map((s) => s.text)
    .join("");
}
