/**
 * Minecraft `§` legacy format codes → coloured DOM spans.
 * Unknown codes are stripped. Does not implement obfuscated/`k`.
 */

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
        case "n":
          underline = true;
          break;
        case "m":
          strike = true;
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
 * Map Minecraft private-use glyphs the canvas font lacks onto unicode, and
 * drop unknown PUA codepoints (avoids tofu next to sidebar names).
 *
 * Pack font maps: U+E108 male, U+E109 female, U+E10A shiny.
 *
 * @param input - Raw text that may contain PUA glyphs.
 * @returns text safe for system/canvas fonts.
 */
export function mapMinecraftGlyphs(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xe108) out += "♂";
    else if (code === 0xe109) out += "♀";
    else if (code === 0xe10a) out += "★";
    else if (code >= 0xe000 && code <= 0xf8ff) continue;
    else out += ch;
  }
  return out;
}

/**
 * Render format-coded text into a document fragment of coloured spans.
 *
 * @param input - Raw text that may contain `§` codes.
 * @returns a DocumentFragment ready to append.
 */
export function formatCodesToFragment(input: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const seg of parseFormatCodes(mapMinecraftGlyphs(input))) {
    if (!seg.text) continue;
    const span = document.createElement("span");
    if (seg.color) span.style.color = seg.color;
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
